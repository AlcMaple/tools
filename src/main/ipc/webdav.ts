import { ipcMain, app } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'

interface WebDavConfig {
  account: string
  appPassword: string
  /**
   * WebDAV 上的基准目录 —— 各类数据的文件名在运行时拼到后面。
   *
   * 向后兼容:老配置存的是完整文件路径,加载时检测到结尾是 `.json` 就自动取父目录当基准
   * 并把规范化后的值写回磁盘,下次启动就是干净的。
   */
  remotePath: string
}

/**
 * 同步数据的分类。每类对应远端一个独立 JSON 文件,rev 和冲突检测各自独立。
 * 新增类型在这里加即可,主进程会自动把它拼到基准路径后面。
 */
export type WebDavKind = 'homework' | 'anime' | 'miaoyu'

const WEBDAV_BASE = 'https://dav.jianguoyun.com/dav/'

function configPath(): string {
  return join(app.getPath('userData'), 'webdav_config.json')
}

/**
 * 把「可能是老的完整文件路径」或「基准目录」统一规范化成基准目录,始终返回不带头尾斜杠的
 * 纯目录路径,方便后面 join 文件名。
 */
function normalizeBaseFolder(raw: string): string {
  let p = (raw || '').trim().replace(/^\/+|\/+$/g, '')
  if (!p) return ''
  // 结尾是 .json → 老配置的完整文件路径,取父目录
  if (/\.json$/i.test(p)) {
    const slash = p.lastIndexOf('/')
    p = slash >= 0 ? p.slice(0, slash) : ''
  }
  return p.replace(/^\/+|\/+$/g, '')
}

function fileNameFor(kind: WebDavKind): string {
  switch (kind) {
    case 'homework': return 'homework.json'
    case 'anime': return 'anime.json'
    case 'miaoyu': return 'miaoyu.json'
  }
}

function joinRemote(basePath: string, kind: WebDavKind): string {
  const base = normalizeBaseFolder(basePath)
  const name = fileNameFor(kind)
  return base ? `${base}/${name}` : name
}

async function loadConfig(): Promise<WebDavConfig | null> {
  try {
    const data = await readFile(configPath(), 'utf-8')
    const parsed = JSON.parse(data) as WebDavConfig
    // 一次性迁移：老格式的完整文件路径 → base 文件夹，并写回磁盘
    const normalized = normalizeBaseFolder(parsed.remotePath || '')
    if (normalized !== (parsed.remotePath || '')) {
      const fixed = { ...parsed, remotePath: normalized }
      await writeFile(configPath(), JSON.stringify(fixed, null, 2), 'utf-8').catch(() => {})
      return fixed
    }
    return parsed
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
    // 保存时同步规范化，防止用户在 Settings 里粘了完整文件路径
    const fixed: WebDavConfig = {
      account: config.account,
      appPassword: config.appPassword,
      remotePath: normalizeBaseFolder(config.remotePath || ''),
    }
    await writeFile(configPath(), JSON.stringify(fixed, null, 2), 'utf-8')
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

  ipcMain.handle('webdav:push', async (_e, kind: WebDavKind, jsonStr: string) => {
    const cfg = await loadConfig()
    if (!cfg?.account || !cfg?.appPassword) throw new Error('WebDAV 未配置，请前往设置页面填写坚果云信息')
    const auth = authHeader(cfg.account, cfg.appPassword)
    const remotePath = joinRemote(cfg.remotePath, kind)
    const url = WEBDAV_BASE + remotePath

    // 逐层 MKCOL 确保父目录存在（MKCOL 幂等，目录已存在的错误忽略）
    const parts = remotePath.split('/').slice(0, -1)
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

  ipcMain.handle('webdav:pull', async (_e, kind: WebDavKind) => {
    const cfg = await loadConfig()
    if (!cfg?.account || !cfg?.appPassword) throw new Error('WebDAV 未配置，请前往设置页面填写坚果云信息')
    const url = WEBDAV_BASE + joinRemote(cfg.remotePath, kind)
    const res = await fetch(url, {
      headers: { Authorization: authHeader(cfg.account, cfg.appPassword) },
    })
    if (res.status === 404 || res.status === 409) throw new Error('远程文件不存在，请先在此设备上传一次')
    if (!res.ok) throw new Error(`拉取失败 (HTTP ${res.status})`)
    return await res.text()
  })
}
