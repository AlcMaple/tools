import { app, shell, BrowserWindow, protocol, ipcMain } from 'electron'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { scanLibrary, startLibraryWatch, reconcilePaths, incrementalUpdate, type LibraryEntry } from './library/api'
import { createTray, destroyTray } from './tray'
import { registerAllIpc, getMinimizeOnClose } from './ipc'
import { startSpeedBroadcast } from './shared/speed-tracker'
import { setupUpdater } from './updater'

// ── IPC registration ─────────────────────────────────────────
registerAllIpc()
startSpeedBroadcast()

// archivist:// 注册成 privileged + standard scheme —— 这样它的响应才会进
// Chromium 的 HTTP 缓存、处理器里的 Cache-Control 才生效。否则（非标准 scheme）
// 封面每次组件重挂载（切页面 / Calendar 滚动 lazy 重进视口）都重新读盘+解码,
// 表现为"封面发黑→闪一下加载"。
//
// ⚠️ standard scheme **不接受空 host** 的 `archivist:///路径`（路径解析错乱、
// 封面全 404，已踩坑）—— 所以 toArchivistUrl 用占位 host `local`，URL 形如
// `archivist://local/Users/.../267215.jpg`。必须在 app ready 前调用。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'archivist',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

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
    // 窗口底色给暗色主题的 background(#131313)，而不是默认白 —— 否则
    // 内容首帧画出来之前会闪一下刺眼的白。配合 index.html 里的暖色启动屏，
    // 从第一帧起就是项目自己的暗色调。
    backgroundColor: '#131313',
    autoHideMenuBar: true,
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  // 一次性、无闪烁地显示窗口。两道闸都满足才 show：
  //
  //   painted（'ready-to-show'）—— Electron 保证"此时显示不会有视觉闪烁"，
  //     即合成器已经有可显示的首帧。**Windows 必须等它**：否则 show() 早于
  //     首帧合成，窗口客户区会先白一下（backgroundColor 盖不住还没合成的
  //     surface，这正是之前 Windows 仍白屏的根因）。macOS 合成器不会白闪，
  //     所以以前只靠 renderer-ready 在 Mac 上看着没事、Windows 却露馅。
  //   contentReady（'app:renderer-ready'）—— 渲染进程在 React 挂载完 +
  //     document.fonts.ready 后才发，等它是为了避免图标 / 文字（尤其 3.9MB
  //     图标字体）加载完后陆续 pop-in 的二次闪烁。
  //
  // 兜底：首帧已绘制后字体最多再等到 graceTimer（6s 封顶），信号迟到也照显示；
  // hardTimer 9s 是绝对底线，连 ready-to-show 都没来（崩溃 / 老 preload）也不黑窗。
  let revealed = false
  let painted = false
  let contentReady = false
  const maybeReveal = (): void => {
    if (revealed || mainWindow.isDestroyed()) return
    if (!painted || !contentReady) return
    revealed = true
    clearTimeout(graceTimer)
    clearTimeout(hardTimer)
    mainWindow.show()
  }
  mainWindow.once('ready-to-show', () => { painted = true; maybeReveal() })
  ipcMain.once('app:renderer-ready', () => { contentReady = true; maybeReveal() })
  const graceTimer = setTimeout(() => { contentReady = true; maybeReveal() }, 6000)
  const hardTimer = setTimeout(() => {
    painted = true
    contentReady = true
    maybeReveal()
  }, 9000)

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
      // URL 形如 archivist://local/Users/mac/.../267215.jpg（host=local 占位,
      // 见 cover-cache.ts toArchivistUrl）。standard scheme 下用 new URL 取
      // pathname 最稳：/Users/... 或 /C:/Users/...（Windows 盘符）。
      const pathname = decodeURIComponent(new URL(request.url).pathname)
      // Windows 盘符路径有引导斜杠：/C:/Users/... → C:/Users/...
      const filePath = pathname.replace(/^\/([A-Za-z]:)/, '$1')
      const data = await readFile(filePath)
      // 按扩展名给正确 Content-Type（封面可能是 png/webp/gif，不全是 jpeg）。
      const ext = filePath.split('.').pop()?.toLowerCase()
      const contentType =
        ext === 'png' ? 'image/png'
        : ext === 'webp' ? 'image/webp'
        : ext === 'gif' ? 'image/gif'
        : 'image/jpeg'
      // 长缓存头 —— 配合 standard scheme 注册才生效。封面按 bgmId 命名、内容
      // 基本永不变（cover-cache skip-if-exists），标 immutable 让渲染进程长期
      // 缓存：切页面 / 滚动重进视口直接命中缓存、瞬时出图，不再发黑闪一下。
      //
      // **Content-Length 必须显式设置**：注册成 standard scheme 后 Chromium 按
      // HTTP 语义读响应体，没有 Content-Length 时较大的响应会被提前截断（详情页
      // 600px 大封面只渲染上半截就停）。小图（480）能一次塞完没暴露，大图就露馅。
      return new Response(data, {
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(data.length),
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  })

  if (process.platform === 'darwin') {
    app.dock.setIcon(join(__dirname, '../../resources/icon.png'))
  }

  createWindow()
  createTray(exitApp)
  setupUpdater()

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
