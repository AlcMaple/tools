import { ipcMain, app, dialog, net } from 'electron'
import { join } from 'path'
import { statfs } from 'fs/promises'
import { JsonStore } from '../shared/json-store'
import { disposeMediaCache } from '../shared/media-cache'
import { disposeHlsPrefetch } from '../shared/hls-prefetch'
import { disposeMediaProxyRequests } from '../shared/media-proxy'

// 默认关闭 —— 与 OS 惯例一致(× 就是真的退出),新用户不会被「看似关了其实还在跑」困惑。
let appMinimizeOnClose = false
let appAutoUpdateCheckEnabled = true  // 默认开启 —— 多数用户期望被提醒新版本
// 更新源:'auto' 优先国内代理链、失败回退 GitHub;'github' 强制直连。
let appUpdateSource: 'auto' | 'github' = 'auto'

interface AppSettings {
  minimizeOnClose?: boolean
  autoUpdateCheckEnabled?: boolean
  updateSource?: 'auto' | 'github'
}

const settingsStore = new JsonStore<AppSettings>('app_settings.json', (raw) =>
  raw && typeof raw === 'object' ? (raw as AppSettings) : {},
)
// 启动期 bootstrap:窗口关闭逻辑同步依赖这几个值,所以用 current() 同步读一次进内存
// 后续写走异步合并。
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
 * 启动时是否自动检查更新(默认 true)。关掉后主进程的启动延迟检查不再触发、banner 不会自动弹
 * 但设置页里手动点「检查更新」仍然照常走完整流程 —— 手动入口不受这个开关控制。
 */
export function getAutoUpdateCheckEnabled(): boolean {
  return appAutoUpdateCheckEnabled
}

/** 更新源偏好,updater 据此决定走代理链还是直连。 */
export function getUpdateSource(): 'auto' | 'github' {
  return appUpdateSource
}

// 各 JSON 持久化都走 JsonStore:内存是权威值,异步合并落盘,不阻塞事件循环。
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

  // 把「用户没设置保存目录时主进程会回退到的路径」暴露给渲染层,让设置页显示「留空时实际存到哪」
  // 避免 UI 上写「应用同级目录」误导用户。
  ipcMain.handle('system:default-downloads', () => app.getPath('downloads'))

  // DevTools 开关 —— 设置页给个按钮,免得用户记不住快捷键。仅未打包时生效。
  ipcMain.handle('system:is-dev', () => !app.isPackaged)
  ipcMain.handle('system:toggle-devtools', (event) => {
    if (app.isPackaged) return false
    event.sender.toggleDevTools()
    return true
  })

  ipcMain.handle('system:connectivity', () => {
    // 并发探多个端点 —— 任何一个回 2xx/3xx 就算在线。
    // Google's generate_204 is blocked in mainland China, so we include domestic
    // alternatives. First success wins; resolve false only if all fail/timeout.
    const PROBES = [
      'https://www.baidu.com',
      'https://connectivitycheck.gstatic.com/generate_204',
    ]
    return new Promise<boolean>((resolve) => {
      let settled = false
      let failures = 0
      const requests: ReturnType<typeof net.request>[] = []
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        for (const request of requests) {
          try { request.abort() } catch { /* 已结束 */ }
        }
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
          requests.push(req)
          req.on('response', (res) => done(res.statusCode >= 200 && res.statusCode < 400))
          req.on('error', () => done(false))
          req.end()
        } catch { done(false) }
      }
    })
  })

  // 离开播放页时把在线播放的两层缓冲收掉:mp4 后台顺序流(中止 + 删临时文件)、
  // HLS 分片预取(清内存)。不收的话关掉播放器后台还在下满整集、几百 MB 白占。
  // 一次性通知,没有返回值,用 send。
  ipcMain.on('media:release', () => {
    disposeMediaCache()
    disposeHlsPrefetch()
    disposeMediaProxyRequests()
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
