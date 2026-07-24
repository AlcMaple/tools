// MapleTools 网页版账号 —— 只负责 app ↔ web 的追番同步。
//
// JWT 只存在主进程的 userData JSON 里；preload / renderer 只能拿登录状态和
// 同步结果，永远接触不到令牌。请求固定发往 MapleTools 网页版，不接受 renderer
// 传 URL，避免把这个 IPC 变成任意网络请求入口。
import { app, ipcMain } from 'electron'
import { JsonStore } from '../shared/json-store'
import { netRequest, type NetResult } from '../shared/net-request'

const WEB_BASE = process.env.MAPLETOOLS_WEB_URL || 'https://anime.alcmaple.cn'

interface WebAccountState {
  token: string
  username: string
}

interface SyncPushInput {
  baseRev: number
  force?: boolean
  data: unknown[]
}

const accountStore = new JsonStore<WebAccountState>('web_account.json', (raw) => {
  const value = raw && typeof raw === 'object' ? raw as Partial<WebAccountState> : {}
  return {
    token: typeof value.token === 'string' ? value.token : '',
    username: typeof value.username === 'string' ? value.username : '',
  }
})

function responseJson(res: NetResult): Record<string, unknown> {
  try {
    const value = JSON.parse(res.body.toString('utf-8')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function responseError(res: NetResult, fallback: string): Error {
  const body = responseJson(res)
  return new Error(typeof body.error === 'string' && body.error ? body.error : `${fallback} (HTTP ${res.status})`)
}

function isJsonResponse(res: NetResult): boolean {
  const entry = Object.entries(res.headers).find(([key]) => key.toLowerCase() === 'content-type')
  const value = Array.isArray(entry?.[1]) ? entry[1].join(';') : entry?.[1] || ''
  return value.toLowerCase().includes('application/json')
}

function ensureSyncEndpoint(res: NetResult): void {
  // 旧版线上服务会让 GET 命中 SPA 兜底（200 HTML），POST 则直接 404。两种情况都
  // 不是用户数据或网络问题，明确指出服务端版本，避免用户反复登录、重试上传。
  if (res.status === 404 || !isJsonResponse(res)) {
    throw new Error('网页版服务器尚未部署追番同步接口，请先更新网页版服务')
  }
}

function sessionCookie(res: NetResult): string {
  const entry = Object.entries(res.headers).find(([key]) => key.toLowerCase() === 'set-cookie')
  const values = Array.isArray(entry?.[1]) ? entry[1] : entry?.[1] ? [entry[1]] : []
  for (const value of values) {
    const match = value.match(/(?:^|;\s*)mt_session=([^;]+)/)
    if (match?.[1]) return match[1]
  }
  return ''
}

function requestHeaders(token = ''): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json; charset=utf-8',
    'User-Agent': `MapleTools/${app.getVersion()}`,
  }
  if (token) headers.Cookie = `mt_session=${token}`
  return headers
}

async function authedRequest(path: string, options: {
  method?: string
  body?: string
} = {}): Promise<NetResult> {
  const account = await accountStore.read()
  if (!account.token) throw new Error('请先在设置中登录网页版账号')
  const res = await netRequest(`${WEB_BASE}${path}`, {
    method: options.method,
    body: options.body,
    headers: requestHeaders(account.token),
    timeoutMs: 15000,
  })
  if (res.status === 401) {
    accountStore.set({ token: '', username: '' })
    throw new Error('网页版登录已失效，请重新登录')
  }
  return res
}

export function registerWebAccountIpc(): void {
  ipcMain.handle('web-account:status', async () => {
    const account = await accountStore.read()
    return { loggedIn: !!account.token, username: account.token ? account.username : '' }
  })

  ipcMain.handle('web-account:login', async (_event, input: { username: string; password: string }) => {
    const username = typeof input?.username === 'string' ? input.username.trim() : ''
    const password = typeof input?.password === 'string' ? input.password : ''
    if (!username || !password) throw new Error('请填写用户名和密码')

    const res = await netRequest(`${WEB_BASE}/api/auth/login`, {
      method: 'POST',
      headers: requestHeaders(),
      body: JSON.stringify({ username, password }),
      timeoutMs: 15000,
    })
    if (res.status !== 200) throw responseError(res, '登录失败')

    const token = sessionCookie(res)
    const body = responseJson(res)
    if (!token) throw new Error('登录成功但没有收到会话令牌')
    const canonicalName = typeof body.username === 'string' ? body.username : username
    accountStore.set({ token, username: canonicalName })
    return { loggedIn: true, username: canonicalName }
  })

  ipcMain.handle('web-account:logout', async () => {
    accountStore.set({ token: '', username: '' })
    return { loggedIn: false, username: '' }
  })

  ipcMain.handle('web-account:pull-tracks', async () => {
    const res = await authedRequest('/api/tracks/sync')
    ensureSyncEndpoint(res)
    if (res.status !== 200) throw responseError(res, '读取网页版追番失败')
    const body = responseJson(res)
    return {
      rev: Number(body.rev) || 0,
      data: Array.isArray(body.data) ? body.data : [],
    }
  })

  ipcMain.handle('web-account:push-tracks', async (_event, input: SyncPushInput) => {
    const payload = {
      baseRev: Number(input?.baseRev) || 0,
      force: input?.force === true,
      data: Array.isArray(input?.data) ? input.data : [],
    }
    const res = await authedRequest('/api/tracks/sync', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    ensureSyncEndpoint(res)
    const body = responseJson(res)
    if (res.status === 409) {
      return {
        ok: false,
        conflict: true,
        rev: Number(body.rev) || 0,
        serverCount: Number(body.serverCount) || 0,
        error: typeof body.error === 'string' ? body.error : '服务器上有你还没拉取过的改动',
      }
    }
    if (res.status !== 200) throw responseError(res, '上传网页版追番失败')
    return {
      ok: true,
      conflict: false,
      rev: Number(body.rev) || 0,
      count: Number(body.count) || 0,
    }
  })
}
