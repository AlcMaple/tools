/**
 * 应用内自动更新
 *
 * 平台分两条路：
 *
 * 1. **Windows** —— 走 electron-updater 的 autoUpdater
 *    - 启动后延迟静默检查
 *    - 发现新版本 → 自动后台下载 → 下载完发 IPC `updater:downloaded` 给渲染层
 *    - 用户点 banner 「重启安装」 → 调 quitAndInstall()
 *
 * 2. **macOS** —— 不调 autoUpdater（项目未做代码签名 / 公证，quitAndInstall
 *    会在 Sequoia 之后静默失败，更新落地但替换后的可执行文件被 Gatekeeper
 *    拒绝运行）。改为：
 *    - GitHub REST API 拉 latest release tag
 *    - 比对 `app.getVersion()`，更高则发 `updater:available-mac` 给渲染层
 *    - 用户点 banner 「前往下载」 → 主进程 shell.openExternal 跳到 release 页
 *
 * dev 模式 (`!app.isPackaged`) 完全跳过，避免 autoUpdater 抛
 * "Skipping update check because application is not packaged"。
 */

import { app, BrowserWindow, ipcMain, shell, net } from 'electron'
import { autoUpdater } from 'electron-updater'
import { getAutoUpdateCheckEnabled } from '../ipc/system'

type Channel =
  | 'updater:checking'
  | 'updater:available'
  | 'updater:download-progress'
  | 'updater:downloaded'
  | 'updater:available-mac'
  | 'updater:not-available'
  | 'updater:error'

interface VersionInfo {
  version: string
  releaseUrl?: string
}

const REPO_OWNER = 'AlcMaple'
const REPO_NAME = 'tools'

