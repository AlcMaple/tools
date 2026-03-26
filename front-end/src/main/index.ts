import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { spawn } from 'child_process'
import { statfs } from 'fs/promises'

// Python 可执行文件：Windows 用 python，macOS/Linux 用 python3
const PYTHON_BIN = process.platform === 'win32' ? 'python' : 'python3'

/**
 * 运行指定 Python 脚本，返回 stdout 字符串。
 * scriptsDir 在运行时确定（app.getAppPath() 在 ready 前也可用）。
 */
function runPython(scriptName: string, args: string[]): Promise<string> {
  const scriptsDir = join(app.getAppPath(), '..')
  const scriptPath = join(scriptsDir, scriptName)

  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [scriptPath, ...args], {
      cwd: scriptsDir,
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    proc.on('close', (code: number) => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(stderr.trim() || `Python exited with code ${code}`))
      }
    })
    proc.on('error', (err: Error) => {
      reject(new Error(`Failed to start Python: ${err.message}`))
    })
  })
}

// ── IPC 处理器 ──────────────────────────────────────────────
ipcMain.handle('bgm:search', async (_event, keyword: string) => {
  const output = await runPython('search_anime.py', [keyword, 'n', '--json'])
  return JSON.parse(output)
})

ipcMain.handle('bgm:detail', async (_event, subjectId: number) => {
  const output = await runPython('bgm_detail.py', [String(subjectId)])
  return JSON.parse(output)
})

ipcMain.handle('xifan:captcha', async () => {
  const output = await runPython('xifan_api.py', ['captcha'])
  return JSON.parse(output)
})

ipcMain.handle('xifan:verify', async (_event, code: string) => {
  const output = await runPython('xifan_api.py', ['verify', code])
  return JSON.parse(output)
})

ipcMain.handle('xifan:search', async (_event, keyword: string) => {
  const output = await runPython('xifan_api.py', ['search', keyword])
  return JSON.parse(output)
})

ipcMain.handle('xifan:watch', async (_event, watchUrl: string) => {
  const output = await runPython('xifan_api.py', ['watch', watchUrl])
  return JSON.parse(output)
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

// Push download speed to renderer every second
setInterval(() => {
  const bps = _speedAccum
  _speedAccum = 0
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('system:speed', bps)
  }
}, 1000)

// ── Episode Queue Manager ────────────────────────────────────
interface EpQueue {
  title: string
  templates: string[]
  savePath: string | null
  pending: number[]        // normal order queue
  priorityFront: number[]  // played after current finishes (high priority)
  pausedEps: Set<number>   // per-episode paused by user
  current: number | null
  currentProc: ReturnType<typeof spawn> | null
  taskPaused: boolean
  killedForEpPause: boolean // current was killed for ep-level pause (not an error)
  cancelled: boolean
  sender: Electron.WebContents
}

const episodeQueues = new Map<string, EpQueue>()

function startNextEp(taskId: string): void {
  const q = episodeQueues.get(taskId)
  if (!q || q.taskPaused || q.cancelled || q.current !== null) return

  // Pick next: priority first, then normal pending
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
    // Queue exhausted — done only if no eps are sitting in pausedEps
    if (q.pausedEps.size === 0) {
      episodeQueues.delete(taskId)
      _epLastBytes.delete(taskId)
      q.sender.send('download:progress', taskId, { type: 'all_done' })
    }
    // Otherwise we wait; user must resume paused eps manually
    return
  }

  q.current = ep
  const scriptsDir = join(app.getAppPath(), '..')
  const spawnArgs = [join(scriptsDir, 'xifan_api.py'), 'download-single', q.title, String(ep)]
  if (q.savePath) spawnArgs.push('--save-dir', q.savePath)
  spawnArgs.push(...q.templates)
  const proc = spawn(PYTHON_BIN, spawnArgs, { cwd: scriptsDir })
  q.currentProc = proc

  let buf = ''
  proc.stdout.on('data', (data: Buffer) => {
    buf += data.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const ev = JSON.parse(trimmed) as Record<string, unknown>
        // Track bytes for download speed calculation
        if (ev.type === 'ep_progress' && typeof ev.bytes === 'number') {
          const taskMap = _epLastBytes.get(taskId) ?? new Map<number, number>()
          const prev = taskMap.get(Number(ev.ep)) ?? 0
          _speedAccum += Math.max(0, (ev.bytes as number) - prev)
          taskMap.set(Number(ev.ep), ev.bytes as number)
          _epLastBytes.set(taskId, taskMap)
        }
        // Don't forward the single-ep 'all_done' — we handle queue completion ourselves
        if (ev.type !== 'all_done') {
          q.sender.send('download:progress', taskId, ev)
        }
      } catch { /* ignore non-JSON */ }
    }
  })

  proc.on('close', () => {
    q.killedForEpPause = false
    q.current = null
    q.currentProc = null
    if (q.cancelled) return
    startNextEp(taskId)
  })

  proc.on('error', () => {
    q.current = null
    q.currentProc = null
    q.sender.send('download:progress', taskId, { type: 'ep_error', ep, msg: 'Process error' })
    startNextEp(taskId)
  })
}

