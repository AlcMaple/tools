// 在线播放媒体流代理 —— 把远端 mp4 直链 / HLS 播放列表在主进程用 Electron net 取回,
// 再以**同源**自定义协议 mtmedia:// 回给渲染进程的 <video> / hls.js。
//
// 为什么需要它(011 在线观看实测结论,见 DEVLOG):
//   1. mp4:渲染进程的 <video> 直连远端 mp4 时,能不能播**取决于页面 origin**。dev 下
//      origin 是 http://localhost:5173,Chromium 会拒绝播放带 `content-disposition:
//      attachment` 的**跨源**媒体(稀饭主线的 pan.wo.cn 联通网盘签名直链正是这种)→
//      <video> 直接报 code 4;打包后 origin 是 file:// 不拦,所以只在 dev 挂。
//   2. HLS(Girigiri):hls.js 是在**渲染进程里**逐条去取变体列表 / 分片 / AES 密钥的,
//      直连 CDN 会被跨源策略拦(那些 CDN 不带 CORS 头)。
// 根治办法一致:媒体统一经主进程取流、剥掉 content-disposition,用同源协议回给渲染
// 进程,dev/正式都不受 origin 限制。播放列表额外把里面的地址重写成 mtmedia://
// (见 rewritePlaylist),否则 hls.js 拿到的仍是原始跨源地址。
//
// 为什么用 net.fetch 而不是 netRequest():netRequest 把整个 body Buffer.concat
// 缓冲,视频几百 MB 会爆内存。这里要边下边播的**流**,net.fetch(同样走 Chromium
// 网络栈 + 系统代理,与红线一致)返回可读流直接透传。redirect 默认 follow
// (apn.moedot.net→pan.wo.cn 的签名跳转靠它跟)。
//
// 注:不缓存最终签名直链、每个 Range 都重走一遍 302 是**故意的**——pan.wo.cn
// 对单条签名链有并发限制,复用一条链去打多个并发 Range 反而会被卡死(实测 rs=0);
// 每个 Range 各拿一条新鲜签名链才稳。302 那点开销远小于卡死的代价。
import { protocol, net } from 'electron'
import { DESKTOP_USER_AGENT } from './download-types'

export const MEDIA_PROXY_SCHEME = 'mtmedia'

// 播放列表是纯文本(KB~几 MB)。20MB 已远超正常,超了视作损坏/恶意响应直接拒,
// 不整份读进内存(与 girigiri/download.ts 的 M3U8_MAX_BYTES 同口径)。
const PLAYLIST_MAX_BYTES = 20 * 1024 * 1024
const HLS_MIME = 'application/vnd.apple.mpegurl'

/**
 * 把 http(s) 直链包成同源代理 URL 喂给 <video> / hls.js / shaka。非 http(s) 原样返回。
 *
 * `referer`:有些站的 CDN 校验防盗链(B 站 upos/bilivideo 不带 Referer 一律 403,实测),
 * 由**取到地址的那一方**在主进程就把该带的 Referer 钉进代理 URL —— 渲染层因此永远
 * 拿不到裸签名链,也就不可能忘了带头。稀饭/Girigiri 不需要,省略即可。
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

// 把播放列表里的所有地址重写成 mtmedia:// 绝对地址:分片、master 列表指向的变体
// 列表、#EXT-X-KEY 的 AES 密钥、#EXT-X-MAP 的 fMP4 初始化段。不重写的话 hls.js
// 会拿着原始 CDN 地址在渲染进程里直取,被跨源策略拦。
// 相对地址按**重定向后的最终列表地址**解析 —— 用原始 target 解会解错 302 过的列表。
function rewritePlaylist(text: string, baseUrl: string, referer?: string): string {
  const abs = (u: string): string => {
    try {
      // 分片/密钥继承列表本身的 Referer,否则重写完第一跳就丢了防盗链头
      return toMediaProxyUrl(new URL(u, baseUrl).href, referer)
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
      if (line.startsWith('#')) return raw.replace(/URI="([^"]+)"/i, (_m, u: string) => `URI="${abs(u)}"`)
      return abs(line)
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

    // 默认只带 UA(与下载器一致,不带 Cookie);<video> 的 Range 原样转发,
    // moov 在文件尾部的非 faststart mp4 靠它取索引。
    const headers: Record<string, string> = { 'User-Agent': DESKTOP_USER_AGENT }
    if (referer && /^https?:\/\//i.test(referer)) headers['Referer'] = referer
    const wantsPlaylist = isPlaylistPath(target)
    const range = request.headers.get('Range')
    // 播放列表要整份读出来重写,Range 对它没意义(还会把重写切断);只给分片透传。
    if (range && !wantsPlaylist) headers['Range'] = range

    // Electron 的 protocol.handle 里 request.signal **不会**在渲染进程取消时触发
    // (实测),所以自己用 AbortController:返回流的 cancel() 里 abort 上游 net.fetch。
    // 否则 seek / 切集 / 销毁 <video> 时被丢弃的直链会在后台继续下载,抢带宽 +
    // 占满 pan.wo.cn 的并发连接,导致下一个视频卡住不动(实测切集必现)。
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
        // 真播放列表必以 #EXTM3U 开头。取到 404 页 / 反爬 HTML 时原样回,别把 HTML
        // 逐行当分片地址重写(与 girigiri/download.ts parseM3u8 同一道闸)。
        if (!text.trimStart().startsWith('#EXTM3U')) {
          return new Response(text, {
            status: res.status,
            headers: {
              'content-type': res.headers.get('content-type') ?? 'text/plain',
              'cache-control': 'no-store',
            },
          })
        }
        return new Response(rewritePlaylist(text, res.url || target, referer ?? undefined), {
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
      // content-disposition 故意**不透传** —— 它正是触发 <video> 跨源拦截的元凶。
      // no-store:签名直链一次性,别让 Chromium 按响应里那个离谱的 1 年 max-age
      // 把它缓存进磁盘(实测能撑到上百 MB 死缓存)。
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
