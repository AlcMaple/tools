import { app, BrowserWindow, Tray, Menu, nativeImage, NativeImage } from 'electron'
import { join } from 'path'

let appTray: Tray | null = null

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function showWindow(): void {
  // macOS：「关闭到托盘」时我们把 Dock 图标也撤了,从托盘恢复时要先把它带回来。
  if (process.platform === 'darwin') app.dock?.show()
  const win = getMainWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function toggleWindow(): void {
  const win = getMainWindow()
  if (!win) return
  if (win.isVisible() && !win.isMinimized()) win.hide()
  else showWindow()
}

// 托盘图标:Windows 用 .ico;macOS 用 PNG glyph 缩到菜单栏高度,并设为模板图 ——
// 模板图只取 alpha 形状,由系统按菜单栏明暗自动反色(亮色栏黑、暗色栏白),是原生
// 顶部状态栏图标的标准做法。我们的 icon.png 正好是透明底单色 glyph,直接拿来用。
function trayImage(): string | NativeImage | null {
  if (process.platform === 'win32') {
    return app.isPackaged
      ? join(process.resourcesPath, 'icon.ico')
      : join(__dirname, '../../resources/icon.ico')
  }
  // 打包后 icon.png 在 Contents/Resources(extraResources),dev 在 resources/。
  const pngPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '../../resources/icon.png')
  const img = nativeImage.createFromPath(pngPath)
  if (img.isEmpty()) return null // 读不到就返回 null,交给 createTray 跳过,别让 new Tray 抛错
  const sized = img.resize({ width: 18, height: 18 })
  sized.setTemplateImage(true)
  return sized
}

export function createTray(onExit: () => void): void {
  if (appTray) return
  // Windows + macOS 都启用托盘 / 顶部菜单栏;Linux 暂无资源
  if (process.platform !== 'win32' && process.platform !== 'darwin') return

  const img = trayImage()
  if (!img) return // 图标资源缺失:不建托盘也比抛错中断启动好

  appTray = new Tray(img)
  appTray.setToolTip('MapleTools')

  const menu = Menu.buildFromTemplate([
    { label: '显示主界面', click: showWindow },
    { type: 'separator' },
    { label: '退出', click: onExit },
  ])
  appTray.setContextMenu(menu)

  // Windows 习惯左键单击直接唤回窗口;macOS 左键单击弹菜单(系统默认),不另绑。
  if (process.platform === 'win32') {
    appTray.on('click', toggleWindow)
    appTray.on('double-click', showWindow)
  }
}

export function destroyTray(): void {
  if (!appTray) return
  appTray.destroy()
  appTray = null
}
