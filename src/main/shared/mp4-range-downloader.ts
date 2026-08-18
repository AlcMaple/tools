/**
 * 多线程 MP4 下载,分片各自断点续传。xifan / aowu 共用(以及任何直链 mp4 且支持 Range 的站)。
 * 本模块只关心「最终 URL + 保存路径」,拿地址、目录命名由各站模块负责。
 *
 * 流程:
 *   1. `GET Range: bytes=0-0` 探一次 —— 回 206 走多线程,回 200 走单流。
 *   2. 多线程:每片下到 `{savePath}.partN`,各自独立重试;续传就是复用已存在的 partN 大小
 *      请求 `Range: bytes=(start+已有)-end`。
 *   3. 全部分片完成后拼成最终 mp4 并删掉分片。
 */
import * as https from 'https'
import * as http from 'http'
import { createWriteStream, createReadStream, existsSync, statSync, unlinkSync } from 'fs'
import { URL } from 'url'
import { DESKTOP_USER_AGENT } from './download-types'

const MAX_RETRIES = 5
const THREAD_COUNT = 8

const DL_HEADERS: Record<string, string> = {
  'User-Agent': DESKTOP_USER_AGENT,
  Accept: '*/*',
}

function headersFor(extra?: Record<string, string>): Record<string, string> {
  return { ...DL_HEADERS, ...(extra ?? {}) }
}

/**
 * 构造请求参数时**必须带上 u.port**:有的直链会 302 到非标端口(如 :30443),漏了 port 会连到
 * 默认 443 → 下载 0% 失败,而浏览器和下载工具都正常(它们 follow redirect 时保留端口)。
 * port 为空串时给 undefined,让 Node 用协议默认端口。
 */
function reqOptions(u: URL, extraHeaders?: Record<string, string>): https.RequestOptions {
  return {
    hostname: u.hostname,
    port: u.port || undefined,
    path: u.pathname + u.search,
    headers: headersFor(extraHeaders),
    rejectUnauthorized: false,
  }
}

function partPath(savePath: string, idx: number): string {
  return `${savePath}.part${idx}`
}

interface ProbeResult {
  size: number
  rangeSupported: boolean
  /** 探测失败时的 HTTP 状态码,调用方据此区分 404(链接拼错)和限流/5xx。 */
  status?: number
  /** 响应的 Content-Type,用来识别「HTTP 200 但回的是 JSON/HTML 错误体」这种假视频。 */
  contentType?: string
}

// 真视频直链回 video/* 或 application/octet-stream。有的 CDN 在链接拼错时会用 **HTTP 200**
// 回一个几 KB 的 JSON 错误体(不是 404),只看状态码会当成下载成功 —— 用户最后拿到一个点开
// 提示「无法打开文件或流」的假 mp4。所以要靠 Content-Type + 体积识别,交给上层回源重解析。
const MIN_MEDIA_BYTES = 100 * 1024 // 正片单集都是几十~几百 MB,远大于此;错误体只有几 KB

function looksLikeErrorBody(info: ProbeResult): boolean {
  const ct = (info.contentType ?? '').toLowerCase()
  if (ct.includes('json') || ct.includes('html') || ct.startsWith('text/')) return true
  // 没给 Content-Type 时:不支持 Range 的纯 200 且体积小到不可能是视频 → 多半是错误体
  if (!info.rangeSupported && info.size > 0 && info.size < MIN_MEDIA_BYTES) return true
  return false
}

/** 跟完重定向返回最终 URL —— 有些 mp4 会 302 到 CDN,而 Node 的 http.get 不自动跟随。 */
async function resolveRedirects(url: string, maxHops = 5): Promise<string> {
  let current = url
  for (let i = 0; i < maxHops; i++) {
    const next = await new Promise<string | null>((resolve) => {
      const u = new URL(current)
      const mod = (u.protocol === 'https:' ? https : http) as typeof https
      const req = mod.get(
        reqOptions(u, { Range: 'bytes=0-0' }),
        (res) => {
          res.resume()
          const status = res.statusCode ?? 0
          if (status >= 300 && status < 400 && res.headers.location) {
            resolve(new URL(String(res.headers.location), current).href)
          } else {
            resolve(null)
          }
        }
      )
      req.setTimeout(10000, () => { req.destroy(); resolve(null) })
      req.on('error', () => resolve(null))
    })
    if (!next) return current
    current = next
  }
  return current
}

