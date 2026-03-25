import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { spawn } from 'child_process'

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

// Track running download processes by taskId
const downloadProcesses = new Map<string, ReturnType<typeof spawn>>()

ipcMain.handle(
  'xifan:download',
  async (event, title: string, templates: string[], startEp: number, endEp: number) => {
    const scriptsDir = join(app.getAppPath(), '..')
    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`

    const proc = spawn(
      PYTHON_BIN,
      [join(scriptsDir, 'xifan_api.py'), 'download', title, String(startEp), String(endEp), ...templates],
      { cwd: scriptsDir }
    )

    downloadProcesses.set(taskId, proc)

    let buf = ''
    proc.stdout.on('data', (data: Buffer) => {
      buf += data.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const ev = JSON.parse(trimmed)
          event.sender.send('download:progress', taskId, ev)
        } catch {
          // ignore non-JSON lines (tqdm output etc.)
        }
      }
    })

    proc.on('close', (code: number) => {
      downloadProcesses.delete(taskId)
      if (code !== 0) {
        event.sender.send('download:progress', taskId, { type: 'all_done', error: true })
      }
    })

    proc.on('error', () => {
      downloadProcesses.delete(taskId)
      event.sender.send('download:progress', taskId, { type: 'all_done', error: true })
    })

    return { started: true, pid: proc.pid, taskId }
  }
)

ipcMain.handle('xifan:download-cancel', (_event, taskId: string) => {
  const proc = downloadProcesses.get(taskId)
  if (proc) {
    proc.kill()
    downloadProcesses.delete(taskId)
  }
  return { cancelled: true }
})
// ────────────────────────────────────────────────────────────

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
