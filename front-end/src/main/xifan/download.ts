/**
 * Xifan MP4 download — streaming with Range resume + multi-source fallback.
 * Replaces xifan_crawler.py download_single_ep().
 */
import * as https from 'https'
import * as http from 'http'
import { createWriteStream, existsSync, statSync, mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { URL } from 'url'
import { app } from 'electron'

const MAX_RETRIES = 5

const DL_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Encoding': 'identity',
  Connection: 'keep-alive',
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

async function getFileSize(url: string): Promise<number> {
  return new Promise((resolve) => {
    const u = new URL(url)
    const mod = (u.protocol === 'https:' ? https : http) as typeof https
    const req = mod.request(
      { method: 'HEAD', hostname: u.hostname, path: u.pathname + u.search, headers: DL_HEADERS, rejectUnauthorized: false },
      (res) => {
        res.resume()
        const size = parseInt(res.headers['content-length'] ?? '0')
        resolve(isNaN(size) ? 0 : size)
      }
    )
    req.setTimeout(15000, () => { req.destroy(); resolve(0) })
    req.on('error', () => resolve(0))
    req.end()
  })
}

async function streamToFile(
  url: string,
  savePath: string,
  fileSize: number, // 0 = unknown
  signal: AbortSignal,
  onBytes: (total: number) => void
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (signal.aborted) return false

    const existing = existsSync(savePath) ? statSync(savePath).size : 0
    if (fileSize > 0 && existing >= fileSize) return true

    const headers: Record<string, string> = { ...DL_HEADERS }
    if (existing > 0 && fileSize > 0) headers['Range'] = `bytes=${existing}-`
    const u = new URL(url)
    const mod = (u.protocol === 'https:' ? https : http) as typeof https

    const ok = await new Promise<boolean>((resolve) => {
      const req = mod.get(
        { hostname: u.hostname, path: u.pathname + u.search, headers, rejectUnauthorized: false },
        (res) => {
          if (res.statusCode !== 200 && res.statusCode !== 206) {
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
            file.close(() => resolve(true))
          })
          res.on('error', () => {
            signal.removeEventListener('abort', onAbort)
            file.close()
            resolve(false)
          })
        }
      )
      req.setTimeout(60000, () => { req.destroy(); resolve(false) })
      req.on('error', () => resolve(false))
    })

    if (ok) break
    if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, 2000))
  }

  if (!existsSync(savePath)) return false
  const written = statSync(savePath).size
  return fileSize > 0 ? written >= fileSize : written > 0
}

export async function downloadSingleEp(
  title: string,
  ep: number,
  templates: string[],
  saveDir: string | undefined,
  signal: AbortSignal,
  onEvent: (ev: DlEvent) => void
): Promise<void> {
  onEvent({ type: 'ep_start', ep })

  const epStr = String(ep).padStart(2, '0')
  const base = saveDir ?? app.getPath('downloads')
  const dir = join(base, safeName(title))
  mkdirSync(dir, { recursive: true })
  const savePath = join(dir, `${safeName(title)} - ${epStr}.mp4`)

  // Skip if already complete (size check happens below per source)
  for (const template of templates) {
    if (!template || signal.aborted) break

    const url = template.replace('{:02d}', epStr)

    const fileSize = await getFileSize(url) // 0 = unknown (HEAD not supported)

    // Already complete?
    if (fileSize > 0 && existsSync(savePath) && statSync(savePath).size >= fileSize) {
      onEvent({ type: 'ep_done', ep })
      return
    }

    const ok = await streamToFile(url, savePath, fileSize, signal, (bytesTotal) => {
      const pct = fileSize > 0 ? Math.min(99, Math.floor(bytesTotal * 100 / fileSize)) : -1
      onEvent({ type: 'ep_progress', ep, pct, bytes: bytesTotal })
    })

    if (signal.aborted) return

    if (ok) {
      onEvent({ type: 'ep_done', ep })
      return
    }

    // Clean up failed partial file before trying next source
    try { if (existsSync(savePath)) unlinkSync(savePath) } catch { /* ignore */ }
  }

  if (!signal.aborted) {
    onEvent({ type: 'ep_error', ep, msg: 'All sources failed' })
  }
}
