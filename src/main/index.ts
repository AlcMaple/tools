import { app, shell, BrowserWindow, protocol } from 'electron'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { scanLibrary, startLibraryWatch, reconcilePaths, incrementalUpdate, type LibraryEntry } from './library/api'
import { createTray, destroyTray } from './tray'
import { registerAllIpc, getMinimizeOnClose } from './ipc'
import { startSpeedBroadcast } from './shared/speed-tracker'

// ── IPC registration ─────────────────────────────────────────
registerAllIpc()
startSpeedBroadcast()

// ── Lifecycle state ──────────────────────────────────────────
let isAppQuitting = false

function exitApp(): void {
  isAppQuitting = true
  app.quit()
}

process.on('SIGINT', exitApp)

process.on('uncaughtException', (err) => {
  // Don't quit on stray async errors (e.g. fs writes racing past stream destroy).
  // Surface them in the log; only quit on truly fatal startup errors via SIGINT path.
  console.error('[uncaughtException]', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})

app.on('before-quit', () => { isAppQuitting = true })
app.on('will-quit', () => {
  destroyTray()
  // 关闭 aowu 用的隐藏 BrowserWindow（如果有），避免泄漏
  void import('./aowu/headless').then(m => m.closeAowuHeadless()).catch(() => {})
  // dev 模式下：Ctrl+C 会让整组进程收到 SIGINT，此处强制以 code=0 退出，
  // 父进程(electron-vite)看到 close(0, null) 就不会打"exited with signal"。
  // 打包环境不能 process.exit，否则 electron-log 之类的异步写入会被截断。
  if (!app.isPackaged) process.exit(0)
})

// ── Window ───────────────────────────────────────────────────
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'MapleTools',
    show: false,
    autoHideMenuBar: true,
    icon: join(__dirname, '../../resources/icon.png'),
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

  mainWindow.on('close', (event) => {
    if (getMinimizeOnClose() && !isAppQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 单实例锁：仅打包后生效，dev 模式跳过避免热重载冲突
if (app.isPackaged) {
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
}

app.whenReady().then(() => {
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

  if (process.platform === 'darwin') {
    app.dock.setIcon(join(__dirname, '../../resources/icon.png'))
  }

  createWindow()
  createTray(exitApp)

  let silentScanRunning = false
  const runSilentScan = async (): Promise<void> => {
    if (silentScanRunning) return
    silentScanRunning = true
    try {
      const newEntries = await scanLibrary((status, current, total) => {
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) {
            win.webContents.send('library:scan-status', { status, currentVal: current, totalVal: total })
          }
        })
      })

      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('library-updated', newEntries)
        }
      })
    } finally {
      silentScanRunning = false
    }
  }

  // 启动时对账一次：剔除已被用户删除的路径，再扫描现有条目
  reconcilePaths()
  runSilentScan().catch(err => console.error('启动对账扫描失败:', err))

  // 启动后台目录变动监听（增量更新：只重扫变化发生的子目录，静默不触发全屏加载）
  startLibraryWatch(async (changedPaths) => {
    if (silentScanRunning) return
    silentScanRunning = true
    try {
      let updatedEntries: LibraryEntry[] = []
      for (const p of changedPaths) {
        updatedEntries = await incrementalUpdate(p)
      }
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('library-updated', updatedEntries)
        }
      })
    } finally {
      silentScanRunning = false
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
