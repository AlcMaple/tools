/**
 * Girigiri HLS/m3u8 download.
 * Replaces girigiri_api.py cmd_download_single().
 *
 * m3u8 capture: uses a hidden Electron BrowserWindow + webRequest interception
 * instead of Playwright (no extra dependency, uses the bundled Chromium).
 */
import * as https from 'https'
import * as http from 'http'
import { mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { URL } from 'url'
import { createDecipheriv } from 'crypto'
import { spawn } from 'child_process'
import { BrowserWindow, session as electronSession } from 'electron'
import { app } from 'electron'

// eslint-disable-next-line @typescript-eslint/no-require-imports
let ffmpegPath: string | null = require('ffmpeg-static')
// 打包后二进制在 app.asar.unpacked/ 外，需修正路径
if (ffmpegPath && app.isPackaged) {
  ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked')
}

export interface DlEvent {
  type: 'ep_start' | 'ep_progress' | 'ep_done' | 'ep_error'
  ep?: number
  pct?: number
  bytes?: number
  msg?: string
}

const GIRI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: '*/*',
}

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_')
}

// ── m3u8 capture via hidden BrowserWindow ─────────────────────────────────────

async function captureM3u8(epUrl: string, cookieString: string): Promise<string | null> {
  return new Promise((resolve) => {
    const partition = `girigiri-capture-${Date.now()}`
    const ses = electronSession.fromPartition(partition, { cache: false })

    // Inject cookies so the site recognises the session
    const cookiePairs = cookieString.split(';').map((p) => p.trim()).filter(Boolean)
    const cookiePromises = cookiePairs.map((pair) => {
      const eq = pair.indexOf('=')
      if (eq <= 0) return Promise.resolve()
      return ses.cookies.set({
        url: 'https://bgm.girigirilove.com',
        name: pair.slice(0, eq).trim(),
        value: pair.slice(eq + 1).trim(),
      }).catch(() => undefined)
    })

    Promise.all(cookiePromises).then(() => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true },
      })

      let resolved = false
      const done = (url: string | null): void => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        if (!win.isDestroyed()) win.close()
        resolve(url)
      }

      const timer = setTimeout(() => done(null), 30000)

      // Intercept network requests to find m3u8
      ses.webRequest.onBeforeRequest((details, callback) => {
        const url = details.url
        if (
          !resolved &&
          url.includes('.m3u8') &&
          (url.includes('girigirilove') || url.includes('ai.girigirilove.net'))
        ) {
          done(url)
          callback({ cancel: false })
          return
        }
        callback({})
      })

      win.loadURL(epUrl).catch(() => done(null))
      win.on('closed', () => done(null))
    })
  })
}

// ── HTTP fetch helper ─────────────────────────────────────────────────────────

async function fetchBuffer(url: string, extraHeaders: Record<string, string> = {}): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const u = new URL(url)
    const mod = (u.protocol === 'https:' ? https : http) as typeof https
    const req = mod.get(
      { hostname: u.hostname, path: u.pathname + u.search, headers: { ...GIRI_HEADERS, ...extraHeaders }, rejectUnauthorized: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', () => resolve(null))
      }
    )
    req.setTimeout(30000, () => { req.destroy(); resolve(null) })
    req.on('error', () => resolve(null))
  })
}

// ── m3u8 parser ──────────────────────────────────────────────────────────────

interface M3u8Info {
  tsUrls: string[]
  keyInfo: { uri: string; iv: string } | null
}

async function parseM3u8(m3u8Url: string): Promise<M3u8Info> {
  const buf = await fetchBuffer(m3u8Url)
  if (!buf) return { tsUrls: [], keyInfo: null }

  const text = buf.toString('utf-8')
  const tsUrls: string[] = []
  let keyInfo: M3u8Info['keyInfo'] = null

  for (const line of text.split('\n')) {
    const l = line.trim()
    if (!l) continue

    if (l.startsWith('#EXT-X-KEY:')) {
      const uriM = l.match(/URI="([^"]+)"/)
      const ivM = l.match(/IV=0x([0-9a-fA-F]+)/)
      if (uriM) {
        keyInfo = {
          uri: new URL(uriM[1], m3u8Url).href,
          iv: ivM ? ivM[1] : '00000000000000000000000000000000',
        }
      }
      continue
    }
    if (l.startsWith('#')) continue
    if (l.includes('.m3u8')) {
      // nested m3u8
      const nested = await parseM3u8(new URL(l, m3u8Url).href)
      return nested
    }
    tsUrls.push(new URL(l, m3u8Url).href)
  }

  return { tsUrls, keyInfo }
}

// ── TS segment downloader ─────────────────────────────────────────────────────

async function downloadSegment(
  url: string,
  savePath: string,
  signal: AbortSignal,
  maxRetries = 8
): Promise<boolean> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (signal.aborted) return false
    const buf = await fetchBuffer(url)
    if (buf && buf.length > 0) {
      writeFileSync(savePath, buf)
      return true
    }
    await new Promise((r) => setTimeout(r, Math.min(2000 + attempt * 1500, 8000)))
  }
  return false
}

async function downloadSegmentsConcurrent(
  tsUrls: string[],
  tempDir: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number, bytes: number) => void,
  concurrency = 10
): Promise<number> {
  let segsDone = 0
  let totalBytes = 0
  let failedCount = 0
  const total = tsUrls.length

  const semaphore = { slots: concurrency }
  const tasks = tsUrls.map((url, i) => async () => {
    while (semaphore.slots <= 0) await new Promise((r) => setTimeout(r, 50))
    semaphore.slots--
    const segPath = join(tempDir, `segment_${String(i).padStart(5, '0')}.ts`)
    const ok = await downloadSegment(url, segPath, signal)
    semaphore.slots++
    if (ok) {
      let segSize = 0
      try { segSize = require('node:fs').statSync(segPath).size as number } catch { /* ignore */ }
      segsDone++
      totalBytes += segSize
      onProgress(segsDone, total, totalBytes)
    } else {
      failedCount++
    }
  })

  await Promise.all(tasks.map((t) => t()))
  return failedCount
}

