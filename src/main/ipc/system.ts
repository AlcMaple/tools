import { ipcMain, app, dialog, net } from 'electron'
import { join } from 'path'
import { statfs } from 'fs/promises'
import { JsonStore } from '../shared/json-store'

// 默认关闭 —— 跟 OS 惯例对齐（X = 真的退出，不是偷偷常驻），新用户不会
// 被"看似关了其实还在跑"困惑到。需要后台模式的用户进设置打开即可。
let appMinimizeOnClose = false
let appAutoUpdateCheckEnabled = true  // 默认开启 —— 多数用户期望被提醒新版本
// 更新源：'auto' = 优先国内 ghproxy 代理链下载、失败回退 GitHub（默认，覆盖
// 无魔法用户）；'github' = 强制直连 GitHub（有魔法用户想跳过代理时用）。
let appUpdateSource: 'auto' | 'github' = 'auto'

interface AppSettings {
  minimizeOnClose?: boolean
  autoUpdateCheckEnabled?: boolean
  updateSource?: 'auto' | 'github'
}

const settingsStore = new JsonStore<AppSettings>('app_settings.json', (raw) =>
  raw && typeof raw === 'object' ? (raw as AppSettings) : {},
)
// 启动期 bootstrap —— 早于 app-ready、且窗口关闭逻辑(getMinimizeOnClose)同步依赖
// 这几个值,所以用 current() 同步读一次进内存;后续写走异步合并。
{
  const s = settingsStore.current()
  if (typeof s.minimizeOnClose === 'boolean') appMinimizeOnClose = s.minimizeOnClose
  if (typeof s.autoUpdateCheckEnabled === 'boolean') appAutoUpdateCheckEnabled = s.autoUpdateCheckEnabled
  if (s.updateSource === 'auto' || s.updateSource === 'github') appUpdateSource = s.updateSource
}

export function getMinimizeOnClose(): boolean {
  return appMinimizeOnClose
}

/**
 * 是否启用启动时的自动检查更新（默认 true）。
 * 用户关掉之后，主进程的 `setupUpdater()` 启动延迟检查不再触发，banner
 * 永远不会自动弹出 —— 但用户在设置页主动点「检查更新」按钮依然能跑完
 * 整个检查 / 下载 / 提示流程（手动入口不受这个开关控制）。
 */
export function getAutoUpdateCheckEnabled(): boolean {
  return appAutoUpdateCheckEnabled
}

/** 更新源偏好（见上方变量声明）。updater 据此决定走代理链还是直连 GitHub。 */
export function getUpdateSource(): 'auto' | 'github' {
  return appUpdateSource
}

// 各 JSON 持久化都走 JsonStore：内存权威值、异步合并落盘,不再阻塞事件循环。
const historyStore = new JsonStore<unknown[]>('xifan_settings_history.json', (raw) =>
  Array.isArray(raw) ? raw : [],
)
const cacheStore = new JsonStore<Record<string, unknown>>('search_cache.json', (raw) =>
  raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {},
)
const downloadStateStore = new JsonStore<unknown[]>('download_queue.json', (raw) =>
  Array.isArray(raw) ? raw : [],
)

export function registerSystemIpc(): void {
  ipcMain.handle('system:get-setting', (_event, key: string) => {
    if (key === 'minimizeOnClose') return appMinimizeOnClose
    if (key === 'autoUpdateCheckEnabled') return appAutoUpdateCheckEnabled
    if (key === 'updateSource') return appUpdateSource
    return null
  })

  ipcMain.handle('system:set-setting', (_event, key: string, value: unknown) => {
    if (key === 'minimizeOnClose') {
      appMinimizeOnClose = Boolean(value)
      settingsStore.update((s) => { s.minimizeOnClose = appMinimizeOnClose })
    } else if (key === 'autoUpdateCheckEnabled') {
      appAutoUpdateCheckEnabled = Boolean(value)
      settingsStore.update((s) => { s.autoUpdateCheckEnabled = appAutoUpdateCheckEnabled })
    } else if (key === 'updateSource') {
      appUpdateSource = value === 'github' ? 'github' : 'auto'
      settingsStore.update((s) => { s.updateSource = appUpdateSource })
    }
  })

  ipcMain.handle('system:disk-free', async () => {
    try {
      const stats = await statfs(join(app.getAppPath(), '..'))
      return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize }
    } catch {
      return { free: 0, total: 0 }
    }
  })

  ipcMain.handle('system:pick-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  // 把"用户没设置 saveDir 时"主进程会回退到的路径暴露给 renderer。
  // 主进程下载器（xifan / aowu / girigiri）的 fallback 都是 `app.getPath('downloads')`,
  // Settings 页用这个值显示"留空时实际会保存到哪"，避免 UI 上写"应用同级目录"
  // 误导用户。同一个值；只读；调用频率极低，不缓存。
  ipcMain.handle('system:default-downloads', () => app.getPath('downloads'))

  ipcMain.handle('system:connectivity', () => {
    // Probe multiple endpoints in parallel — any 2xx/3xx response means online.
    // Google's generate_204 is blocked in mainland China, so we include domestic
    // alternatives. First success wins; resolve false only if all fail/timeout.
    const PROBES = [
      'https://www.baidu.com',
      'https://connectivitycheck.gstatic.com/generate_204',
    ]
    return new Promise<boolean>((resolve) => {
      let settled = false
      let failures = 0
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(ok)
      }
      const done = (ok: boolean): void => {
        if (settled) return
        if (ok) { finish(true); return }
        failures++
        if (failures === PROBES.length) finish(false)
      }
      const timer = setTimeout(() => finish(false), 4000)
      for (const url of PROBES) {
        try {
          const req = net.request({ method: 'HEAD', url })
          req.on('response', (res) => done(res.statusCode >= 200 && res.statusCode < 400))
          req.on('error', () => done(false))
          req.end()
        } catch { done(false) }
      }
    })
  })

  ipcMain.handle('system:history-read', () => historyStore.read())

  ipcMain.handle('system:history-write', (_event, entries: unknown) => {
    historyStore.set(Array.isArray(entries) ? entries : [])
    return true
  })

  ipcMain.handle('cache:get', async (_event, key: string) => {
    const all = await cacheStore.read()
    return all[key] ?? null
  })

  ipcMain.handle('cache:set', (_event, key: string, valueOrSubkey: unknown, maybeValue?: unknown) => {
    cacheStore.update((all) => {
      if (maybeValue !== undefined) {
        if (!all[key] || typeof all[key] !== 'object') all[key] = {}
        ;(all[key] as Record<string, unknown>)[valueOrSubkey as string] = maybeValue
      } else {
        all[key] = valueOrSubkey
      }
    })
  })

  // 右键菜单的「剪切/复制/粘贴/全选」走 webContents 自带的编辑命令 —— 它直接
  // 作用在当前聚焦元素 / 选区上,比在渲染进程里手搓 execCommand/clipboard 更可靠
  // (粘贴尤其,渲染层的 execCommand('paste') 常被禁)。一次性通知,无返回值用 send。
  ipcMain.on('system:edit-command', (event, action: string) => {
    const wc = event.sender
    if (action === 'cut') wc.cut()
    else if (action === 'copy') wc.copy()
    else if (action === 'paste') wc.paste()
    else if (action === 'selectAll') wc.selectAll()
  })

  ipcMain.handle('download:load-state', () => downloadStateStore.read())

  ipcMain.handle('download:save-state', (_event, tasks: unknown) => {
    downloadStateStore.set(Array.isArray(tasks) ? tasks : [])
  })
}
