/**
 * 在线播放的媒体流代理:远端 mp4 / HLS 在主进程用 Electron net 取回,再以**同源**的
 * mtmedia:// 协议回给渲染进程的 <video> / hls.js。
 *
 * 为什么必须经主进程转一手:
 *   - mp4:带 `content-disposition: attachment` 的跨源媒体会被 Chromium 拒播(<video> code 4),
 *     剥掉这个头就能播。
 *   - HLS:CDN 不带 CORS 头,渲染进程直连取列表/分片/密钥会被拦;列表里的地址还得重写成
 *     mtmedia://(见 rewritePlaylist),否则 hls.js 拿到的仍是原始跨源地址。
 *
 * 必须用 `net.fetch` 而不是 `netRequest()`:后者把整个 body 缓冲进内存,几百 MB 的视频会爆。
 */
import { protocol, net } from 'electron'
import { DESKTOP_USER_AGENT } from './download-types'
import { tryServeFromCache, SUPERSEDED_SEEK } from './media-cache'
import { tryServeSegment, rememberPlaylist } from './hls-prefetch'

export const MEDIA_PROXY_SCHEME = 'mtmedia'

// 播放列表是纯文本,20MB 已远超正常 —— 超了当损坏/恶意响应拒掉,不整份读进内存。
const PLAYLIST_MAX_BYTES = 20 * 1024 * 1024
const HLS_MIME = 'application/vnd.apple.mpegurl'

/**
 * 把 http(s) 直链包成同源代理 URL。非 http(s) 原样返回。
 *
 * `referer` 防盗链用(B 站 upos/bilivideo 不带 Referer 一律 403),由取到地址的那一方在主进程
 * 钉进 URL —— 渲染层拿不到裸签名链,也就不可能忘了带头。
 */
export function toMediaProxyUrl(url: string, referer?: string): string {
  if (!/^https?:\/\//i.test(url)) return url
  const r = referer ? `&r=${encodeURIComponent(referer)}` : ''
  return `${MEDIA_PROXY_SCHEME}://media/?u=${encodeURIComponent(url)}${r}`
}

function isPlaylistPath(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.m3u8')
  } catch {
    return false
  }
}

function isPlaylistType(contentType: string | null): boolean {
  return (contentType ?? '').toLowerCase().includes('mpegurl')
}

// 把列表里所有地址重写成 mtmedia://:分片、变体列表、#EXT-X-KEY 密钥、#EXT-X-MAP 初始段。
// 相对地址按**重定向后的最终列表地址**解析,用原始 target 解会解错 302 过的列表。
// `segments` 出参按播放顺序收集原始分片地址,交给 hls-prefetch 做滑动窗口预取。
function rewritePlaylist(
  text: string,
  baseUrl: string,
  referer: string | undefined,
  segments: string[],
): string {
  const abs = (u: string, isSegment: boolean): string => {
    try {
      const full = new URL(u, baseUrl).href
      if (isSegment) segments.push(full)
      // 分片/密钥继承列表本身的 Referer,否则重写完第一跳就丢了防盗链头
      return toMediaProxyUrl(full, referer)
    } catch {
      return u
    }
  }
  return text
    .split('\n')
    .map((raw) => {
      const line = raw.trim()
      if (!line) return raw
      // # 开头是标签行:只有 #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA 这类把地址放在
      // URI="..." 属性里,其余标签不含地址,原样保留。
      if (line.startsWith('#')) {
        return raw.replace(/URI="([^"]+)"/i, (_m, u: string) => `URI="${abs(u, false)}"`)
      }
      return abs(line, true)
    })
    .join('\n')
}

