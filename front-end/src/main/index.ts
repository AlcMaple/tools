import { app, shell, BrowserWindow, ipcMain, dialog, net, protocol, Tray, Menu } from 'electron'
import { join } from 'path'
import { statfs, readFile } from 'fs/promises'
import { readFileSync, writeFileSync } from 'fs'
import { searchBgm } from './bgm/search'
import { getBgmDetail } from './bgm/detail'
import { getCaptcha as xifanGetCaptcha, verifyCaptcha as xifanVerify, search as xifanSearch, watch as xifanWatch } from './xifan/api'
import { downloadSingleEp as xifanDownloadSingleEp, DlEvent } from './xifan/download'
import { getCaptcha as giriGetCaptcha, verifyCaptcha as giriVerify, search as giriSearch, watch as giriWatch, giriSession } from './girigiri/api'
import { downloadSingleEp as giriDownloadSingleEp } from './girigiri/download'
import { getPaths, addPath, removePath, getEntries, scanLibrary, startLibraryWatch, getFiles } from './library/api'

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

ipcMain.handle('library:get-paths', async () => getPaths())
ipcMain.handle('library:add-path', async (_event, folderPath: string, label: string) => addPath(folderPath, label))
ipcMain.handle('library:remove-path', async (_event, folderPath: string) => removePath(folderPath))
ipcMain.handle('library:get-entries', async () => getEntries())
ipcMain.handle('library:get-files', async (_event, folderPath: string) => getFiles(folderPath))
ipcMain.handle('library:open-folder', async (_event, folderPath: string) => shell.openPath(folderPath))
ipcMain.handle('library:play-video', async (_event, filePath: string) => shell.openPath(filePath))
ipcMain.handle('library:play-folder', async (_event, folderPath: string) => {
  const files = await getFiles(folderPath)
  if (files.length > 0) await shell.openPath(files[0].path)
})
ipcMain.handle('library:scan', async (event) => {
  return scanLibrary((status: string, currentVal: number, totalVal: number) => {
    event.sender.send('library:scan-status', { status, currentVal, totalVal })
  })
})

let appMinimizeOnClose = false
try {
  const file = join(app.getPath('userData'), 'app_settings.json')
  const settings = JSON.parse(readFileSync(file, 'utf-8'))
  if (typeof settings.minimizeOnClose === 'boolean') {
    appMinimizeOnClose = settings.minimizeOnClose
  }
} catch {
  // ignore
}

ipcMain.handle('system:get-setting', (_event, key: string) => {
  if (key === 'minimizeOnClose') return appMinimizeOnClose
  return null
})

ipcMain.handle('system:set-setting', (_event, key: string, value: any) => {
  if (key === 'minimizeOnClose') {
    appMinimizeOnClose = value
    const file = join(app.getPath('userData'), 'app_settings.json')
    try {
      let settings: any = {}
      try { settings = JSON.parse(readFileSync(file, 'utf-8')) } catch { }
      settings.minimizeOnClose = value
      writeFileSync(file, JSON.stringify(settings))
    } catch { }
  }
})

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

