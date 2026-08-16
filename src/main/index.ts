// ⚠️ 必须是第一个 import —— 在任何 fs 异步操作前把 libuv 线程池调大(见模块注释)。
import './shared/uv-bootstrap'
import { app, shell, BrowserWindow, protocol, ipcMain, nativeImage } from 'electron'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { scanLibrary, startLibraryWatch, reconcilePaths, incrementalUpdate, type LibraryEntry } from './library/api'
import { createTray, destroyTray } from './tray'
import { registerAllIpc, getMinimizeOnClose } from './ipc'
import { startSpeedBroadcast, stopSpeedBroadcast } from './shared/speed-tracker'
import { setupUpdater } from './updater'
import { setupBgmOfflineIndex } from './bgm/offline-index'
import { initConsoleCapture, logInfo } from './shared/logger'
import { MEDIA_PROXY_SCHEME, registerMediaProxy } from './shared/media-proxy'
import { disposeMediaCache, sweepMediaCacheDir } from './shared/media-cache'
import { disposeHlsPrefetch } from './shared/hls-prefetch'
import { disposeXifanBackgroundWindow, isXifanBackgroundWindow } from './xifan/browser-challenge'

// 接管 console.error/warn → 同时落盘到 main.log,让主进程所有报错可查。
initConsoleCapture()

// ── IPC registration ─────────────────────────────────────────
registerAllIpc()
startSpeedBroadcast()

// dev 看护：父进程（electron-vite / npm）没了就自己退出，避免孤儿进程空转烤机
// （2026-08-16 事故：主进程卡在退出流程，被过继给 launchd 后 97.5% CPU 挂后台）。
// 打包版不启用 —— Finder/Dock 启动时父进程本来就是 launchd（ppid 恒为 1）。
// 每 5 秒一次 kill(ppid,0) 级别的探测，开销可忽略；unref 掉，不阻止事件循环自然退出。
if (!app.isPackaged) {
  const orphanWatch = setInterval(() => {
    if (process.ppid === 1) app.quit()
  }, 5000)
  orphanWatch.unref()
}

// archivist:// 注册成 privileged + standard scheme,它的响应才会进 Chromium 的 HTTP 缓存、
// 处理器里的 Cache-Control 才生效。否则封面每次组件重挂载都要重新读盘 + 解码,表现为
// 「封面发黑 → 闪一下加载」。
//
// ⚠️ standard scheme **不接受空 host**(`archivist:///路径` 会解析错乱、封面全 404)
// 所以用占位 host `local`,URL 形如 `archivist://local/Users/.../267215.jpg`。必须在 ready 前调。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'archivist',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  {
    // 在线播放媒体流代理:远端 mp4 / HLS 经主进程取流后用自定义协议回给 <video> 和 hls.js
    // 绕开渲染进程 origin 对跨源媒体的拦截(见 shared/media-proxy.ts)。
    //
    // ⚠️ 别顺手加 `corsEnabled: true` —— 那是**主动 opt-in 进 CORS 检查**,加了之后 hls.js 取
    // 播放列表/分片就必须让 handler 回 ACAO 头才放行。不加时这个 scheme 根本不过 CORS。
    scheme: MEDIA_PROXY_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
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
  // 别因为零散的异步错误(如 fs 写入赛过流销毁)整个退出:记进日志即可。
  console.error('[uncaughtException]', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})

// ── Webview 硬化 ────────────────────────────────────────────────────────────
// 自定义源用 <webview> 嵌**真实播放页**,页面里的第三方 JS 会跑起来。两道闸:
//   1. guest 的一切 window.open / target=_blank **一律拦死** —— 盗版站最常见的广告手法
//      就是点哪弹哪;正经外跳本来也不该由不受信页面替用户决定。
//   2. attach 时剥掉 preload、禁 nodeIntegration。默认本就如此,显式钉死防以后手滑放开。
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  }
  // 在嵌主(主窗口 webContents)上净化即将 attach 的 webview 参数
  contents.on('will-attach-webview', (_evt, webPreferences) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
  })
})

