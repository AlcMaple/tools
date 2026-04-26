/**
 * Girigiri HLS/m3u8 download. The real m3u8 URL is sniffed by loading the player
 * page in a hidden BrowserWindow and intercepting requests via webRequest, which
 * avoids pulling in a headless-browser dependency just to get one URL.
 */
import * as https from 'https'
import * as http from 'http'
import { mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { URL } from 'url'
import { createDecipheriv } from 'crypto'
import { spawn } from 'child_process'
import { BrowserWindow, session as electronSession, app } from 'electron'
import { DESKTOP_USER_AGENT, safeName, DlEvent } from '../shared/download-types'

export type { DlEvent }

// Per-process session id. Used to invalidate tempDir contents from a previous
// app run — segments only resume if they were written by this same process.
// Prevents partial / corrupt segments left over by older buggy runs from being
// treated as "already downloaded" and ffmpeg-merged into broken mp4 files.
const SESSION_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SESSION_FILE = '.session'

const GIRI_HEADERS = {
  'User-Agent': DESKTOP_USER_AGENT,
  Accept: '*/*',
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

      // Intercept network requests to find the real m3u8 playlist.
      // Strict: pathname (case-insensitive) must end with `.m3u8` so we don't
      // grab JS / HTML resources that merely contain the substring "m3u8".
      ses.webRequest.onBeforeRequest((details, callback) => {
        callback({})
        if (resolved) return
        let parsed: URL
        try { parsed = new URL(details.url) } catch { return }
        const pathLower = parsed.pathname.toLowerCase()
        const hostLower = parsed.hostname.toLowerCase()
        if (!pathLower.endsWith('.m3u8')) return
        if (!hostLower.includes('girigirilove')) return
        console.log(`[girigiri] captured m3u8 candidate: ${details.url}`)
        done(details.url)
      })

      win.loadURL(epUrl).catch(() => done(null))
      win.on('closed', () => done(null))
    })
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Sleep that wakes up immediately when the signal aborts. Used so retry/semaphore
// loops respond to pause within milliseconds instead of dragging out for seconds.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return }
    const onAbort = (): void => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// http.request rejects unescaped chars in `path`. URL parser leaves [, ], |, {, }, `, space, etc. unencoded.
// Encode them defensively so chunk URLs containing such chars don't crash mod.get synchronously.
function buildSafePath(u: URL): string {
  let out = ''
  for (const ch of u.pathname) {
    const code = ch.charCodeAt(0)
    const unsafe = code < 0x21 || code === 0x7f || '[]|{}\\^`"<>'.indexOf(ch) >= 0
    out += unsafe ? '%' + code.toString(16).toUpperCase().padStart(2, '0') : ch
  }
  return out + u.search
}