async function probe(url: string, logTag: string): Promise<ProbeResult | null> {
  return new Promise((resolve) => {
    const u = new URL(url)
    const mod = (u.protocol === 'https:' ? https : http) as typeof https
    const req = mod.get(
      reqOptions(u, { Range: 'bytes=0-0' }),
      (res) => {
        res.resume() // discard body
        const status = res.statusCode ?? 0
        const contentType = String(res.headers['content-type'] ?? '')
        if (status === 206) {
          const cr = String(res.headers['content-range'] ?? '')
          const m = /\/(\d+)/.exec(cr)
          const size = m ? parseInt(m[1]) : 0
          resolve({ size, rangeSupported: size > 0, contentType })
        } else if (status === 200) {
          const size = parseInt(String(res.headers['content-length'] ?? '0'))
          resolve({ size: isNaN(size) ? 0 : size, rangeSupported: false, contentType })
        } else {
          console.warn(`[${logTag}] probe ${url} → HTTP ${status}`)
          resolve({ size: 0, rangeSupported: false, status })
        }
      }
    )
    req.setTimeout(15000, () => { req.destroy(); resolve(null) })
    req.on('error', (err) => { console.warn(`[${logTag}] probe error: ${err.message}`); resolve(null) })
  })
}

/** 下载一个 Range 分片到 part 文件,带重试;按已存在的 part 大小续传。 */
async function downloadChunk(
  url: string,
  partFile: string,
  start: number,
  end: number, // inclusive
  signal: AbortSignal,
  onDelta: (delta: number) => void,
  logTag: string
): Promise<boolean> {
  const chunkSize = end - start + 1

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (signal.aborted) return false

    const existing = existsSync(partFile) ? statSync(partFile).size : 0
    if (existing >= chunkSize) return true
    if (existing > chunkSize) {
      try { unlinkSync(partFile) } catch { /* ignore */ }
    }

    const reqStart = start + existing
    const u = new URL(url)
    const mod = (u.protocol === 'https:' ? https : http) as typeof https

    const ok = await new Promise<boolean>((resolve) => {
      const req = mod.get(
        reqOptions(u, { Range: `bytes=${reqStart}-${end}` }),
        (res) => {
          if (res.statusCode !== 206 && res.statusCode !== 200) {
            console.warn(`[${logTag}] chunk ${reqStart}-${end} → HTTP ${res.statusCode}`)
            res.resume(); resolve(false); return
          }
          const file = createWriteStream(partFile, { flags: existing > 0 ? 'a' : 'w' })
          const onAbort = (): void => { req.destroy(); file.destroy(); resolve(false) }
          signal.addEventListener('abort', onAbort, { once: true })

          res.on('data', (chunk: Buffer) => {
            // abort 之后文件已销毁,但响应流可能还会吐出几个排队的块;往已销毁的流里写会在 fs 回调里
            // 异步抛 ERR_STREAM_DESTROYED。
            if (!file.writable) return
            file.write(chunk)
            onDelta(chunk.length)
          })
          res.on('end', () => {
            signal.removeEventListener('abort', onAbort)
            file.end(() => resolve(true))
          })
          res.on('error', (err) => {
            console.warn(`[${logTag}] chunk stream error: ${err.message}`)
            signal.removeEventListener('abort', onAbort)
            file.destroy()
            resolve(false)
          })
        }
      )
      req.setTimeout(60000, () => { req.destroy(); resolve(false) })
      req.on('error', (err) => { console.warn(`[${logTag}] chunk req error: ${err.message}`); resolve(false) })
    })

    if (signal.aborted) return false
    if (ok) {
      const size = existsSync(partFile) ? statSync(partFile).size : 0
      if (size >= chunkSize) return true
    }

    if (attempt < MAX_RETRIES) {
      const backoff = Math.min(8000, 500 * 2 ** (attempt - 1))
      await new Promise((r) => setTimeout(r, backoff))
    }
  }

  return false
}

