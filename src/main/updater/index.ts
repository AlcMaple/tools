/**
 * 应用内自动更新 —— 国内加速 + GitHub 回退
 *
 * ## 为什么不能直接用 electron-updater 默认的 GitHub provider
 *
 * GitHub Release 的产物走 `objects.githubusercontent.com`，国内无魔法直接拉
 * 不到（feed 文件 latest.yml 都下不来 → 整个更新流程死在第一步，这是上一版
 * 走 Cloudflare 踩过的坑）。ghproxy 系镜像（`https://ghproxy.net/` 前缀反代
 * GitHub）国内可达，但它**不认 `/releases/latest/` 重定向**（实测 502），也
 * **不放行 `releases.atom`**（403）。能走通的只有：
 *   - 固定 tag 的产物：`{proxy}https://github.com/owner/repo/releases/download/vX/...` ✅
 *   - `raw.githubusercontent.com` 上的小文件（经 ghproxy / jsdelivr）✅
 *
 * ## 方案：两步走
 *
 * 1. **查最新版本**（discoverLatest）：读 repo 根目录 `update-manifest.json`
 *    （`{ version, proxies }`），通道带回退：ghproxy-raw → jsdelivr → 直连。
 *    proxies 列表写在这份远程清单里 —— 哪个代理挂了直接改这文件，**所有已
 *    安装客户端下次检查就生效，不用重新发版**（解决「挂了就换」的维护痛点）。
 * 2. **下载安装**：拿到版本号后拼**固定 tag** 的 ghproxy URL，用
 *    electron-updater 的 generic provider 逐个代理尝试（setFeedURL +
 *    checkForUpdates + downloadUpdate），任一成功即止，全挂回退直连 GitHub
 *    （有魔法用户兜底）。复用 electron-updater 的 NSIS 下载 / 安装机制。
 *
 * ## 平台差异
 *
 * - **Windows**：走 electron-updater generic provider，能真·静默下载 + 重启安装。
 * - **macOS**：项目未签名 / 公证，quitAndInstall 在 Sequoia 后静默失败，所以
 *   不调 autoUpdater，只「查版本 → 给一个 ghproxy 加速的 dmg 下载直链」，用户
 *   点 banner 在浏览器里快速下到 dmg 后自行拖入 Applications。
 *
 * dev 模式 (`!app.isPackaged`) 完全跳过 autoUpdater。
 *
 * 更新源由用户设置 `updateSource` 控制：
 *   - 'auto'   ：先国内代理链、失败回退 GitHub（默认，覆盖无魔法用户）
 *   - 'github' ：强制直连 GitHub（有魔法用户想跳过代理时用）
 */

import { app, BrowserWindow, ipcMain, shell, net } from 'electron'
import { autoUpdater } from 'electron-updater'
import { getAutoUpdateCheckEnabled, getUpdateSource } from '../ipc/system'

type Channel =
  | 'updater:checking'
  | 'updater:available'
  | 'updater:download-progress'
  | 'updater:downloaded'
  | 'updater:available-mac'
  | 'updater:not-available'
  | 'updater:error'

const REPO_OWNER = 'AlcMaple'
const REPO_NAME = 'tools'

// update-manifest.json 的获取通道（只拉这份很小的 JSON 用）。
const MANIFEST_RAW = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/update-manifest.json`
const MANIFEST_JSDELIVR = `https://cdn.jsdelivr.net/gh/${REPO_OWNER}/${REPO_NAME}@main/update-manifest.json`
// 引导代理：仅用于「拉 manifest」这一步的 ghproxy 前缀（大文件下载用 manifest
// 里返回的 proxies）。这两个写死是因为 proxies 列表本身在 manifest 里，存在
// 先有鸡还是先有蛋的问题；但 manifest 极小且有 jsdelivr + 直连两路兜底，写死
// 一两个引导代理够用。
const BOOTSTRAP_PROXIES = ['https://ghproxy.net/', 'https://ghfast.top/']

interface UpdateManifest {
  version: string
  proxies: string[]
}

interface MacResult {
  version: string
  downloadUrl: string
  pageUrl: string
}

const isMac = process.platform === 'darwin'
let lastMacResult: MacResult | null = null

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

/** 用 Electron net 拉一段文本（项目约定：抓取一律走 net，自动读系统代理）。 */
function fetchText(url: string, timeoutMs = 10000): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: string | null): void => { if (!done) { done = true; resolve(v) } }
    const req = net.request({ method: 'GET', url, redirect: 'follow' })
    req.setHeader('User-Agent', 'MapleTools-Updater')
    const timer = setTimeout(() => { try { req.abort() } catch { /* noop */ } finish(null) }, timeoutMs)
    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        clearTimeout(timer); finish(null); return
      }
      let buf = ''
      res.on('data', (c) => { buf += c.toString('utf-8') })
      res.on('end', () => { clearTimeout(timer); finish(buf) })
      res.on('error', () => { clearTimeout(timer); finish(null) })
    })
    req.on('error', () => { clearTimeout(timer); finish(null) })
    req.end()
  })
}

/** manifest 的获取通道顺序（按更新源偏好排）。 */
function manifestChannels(source: 'auto' | 'github'): string[] {
  if (source === 'github') return [MANIFEST_RAW, MANIFEST_JSDELIVR]
  return [...BOOTSTRAP_PROXIES.map((p) => p + MANIFEST_RAW), MANIFEST_JSDELIVR, MANIFEST_RAW]
}

