/**
 * Xifan MP4 download — NDM-style multi-thread Range download with per-part resume.
 *
 * Strategy:
 * 1. Probe URL with `GET Range: bytes=0-0`:
 *    - 206 + Content-Range → multi-thread path (8 concurrent chunks)
 *    - 200 → single-stream fallback
 * 2. Multi-thread: each chunk downloads to `{final}.partN`; independent retries.
 *    Resume = existing partN size is reused; request `Range: bytes=(start+existing)-end`.
 * 3. On completion of all parts → concat into final mp4 and delete parts.
 * 4. Single source only — `templates[sourceIdx]`. No auto-fallback. Caller decides.
 */
import * as https from 'https'
import * as http from 'http'
import { createWriteStream, createReadStream, existsSync, statSync, mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { URL } from 'url'
import { app } from 'electron'

const MAX_RETRIES = 5
const THREAD_COUNT = 8

const DL_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: '*/*',
}

function headersFor(_url: string, extra?: Record<string, string>): Record<string, string> {
  return { ...DL_HEADERS, ...(extra ?? {}) }
}

export interface DlEvent {
  type: 'ep_start' | 'ep_progress' | 'ep_done' | 'ep_error'
  ep?: number
  pct?: number
  bytes?: number
  msg?: string
}

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_')
}

function partPath(savePath: string, idx: number): string {
  return `${savePath}.part${idx}`
}

interface ProbeResult {
  size: number
  rangeSupported: boolean
}

/**
 * Resolve redirects, returning the final URL. Xifan MP4 URLs frequently 302 to a CDN
 * (e.g. moedot.net); Node's http.get does not follow redirects automatically.
 */
async function resolveRedirects(url: string, maxHops = 5): Promise<string> {
  let current = url
  for (let i = 0; i < maxHops; i++) {
    const next = await new Promise<string | null>((resolve) => {
      const u = new URL(current)
      const mod = (u.protocol === 'https:' ? https : http) as typeof https
      const req = mod.get(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: headersFor(current, { Range: 'bytes=0-0' }),
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

async function probe(url: string): Promise<ProbeResult | null> {
  return new Promise((resolve) => {
    const u = new URL(url)
    const mod = (u.protocol === 'https:' ? https : http) as typeof https
    const req = mod.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: headersFor(url, { Range: 'bytes=0-0' }),
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
          console.warn(`[xifan] probe ${url} → HTTP ${status}`)
          resolve(null)
        }
      }
    )
    req.setTimeout(15000, () => { req.destroy(); resolve(null) })
    req.on('error', (err) => { console.warn(`[xifan] probe error: ${err.message}`); resolve(null) })
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
  onDelta: (delta: number) => void
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
          headers: headersFor(url, { Range: `bytes=${reqStart}-${end}` }),
          rejectUnauthorized: false,
        },
        (res) => {
          if (res.statusCode !== 206 && res.statusCode !== 200) {
            console.warn(`[xifan] chunk ${reqStart}-${end} → HTTP ${res.statusCode}`)
            res.resume(); resolve(false); return
          }
          const file = createWriteStream(partFile, { flags: existing > 0 ? 'a' : 'w' })
          const onAbort = (): void => { req.destroy(); file.destroy(); resolve(false) }
          signal.addEventListener('abort', onAbort, { once: true })

          res.on('data', (chunk: Buffer) => {
            file.write(chunk)
            onDelta(chunk.length)
          })
          res.on('end', () => {
            signal.removeEventListener('abort', onAbort)
            file.end(() => resolve(true))
          })
          res.on('error', (err) => {
            console.warn(`[xifan] chunk stream error: ${err.message}`)
            signal.removeEventListener('abort', onAbort)
            file.destroy()
            resolve(false)
          })
        }
      )
      req.setTimeout(60000, () => { req.destroy(); resolve(false) })
      req.on('error', (err) => { console.warn(`[xifan] chunk req error: ${err.message}`); resolve(false) })
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
  onBytes: (total: number) => void
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
        { hostname: u.hostname, path: u.pathname + u.search, headers: headersFor(url, extra), rejectUnauthorized: false },
        (res) => {
          if (res.statusCode !== 200 && res.statusCode !== 206) {
            console.warn(`[xifan] stream ${url} → HTTP ${res.statusCode}`)
            res.resume(); resolve(false); return
          }
          const file = createWriteStream(savePath, { flags: existing > 0 && fileSize > 0 ? 'a' : 'w' })
          let written = existing
          const onAbort = (): void => { req.destroy(); file.destroy(); resolve(false) }
          signal.addEventListener('abort', onAbort, { once: true })
          res.on('data', (chunk: Buffer) => {
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
      req.on('error', (err) => { console.warn(`[xifan] stream req error: ${err.message}`); resolve(false) })
    })

    if (ok) break
    if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, 2000))
  }

  if (!existsSync(savePath)) return false
  const written = statSync(savePath).size
  return fileSize > 0 ? written >= fileSize : written > 0
}

