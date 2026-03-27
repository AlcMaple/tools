import { app, shell, BrowserWindow, ipcMain, dialog, net } from 'electron'
import { join } from 'path'
import { statfs } from 'fs/promises'
import { readFileSync, writeFileSync } from 'fs'
import { searchBgm } from './bgm/search'
import { getBgmDetail } from './bgm/detail'
import { getCaptcha as xifanGetCaptcha, verifyCaptcha as xifanVerify, search as xifanSearch, watch as xifanWatch } from './xifan/api'
import { downloadSingleEp as xifanDownloadSingleEp, DlEvent } from './xifan/download'
import { getCaptcha as giriGetCaptcha, verifyCaptcha as giriVerify, search as giriSearch, watch as giriWatch, giriSession } from './girigiri/api'
import { downloadSingleEp as giriDownloadSingleEp } from './girigiri/download'

// ── IPC 处理器 ──────────────────────────────────────────────
ipcMain.handle('bgm:search', async (_event, keyword: string) => {
  return searchBgm(keyword)
})

ipcMain.handle('bgm:detail', async (_event, subjectId: number) => {
  return getBgmDetail(subjectId)
})

ipcMain.handle('xifan:captcha', async () => xifanGetCaptcha())
ipcMain.handle('xifan:verify', async (_event, code: string) => xifanVerify(code))
ipcMain.handle('xifan:search', async (_event, keyword: string) => xifanSearch(keyword))
ipcMain.handle('xifan:watch', async (_event, watchUrl: string) => xifanWatch(watchUrl))

ipcMain.handle('girigiri:captcha', async () => giriGetCaptcha())
ipcMain.handle('girigiri:verify', async (_event, code: string) => giriVerify(code))
ipcMain.handle('girigiri:search', async (_event, keyword: string) => giriSearch(keyword))
ipcMain.handle('girigiri:watch', async (_event, playUrl: string) => giriWatch(playUrl))

// ── System stats ─────────────────────────────────────────────
let _speedAccum = 0
const _epLastBytes = new Map<string, Map<number, number>>()

ipcMain.handle('system:disk-free', async () => {
  try {
    const stats = await statfs(join(app.getAppPath(), '..'))
    return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize }
  } catch {
    return { free: 0, total: 0 }
  }
})

setInterval(() => {
  const bps = _speedAccum
  _speedAccum = 0
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('system:speed', bps)
  }
}, 1000)

// ── Xifan Episode Queue ───────────────────────────────────────
interface EpQueue {
  title: string
  templates: string[]
  savePath: string | null
  pending: number[]
  priorityFront: number[]
  pausedEps: Set<number>
  current: number | null
  currentAbort: AbortController | null
  taskPaused: boolean
  cancelled: boolean
  sender: Electron.WebContents
}

const episodeQueues = new Map<string, EpQueue>()

function trackSpeed(taskId: string, ep: number, bytes: number): void {
  const taskMap = _epLastBytes.get(taskId) ?? new Map<number, number>()
  const prev = taskMap.get(ep) ?? 0
  _speedAccum += Math.max(0, bytes - prev)
  taskMap.set(ep, bytes)
  _epLastBytes.set(taskId, taskMap)
}

function startNextEp(taskId: string): void {
  const q = episodeQueues.get(taskId)
  if (!q || q.taskPaused || q.cancelled || q.current !== null) return

  let ep: number | undefined
  while (q.priorityFront.length > 0) {
    const c = q.priorityFront.shift()!
    if (!q.pausedEps.has(c)) { ep = c; break }
  }
  if (ep === undefined) {
    while (q.pending.length > 0) {
      const c = q.pending.shift()!
      if (!q.pausedEps.has(c)) { ep = c; break }
    }
  }

  if (ep === undefined) {
    if (q.pausedEps.size === 0) {
      episodeQueues.delete(taskId)
      _epLastBytes.delete(taskId)
      q.sender.send('download:progress', taskId, { type: 'all_done' })
    }
    return
  }

  const capturedEp = ep
  q.current = capturedEp
  const abort = new AbortController()
  q.currentAbort = abort

  setImmediate(() => {
    xifanDownloadSingleEp(q.title, capturedEp, q.templates, q.savePath ?? undefined, abort.signal, (ev: DlEvent) => {
      if (ev.type === 'ep_progress' && typeof ev.bytes === 'number') {
        trackSpeed(taskId, capturedEp, ev.bytes)
      }
      q.sender.send('download:progress', taskId, ev)
    }).finally(() => {
      if (q.currentAbort === abort) {
        q.current = null
        q.currentAbort = null
      }
      if (!q.cancelled) startNextEp(taskId)
    })
  })
}