/** 逐通道拉 update-manifest.json，第一份合法的即返回。全失败返回 null。 */
async function discoverLatest(source: 'auto' | 'github'): Promise<UpdateManifest | null> {
  for (const url of manifestChannels(source)) {
    const text = await fetchText(url)
    if (!text) continue
    try {
      const json = JSON.parse(text) as Partial<UpdateManifest>
      if (typeof json.version === 'string' && json.version) {
        const proxies = Array.isArray(json.proxies)
          ? json.proxies.filter((p): p is string => typeof p === 'string' && p.length > 0)
          : []
        return { version: json.version.replace(/^v/, ''), proxies }
      }
    } catch { /* 这个通道返回的不是合法 JSON，试下一个 */ }
  }
  return null
}

/** 拼某版本的固定 tag release 目录 URL（proxy 为 '' 表示直连 GitHub）。 */
function releaseBase(proxy: string, version: string): string {
  return `${proxy}https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/v${version}/`
}

/** Windows 下载阶段要依次尝试的 feed base 列表。 */
function downloadBases(source: 'auto' | 'github', manifest: UpdateManifest): string[] {
  const direct = releaseBase('', manifest.version)
  if (source === 'github') return [direct]
  // 代理链在前，直连兜底在最后（有魔法用户即便所有代理挂了也能走直连）。
  return [...manifest.proxies.map((p) => releaseBase(p, manifest.version)), direct]
}

/**
 * Windows 检查 + 下载流程。autoDownload 关掉，自己驱动「逐源尝试」：
 * 某个源的 latest.yml / exe 拉不到就换下一个，全挂才报错。
 */
async function runWin(manual: boolean): Promise<void> {
  broadcast('updater:checking')
  const source = getUpdateSource()
  const manifest = await discoverLatest(source)
  if (!manifest) {
    if (manual) broadcast('updater:error', { message: '无法获取更新信息，请检查网络后重试' })
    return
  }
  const current = app.getVersion()
  if (compareVersions(manifest.version, current) <= 0) {
    if (manual) broadcast('updater:not-available', { version: current })
    return
  }
  broadcast('updater:available', { version: manifest.version })

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  for (const base of downloadBases(source, manifest)) {
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url: base })
      const result = await autoUpdater.checkForUpdates()
      if (!result?.updateInfo || compareVersions(result.updateInfo.version, current) <= 0) {
        continue
      }
      await autoUpdater.downloadUpdate()
      return // 成功：update-downloaded 事件已发给渲染层
    } catch {
      // 这个源（latest.yml 502 / exe 拉不到 / 超时）失败，换下一个
      continue
    }
  }
  broadcast('updater:error', { message: '所有更新源均不可用，请稍后重试' })
}

/**
 * macOS 检查流程。未签名做不了真·自动安装，只查版本 + 给一个 ghproxy 加速的
 * dmg 直链，让用户在浏览器快速下载后自行安装。
 */
async function runMac(manual: boolean): Promise<void> {
  broadcast('updater:checking')
  const source = getUpdateSource()
  const manifest = await discoverLatest(source)
  if (!manifest) {
    if (manual) broadcast('updater:error', { message: '无法获取更新信息，请检查网络后重试' })
    return
  }
  const current = app.getVersion()
  if (compareVersions(manifest.version, current) <= 0) {
    if (manual) broadcast('updater:not-available', { version: current })
    return
  }
  const proxy = source === 'github' ? '' : (manifest.proxies[0] ?? '')
  // dmg 文件名要和 electron-builder 的 artifactName 模板对齐：
  // `${productName}_${version}_macos_${arch}.${ext}`（见 package.json build.dmg）
  const dmg = `${releaseBase(proxy, manifest.version)}MapleTools_${manifest.version}_macos_arm64.dmg`
  lastMacResult = {
    version: manifest.version,
    downloadUrl: dmg,
    pageUrl: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/v${manifest.version}`,
  }
  broadcast('updater:available-mac', { version: manifest.version, releaseUrl: dmg })
}

export function setupUpdater(): void {
  // IPC 无论 dev / packaged 都注册，handler 自己判断。
  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) return { skipped: true, reason: 'dev-mode' }
    if (isMac) await runMac(true)
    else await runWin(true)
    return { ok: true }
  })

  ipcMain.handle('updater:install', () => {
    if (isMac) {
      // mac 没在本地下载文件，给浏览器一个加速 dmg 直链
      if (lastMacResult?.downloadUrl) shell.openExternal(lastMacResult.downloadUrl)
      return { ok: true }
    }
    // Windows：generic provider 已下载完，触发重启安装
    try {
      autoUpdater.quitAndInstall()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error)?.message }
    }
  })

  ipcMain.handle('updater:open-release-page', () => {
    const url = lastMacResult?.pageUrl
      ?? `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`
    shell.openExternal(url)
    return { ok: true }
  })

  // dev 模式到此为止：不挂 autoUpdater 事件、不跑自动检查
  if (!app.isPackaged) return

  if (!isMac) {
    // 进度 / 下载完成走事件转发；available / not-available / error 由上面的
    // 编排函数手动 broadcast（避免「逐源尝试」时每次失败都炸一个 error 给 UI）。
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
    // 必须挂一个 error 监听，否则 electron-updater 内部 emit('error') 会变成
    // 未捕获异常。用户可见的错误由编排函数在所有源都失败后统一报。
    autoUpdater.on('error', () => { /* swallow; runWin 统一处理 */ })
  }

  // 启动后延迟 3s 静默检查（不阻塞首屏），受 autoUpdateCheckEnabled 控制。
  setTimeout(() => {
    if (!getAutoUpdateCheckEnabled()) return
    if (isMac) runMac(false).catch(() => { /* silent */ })
    else runWin(false).catch(() => { /* silent */ })
  }, 3000)
}
