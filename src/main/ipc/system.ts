import { ipcMain, app, dialog, net } from 'electron'
import { join } from 'path'
import { statfs, readFile, writeFile } from 'fs/promises'
import { readFileSync, writeFileSync } from 'fs'

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

  ipcMain.handle('system:connectivity', () => {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2500)
      try {
        const req = net.request({ method: 'HEAD', url: 'https://connectivitycheck.gstatic.com/generate_204' })
        req.on('response', (res) => { clearTimeout(timer); resolve(res.statusCode === 204) })
        req.on('error', () => { clearTimeout(timer); resolve(false) })
        req.end()
      } catch { clearTimeout(timer); resolve(false) }
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