ipcMain.handle(
  'xifan:download',
  async (event, title: string, templates: string[], startEp: number, endEp: number, savePath?: string) => {
    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const pending = Array.from({ length: endEp - startEp + 1 }, (_, i) => startEp + i)
    episodeQueues.set(taskId, {
      title, templates, savePath: savePath ?? null,
      pending, priorityFront: [], pausedEps: new Set(),
      current: null, currentAbort: null, taskPaused: false, cancelled: false,
      sender: event.sender,
    })
    startNextEp(taskId)
    return { started: true, taskId }
  }
)

ipcMain.handle('xifan:download-cancel', (_event, taskId: string) => {
  const q = episodeQueues.get(taskId)
  if (q) { q.cancelled = true; q.currentAbort?.abort(); episodeQueues.delete(taskId) }
  return { cancelled: true }
})

ipcMain.handle('xifan:download-pause', (_event, taskId: string) => {
  const q = episodeQueues.get(taskId)
  if (q) q.taskPaused = true
  // Current episode continues to completion; won't start next while paused
  return { paused: true }
})

ipcMain.handle('xifan:download-resume', (_event, taskId: string) => {
  const q = episodeQueues.get(taskId)
  if (q) { q.taskPaused = false; startNextEp(taskId) }
  return { resumed: true }
})

ipcMain.handle('xifan:download-pause-ep', (_event, taskId: string, ep: number) => {
  const q = episodeQueues.get(taskId)
  if (!q) return { paused: false }
  q.pausedEps.add(ep)
  q.sender.send('download:progress', taskId, { type: 'ep_paused', ep })
  // Abort if currently downloading this ep; .finally() will call startNextEp → picks next
  if (q.current === ep) q.currentAbort?.abort()
  return { paused: true }
})

ipcMain.handle('xifan:download-resume-ep', (_event, taskId: string, ep: number) => {
  const q = episodeQueues.get(taskId)
  if (!q) return { resumed: false }
  q.pausedEps.delete(ep)
  q.priorityFront.unshift(ep)
  q.sender.send('download:progress', taskId, { type: 'ep_queued', ep })
  if (q.current === null && !q.taskPaused) startNextEp(taskId)
  return { resumed: true }
})

ipcMain.handle(
  'xifan:download-requeue',
  async (event, taskId: string, title: string, templates: string[], eps: number[], savePath?: string) => {
    episodeQueues.set(taskId, {
      title, templates, savePath: savePath ?? null,
      pending: [...eps], priorityFront: [], pausedEps: new Set(),
      current: null, currentAbort: null, taskPaused: false, cancelled: false,
      sender: event.sender,
    })
    startNextEp(taskId)
    return { started: true }
  }
)

ipcMain.handle('xifan:download-retry', (_event, taskId: string, _title: string, _templates: string[], failedEps: number[]) => {
  const q = episodeQueues.get(taskId)
  if (!q) return { started: false }
  for (const ep of [...failedEps].reverse()) { q.pausedEps.delete(ep); q.priorityFront.unshift(ep) }
  if (q.current === null && !q.taskPaused) startNextEp(taskId)
  return { started: true }
})

// ── Girigiri Episode Queue ────────────────────────────────────

interface GiriEpQueue {
  title: string
  epList: { idx: number; name: string; url: string }[]
  savePath: string | null
  pending: number[]
  priorityFront: number[]
  pausedEps: Set<number>
  current: number | null
  currentAbort: AbortController | null
  taskPaused: boolean
  cancelled: boolean
  sender: Electron.WebContents
}

const giriEpQueues = new Map<string, GiriEpQueue>()

function startNextGiriEp(taskId: string): void {
  const q = giriEpQueues.get(taskId)
  if (!q || q.taskPaused || q.cancelled || q.current !== null) return

  let ep: number | undefined
  while (q.priorityFront.length > 0) {
    const c = q.priorityFront.shift()!
    if (!q.pausedEps.has(c)) { ep = c; break }
  }
  if (ep === undefined) {
    while (q.pending.length > 0) {
      const c = q.pending.shift()!
      if (!q.pausedEps.has(c)) { ep = c; break }
    }
  }

  if (ep === undefined) {
    if (q.pausedEps.size === 0) {
      giriEpQueues.delete(taskId)
      q.sender.send('download:progress', taskId, { type: 'all_done' })
    }
    return
  }

  const epInfo = q.epList.find((e) => e.idx === ep)
  if (!epInfo) { startNextGiriEp(taskId); return }

  const capturedEp = ep
  q.current = capturedEp
  const abort = new AbortController()
  q.currentAbort = abort

  setImmediate(() => {
    giriDownloadSingleEp(
      q.title, capturedEp, epInfo.name, epInfo.url,
      q.savePath ?? undefined, giriSession.getCookieString(),
      abort.signal,
      (ev: DlEvent) => {
        if (ev.type === 'ep_progress' && typeof ev.bytes === 'number') {
          trackSpeed(taskId, capturedEp, ev.bytes)
        }
        q.sender.send('download:progress', taskId, ev)
      }
    ).finally(() => {
      if (q.currentAbort === abort) {
        q.current = null
        q.currentAbort = null
      }
      if (!q.cancelled) startNextGiriEp(taskId)
    })
  })
}

