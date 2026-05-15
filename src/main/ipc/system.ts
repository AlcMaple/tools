import { ipcMain, app, dialog, net } from 'electron'
import { join } from 'path'
import { statfs, readFile, writeFile } from 'fs/promises'
import { readFileSync, writeFileSync, renameSync } from 'fs'

let appMinimizeOnClose = false
try {
  const file = join(app.getPath('userData'), 'app_settings.json')
  const settings = JSON.parse(readFileSync(file, 'utf-8'))
  if (typeof settings.minimizeOnClose === 'boolean') {
    appMinimizeOnClose = settings.minimizeOnClose
  }
} catch {
  // ignore
}

export function getMinimizeOnClose(): boolean {
  return appMinimizeOnClose
}

const HISTORY_FILE = (): string => join(app.getPath('userData'), 'xifan_settings_history.json')

export function registerSystemIpc(): void {
  ipcMain.handle('system:get-setting', (_event, key: string) => {
    if (key === 'minimizeOnClose') return appMinimizeOnClose
    return null
  })

  ipcMain.handle('system:set-setting', (_event, key: string, value: unknown) => {
    if (key === 'minimizeOnClose') {
      appMinimizeOnClose = Boolean(value)
      const file = join(app.getPath('userData'), 'app_settings.json')
      try {
        let settings: Record<string, unknown> = {}
        try { settings = JSON.parse(readFileSync(file, 'utf-8')) } catch { /* ignore */ }
        settings.minimizeOnClose = appMinimizeOnClose
        writeFileSync(file, JSON.stringify(settings))
      } catch { /* ignore */ }
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
      const done = (ok: boolean): void => {
        if (settled) return
        if (ok) { settled = true; resolve(true); return }
        failures++
        if (failures === PROBES.length) { settled = true; resolve(false) }
      }
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve(false) } }, 4000)
      for (const url of PROBES) {
        try {
          const req = net.request({ method: 'HEAD', url })
          req.on('response', (res) => {
            clearTimeout(timer)
            done(res.statusCode >= 200 && res.statusCode < 400)
          })
          req.on('error', () => done(false))
          req.end()
        } catch { done(false) }
      }
    })
  })

  ipcMain.handle('system:history-read', () => {
    try { return JSON.parse(readFileSync(HISTORY_FILE(), 'utf-8')) }
    catch { return [] }
  })

  ipcMain.handle('system:history-write', (_event, entries: unknown) => {
    try { writeFileSync(HISTORY_FILE(), JSON.stringify(entries)); return true }
    catch { return false }
  })

  ipcMain.handle('cache:get', (_event, key: string) => {
    try {
      const file = join(app.getPath('userData'), 'search_cache.json')
      const all = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
      return all[key] ?? null
    } catch { return null }
  })

  const DOWNLOAD_STATE_FILE = join(app.getPath('userData'), 'download_queue.json')

  ipcMain.handle('download:load-state', () => {
    try { return JSON.parse(readFileSync(DOWNLOAD_STATE_FILE, 'utf-8')) }
    catch { return [] }
  })

  ipcMain.handle('download:save-state', (_event, tasks: unknown) => {
    try {
      writeFileSync(DOWNLOAD_STATE_FILE + '.tmp', JSON.stringify(tasks))
      renameSync(DOWNLOAD_STATE_FILE + '.tmp', DOWNLOAD_STATE_FILE)
    } catch { /* ignore */ }
  })

  ipcMain.handle('cache:set', async (_event, key: string, valueOrSubkey: unknown, maybeValue?: unknown) => {
    try {
      const file = join(app.getPath('userData'), 'search_cache.json')
      let all: Record<string, unknown> = {}
      try {
        const data = await readFile(file, 'utf-8')
        all = JSON.parse(data)
      } catch { /* ignore */ }
      if (maybeValue !== undefined) {
        if (!all[key] || typeof all[key] !== 'object') all[key] = {}
        ;(all[key] as Record<string, unknown>)[valueOrSubkey as string] = maybeValue
      } else {
        all[key] = valueOrSubkey
      }
      await writeFile(file, JSON.stringify(all))
    } catch { /* ignore */ }
  })
}
