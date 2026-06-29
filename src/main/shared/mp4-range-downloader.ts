/**
 * NDM-style multi-thread MP4 download with per-part resume.
 *
 * Shared between xifan and aowu (and any future site whose video URLs are direct mp4
 * with Range support). The orchestrator `downloadByUrl` only cares about the final URL
 * + save path; per-source modules handle URL acquisition (template, redirect, encrypted
 * lookup) and the directory naming convention before calling in.
 *
 * Strategy:
 * 1. Probe URL with `GET Range: bytes=0-0`:
 *    - 206 + Content-Range → multi-thread path (8 concurrent chunks)
 *    - 200 → single-stream fallback
 * 2. Multi-thread: each chunk downloads to `{savePath}.partN`; independent retries.
 *    Resume = existing partN size is reused; request `Range: bytes=(start+existing)-end`.
 * 3. On completion of all parts → concat into final mp4 and delete parts.
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
 * 用 URL 构造 http(s).get 的请求参数。**必须带上 u.port**:有的真实直链会 302 到
 * 非标端口(moedot 的视频跳到 bjdownload.pan.wo.cn:30443),漏了 port 会连到默认 443
 * → 下载 0% 失败,而 NDM / 浏览器都正常(它们 follow redirect 时保留端口)。
 * u.port 为 '' 时给 undefined,Node 自动用协议默认端口(443/80)。
 * 见 docs/regression/xifan-下载链接-集数补零-回归用例.md。
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
  /** 探测失败时的 HTTP 状态码,调用方据此区分 404(链接拼错)与限流/5xx。 */
  status?: number
  /** 响应的 Content-Type,用于识别「HTTP 200 但回的是 JSON/HTML 错误体」的假视频。 */
  contentType?: string
}

// 真实视频直链回的是 video/* 或 application/octet-stream;moedot 这类 CDN 在链接拼错时
// 会用 HTTP 200 回一个几 KB 的 JSON 错误体(不是 404),只看状态码会被当成下载成功——
// 用户最后拿到一个点开「无法打开文件或流」的假 mp4。据 Content-Type + 体积识别出来,
// 交给上层回源解析真实直链(见 xifan/download.ts 的 not_media 回退)。
const MIN_MEDIA_BYTES = 100 * 1024 // 正片单集都是几十~几百 MB,远大于此;错误体只有几 KB

function looksLikeErrorBody(info: ProbeResult): boolean {
  const ct = (info.contentType ?? '').toLowerCase()
  if (ct.includes('json') || ct.includes('html') || ct.startsWith('text/')) return true
  // 没给 Content-Type 时:不支持 Range 的纯 200 且体积小到不可能是视频 → 多半是错误体
  if (!info.rangeSupported && info.size > 0 && info.size < MIN_MEDIA_BYTES) return true
  return false
}

/**
 * Resolve redirects, returning the final URL. Some MP4 URLs 302 to a CDN
 * (e.g. moedot.net for xifan); Node's http.get does not follow redirects automatically.
 */
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

/**
 * Download one Range chunk to a part file with retries. Supports resume
 * via existing part file size.
 */
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
            // After abort the file is destroyed but res may still emit a few queued chunks;
            // writing to a destroyed stream throws ERR_STREAM_DESTROYED async via fs cb.
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

/**
 * Concatenate part files into the final save path in order, then delete parts.
 */
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

/**
 * Single-stream fallback (server doesn't support Range). Preserves prior resume-by-size.
 */
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

/**
 * Wipe partN files + the merged file at a given save path. Used when caller wants to
 * force re-download (e.g. switching source).
 */
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
   * Number of parallel Range chunks. Default 8.
   *
   * Set to 1 for CDNs that throttle signed URLs as a whole (typical of ByteDance's
   * imcloud-file-sign / toutiao*.com hosts used by aowu): multiple connections
   * don't add throughput, instead they run into per-URL bandwidth caps that make
   * one chunk crawl while others race ahead — the visible "stuck at 97%" symptom.
   * Single-stream matches what tools like NDM do, and gets reliable completion.
   */
  threadCount?: number
}

/**
 * The orchestrator. Caller provides the final URL (already resolved/decrypted) and
 * the destination savePath; we pick multi-thread or single-stream based on probe
 * and the optional threadCount hint.
 *
 * `onProgress` is called with (bytesDownloaded, totalBytes, pct). pct is -1 when
 * total size is unknown (single-stream fallback case).
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

  // 探测到的是错误体(假 mp4:200 回 JSON/HTML 或超小体积)→ 当作「链接拼错」上抛,
  // 由站点层回源解析真实直链。绝不能当成功写盘,否则用户拿到几 KB 的假 mp4 还显示"完成"。
  // 放在「已完成跳过」之前:磁盘上若残留旧的假 mp4,也要重新回源拉正确的。
  if (looksLikeErrorBody(info)) {
    return { ok: false, reason: 'not_media' }
  }

  // Already complete? Skip download.(上面已 probe 过,直接复用 info,省一次请求)
  if (existsSync(savePath) && statSync(savePath).size >= info.size) {
    return { ok: true }
  }

  // Multi-thread path
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

  // Single-stream path. If the caller went single-thread but had stale .partN
  // files lying around from a previous multi-thread attempt, clear them so we
  // don't leak orphaned files. The savePath itself we leave alone — streamToFile
  // resumes from its existing size via Range.
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