app.on('before-quit', () => {
  isAppQuitting = true
  // 退出时一并收掉在线播放的缓冲。渲染层离开 /play 会主动 media:release,但「看到一半直接
  // 关应用」没有那个时机。
  disposeMediaCache()
  disposeHlsPrefetch()
  // 速度广播是常驻心跳，退出时停掉 —— 它每秒向所有窗口发送，退出竞态窗口里
  // 会向已销毁的渲染帧发送并抛错，别让它参与退出流程。
  stopSpeedBroadcast()
})
app.on('will-quit', () => {
  destroyTray()
  // dev 下 Ctrl+C 会让整组进程收到 SIGINT,这里强制 code=0 退出,父进程才不会打
  // 「exited with signal」。**打包环境不能 process.exit**,否则日志的异步写入会被截断。
  if (!app.isPackaged) process.exit(0)
})

// ── Window ───────────────────────────────────────────────────
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    // 最小尺寸卡在手机版设计宽度（~390），不让窗口无限缩小到布局崩坏。
    minWidth: 390,
    minHeight: 600,
    title: 'MapleTools',
    show: false,
    // 窗口底色给暗色主题的背景色而不是默认白 —— 否则首帧画出来之前会闪一下刺眼的白。
    backgroundColor: '#131313',
    autoHideMenuBar: true,
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // 播放页用 <webview partition="persist:bili"> 嵌 B 站播放器:第一方 cookie 才能带上登录态
      // iframe 做不到。
      webviewTag: true,
    },
  })

  // 一次性、无闪烁地显示窗口,两道闸都满足才 show:
  //   - `ready-to-show`:合成器已有可显示的首帧。**Windows 必须等它** —— 否则 show() 早于
  //     首帧合成,客户区会先白一下(backgroundColor 盖不住还没合成的 surface)。macOS 合成器
  //     不白闪,所以只等 renderer-ready 时 Mac 看着没事、Windows 露馅。
  //   - `app:renderer-ready`:渲染进程在 React 挂载完 + document.fonts.ready 之后才发
  //     等它是为了避免图标字体(3.9MB)加载完后陆续 pop-in 的二次闪烁。
  // 兜底:graceTimer 6s 封顶,hardTimer 9s 是绝对底线 —— 连 ready-to-show 都没来也不黑窗。
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

  // F12 / Ctrl+Shift+I 开关 DevTools,仅未打包时生效 —— 打包版不给普通用户暴露开发者工具。
  if (!app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return
      const isF12 = input.key === 'F12'
      const isInspect = (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i'
      if (isF12 || isInspect) {
        mainWindow.webContents.toggleDevTools()
      }
    })
  }

  mainWindow.on('close', (event) => {
    if (getMinimizeOnClose() && !isAppQuitting) {
      event.preventDefault()
      mainWindow.hide()
      // macOS:隐藏到托盘后把 Dock 图标也撤掉,只留顶部 logo、不在 Dock 占位。
      if (process.platform === 'darwin') app.dock?.hide()
    }
  })
  // Xifan 那个无界面后台页面不能在主窗口关闭后独自留住进程,更不能被托盘的「显示主界面」
  // 误当成主窗口显示出来。
  mainWindow.on('closed', () => {
    disposeXifanBackgroundWindow()
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
      const win = BrowserWindow.getAllWindows().find((item) => !isXifanBackgroundWindow(item))
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    })
  }
}

