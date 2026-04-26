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
export const THREAD_COUNT = 8

const DL_HEADERS: Record<string, string> = {
  'User-Agent': DESKTOP_USER_AGENT,
  Accept: '*/*',
}

function headersFor(extra?: Record<string, string>): Record<string, string> {
  return { ...DL_HEADERS, ...(extra ?? {}) }
}

export function partPath(savePath: string, idx: number): string {
  return `${savePath}.part${idx}`
}

export interface ProbeResult {
  size: number
  rangeSupported: boolean
}

/**
 * Resolve redirects, returning the final URL. Some MP4 URLs 302 to a CDN
 * (e.g. moedot.net for xifan); Node's http.get does not follow redirects automatically.
 */
export async function resolveRedirects(url: string, maxHops = 5): Promise<string> {
  let current = url
  for (let i = 0; i < maxHops; i++) {
    const next = await new Promise<string | null>((resolve) => {
      const u = new URL(current)
      const mod = (u.protocol === 'https:' ? https : http) as typeof https
      const req = mod.get(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: headersFor({ Range: 'bytes=0-0' }),
          rejectUnauthorized: false,
        },
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

export async function probe(url: string, logTag: string): Promise<ProbeResult | null> {
  return new Promise((resolve) => {
    const u = new URL(url)
    const mod = (u.protocol === 'https:' ? https : http) as typeof https
    const req = mod.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: headersFor({ Range: 'bytes=0-0' }),
        rejectUnauthorized: false,
      },
      (res) => {
        res.resume() // discard body
        const status = res.statusCode ?? 0
        if (status === 206) {
          const cr = String(res.headers['content-range'] ?? '')
          const m = /\/(\d+)/.exec(cr)
          const size = m ? parseInt(m[1]) : 0
          resolve({ size, rangeSupported: size > 0 })
        } else if (status === 200) {
          const size = parseInt(String(res.headers['content-length'] ?? '0'))
          resolve({ size: isNaN(size) ? 0 : size, rangeSupported: false })
        } else {
          console.warn(`[${logTag}] probe ${url} → HTTP ${status}`)
          resolve(null)
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
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: headersFor({ Range: `bytes=${reqStart}-${end}` }),
          rejectUnauthorized: false,
        },
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
        { hostname: u.hostname, path: u.pathname + u.search, headers: headersFor(extra), rejectUnauthorized: false },
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
  | { ok: false; reason: 'aborted' | 'probe_failed' | 'chunks_failed' | 'merge_failed' | 'stream_failed'; msg?: string }

/**
 * The orchestrator. Caller provides the final URL (already resolved/decrypted) and
 * the destination savePath; we pick multi-thread or single-stream based on probe.
 *
 * `onProgress` is called with (bytesDownloaded, totalBytes, pct). pct is -1 when
 * total size is unknown (single-stream fallback case).
 */
export async function downloadByUrl(
  url: string,
  savePath: string,
  signal: AbortSignal,
  onProgress: (bytes: number, total: number, pct: number) => void,
  logTag: string
): Promise<DownloadOutcome> {
  const finalUrl = await resolveRedirects(url)

  // Already complete? Skip re-probe-and-download.
  if (existsSync(savePath)) {
    const head = await probe(finalUrl, logTag)
    if (head && head.size > 0 && statSync(savePath).size >= head.size) {
      return { ok: true }
    }
  }

  const info = await probe(finalUrl, logTag)
  if (!info || info.size === 0) {
    if (signal.aborted) return { ok: false, reason: 'aborted' }
    return { ok: false, reason: 'probe_failed' }
  }

  // Multi-thread path
  if (info.rangeSupported && info.size > THREAD_COUNT * 64 * 1024) {
    const totalBytes = info.size
    const chunkBase = Math.floor(totalBytes / THREAD_COUNT)
    const ranges: Array<{ start: number; end: number }> = []
    for (let i = 0; i < THREAD_COUNT; i++) {
      const s = i * chunkBase
      const e = i === THREAD_COUNT - 1 ? totalBytes - 1 : (i + 1) * chunkBase - 1
      ranges.push({ start: s, end: e })
    }

    let downloaded = 0
    for (let i = 0; i < THREAD_COUNT; i++) {
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
        await mergeParts(savePath, THREAD_COUNT)
      } catch (err) {
        return { ok: false, reason: 'merge_failed', msg: (err as Error).message }
      }
      onProgress(totalBytes, totalBytes, 100)
      return { ok: true }
    }
    return { ok: false, reason: 'chunks_failed', msg: 'One or more chunks failed after retries' }
  }

  // Single-stream fallback
  const ok = await streamToFile(finalUrl, savePath, info.size, signal, (bytesTotal) => {
    const pct = info.size > 0 ? Math.min(99, Math.floor(bytesTotal * 100 / info.size)) : -1
    onProgress(bytesTotal, info.size, pct)
  }, logTag)

  if (signal.aborted) return { ok: false, reason: 'aborted' }
  if (ok) return { ok: true }
  return { ok: false, reason: 'stream_failed', msg: 'Download failed' }
}