ipcMain.handle('xifan:download-resume', (event, taskId: string, title?: string, templates?: string[], pendingEps?: number[], savePath?: string) => {
  const q = episodeQueues.get(taskId)
  if (!q) {
    // Queue lost after app restart — recreate it and start downloading
    if (title && templates && pendingEps?.length) {
      episodeQueues.set(taskId, {
        title, templates, savePath: savePath ?? null,
        pending: [...pendingEps], priorityFront: [], pausedEps: new Set(),
        current: null, currentAbort: null, taskPaused: false, cancelled: false,
        sender: event.sender,
      })
      startNextEp(taskId)
    }
    return { resumed: true }
  }
  q.taskPaused = false
  startNextEp(taskId)
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

ipcMain.handle('xifan:download-retry', (event, taskId: string, title: string, templates: string[], failedEps: number[], savePath?: string) => {
  const q = episodeQueues.get(taskId)
  if (!q) {
    // Queue lost after app restart — recreate it from the persisted task info
    episodeQueues.set(taskId, {
      title, templates, savePath: savePath ?? null,
      pending: [...failedEps], priorityFront: [], pausedEps: new Set(),
      current: null, currentAbort: null, taskPaused: false, cancelled: false,
      sender: event.sender,
    })
    startNextEp(taskId)
    return { started: true }
  }
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

ipcMain.handle('girigiri:download-resume', (event, taskId: string, title?: string, epList?: { idx: number; name: string; url: string }[], pendingEps?: number[], savePath?: string) => {
  const q = giriEpQueues.get(taskId)
  if (!q) {
    // Queue lost after app restart — recreate it and start downloading
    if (title && epList && pendingEps?.length) {
      giriEpQueues.set(taskId, {
        title, epList, savePath: savePath ?? null,
        pending: [...pendingEps], priorityFront: [], pausedEps: new Set(),
        current: null, currentAbort: null, taskPaused: false, cancelled: false,
        sender: event.sender,
      })
      startNextGiriEp(taskId)
    }
    return { resumed: true }
  }
  q.taskPaused = false
  startNextGiriEp(taskId)
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

ipcMain.handle('girigiri:download-retry', (event, taskId: string, title: string, epList: { idx: number; name: string; url: string }[], failedEps: number[], savePath?: string) => {
  const q = giriEpQueues.get(taskId)
  if (!q) {
    // Queue lost after app restart — recreate it from the persisted task info
    giriEpQueues.set(taskId, {
      title, epList, savePath: savePath ?? null,
      pending: [...failedEps], priorityFront: [], pausedEps: new Set(),
      current: null, currentAbort: null, taskPaused: false, cancelled: false,
      sender: event.sender,
    })
    startNextGiriEp(taskId)
    return { started: true }
  }
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

ipcMain.handle('cache:get', (_event, key: string) => {
  try {
    const file = join(app.getPath('userData'), 'search_cache.json')
    const all = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
    return all[key] ?? null
  } catch { return null }
})

ipcMain.handle('cache:set', (_event, key: string, valueOrSubkey: unknown, maybeValue?: unknown) => {
  try {
    const file = join(app.getPath('userData'), 'search_cache.json')
    let all: Record<string, unknown> = {}
    try { all = JSON.parse(readFileSync(file, 'utf-8')) } catch { }
    if (maybeValue !== undefined) {
      if (!all[key] || typeof all[key] !== 'object') all[key] = {}
        ; (all[key] as Record<string, unknown>)[valueOrSubkey as string] = maybeValue
    } else {
      all[key] = valueOrSubkey
    }
    writeFileSync(file, JSON.stringify(all))
  } catch { /* ignore */ }
})

ipcMain.handle('system:history-write', (_event, entries: unknown) => {
  try { writeFileSync(HISTORY_FILE(), JSON.stringify(entries)); return true }
  catch { return false }
})

// ── Window ────────────────────────────────────────────────────

let isAppQuitting = false
let appTray: Tray | null = null

app.on('before-quit', () => {
  isAppQuitting = true
  if (appTray) {
    appTray.destroy()
    appTray = null
  }
})

function initTray(): void {
  if (appTray) return

  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(__dirname, '../../resources/icon.ico')
  appTray = new Tray(iconPath)
  appTray.setToolTip('MapleTools')

  const showWin = () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    } else {
      createWindow()
    }
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: showWin,
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isAppQuitting = true
        app.quit()
      },
    },
  ])
  appTray.setContextMenu(contextMenu)

  appTray.on('click', showWin)
  appTray.on('double-click', showWin)
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'MapleTools',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  // mainWindow.webContents.openDevTools()

  mainWindow.on('ready-to-show', () => { mainWindow.show() })

  mainWindow.webContents.setWindowOpenHandler((details: { url: string }) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.on('close', (event) => {
    if (appMinimizeOnClose && !isAppQuitting) {
      event.preventDefault()
      mainWindow.hide()
    } else if (!appMinimizeOnClose && !isAppQuitting) {
      isAppQuitting = true
      app.quit()
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 单实例锁：再次启动 exe 时，聚焦到已有窗口而非创建新实例
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}

app.whenReady().then(() => {
  initTray()

  protocol.handle('archivist', async (request) => {
    try {
      // URL 格式：archivist:///C:/Users/... (Windows) 或 archivist:///Users/mac/... (macOS)
      // host 为空，完整路径在 pathname 里：/C:/Users/... 或 /Users/mac/...
      const pathname = decodeURIComponent(request.url.slice('archivist://'.length))
      // Windows 盘符路径有引导斜杠：/C:/Users/... → C:/Users/...
      const filePath = pathname.replace(/^\/([A-Za-z]:)/, '$1')
      const data = await readFile(filePath)
      return new Response(data, { headers: { 'Content-Type': 'image/jpeg' } })
    } catch {
      return new Response(null, { status: 404 })
    }
  })

  createWindow()

  // 3. 启动后台目录变动监听
  startLibraryWatch(async () => {
    console.log('检测到文件夹变动，开始后台静默扫描...')

    const newEntries = await scanLibrary((status, current, total) => {
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('library:scan-status', { status, currentVal: current, totalVal: total })
        }
      })
    }, true)

    console.log(`后台扫描完成，推送了 ${newEntries.length} 个条目给前端`)

    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('library-updated', newEntries)
      }
    })
  }, () => {
    console.log('文件夹发生变动，准备扫描...')
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        // 发送一个前置状态，由于 status 不等于 'Idle'，你的 React 页面会立刻开始转圈圈！
        win.webContents.send('library:scan-status', { status: 'Preparing to scan...', currentVal: 0, totalVal: 1 })
      }
    })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