/**
 * Delete all part files for a given saved episode path. Used when caller switches source.
 */
export function cleanupParts(title: string, ep: number, saveDir: string | undefined): void {
  const epStr = String(ep).padStart(2, '0')
  const base = saveDir ?? app.getPath('downloads')
  const dir = join(base, safeName(title))
  const savePath = join(dir, `${safeName(title)} - ${epStr}.mp4`)
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

export async function downloadSingleEp(
  title: string,
  ep: number,
  templates: string[],
  sourceIdx: number,
  saveDir: string | undefined,
  signal: AbortSignal,
  onEvent: (ev: DlEvent) => void
): Promise<void> {
  onEvent({ type: 'ep_start', ep })

  const template = templates[sourceIdx]
  if (!template) {
    onEvent({ type: 'ep_error', ep, msg: `No source at index ${sourceIdx}` })
    return
  }

  const epStr = String(ep).padStart(2, '0')
  const base = saveDir ?? app.getPath('downloads')
  const dir = join(base, safeName(title))
  mkdirSync(dir, { recursive: true })
  const savePath = join(dir, `${safeName(title)} - ${epStr}.mp4`)
  const rawUrl = template.replace('{:02d}', epStr)
  const url = await resolveRedirects(rawUrl)

  // Already complete?
  if (existsSync(savePath)) {
    const head = await probe(url)
    if (head && head.size > 0 && statSync(savePath).size >= head.size) {
      onEvent({ type: 'ep_done', ep })
      return
    }
  }

  const info = await probe(url)
  if (!info || info.size === 0) {
    if (!signal.aborted) onEvent({ type: 'ep_error', ep, msg: 'Probe failed' })
    return
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
      onEvent({ type: 'ep_progress', ep, pct, bytes: downloaded })
    }
    reportProgress()

    const results = await Promise.all(
      ranges.map((r, i) =>
        downloadChunk(url, partPath(savePath, i), r.start, r.end, signal, (delta) => {
          downloaded += delta
          reportProgress()
        })
      )
    )

    if (signal.aborted) return

    if (results.every((ok) => ok)) {
      try {
        await mergeParts(savePath, THREAD_COUNT)
      } catch (err) {
        onEvent({ type: 'ep_error', ep, msg: `Merge failed: ${(err as Error).message}` })
        return
      }
      onEvent({ type: 'ep_progress', ep, pct: 100, bytes: totalBytes })
      onEvent({ type: 'ep_done', ep })
      return
    }

    onEvent({ type: 'ep_error', ep, msg: 'One or more chunks failed after retries' })
    return
  }

  // Single-stream fallback
  const ok = await streamToFile(url, savePath, info.size, signal, (bytesTotal) => {
    const pct = info.size > 0 ? Math.min(99, Math.floor(bytesTotal * 100 / info.size)) : -1
    onEvent({ type: 'ep_progress', ep, pct, bytes: bytesTotal })
  })

  if (signal.aborted) return
  if (ok) {
    onEvent({ type: 'ep_done', ep })
    return
  }
  onEvent({ type: 'ep_error', ep, msg: 'Download failed' })
}