/** 按顺序把分片拼成最终文件,然后删掉分片。 */
async function mergeParts(savePath: string, count: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(savePath, { flags: 'w' })
    let i = 0
    const next = (): void => {
      if (i >= count) { out.end(resolve); return }
      const rs = createReadStream(partPath(savePath, i))
      rs.on('error', reject)
      rs.on('end', () => { i++; next() })
      rs.pipe(out, { end: false })
    }
    out.on('error', reject)
    next()
  })
  for (let i = 0; i < count; i++) {
    try { unlinkSync(partPath(savePath, i)) } catch { /* ignore */ }
  }
}

/** 单流回退(服务端不支持 Range),保留按文件大小续传的能力。 */
async function streamToFile(
  url: string,
  savePath: string,
  fileSize: number,
  signal: AbortSignal,
  onBytes: (total: number) => void,
  logTag: string
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (signal.aborted) return false
    const existing = existsSync(savePath) ? statSync(savePath).size : 0
    if (fileSize > 0 && existing >= fileSize) return true

    const extra: Record<string, string> = {}
    if (existing > 0 && fileSize > 0) extra['Range'] = `bytes=${existing}-`
    const u = new URL(url)
    const mod = (u.protocol === 'https:' ? https : http) as typeof https

    const ok = await new Promise<boolean>((resolve) => {
      const req = mod.get(
        reqOptions(u, extra),
        (res) => {
          if (res.statusCode !== 200 && res.statusCode !== 206) {
            console.warn(`[${logTag}] stream ${url} → HTTP ${res.statusCode}`)
            res.resume(); resolve(false); return
          }
          const file = createWriteStream(savePath, { flags: existing > 0 && fileSize > 0 ? 'a' : 'w' })
          let written = existing
          const onAbort = (): void => { req.destroy(); file.destroy(); resolve(false) }
          signal.addEventListener('abort', onAbort, { once: true })
          res.on('data', (chunk: Buffer) => {
            if (!file.writable) return
            file.write(chunk)
            written += chunk.length
            onBytes(written)
          })
          res.on('end', () => {
            signal.removeEventListener('abort', onAbort)
            file.end(() => resolve(true))
          })
          res.on('error', () => {
            signal.removeEventListener('abort', onAbort)
            file.destroy()
            resolve(false)
          })
        }
      )
      req.setTimeout(60000, () => { req.destroy(); resolve(false) })
      req.on('error', (err) => { console.warn(`[${logTag}] stream req error: ${err.message}`); resolve(false) })
    })

    if (ok) break
    if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, 2000))
  }

  if (!existsSync(savePath)) return false
  const written = statSync(savePath).size
  return fileSize > 0 ? written >= fileSize : written > 0
}

/** 清掉某个保存路径下的 partN 和已合并的文件,用于强制重新下载(如换源)。 */
export function cleanupPartsAt(savePath: string): void {
  for (let i = 0; i < 32; i++) {
    const p = partPath(savePath, i)
    if (existsSync(p)) {
      try { unlinkSync(p) } catch { /* ignore */ }
    } else if (i >= THREAD_COUNT) {
      break
    }
  }
  if (existsSync(savePath)) {
    try { unlinkSync(savePath) } catch { /* ignore */ }
  }
}

export type DownloadOutcome =
  | { ok: true }
  | { ok: false; reason: 'aborted' | 'probe_failed' | 'not_media' | 'chunks_failed' | 'merge_failed' | 'stream_failed'; msg?: string; status?: number }

export interface DownloadOpts {
  /**
   * 并发 Range 分片数,默认 8。
   *
   * **对整条签名 URL 限速的 CDN 要设成 1**:多连接不会带来更高吞吐,反而会撞上「每 URL 带宽上限」
   * 结果一个分片爬行、其他分片飞快 —— 表现就是进度卡在 97% 不动。单流反而能稳定跑完。
   */
  threadCount?: number
}

