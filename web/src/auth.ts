// 前端账号层 —— 调后端 /api/auth/*（见 server/auth.ts）。会话是 httpOnly cookie，前端拿不到也
// 不需要拿；登录态靠 /me 探。极简 store：单个 user 值 + 订阅，够登录入口和后续追番用。
import { useEffect, useState } from 'react'

const INVITE_STORAGE_KEY = 'mapletools-pending-invite'

function normalizeInviteCode(value: string | null | undefined): string {
  const code = (value ?? '').trim().toUpperCase()
  return /^[A-Z0-9]{6,16}$/.test(code) ? code : ''
}

export function captureInviteFromLocation(): void {
  const code = normalizeInviteCode(new URL(window.location.href).searchParams.get('invite'))
  if (code) window.localStorage.setItem(INVITE_STORAGE_KEY, code)
}

export function pendingInviteCode(): string {
  return normalizeInviteCode(window.localStorage.getItem(INVITE_STORAGE_KEY))
}

export function clearPendingInvite(): void {
  window.localStorage.removeItem(INVITE_STORAGE_KEY)
}

export interface AuthUser {
  id: number
  username: string
  createdAt: string
  /** Bangumi 数字 UID 或自定义用户名；空串表示尚未设置。 */
  bgmUid: string
  /** 已核验的邮箱地址（设置页展示用）；未绑定为 null。 */
  email: string | null
  /** 只知道「设没设」密保 —— 后端不回显问题和答案（问题本身也是秘密）。 */
  hasSecurity: boolean
  hasEmail: boolean
  /** 是否拥有用户名密码凭据；邮箱验证码账号没有密码，也不能走密码设置流程。 */
  hasPassword: boolean
  // 默认 false；只有用户明确打开后才进入公开追番大厅。
  tracksPublic: boolean
  /** AI 来源偏好（推荐与点评助手）。API key 不在这里 —— 只存本机浏览器。 */
  aiConfig: AiConfig
}

export interface AiConfig {
  provider: 'server' | 'byok'
  endpoint: string
  model: string
}

const DEFAULT_AI_CONFIG: AiConfig = { provider: 'server', endpoint: '', model: '' }

function normalizeAiConfig(raw: unknown): AiConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_AI_CONFIG
  const o = raw as Record<string, unknown>
  return {
    provider: o.provider === 'byok' ? 'byok' : 'server',
    endpoint: typeof o.endpoint === 'string' ? o.endpoint : '',
    model: typeof o.model === 'string' ? o.model : '',
  }
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

type MeRes = {
  id: number
  username: string
  createdAt: string
  bgmUid: string
  email: string | null
  hasSecurity: boolean
  hasEmail: boolean
  hasPassword: boolean
  tracksPublic: boolean
  aiConfig: unknown
  dailyReward: number
}
type LoginRes = { username: string; hasSecurity: boolean; hasEmail: boolean; hasPassword: boolean }

let currentUser: AuthUser | null = null
let ready = false // 首次 /me 是否已回来（避免登录态未知时闪一下登录按钮）
let dailyRewardEvent = { seq: 0, points: 0 }
const listeners = new Set<() => void>()

function setUser(u: AuthUser | null, dailyReward = 0): void {
  currentUser = u
  window.__mapleMonitoring?.setUser(u ? { id: u.id, username: u.username } : null)
  ready = true
  if (dailyReward > 0) dailyRewardEvent = { seq: dailyRewardEvent.seq + 1, points: dailyReward }
  listeners.forEach((fn) => fn())
}