app.whenReady().then(() => {
  // 在线播放媒体流代理(mtmedia://)—— 必须 app ready 后注册。
  registerMediaProxy()
  // 上次被强杀 / 崩溃时遗留的播放临时文件在这里收拾(几百 MB 级别,不能任其堆积)
  void sweepMediaCacheDir()

  protocol.handle('archivist', async (request) => {
    try {
      // URL 形如 archivist://local/Users/.../267215.jpg(host=local 是占位)。standard scheme 下
      // 用 new URL 取 pathname 最稳:/Users/... 或 /C:/Users/...(Windows 盘符)。
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
      // 长缓存头 —— 要配合 standard scheme 注册才生效。封面按 bgmId 命名、内容基本不变,标
      // immutable 让渲染进程长期缓存,切页面 / 滚动重进视口直接命中、瞬时出图。
      //
      // **Content-Length 必须显式设置**:注册成 standard scheme 后 Chromium 按 HTTP 语义读响应体
      // 没有它时较大的响应会被提前截断(详情页 600px 大封面只渲染上半截就停)。
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
    // Dock 图标读不到就跳过。⚠️ **绝不能让这里抛错** —— 它在 createWindow() 之前执行
    // 一抛整个 whenReady 回调中断,窗口直接出不来,只剩一个 Dock 图标。
    const dockPng = app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(__dirname, '../../resources/icon.png')
    const dockIcon = nativeImage.createFromPath(dockPng)
    if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon)
  }

  createWindow()
  createTray(exitApp)
  setupUpdater()
  setupBgmOfflineIndex()

  let silentScanRunning = false
  const runSilentScan = async (): Promise<void> => {
    if (silentScanRunning) return
    silentScanRunning = true
    // 探子:启动期全量扫描占用主进程事件循环的总时长。冷启动首开 MyAnime 慢的怀疑点之一 ——
    // 这段时间里封面本地化的 IPC 会被它挤在后面。
    const scanT0 = Date.now()
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
          win.webContents.send('library:updated', newEntries)
        }
      })
    } finally {
      silentScanRunning = false
      logInfo('perf', `startup:silent-scan ${Date.now() - scanT0}ms`)
    }
  }

  // 媒体库增量同步 + 目录监听:对账剔除残留路径 → 同步 → 起目录监听。
  const kickLibraryWork = (): void => {
    reconcilePaths()
    runSilentScan().catch(err => console.error('启动对账扫描失败:', err))

    // 启动后台目录变动监听(增量更新:只重扫变化发生的子目录,静默不触发全屏加载)。
    // 探子:原生递归 fs.watch 的设置应为毫秒级(每库根 1 个句柄)。若这里出现几百 ms+,
    // 说明监听实现又退化回"逐目录开句柄",主进程会冻结。
    const watchT0 = Date.now()
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
            win.webContents.send('library:updated', updatedEntries)
          }
        })
      } finally {
        silentScanRunning = false
      }
    })
    logInfo('perf', `startup:watch-setup ${Date.now() - watchT0}ms`)
  }

  // 把库同步 / 目录监听推迟到首屏交互之后再跑。同步会向 fs 线程池灌入大量
  // readdir/stat/open,冷启动时把 MyAnime 的封面本地化(cacheCover —— 本是磁盘
  // 命中、毫秒级)挤在同一队列后面排到 1s+,首开封面要等一秒多才齐。延后启动让
  // 首次切页/封面先抢到 fs 线程;落地页本就先显示 JsonStore 缓存条目,重扫晚
  // 1~2s 对用户无感。
  //
  // 触发:渲染就绪(app:renderer-ready)后再过一拍给首屏让路;5s 兜底,即便信号
  // 迟到/不来(崩溃/老 preload)也照常扫一次,不会漏扫。
  let libraryKicked = false
  const kickLibraryOnce = (): void => {
    if (libraryKicked) return
    libraryKicked = true
    kickLibraryWork()
  }
  ipcMain.once('app:renderer-ready', () => setTimeout(kickLibraryOnce, 1200))
  setTimeout(kickLibraryOnce, 5000)

  app.on('activate', () => {
    // 点 Dock 图标:没窗口就建,有(可能是被隐藏的)就唤回来 —— 避免「关闭到托盘」
    // 后窗口还在但隐藏着,点 Dock 却没反应。
    const win = BrowserWindow.getAllWindows().find((item) => !isXifanBackgroundWindow(item))
    if (!win) { createWindow(); return }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
})

app.on('window-all-closed', () => {
  // 窗口都关了就退出 —— 不对 macOS 做「关窗不退」的系统默认例外:本应用语义是
  // 关掉「关闭到托盘」后,点 X 就等于退出程序。
  // (开着「关闭到托盘」时,close 被 preventDefault + hide,窗口并未真正销毁,
  //  本事件根本不触发,所以托盘常驻不受影响。)
  app.quit()
})
