/**
 * Girigiri 的 HLS/m3u8 下载。真实 m3u8 地址是把播放页加载进隐藏 BrowserWindow、
 * 用 webRequest 截流拿到的 —— 为了一个地址引入 headless 浏览器依赖不划算。
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
import { logError } from '../shared/logger'
import { BASE_DOMAIN } from './api'

export type { DlEvent }

// 进程级 session id,用来作废上一次运行留下的临时目录内容:分片只有在**本次进程**写过时
// 才允许续传。否则旧的残缺分片会被当成「已下载」,被 ffmpeg 合进一个坏 mp4。
const SESSION_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const SESSION_FILE = '.session'

const GIRI_HEADERS = {
  'User-Agent': DESKTOP_USER_AGENT,
  Accept: '*/*',
}

// ── m3u8 capture via hidden BrowserWindow ─────────────────────────────────────

// 在线播放也复用这条路:m3u8 是播放页 JS 运行时拼出来的,拿不到就只能截流。
// 下载可以慢慢等,播放等不起 30s,所以超时可调。
export async function captureM3u8(
  epUrl: string,
  cookieString: string,
  timeoutMs = 30000,
): Promise<string | null> {
  return new Promise((resolve) => {
    const partition = `girigiri-capture-${Date.now()}`
    const ses = electronSession.fromPartition(partition, { cache: false })

    // 注入 cookie,让站点认得这个会话
    const cookiePairs = cookieString.split(';').map((p) => p.trim()).filter(Boolean)
    const cookiePromises = cookiePairs.map((pair) => {
      const eq = pair.indexOf('=')
      if (eq <= 0) return Promise.resolve()
      return ses.cookies.set({
        // 域名跟着 api.ts 的主域走 —— 写死旧域名的话,站点换域后 cookie 会落在错误的 domain 上
        // 注了等于没注。
        url: BASE_DOMAIN,
        name: pair.slice(0, eq).trim(),
        value: pair.slice(eq + 1).trim(),
      }).catch(() => undefined)
    })

    Promise.all(cookiePromises).then(() => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true },
      })
      // 加载的是站点播放页,里面的播放器会自动播 —— 窗口不可见,就成了「凭空冒出的声音」,
      // 且渲染层完全够不着它。抓 m3u8 不需要出声,建完立刻静音(同 xifan/browser-challenge)。
      win.webContents.setAudioMuted(true)

      let resolved = false
      const done = (url: string | null): void => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        if (!win.isDestroyed()) win.close()
        resolve(url)
      }

      const timer = setTimeout(() => {
        // 超时没截到 m3u8 —— 留个痕,否则用户只看到「下载失败」,不知道是卡在抓流这一步。
        logError('girigiri:capture', `${Math.round(timeoutMs / 1000)}s 超时未截获 m3u8: ${epUrl}`)
        done(null)
      }, timeoutMs)

      // 截网络请求找真正的 m3u8。严格要求 pathname 以 `.m3u8` 结尾,别把只是名字里含 "m3u8" 的
      // JS / HTML 资源也抓进来。
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

      win.loadURL(epUrl).catch((err) => {
        logError('girigiri:capture', `页面加载失败 ${epUrl}: ${err}`)
        done(null)
      })
      win.once('closed', () => done(null))
    })
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// 能被 abort 立刻唤醒的 sleep:让重试 / 信号量循环在毫秒内响应暂停,而不是拖上好几秒。
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

// http.request 不接受 path 里的未转义字符,而 URL 解析器会原样留下 [ ] | { } ` 和空格。
// 这里防御性地编码一遍,免得含这些字符的分片地址让请求同步崩掉。
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

// m3u8 是纯文本,20MB 已远超正常 —— 超了当损坏/恶意响应,别 split 成几百万行阻塞事件循环。
// master 列表可能嵌套指向变体列表,深度封顶防自引用死循环。
const M3U8_MAX_BYTES = 20 * 1024 * 1024
const M3U8_MAX_DEPTH = 5

async function parseM3u8(m3u8Url: string, depth = 0): Promise<M3u8Info> {
  if (depth > M3U8_MAX_DEPTH) {
    logError('girigiri:m3u8', `master playlist 嵌套过深(>${M3U8_MAX_DEPTH}),疑似自引用: ${m3u8Url}`)
    return { tsUrls: [], keyInfo: null }
  }
  const buf = await fetchBuffer(m3u8Url)
  if (!buf) return { tsUrls: [], keyInfo: null }
  if (buf.length > M3U8_MAX_BYTES) {
    logError('girigiri:m3u8', `m3u8 响应过大(${buf.length}B),拒绝解析: ${m3u8Url}`)
    return { tsUrls: [], keyInfo: null }
  }

  const text = buf.toString('utf-8')

  // 真正的 m3u8 一定以 #EXTM3U 开头。没有这道闸的话,走错地址拿到的 JS/HTML 会被逐行当成
  // 分片地址解析。
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
    // master 列表里指向的变体列表也以 .m3u8 结尾(可能带 query)。
    // Substring match would mistakenly recurse on segment URLs that merely contain ".m3u8".
    if (/\.m3u8($|\?)/i.test(l)) {
      return parseM3u8(new URL(l, m3u8Url).href, depth + 1)
    }

    // 真正的分片地址不会含空白或这些 JS/HTML 字符 —— 命中的行显然不是 URL
    // (比如 `return new Promise(...)`)。
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

function runFfmpeg(segListPath: string, outputPath: string, cwd: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-f', 'concat', '-safe', '0', '-i', segListPath,
      '-c:v', 'copy', '-c:a', 'copy', '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart', '-y', '-loglevel', 'warning',
      outputPath,
    ], { cwd })

    // 取消下载时把 ffmpeg 子进程一并杀掉,否则合并阶段被 abort 后进程仍在后台
    // 空跑到结束(多次取消会累积多个 ffmpeg 吃 CPU/磁盘)。
    const onAbort = (): void => { proc.kill() }
    if (signal.aborted) proc.kill()
    else signal.addEventListener('abort', onAbort, { once: true })

    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (code === 0) resolve()
      else reject(new Error(`FFmpeg failed: ${stderr.slice(-300)}`))
    })
    proc.on('error', (err) => {
      signal.removeEventListener('abort', onAbort)
      reject(err)
    })
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

  // 最终文件已存在就整条流程跳过。
  const base = saveDir ?? app.getPath('downloads')
  const animeDir = join(base, `[Girigiri] ${safeName(title)}`)
  const outputPath = join(animeDir, `${safeName(epName)}.mp4`)
  if (existsSync(outputPath) && statSync(outputPath).size > 0) {
    onEvent({ type: 'ep_done', ep: epIdx })
    return
  }

  // 立刻建好目标文件夹,下载过程中用户在访达里就能看到。
  mkdirSync(animeDir, { recursive: true })

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
  // 同一次运行内,分片在暂停/继续之间保留;跨进程则作废 —— 续传守卫只看文件大小,
  // A SESSION_ID guard wipes leftovers from a previous run so corrupt partial
  // 分不出好数据和垃圾数据。
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
  try {
    await runFfmpeg('segments.txt', outputPath, tempDir, signal)
    rmSync(tempDir, { recursive: true, force: true })
    onEvent({ type: 'ep_done', ep: epIdx })
  } catch (e) {
    rmSync(tempDir, { recursive: true, force: true })
    onEvent({ type: 'ep_error', ep: epIdx, msg: String(e) })
  }
}
