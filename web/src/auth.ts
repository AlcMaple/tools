// 前端账号层 —— 调后端 /api/auth/*（见 server/auth.ts）。会话是 httpOnly cookie，前端拿不到也
// 不需要拿；登录态靠 /me 探。极简 store：单个 user 值 + 订阅，够登录入口和后续追番用。
import { useEffect, useState } from 'react'

export interface AuthUser {
  username: string
  createdAt: string
  /** 只知道「设没设」密保 —— 后端不回显问题和答案（问题本身也是秘密）。 */
  hasSecurity: boolean
}

export interface SecurityQuestion {
  id: string
  text: string
}

// 后端出错时统一抛出带中文原因的 Error（{ error } 来自 server/auth.ts）。
async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/auth${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data as T
}

type MeRes = { username: string; createdAt: string; hasSecurity: boolean }
type LoginRes = { username: string; hasSecurity: boolean }

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
      const me = await request<MeRes>('/me')
      setUser({ username: me.username, createdAt: me.createdAt, hasSecurity: me.hasSecurity })
    } catch {
      setUser(null)
    }
  },
  async refresh(): Promise<void> {
    await auth.init()
  },
  async register(username: string, password: string, confirm: string): Promise<void> {
    const r = await request<LoginRes>('/register', { username, password, confirm })
    setUser({ username: r.username, createdAt: new Date().toISOString(), hasSecurity: r.hasSecurity })
  },
  async login(username: string, password: string): Promise<void> {
    await request<LoginRes>('/login', { username, password })
    await auth.init() // 顺带把 createdAt / hasSecurity 拉全
  },
  async logout(): Promise<void> {
    await request('/logout', {})
    setUser(null)
  },
  /** 找回密码 —— 成功后不自动登录，让用户拿新密码正常登录。 */
  async forgot(p: {
    username: string
    questionId: string
    answer: string
    newPassword: string
    confirm: string
  }): Promise<void> {
    await request('/forgot', p)
  },
  /** 账号安全设置 —— 新密码留空 = 只改密保。两条路都要原始密码。 */
  async saveSettings(p: {
    currentPassword: string
    newPassword?: string
    confirm?: string
    questionId?: string
    answer?: string
  }): Promise<void> {
    await request('/settings', p)
    await auth.init()
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}

// 密保问题预设 —— 后端是单一事实源（server/auth.ts SECURITY_QUESTIONS），这里拉一次就缓存。
let questionsCache: SecurityQuestion[] | null = null
export async function fetchQuestions(): Promise<SecurityQuestion[]> {
  if (questionsCache) return questionsCache
  const r = await request<{ questions: SecurityQuestion[] }>('/questions')
  questionsCache = r.questions
  return questionsCache
}

// 组件里订阅登录态。返回 { user, ready }，配合 auth.login/register/logout 用。
export function useAuth(): { user: AuthUser | null; ready: boolean } {
  const [, force] = useState(0)
  useEffect(() => auth.subscribe(() => force((n) => n + 1)), [])
  return { user: currentUser, ready }
}
