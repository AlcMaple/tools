/**
 * 应用内自动更新 —— 国内加速为主,直连 GitHub 兜底。
 *
 * **不能用 electron-updater 默认的 GitHub provider**:产物走 objects.githubusercontent.com
 * 国内无魔法连 feed 文件都拉不到,整个流程死在第一步。ghproxy 系反代国内可达,但它不认
 * `/releases/latest/` 重定向(502)、也不放行 `releases.atom`(403)。能走通的只有两种:
 * 固定 tag 的产物下载,和 raw.githubusercontent.com 上的小文件。
 *
 * 所以分两步:
 *   1. **查版本**:读仓库根目录的 `update-manifest.json`,通道依次 ghproxy-raw → jsdelivr →
 *      直连。**代理列表写在这份远程清单里** —— 哪个代理挂了直接改这个文件,所有已安装的
 *      客户端下次检查就生效,不用重新发版。
 *   2. **下载安装**:拿版本号拼固定 tag 的 URL,用 generic provider 逐个代理试,任一成功即止
 *      全挂再回退直连 GitHub。
 *
 * 平台差异:Windows 走 electron-updater,能静默下载 + 重启安装;macOS 未签名 / 未公证
 * quitAndInstall 在 Sequoia 之后会静默失败,所以只查版本 + 给一条加速的 dmg 直链
 * 用户自己下载拖进 Applications。未打包时完全跳过。
 */

import { app, BrowserWindow, ipcMain, shell, net } from 'electron'
import { autoUpdater } from 'electron-updater'
import { getAutoUpdateCheckEnabled, getUpdateSource } from '../ipc/system'
import { logError } from '../shared/logger'

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
// 只用于「拉 manifest」这一步的引导代理。写死是因为代理列表本身就在 manifest 里
// 有先有鸡还是先有蛋的问题;manifest 极小且有 jsdelivr + 直连两路兜底,写死一两个够用。
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

/** 按 `Major.Minor.Patch` 三段比;本项目不发预发布版本,带 `-beta` 之类后缀的直接 strip 再比。 */
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

/** 用 Electron net 拉一段文本(项目约定:抓取一律走 net,自动读系统代理)。 */
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
 * Windows 的检查 + 下载。autoDownload 关掉,自己驱动逐源尝试:某个源的 latest.yml / exe
 * 拉不到就换下一个,全挂才报错。
 */
async function runWin(manual: boolean): Promise<void> {
  // 「检查中…」只在用户手动点检查时广播。**自动检查不发 checking** —— 自动检查的错误是静默的
  // (按钮留在「检查更新」让用户自己重试),要是自动也发 checking,出错时收不到复位就会永久卡在
  // 「检查中…」。所以自动检查直接从 idle 翻到终态。
  if (manual) broadcast('updater:checking')
  const source = getUpdateSource()
  const manifest = await discoverLatest(source)
  if (!manifest) {
    if (manual) broadcast('updater:error', { message: '无法获取更新信息，请检查网络后重试' })
    return
  }
  const current = app.getVersion()
  if (compareVersions(manifest.version, current) <= 0) {
    // 无新版本时手动 / 自动都广播,按钮显示「已是最新版本」——自动检查靠这条从 idle 翻过去。
    broadcast('updater:not-available', { version: current })
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
      // 这个源失败(latest.yml 502 / exe 拉不到 / 超时),换下一个
      continue
    }
  }
  broadcast('updater:error', { message: '所有更新源均不可用，请稍后重试' })
}

/** macOS 的检查。未签名做不了真·自动安装,只查版本 + 给一条加速的 dmg 直链,用户自行安装。 */
async function runMac(manual: boolean): Promise<void> {
  // 「检查中…」只在手动检查时广播,理由同 Windows 分支。
  if (manual) broadcast('updater:checking')
  const source = getUpdateSource()
  const manifest = await discoverLatest(source)
  if (!manifest) {
    if (manual) broadcast('updater:error', { message: '无法获取更新信息，请检查网络后重试' })
    return
  }
  const current = app.getVersion()
  if (compareVersions(manifest.version, current) <= 0) {
    // 无新版本时手动 / 自动都广播。
    broadcast('updater:not-available', { version: current })
    return
  }
  const proxy = source === 'github' ? '' : (manifest.proxies[0] ?? '')
  // dmg 文件名必须和 electron-builder 的 artifactName 模板对齐:
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
    // 未捕获异常。用户可见的错误由编排函数在所有源都失败后统一报；这里只落盘留痕。
    autoUpdater.on('error', (err) => { logError('updater:autoUpdater', err) })
  }

  // 启动后延迟 3s 静默检查（不阻塞首屏），受 autoUpdateCheckEnabled 控制。
  setTimeout(() => {
    if (!getAutoUpdateCheckEnabled()) return
    // 后台静默检查:不弹错给用户(不该开机就报错打扰),但失败落盘留痕可查。
    if (isMac) runMac(false).catch((err) => logError('updater:autoCheck', err))
    else runWin(false).catch((err) => logError('updater:autoCheck', err))
  }, 3000)
}
