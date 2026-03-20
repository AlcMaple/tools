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