/**
 * 总入口。调用方给最终 URL(已解析/解密)和保存路径,这里按探测结果和 threadCount 决定走
 * 多线程还是单流。`onProgress(已下字节, 总字节, 百分比)`,总大小未知时百分比为 -1。
 */
export async function downloadByUrl(
  url: string,
  savePath: string,
  signal: AbortSignal,
  onProgress: (bytes: number, total: number, pct: number) => void,
  logTag: string,
  opts: DownloadOpts = {}
): Promise<DownloadOutcome> {
  const threadCount = Math.max(1, Math.min(opts.threadCount ?? THREAD_COUNT, THREAD_COUNT))
  const finalUrl = await resolveRedirects(url)

  const info = await probe(finalUrl, logTag)
  if (!info || info.size === 0) {
    if (signal.aborted) return { ok: false, reason: 'aborted' }
    return { ok: false, reason: 'probe_failed', status: info?.status }
  }

  // 探到错误体(判据见 looksLikeErrorBody)→ 当「链接拼错」上抛,由站点层回源重解析。
  // 必须放在「已完成跳过」之前:磁盘上若残留旧的假 mp4,也要重新回源拉正确的。
  if (looksLikeErrorBody(info)) {
    return { ok: false, reason: 'not_media' }
  }

  // Already complete? Skip download.(上面已 probe 过,直接复用 info,省一次请求)
  if (existsSync(savePath) && statSync(savePath).size >= info.size) {
    return { ok: true }
  }

  // 多线程路径
  if (info.rangeSupported && threadCount > 1 && info.size > threadCount * 64 * 1024) {
    const totalBytes = info.size
    const chunkBase = Math.floor(totalBytes / threadCount)
    const ranges: Array<{ start: number; end: number }> = []
    for (let i = 0; i < threadCount; i++) {
      const s = i * chunkBase
      const e = i === threadCount - 1 ? totalBytes - 1 : (i + 1) * chunkBase - 1
      ranges.push({ start: s, end: e })
    }

    let downloaded = 0
    for (let i = 0; i < threadCount; i++) {
      const p = partPath(savePath, i)
      if (existsSync(p)) downloaded += statSync(p).size
    }

    const reportProgress = (): void => {
      const pct = Math.min(99, Math.floor(downloaded * 100 / totalBytes))
      onProgress(downloaded, totalBytes, pct)
    }
    reportProgress()

    const results = await Promise.all(
      ranges.map((r, i) =>
        downloadChunk(finalUrl, partPath(savePath, i), r.start, r.end, signal, (delta) => {
          downloaded += delta
          reportProgress()
        }, logTag)
      )
    )

    if (signal.aborted) return { ok: false, reason: 'aborted' }

    if (results.every((ok) => ok)) {
      try {
        await mergeParts(savePath, threadCount)
      } catch (err) {
        return { ok: false, reason: 'merge_failed', msg: (err as Error).message }
      }
      onProgress(totalBytes, totalBytes, 100)
      return { ok: true }
    }
    return { ok: false, reason: 'chunks_failed', msg: 'One or more chunks failed after retries' }
  }

  // 单流路径。若调用方选了单线程、但磁盘上还残留着上次多线程尝试的 .partN,顺手清掉
  // 免得留下孤儿文件。savePath 本身不动 —— 单流会按它已有的大小续传。
  if (threadCount === 1) {
    for (let i = 0; i < THREAD_COUNT; i++) {
      const p = partPath(savePath, i)
      if (existsSync(p)) {
        try { unlinkSync(p) } catch { /* ignore */ }
      }
    }
  }

  const ok = await streamToFile(finalUrl, savePath, info.size, signal, (bytesTotal) => {
    const pct = info.size > 0 ? Math.min(99, Math.floor(bytesTotal * 100 / info.size)) : -1
    onProgress(bytesTotal, info.size, pct)
  }, logTag)

  if (signal.aborted) return { ok: false, reason: 'aborted' }
  if (ok) return { ok: true }
  return { ok: false, reason: 'stream_failed', msg: 'Download failed' }
}