export const auth = {
  get user(): AuthUser | null {
    return currentUser
  },
  get ready(): boolean {
    return ready
  },
  consumeDailyReward(seq: number): number {
    if (dailyRewardEvent.seq !== seq || dailyRewardEvent.points <= 0) return 0
    const points = dailyRewardEvent.points
    dailyRewardEvent = { seq, points: 0 }
    return points
  },
  // 启动时探一次登录态；/me 401 时静默置未登录（未登录不是错误）。
  async init(): Promise<void> {
    try {
      const me = await request<MeRes>('/me')
      clearPendingInvite()
      setUser({
        id: me.id,
        username: me.username,
        createdAt: me.createdAt,
        bgmUid: me.bgmUid,
        email: me.email,
        hasSecurity: me.hasSecurity,
        hasEmail: me.hasEmail,
        hasPassword: me.hasPassword,
        tracksPublic: me.tracksPublic === true,
        aiConfig: normalizeAiConfig(me.aiConfig),
      }, me.dailyReward)
    } catch {
      setUser(null)
    }
  },
  async refresh(): Promise<void> {
    await auth.init()
  },
  async register(username: string, password: string, confirm: string): Promise<void> {
    await request<LoginRes>('/register', { username, password, confirm, inviteCode: pendingInviteCode() })
    clearPendingInvite()
    await auth.init()
  },
  async login(username: string, password: string): Promise<void> {
    await request<LoginRes>('/login', { username, password })
    await auth.init() // 顺带把 createdAt / hasSecurity 拉全
  },
  async requestEmailCode(email: string): Promise<{ challengeId: string; expiresIn: number }> {
    return request<{ challengeId: string; expiresIn: number }>('/email/start', { email })
  },
  /** 向**当前绑定邮箱**发验证码（改用户名 / 解绑共用的「证明仍控制现身份」通道）。 */
  async requestCodeForCurrentEmail(): Promise<{ challengeId: string; expiresIn: number; email: string }> {
    return request<{ challengeId: string; expiresIn: number; email: string }>('/email/current-start', {})
  },
  async verifyEmailCode(challengeId: string, code: string): Promise<void> {
    await request<LoginRes>('/email/verify', { challengeId, code, inviteCode: pendingInviteCode() })
    clearPendingInvite()
    await auth.init()
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
    tracksPublic?: boolean
  }): Promise<void> {
    await request('/settings', p)
    await auth.init()
  },
  /** 导入追番时默认使用的 Bangumi 数字 UID 或自定义用户名。 */
  async saveBgmUid(bgmUid: string): Promise<void> {
    await request('/settings', { bgmUid })
    await auth.init()
  },
  // 公开开关不涉及账号凭据，因此不要求再次输入密码。
  async saveTracksPublic(tracksPublic: boolean): Promise<void> {
    await request('/settings', { tracksPublic })
    await auth.init()
  },
  // AI 来源偏好（provider / endpoint / model）。API key 由前端单独存本机浏览器，不走这里。
  async saveAiConfig(aiConfig: AiConfig): Promise<void> {
    await request('/settings', { aiConfig })
    await auth.init()
  },
  /** 无密码账号（Google / 验证码注册）首次设置密码。 */
  async setPassword(newPassword: string, confirm: string): Promise<void> {
    await request('/password/set', { newPassword, confirm })
    await auth.init()
  },
  /** 改用户名：有密码账号验密码，或当前邮箱验证码（无密码账号的主路径）。 */
  async changeUsername(p: {
    username: string
    currentPassword?: string
    challengeId?: string
    code?: string
  }): Promise<string> {
    const r = await request<{ ok: boolean; username: string }>('/username/change', p)
    await auth.init()
    return r.username
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

// 第三方登录 / 邮箱能力是否启用 —— 服务端按环境变量决定，未配置时前端不画对应入口。
// 登录走整页跳转（/api/auth/oauth/google/start → Google → 回调设会话 cookie 后跳回），
// 前端无需也不应经手任何令牌。失败时回调带 ?oauth=failed 回来，由 App 弹登录框提示。
let providersCache: { google: boolean; email: boolean } | null = null
export async function fetchOauthProviders(): Promise<{ google: boolean; email: boolean }> {
  if (!providersCache) providersCache = await request<{ google: boolean; email: boolean }>('/oauth/providers')
  return providersCache
}

/** 已登录账号绑定 / 换绑邮箱第一步（验证码路径，任意邮箱）：有密码的账号要带原始密码。 */
export async function bindEmailStart(
  email: string,
  currentPassword?: string,
): Promise<{ challengeId: string; expiresIn: number }> {
  return request<{ challengeId: string; expiresIn: number }>('/email/bind-start', { email, currentPassword })
}

export async function bindEmailVerify(challengeId: string, code: string): Promise<{ email: string }> {
  const r = await request<{ ok: boolean; email: string }>('/email/bind-verify', { challengeId, code })
  await auth.init() // 顺带把 /me 的 email 拉全
  return { email: r.email }
}

// 换绑 / 解绑邮箱与首次设密码 —— 邮箱是身份本身（详见 server/auth.ts 各路由注释）。
// 换绑有两条路：验证码（任意邮箱）与 Google 授权（仅 Gmail，免验证码）。

/** 换绑邮箱的 Google 路径：授权即证明控制新邮箱，免验证码。
 *  返回 Google 授权页地址，前端整页跳转过去，回来后带 ?oauth= 结果码。 */
export async function rebindEmailViaGoogle(currentPassword: string): Promise<string> {
  const url = new URL(window.location.href)
  url.searchParams.delete('oauth')
  const returnTo = url.pathname + url.search + url.hash
  const r = await request<{ url: string }>(
    `/oauth/google/rebind-email?returnTo=${encodeURIComponent(returnTo)}`,
    { currentPassword },
  )
  return r.url
}

/** 解绑邮箱：先向当前邮箱发验证码证明仍控制它，再验证解绑（需已设置密码）。 */
export async function unbindEmailStart(): Promise<{ challengeId: string; expiresIn: number; email: string }> {
  return auth.requestCodeForCurrentEmail()
}

export async function unbindEmailVerify(challengeId: string, code: string): Promise<void> {
  await request<{ ok: boolean }>('/email/unbind-verify', { challengeId, code })
  await auth.init()
}

// 组件里订阅登录态。返回 { user, ready }，配合 auth.login/register/logout 用。
export function useAuth(): {
  user: AuthUser | null
  ready: boolean
  dailyReward: { seq: number; points: number }
} {
  const [, force] = useState(0)
  useEffect(() => auth.subscribe(() => force((n) => n + 1)), [])
  return { user: currentUser, ready, dailyReward: dailyRewardEvent }
}