async function fetchBuffer(url: string, signal?: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<Buffer | null> {
  if (signal?.aborted) return null
  return new Promise<Buffer | null>((resolve) => {
    let settled = false
    let req: http.ClientRequest | null = null

    const finish = (val: Buffer | null): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve(val)
    }
    const onAbort = (): void => {
      req?.destroy()
      finish(null)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    let u: URL
    try { u = new URL(url) } catch (e) {
      console.warn(`[girigiri] fetchBuffer URL parse failed: ${url}`, e)
      finish(null); return
    }
    const mod = (u.protocol === 'https:' ? https : http) as typeof https
    try {
      req = mod.get(
        { hostname: u.hostname, port: u.port || undefined, path: buildSafePath(u), headers: { ...GIRI_HEADERS, ...extraHeaders }, rejectUnauthorized: false },
        (res) => {
          const status = res.statusCode ?? 0
          if (status < 200 || status >= 300) {
            console.warn(`[girigiri] fetchBuffer HTTP ${status} for ${url}`)
            res.resume()
            finish(null)
            return
          }
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => finish(Buffer.concat(chunks)))
          res.on('error', (e) => {
            if (!settled) console.warn(`[girigiri] fetchBuffer stream error for ${url}:`, e)
            finish(null)
          })
        }
      )
    } catch (e) {
      console.warn(`[girigiri] fetchBuffer mod.get threw for ${url}:`, e)
      finish(null); return
    }
    req.setTimeout(30000, () => { console.warn(`[girigiri] fetchBuffer timeout (30s) for ${url}`); req?.destroy(); finish(null) })
    req.on('error', (e) => {
      if (!settled) console.warn(`[girigiri] fetchBuffer req error for ${url}:`, e.message)
      finish(null)
    })
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

  // A real m3u8 playlist always starts with the #EXTM3U marker.
  // Without this guard, JS/HTML content that snuck in via the wrong URL
  // would be parsed line-by-line as if every line were a segment URL.
  if (!text.trimStart().startsWith('#EXTM3U')) {
    console.error(`[girigiri] not a valid m3u8 (no #EXTM3U marker): ${m3u8Url}`)
    console.error(`[girigiri] first 300 chars of response:\n${text.slice(0, 300)}`)
    return { tsUrls: [], keyInfo: null }
  }

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
    // Master playlists list variant playlists ending in .m3u8 (optionally with query).
    // Substring match would mistakenly recurse on segment URLs that merely contain ".m3u8".
    if (/\.m3u8($|\?)/i.test(l)) {
      return parseM3u8(new URL(l, m3u8Url).href)
    }

    // A real segment URL never contains whitespace or these JS/HTML chars.
    // Lines that match are obviously not URLs (e.g. `return new Promise(...)`).
    if (/[\s(){}<>"'`]/.test(l)) {
      console.warn(`[girigiri] skipping non-URL line in m3u8: ${l.slice(0, 80)}`)
      continue
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
  if (existsSync(savePath) && statSync(savePath).size > 0) return true
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (signal.aborted) return false
    const buf = await fetchBuffer(url, signal)
    if (buf && buf.length > 0) {
      writeFileSync(savePath, buf)
      return true
    }
    await sleep(Math.min(2000 + attempt * 1500, 8000), signal)
  }
  if (!signal.aborted) console.error(`[girigiri] segment FAILED after ${maxRetries} attempts: ${url}`)
  return false
}

async function downloadSegmentsConcurrent(
  tsUrls: string[],
  tempDir: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number, bytes: number) => void,
  concurrency = 8
): Promise<number> {
  let segsDone = 0
  let totalBytes = 0
  let failedCount = 0
  const total = tsUrls.length

  const semaphore = { slots: concurrency }
  const tasks = tsUrls.map((url, i) => async () => {
    while (semaphore.slots <= 0) {
      if (signal.aborted) return
      await sleep(50, signal)
    }
    if (signal.aborted) return
    semaphore.slots--
    const segPath = join(tempDir, `segment_${String(i).padStart(5, '0')}.ts`)
    const ok = await downloadSegment(url, segPath, signal)
    semaphore.slots++
    if (ok) {
      let segSize = 0
      try { segSize = statSync(segPath).size } catch { /* ignore */ }
      segsDone++
      totalBytes += segSize
      onProgress(segsDone, total, totalBytes)
    } else if (!signal.aborted) {
      failedCount++
    }
  })

  await Promise.all(tasks.map((t) => t()))
  return failedCount
}

const isSegmentFile = (f: string): boolean => f.startsWith('segment_') && f.endsWith('.ts')

// ── AES decrypt ───────────────────────────────────────────────────────────────

async function decryptSegments(tempDir: string, keyInfo: NonNullable<M3u8Info['keyInfo']>): Promise<void> {
  const keyBuf = await fetchBuffer(keyInfo.uri)
  if (!keyBuf) throw new Error('Failed to fetch AES key')

  const ivBuf = Buffer.from(keyInfo.iv.padStart(32, '0'), 'hex')

  const files = readdirSync(tempDir).filter(isSegmentFile).sort()
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
    const proc = spawn('ffmpeg', [
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

  // 3. Prepare temp dir.
  // Segments are kept across pause/resume within the same app run.
  // A SESSION_ID guard wipes leftovers from a previous run so corrupt partial
  // segments don't get reused (the resume guard in downloadSegment only checks
  // file size, which can't tell good data from garbage).
  const tempDir = join(app.getPath('temp'), 'girigiri_ts', `${safeName(title)}_${String(epIdx).padStart(4, '0')}`)
  mkdirSync(tempDir, { recursive: true })
  const sessionPath = join(tempDir, SESSION_FILE)
  let lastSession = ''
  try { lastSession = readFileSync(sessionPath, 'utf-8') } catch { /* missing is fine */ }
  if (lastSession !== SESSION_ID) {
    for (const f of readdirSync(tempDir)) rmSync(join(tempDir, f), { recursive: true, force: true })
    writeFileSync(sessionPath, SESSION_ID)
  }

  // 4. Download segments (already-downloaded segments are skipped inside downloadSegment)
  const failed = await downloadSegmentsConcurrent(
    tsUrls, tempDir, signal,
    (done, total, bytes) => {
      const pct = Math.min(95, 10 + Math.floor(done / total * 85))
      onEvent({ type: 'ep_progress', ep: epIdx, pct, bytes })
    }
  )

  if (signal.aborted) return

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
  const segFiles = readdirSync(tempDir).filter(isSegmentFile).sort()
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