// ── AES decrypt ───────────────────────────────────────────────────────────────

async function decryptSegments(tempDir: string, keyInfo: NonNullable<M3u8Info['keyInfo']>): Promise<void> {
  const keyBuf = await fetchBuffer(keyInfo.uri)
  if (!keyBuf) throw new Error('Failed to fetch AES key')

  const ivBuf = Buffer.from(keyInfo.iv.padStart(32, '0'), 'hex')

  const files = readdirSync(tempDir).filter((f) => f.endsWith('.ts')).sort()
  for (const fname of files) {
    const fpath = join(tempDir, fname)
    const data = readFileSync(fpath)
    const padLen = 16 - (data.length % 16)
    const padded = padLen === 16 ? data : Buffer.concat([data, Buffer.alloc(padLen)])
    const decipher = createDecipheriv('aes-128-cbc', keyBuf, ivBuf)
    decipher.setAutoPadding(false)
    const decrypted = Buffer.concat([decipher.update(padded), decipher.final()])
    writeFileSync(fpath, decrypted)
  }
}

// ── ffmpeg merge ──────────────────────────────────────────────────────────────

function runFfmpeg(segListPath: string, outputPath: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) { reject(new Error('ffmpeg-static not found')); return }

    const proc = spawn(ffmpegPath, [
      '-f', 'concat', '-safe', '0', '-i', segListPath,
      '-c:v', 'copy', '-c:a', 'copy', '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart', '-y', '-loglevel', 'warning',
      outputPath,
    ], { cwd })

    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`FFmpeg failed: ${stderr.slice(-300)}`))
    })
    proc.on('error', reject)
  })
}

// ── main export ───────────────────────────────────────────────────────────────

export async function downloadSingleEp(
  title: string,
  epIdx: number,
  epName: string,
  epUrl: string,
  saveDir: string | undefined,
  cookieString: string,
  signal: AbortSignal,
  onEvent: (ev: DlEvent) => void
): Promise<void> {
  onEvent({ type: 'ep_start', ep: epIdx })
  onEvent({ type: 'ep_progress', ep: epIdx, pct: 2, bytes: 0 })

  // 1. Capture m3u8
  const m3u8Url = await captureM3u8(epUrl, cookieString)
  if (!m3u8Url || signal.aborted) {
    onEvent({ type: 'ep_error', ep: epIdx, msg: 'Failed to capture m3u8 URL' })
    return
  }
  onEvent({ type: 'ep_progress', ep: epIdx, pct: 8, bytes: 0 })

  // 2. Parse m3u8
  const { tsUrls, keyInfo } = await parseM3u8(m3u8Url)
  if (!tsUrls.length) {
    onEvent({ type: 'ep_error', ep: epIdx, msg: 'No TS segments found in m3u8' })
    return
  }

  // 3. Prepare temp dir
  const tempDir = join(app.getPath('temp'), 'girigiri_ts', `${safeName(title)}_${String(epIdx).padStart(4, '0')}`)
  rmSync(tempDir, { recursive: true, force: true })
  mkdirSync(tempDir, { recursive: true })

  // 4. Download segments
  const failed = await downloadSegmentsConcurrent(
    tsUrls, tempDir, signal,
    (done, total, bytes) => {
      const pct = Math.min(95, 10 + Math.floor(done / total * 85))
      onEvent({ type: 'ep_progress', ep: epIdx, pct, bytes })
    }
  )

  if (signal.aborted) { rmSync(tempDir, { recursive: true, force: true }); return }

  if (failed > 0) {
    rmSync(tempDir, { recursive: true, force: true })
    onEvent({ type: 'ep_error', ep: epIdx, msg: `${failed} segments failed to download` })
    return
  }

  // 5. Decrypt if needed
  if (keyInfo) {
    try {
      await decryptSegments(tempDir, keyInfo)
    } catch (e) {
      rmSync(tempDir, { recursive: true, force: true })
      onEvent({ type: 'ep_error', ep: epIdx, msg: `Decryption failed: ${String(e)}` })
      return
    }
  }

  onEvent({ type: 'ep_progress', ep: epIdx, pct: 97, bytes: 0 })

  // 6. Write segment list file for ffmpeg
  const segFiles = readdirSync(tempDir).filter((f) => f.startsWith('segment_') && f.endsWith('.ts')).sort()
  const segListPath = join(tempDir, 'segments.txt')
  writeFileSync(segListPath, segFiles.map((f) => `file '${f}'`).join('\n'))

  // 7. Merge with ffmpeg
  const base = saveDir ?? app.getPath('downloads')
  const animeDir = join(base, safeName(title))
  mkdirSync(animeDir, { recursive: true })
  const outputPath = join(animeDir, `${safeName(epName)}.mp4`)

  try {
    await runFfmpeg('segments.txt', outputPath, tempDir)
    rmSync(tempDir, { recursive: true, force: true })
    onEvent({ type: 'ep_done', ep: epIdx })
  } catch (e) {
    rmSync(tempDir, { recursive: true, force: true })
    onEvent({ type: 'ep_error', ep: epIdx, msg: String(e) })
  }
}
