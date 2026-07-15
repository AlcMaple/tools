// 前端账号层 —— 调后端 /api/auth/*（见 server/auth.ts）。会话是 httpOnly cookie，前端拿不到也
// 不需要拿；登录态靠 /me 探。极简 store：单个 user 值 + 订阅，够登录入口和后续追番用。
import { useEffect, useState } from 'react'

export interface AuthUser {
  username: string
}

// 后端出错时统一抛出带中文原因的 Error（{ error } 来自 server/auth.ts）。
async function request(path: string, body?: unknown): Promise<AuthUser | null> {
  const res = await fetch(`/api/auth${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
  const data = (await res.json().catch(() => ({}))) as { username?: string; error?: string }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data.username ? { username: data.username } : null
}

let currentUser: AuthUser | null = null
let ready = false // 首次 /me 是否已回来（避免登录态未知时闪一下登录按钮）
const listeners = new Set<() => void>()

function setUser(u: AuthUser | null): void {
  currentUser = u
  ready = true
  listeners.forEach((fn) => fn())
}

export const auth = {
  get user(): AuthUser | null {
    return currentUser
  },
  get ready(): boolean {
    return ready
  },
  // 启动时探一次登录态；/me 401 时静默置未登录（未登录不是错误）。
  async init(): Promise<void> {
    try {
      setUser(await request('/me'))
    } catch {
      setUser(null)
    }
  },
  async register(username: string, password: string, confirm: string): Promise<void> {
    setUser(await request('/register', { username, password, confirm }))
  },
  async login(username: string, password: string): Promise<void> {
    setUser(await request('/login', { username, password }))
  },
  async logout(): Promise<void> {
    await request('/logout', {})
    setUser(null)
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}

// 组件里订阅登录态。返回 { user, ready }，配合 auth.login/register/logout 用。
export function useAuth(): { user: AuthUser | null; ready: boolean } {
  const [, force] = useState(0)
  useEffect(() => auth.subscribe(() => force((n) => n + 1)), [])
  return { user: currentUser, ready }
}