ipcMain.handle(
  'xifan:download',
  async (event, title: string, templates: string[], startEp: number, endEp: number, savePath?: string) => {
    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const pending = Array.from({ length: endEp - startEp + 1 }, (_, i) => startEp + i)
    episodeQueues.set(taskId, {
      title,
      templates,
      savePath: savePath ?? null,
      pending,
      priorityFront: [],
      pausedEps: new Set(),
      current: null,
      currentProc: null,
      taskPaused: false,
      killedForEpPause: false,
      cancelled: false,
      sender: event.sender,
    })
    startNextEp(taskId)
    return { started: true, taskId }
  }
)

ipcMain.handle('xifan:download-cancel', (_event, taskId: string) => {
  const q = episodeQueues.get(taskId)
  if (q) {
    q.cancelled = true
    q.currentProc?.kill()
    episodeQueues.delete(taskId)
  }
  return { cancelled: true }
})

ipcMain.handle('xifan:download-pause', (_event, taskId: string) => {
  const q = episodeQueues.get(taskId)
  if (q) {
    q.taskPaused = true
    // Pause the current episode process at OS level
    if (q.currentProc?.pid) process.kill(q.currentProc.pid, 'SIGSTOP')
  }
  return { paused: true }
})

ipcMain.handle('xifan:download-resume', (_event, taskId: string) => {
  const q = episodeQueues.get(taskId)
  if (q) {
    q.taskPaused = false
    if (q.current !== null && q.currentProc?.pid) {
      // Resume the paused process
      process.kill(q.currentProc.pid, 'SIGCONT')
    } else {
      startNextEp(taskId)
    }
  }
  return { resumed: true }
})

// Pause a specific episode: kill its process (if running), skip it for now
ipcMain.handle('xifan:download-pause-ep', (_event, taskId: string, ep: number) => {
  const q = episodeQueues.get(taskId)
  if (!q) return { paused: false }

  q.pausedEps.add(ep)
  q.sender.send('download:progress', taskId, { type: 'ep_paused', ep })

  if (q.current === ep && q.currentProc) {
    // Kill current download so the next ep in queue can start
    q.killedForEpPause = true
    q.currentProc.kill()
    // close handler will call startNextEp
  }
  return { paused: true }
})

// Resume a specific episode: move it to the front of the priority queue
ipcMain.handle('xifan:download-resume-ep', (_event, taskId: string, ep: number) => {
  const q = episodeQueues.get(taskId)
  if (!q) return { resumed: false }

  q.pausedEps.delete(ep)
  q.priorityFront.unshift(ep)
  q.sender.send('download:progress', taskId, { type: 'ep_queued', ep })

  // If nothing is downloading right now (and task not paused), start immediately
  if (q.current === null && !q.taskPaused) {
    startNextEp(taskId)
  }
  return { resumed: true }
})

// Re-queue specific episodes for a completed task, reusing the same taskId
// so that progress events update the existing store entry.
ipcMain.handle(
  'xifan:download-requeue',
  async (event, taskId: string, title: string, templates: string[], eps: number[], savePath?: string) => {
    episodeQueues.set(taskId, {
      title,
      templates,
      savePath: savePath ?? null,
      pending: [...eps],
      priorityFront: [],
      pausedEps: new Set(),
      current: null,
      currentProc: null,
      taskPaused: false,
      killedForEpPause: false,
      cancelled: false,
      sender: event.sender,
    })
    startNextEp(taskId)
    return { started: true }
  }
)

// Retry failed episodes: add them to front of priority queue
ipcMain.handle('xifan:download-retry', (_event, taskId: string, _title: string, _templates: string[], failedEps: number[]) => {
  const q = episodeQueues.get(taskId)
  if (!q) return { started: false }

  // Move failed eps back into priority queue
  for (const ep of [...failedEps].reverse()) {
    q.pausedEps.delete(ep)
    q.priorityFront.unshift(ep)
  }

  if (q.current === null && !q.taskPaused) {
    startNextEp(taskId)
  }
  return { started: true }
})
// ────────────────────────────────────────────────────────────

ipcMain.handle('system:pick-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})

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

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

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

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
