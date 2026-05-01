import { ipcMain, app } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'

interface WebDavConfig {
  account: string
  appPassword: string
  remotePath: string
}

const WEBDAV_BASE = 'https://dav.jianguoyun.com/dav/'

function configPath(): string {
  return join(app.getPath('userData'), 'webdav_config.json')
}

async function loadConfig(): Promise<WebDavConfig | null> {
  try {
    const data = await readFile(configPath(), 'utf-8')
    return JSON.parse(data) as WebDavConfig
  } catch {
    return null
  }
}

function authHeader(account: string, appPassword: string): string {
  return 'Basic ' + Buffer.from(`${account}:${appPassword}`).toString('base64')
}

export function registerWebDavIpc(): void {
  ipcMain.handle('webdav:get-config', async () => {
    return await loadConfig()
  })

  ipcMain.handle('webdav:save-config', async (_e, config: WebDavConfig) => {
    await writeFile(configPath(), JSON.stringify(config, null, 2), 'utf-8')
    return true
  })

  ipcMain.handle('webdav:test', async () => {
    const cfg = await loadConfig()
    if (!cfg?.account || !cfg?.appPassword) throw new Error('请先填写账号和应用密码')
    const res = await fetch(WEBDAV_BASE, {
      method: 'PROPFIND',
      headers: {
        Authorization: authHeader(cfg.account, cfg.appPassword),
        Depth: '0',
      },
    })
    if (res.status === 401) throw new Error('认证失败，请检查账号和应用密码')
    if (!res.ok && res.status !== 207) throw new Error(`连接失败 (HTTP ${res.status})`)
    return true
  })

  ipcMain.handle('webdav:push', async (_e, jsonStr: string) => {
    const cfg = await loadConfig()
    if (!cfg?.account || !cfg?.appPassword || !cfg?.remotePath) throw new Error('WebDAV 未配置，请前往设置页面填写坚果云信息')
    const auth = authHeader(cfg.account, cfg.appPassword)
    const url = WEBDAV_BASE + cfg.remotePath

    // Create each ancestor directory in order (MKCOL is idempotent, errors silently ignored)
    const parts = cfg.remotePath.split('/').slice(0, -1)
    for (let i = 1; i <= parts.length; i++) {
      const dirPath = parts.slice(0, i).join('/')
      await fetch(WEBDAV_BASE + dirPath, {
        method: 'MKCOL',
        headers: { Authorization: auth },
      }).catch(() => {})
    }

    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: jsonStr,
    })
    if (!res.ok) throw new Error(`上传失败 (HTTP ${res.status})`)
    return true
  })

  ipcMain.handle('webdav:pull', async () => {
    const cfg = await loadConfig()
    if (!cfg?.account || !cfg?.appPassword || !cfg?.remotePath) throw new Error('WebDAV 未配置，请前往设置页面填写坚果云信息')
    const url = WEBDAV_BASE + cfg.remotePath
    const res = await fetch(url, {
      headers: { Authorization: authHeader(cfg.account, cfg.appPassword) },
    })
    if (res.status === 404 || res.status === 409) throw new Error('远程文件不存在，请先在此设备上传一次')
    if (!res.ok) throw new Error(`拉取失败 (HTTP ${res.status})`)
    return await res.text()
  })
}
