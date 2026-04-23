import { app, BrowserWindow, Tray, Menu } from 'electron'
import { join } from 'path'

let appTray: Tray | null = null

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function showWindow(): void {
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

export function createTray(onExit: () => void): void {
  if (appTray) return
  // 仅 Windows 启用托盘；macOS 用 Dock，Linux 暂无 PNG 资源
  if (process.platform !== 'win32') return

  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(__dirname, '../../resources/icon.ico')

  appTray = new Tray(iconPath)
  appTray.setToolTip('MapleTools')

  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏窗口', click: toggleWindow },
    { type: 'separator' },
    { label: '退出 MapleTools', click: onExit },
  ])
  appTray.setContextMenu(menu)

  appTray.on('click', showWindow)
  appTray.on('double-click', showWindow)
}

export function destroyTray(): void {
  if (!appTray) return
  appTray.destroy()
  appTray = null
}