export function registerMediaProxy(): void {
  protocol.handle(MEDIA_PROXY_SCHEME, async (request) => {
    const params = new URL(request.url).searchParams
    const target = params.get('u')
    if (!target || !/^https?:\/\//i.test(target)) return new Response(null, { status: 400 })
    // 防盗链 Referer 由生成代理 URL 的一方钉在 `r` 上(见 toMediaProxyUrl)
    const referer = params.get('r')

    // 只带 UA、不带 Cookie;<video> 的 Range 原样转发。
    const headers: Record<string, string> = { 'User-Agent': DESKTOP_USER_AGENT }
    if (referer && /^https?:\/\//i.test(referer)) headers['Referer'] = referer
    const wantsPlaylist = isPlaylistPath(target)
    const range = request.headers.get('Range')
    // 播放列表要整份读出来重写,Range 对它没意义(还会把重写切断);只给分片透传。
    if (range && !wantsPlaylist) headers['Range'] = range

    // mp4:先给本地预抓缓存一次机会(见 media-cache.ts),不命中就走下面直连 —— 缓存
    // 只是加速层,不是必经之路。
    if (!wantsPlaylist) {
      const cached = await tryServeFromCache(target, range, headers)
      // 拖动进度条的中间位置,且已**观测确认**播放器换用了别的流(见 media-cache 的
      // SUPERSEDED_HOLD_MS):直接回错误、一个字节都不取。走直连反而制造出那串请求。
      if (cached === SUPERSEDED_SEEK) return new Response(null, { status: 503 })
      if (cached) return new Response(cached.stream, { status: cached.status, headers: cached.headers })
      // HLS 分片是完整小文件,hls.js 不对它发 Range —— 带 Range 的一律直连不碰缓存。
      if (!range) {
        const seg = await tryServeSegment(target, headers)
        if (seg) {
          // Buffer 视图转成独立 ArrayBuffer 再回 —— Response 不收 Uint8Array 类型
          return new Response(seg.slice().buffer as ArrayBuffer, {
            status: 200,
            headers: {
              'content-type': 'video/mp2t',
              'content-length': String(seg.byteLength),
              'cache-control': 'no-store',
            },
          })
        }
      }
    }

    // protocol.handle 里的 `request.signal` **不会**在渲染进程取消时触发,只能自己用
    // AbortController(在返回流的 cancel() 里 abort)。否则 seek / 切集时被丢弃的那条流
    // 会在后台继续下载,占满源站并发连接,下一个视频直接卡死。
    const ac = new AbortController()
    try {
      const res = await net.fetch(target, { headers, redirect: 'follow', signal: ac.signal })

      // ── HLS 播放列表:整份读出来重写地址后回,不走流式透传 ─────────────────────
      if (wantsPlaylist || isPlaylistType(res.headers.get('content-type'))) {
        const declared = Number(res.headers.get('content-length') ?? 0)
        if (declared > PLAYLIST_MAX_BYTES) {
          ac.abort()
          return new Response(null, { status: 502 })
        }
        const buf = new Uint8Array(await res.arrayBuffer())
        if (buf.byteLength > PLAYLIST_MAX_BYTES) return new Response(null, { status: 502 })
        const text = new TextDecoder().decode(buf)
        // 真列表必以 #EXTM3U 开头。拿到 404 页 / 反爬 HTML 时原样回,别逐行当分片重写。
        if (!text.trimStart().startsWith('#EXTM3U')) {
          return new Response(text, {
            status: res.status,
            headers: {
              'content-type': res.headers.get('content-type') ?? 'text/plain',
              'cache-control': 'no-store',
            },
          })
        }
        const finalUrl = res.url || target
        const segments: string[] = []
        const rewritten = rewritePlaylist(text, finalUrl, referer ?? undefined, segments)
        // 记下分片顺序,后续分片请求就能滑动窗口并发预取(见 hls-prefetch.ts)
        rememberPlaylist(finalUrl, segments)
        return new Response(rewritten, {
          status: res.status,
          // 重写后长度变了,不能透传上游 content-length,交给 Response 自己算。
          headers: { 'content-type': HLS_MIME, 'cache-control': 'no-store' },
        })
      }

      // ── mp4 / HLS 分片:流式透传 ──────────────────────────────────────────────
      const out = new Headers()
      for (const h of ['content-type', 'content-range', 'accept-ranges', 'content-length']) {
        const v = res.headers.get(h)
        if (v) out.set(h, v)
      }
      // content-disposition **不透传** —— 它正是触发 <video> 跨源拦截的元凶。
      // no-store:签名链一次性,否则 Chromium 会照响应里那个 1 年 max-age 缓存上百 MB。
      out.set('cache-control', 'no-store')

      const reader = res.body?.getReader()
      if (!reader) return new Response(null, { status: 502 })
      const stream = new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          try {
            const { done, value } = await reader.read()
            if (done) { ctrl.close(); return }
            ctrl.enqueue(value)
          } catch (e) { ctrl.error(e as Error) }
        },
        cancel() {
          ac.abort()
          reader.cancel().catch(() => { /* 已断开 */ })
        },
      })
      return new Response(stream, { status: res.status, headers: out })
    } catch {
      return new Response(null, { status: 502 })
    }
  })
}