function broadcast(channel: Channel, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

/**
 * 用 `Major.Minor.Patch` 三段比对版本号。返回 1 表示 a > b，-1 表示 a < b。
 * 仅支持纯数字段；带 `-beta` / `-rc.1` 之类的预发布后缀本项目当前不发布，
 * 简化处理直接 strip 掉再比。
 */
function compareVersions(a: string, b: string): number {
  const norm = (v: string): number[] =>
    v.replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0)
  const pa = norm(a)
  const pb = norm(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

/** macOS：从 GitHub REST API 读 latest release，比对版本号。 */
function fetchLatestReleaseFromGitHub(): Promise<VersionInfo | null> {
  return new Promise((resolve) => {
    const req = net.request({
      method: 'GET',
      url: `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
      redirect: 'follow',
    })
    req.setHeader('User-Agent', 'MapleTools-Updater')
    req.setHeader('Accept', 'application/vnd.github+json')
    let buf = ''
    let timeout: NodeJS.Timeout | null = setTimeout(() => {
      try { req.abort() } catch { /* noop */ }
      resolve(null)
    }, 10000)
    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        if (timeout) { clearTimeout(timeout); timeout = null }
        resolve(null)
        return
      }
      res.on('data', (chunk) => { buf += chunk.toString('utf-8') })
      res.on('end', () => {
        if (timeout) { clearTimeout(timeout); timeout = null }
        try {
          const json = JSON.parse(buf) as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean }
          if (json.draft || json.prerelease) { resolve(null); return }
          if (!json.tag_name) { resolve(null); return }
          resolve({ version: json.tag_name, releaseUrl: json.html_url })
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => {
      if (timeout) { clearTimeout(timeout); timeout = null }
      resolve(null)
    })
    req.end()
  })
}

let isMac = process.platform === 'darwin'
let lastMacResult: VersionInfo | null = null

/**
 * macOS 检查流程。手动 / 自动共用。
 * @param manual 手动触发时，"已是最新"也会发 not-available 事件供 UI 反馈；
 *               自动触发时静默不打扰。
 */
async function checkMac(manual: boolean): Promise<void> {
  broadcast('updater:checking')
  const latest = await fetchLatestReleaseFromGitHub()
  if (!latest) {
    if (manual) broadcast('updater:error', { message: '无法连接 GitHub' })
    return
  }
  const current = app.getVersion()
  if (compareVersions(latest.version, current) > 0) {
    lastMacResult = latest
    broadcast('updater:available-mac', {
      version: latest.version.replace(/^v/, ''),
      releaseUrl: latest.releaseUrl,
    })
  } else {
    if (manual) broadcast('updater:not-available', { version: current })
  }
}

/**
 * Windows 检查流程。让 electron-updater 自己跑事件 loop（checking-for-update
 * → update-available → download-progress → update-downloaded），我们只
 * 转发到 IPC 给渲染层。
 */
async function checkWin(manual: boolean): Promise<void> {
  try {
    const result = await autoUpdater.checkForUpdates()
    // checkForUpdates 解析成功不代表"有新版本"，它只是返回 metadata。
    // 真正的"无可用更新"会触发 update-not-available 事件（下面注册过）。
    // 这里手动触发时如果什么事件都没炸（result 为 null 或同版本），需要
    // 额外发个 not-available。但 electron-updater 行为不稳定，靠下面的
    // 事件回调判断更可靠，这里就不重复发了。
    void result
  } catch (err) {
    if (manual) {
      broadcast('updater:error', { message: (err as Error)?.message ?? '检查失败' })
    }
  }
}

let manualNotAvailablePending = false

export function setupUpdater(): void {
  // 注册 IPC（无论 dev 还是 packaged 都注册，handler 自己判断）
  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) return { skipped: true, reason: 'dev-mode' }
    if (isMac) await checkMac(true)
    else {
      manualNotAvailablePending = true
      await checkWin(true)
    }
    return { ok: true }
  })

  ipcMain.handle('updater:install', () => {
    if (isMac) {
      // Mac 没下载文件，只跳浏览器
      if (lastMacResult?.releaseUrl) shell.openExternal(lastMacResult.releaseUrl)
      return { ok: true }
    }
    // Windows：autoUpdater 已下载完，触发重启安装
    try {
      autoUpdater.quitAndInstall()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error)?.message }
    }
  })

  ipcMain.handle('updater:open-release-page', () => {
    const url = lastMacResult?.releaseUrl
      ?? `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`
    shell.openExternal(url)
    return { ok: true }
  })

  // dev 模式到此为止：不挂 autoUpdater 事件、不跑自动检查
  if (!app.isPackaged) return

  if (!isMac) {
    // Windows: autoUpdater 配置 + 事件转发
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false  // 用户控制何时重启安装

    autoUpdater.on('checking-for-update', () => {
      broadcast('updater:checking')
    })
    autoUpdater.on('update-available', (info) => {
      broadcast('updater:available', { version: info.version })
    })
    autoUpdater.on('update-not-available', (info) => {
      // 手动触发时才报"已是最新"；自动触发不打扰用户
      if (manualNotAvailablePending) {
        manualNotAvailablePending = false
        broadcast('updater:not-available', { version: info?.version ?? app.getVersion() })
      }
    })
    autoUpdater.on('download-progress', (progress) => {
      broadcast('updater:download-progress', {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      })
    })
    autoUpdater.on('update-downloaded', (info) => {
      broadcast('updater:downloaded', { version: info.version })
    })
    autoUpdater.on('error', (err) => {
      broadcast('updater:error', { message: err?.message ?? '更新出错' })
    })
  }

  // 启动后延迟 3s 静默检查（不阻塞首屏）
  // 受用户设置 `autoUpdateCheckEnabled` 控制 —— 关掉之后启动检查彻底跳过,
  // banner 不会自动弹。但手动入口（设置页的「检查更新」按钮）不受影响,
  // 所以用户即使禁用了自动检查也能在想升级时主动触发一次。
  setTimeout(() => {
    if (!getAutoUpdateCheckEnabled()) return
    if (isMac) checkMac(false).catch(() => { /* silent */ })
    else checkWin(false).catch(() => { /* silent */ })
  }, 3000)
}