ipcMain.handle(
  'girigiri:download',
  async (event, title: string, epList: { idx: number; name: string; url: string }[], selectedIdxs: number[], savePath?: string) => {
    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    giriEpQueues.set(taskId, {
      title, epList, savePath: savePath ?? null,
      pending: [...selectedIdxs], priorityFront: [], pausedEps: new Set(),
      current: null, currentAbort: null, taskPaused: false, cancelled: false,
      sender: event.sender,
    })
    startNextGiriEp(taskId)
    return { started: true, taskId }
  }
)

ipcMain.handle('girigiri:download-cancel', (_event, taskId: string) => {
  const q = giriEpQueues.get(taskId)
  if (q) { q.cancelled = true; q.currentAbort?.abort(); giriEpQueues.delete(taskId) }
  return { cancelled: true }
})

ipcMain.handle('girigiri:download-pause', (_event, taskId: string) => {
  const q = giriEpQueues.get(taskId)
  if (q) q.taskPaused = true
  return { paused: true }
})

ipcMain.handle('girigiri:download-resume', (_event, taskId: string) => {
  const q = giriEpQueues.get(taskId)
  if (q) { q.taskPaused = false; startNextGiriEp(taskId) }
  return { resumed: true }
})

ipcMain.handle('girigiri:download-pause-ep', (_event, taskId: string, ep: number) => {
  const q = giriEpQueues.get(taskId)
  if (!q) return { paused: false }
  q.pausedEps.add(ep)
  q.sender.send('download:progress', taskId, { type: 'ep_paused', ep })
  if (q.current === ep) q.currentAbort?.abort()
  return { paused: true }
})

ipcMain.handle('girigiri:download-resume-ep', (_event, taskId: string, ep: number) => {
  const q = giriEpQueues.get(taskId)
  if (!q) return { resumed: false }
  q.pausedEps.delete(ep)
  q.priorityFront.unshift(ep)
  q.sender.send('download:progress', taskId, { type: 'ep_queued', ep })
  if (q.current === null && !q.taskPaused) startNextGiriEp(taskId)
  return { resumed: true }
})

ipcMain.handle(
  'girigiri:download-requeue',
  async (event, taskId: string, title: string, epList: { idx: number; name: string; url: string }[], eps: number[], savePath?: string) => {
    giriEpQueues.set(taskId, {
      title, epList, savePath: savePath ?? null,
      pending: [...eps], priorityFront: [], pausedEps: new Set(),
      current: null, currentAbort: null, taskPaused: false, cancelled: false,
      sender: event.sender,
    })
    startNextGiriEp(taskId)
    return { started: true }
  }
)

ipcMain.handle('girigiri:download-retry', (_event, taskId: string, _title: string, _epList: unknown, failedEps: number[]) => {
  const q = giriEpQueues.get(taskId)
  if (!q) return { started: false }
  for (const ep of [...failedEps].reverse()) { q.pausedEps.delete(ep); q.priorityFront.unshift(ep) }
  if (q.current === null && !q.taskPaused) startNextGiriEp(taskId)
  return { started: true }
})

// ── Misc IPC ──────────────────────────────────────────────────

ipcMain.handle('system:pick-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('system:connectivity', () => {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 2500)
    try {
      const req = net.request({ method: 'HEAD', url: 'https://connectivitycheck.gstatic.com/generate_204' })
      req.on('response', (res) => { clearTimeout(timer); resolve(res.statusCode === 204) })
      req.on('error', () => { clearTimeout(timer); resolve(false) })
      req.end()
    } catch { clearTimeout(timer); resolve(false) }
  })
})

const HISTORY_FILE = (): string => join(app.getPath('userData'), 'xifan_settings_history.json')

ipcMain.handle('system:history-read', () => {
  try { return JSON.parse(readFileSync(HISTORY_FILE(), 'utf-8')) }
  catch { return [] }
})

ipcMain.handle('system:history-write', (_event, entries: unknown) => {
  try { writeFileSync(HISTORY_FILE(), JSON.stringify(entries)); return true }
  catch { return false }
})

// ── Window ────────────────────────────────────────────────────

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => { mainWindow.show() })

  mainWindow.webContents.setWindowOpenHandler((details: { url: string }) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
