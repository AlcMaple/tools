import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { proxyReady } from '../http'
import { db } from '../db'
import { AUTH_SECRET } from '../secrets'

export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
export const BASE_URL = 'https://anime.xifanacg.com'

const BASE_HEADERS: Record<string, string> = {
  'User-Agent': DESKTOP_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: `${BASE_URL}/`,
}

const BASE_ORIGIN = new URL(BASE_URL).origin
const SESSION_TTL_MS = 15 * 60 * 1000
const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const COOKIE_KEY = createHash('sha256').update(`mapletools:xifan-cookie:${AUTH_SECRET}`).digest()

const CF_MARKERS = [
  'Just a moment',
  'cf-browser-verification',
  'challenge-platform',
  '/cdn-cgi/challenge-platform',
  'Attention Required! | Cloudflare',
  'cf-error-details',
  'Error 1020',
  'Enable JavaScript and cookies to continue',
]
const ORIGIN_DOWN_MARKERS = ['GATEWAY_TIMEOUT', 'ORIGIN_ERROR', 'BACKEND_UNAVAILABLE', 'ORIGIN_UNREACHABLE']

export interface XifanHttpResponse {
  status: number
  headers: Headers
  body: Buffer
  url: string
}

export class XifanUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSec: number | null,
    message: string,
  ) {
    super(message)
    this.name = 'XifanUpstreamError'
  }
}

export class XifanLocalRateLimitError extends Error {
  readonly retryAfterSec = 2

  constructor() {
    super('稀饭操作过于频繁，请稍后再试')
    this.name = 'XifanLocalRateLimitError'
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  paced?: boolean
  retryTransient?: boolean
  timeoutMs?: number
}

interface StoredCookie {
  value: string
  expiresAt?: number
}

interface SessionRow {
  cookie_cipher: string
}

const loadSession = db.prepare<[number]>('SELECT cookie_cipher FROM xifan_session WHERE user_id = ?')
const saveSession = db.prepare<[number, string, number]>(`
  INSERT INTO xifan_session (user_id, cookie_cipher, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    cookie_cipher = excluded.cookie_cipher,
    updated_at = excluded.updated_at
`)
const deleteSession = db.prepare<[number]>('DELETE FROM xifan_session WHERE user_id = ?')

let requestQueue = Promise.resolve()
let lastStartedAt = 0

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function scheduleRequest<T>(fn: () => Promise<T>): Promise<T> {
  const gate = requestQueue.then(async () => {
    const targetGap = 1000 + Math.floor(Math.random() * 301)
    const elapsed = Date.now() - lastStartedAt
    if (elapsed < targetGap) await sleep(targetGap - elapsed)
    lastStartedAt = Date.now()
  })
  requestQueue = gate.then(() => undefined, () => undefined)
  return gate.then(fn)
}

function setCookieHeaders(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] }
  const values = h.getSetCookie?.() ?? []
  if (values.length > 0) return values
  const one = headers.get('set-cookie')
  return one ? one.split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/) : []
}

function encryptCookies(cookies: Record<string, StoredCookie>): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', COOKIE_KEY, iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(cookies), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`
}

function decryptCookies(value: string): Record<string, StoredCookie> {
  const [version, ivB64, tagB64, encryptedB64] = value.split('.')
  if (version !== 'v1' || !ivB64 || !tagB64 || !encryptedB64) throw new Error('cookie cipher 格式错误')
  const decipher = createDecipheriv('aes-256-gcm', COOKIE_KEY, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  const plain = Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
  const parsed = JSON.parse(plain) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('cookie 数据格式错误')
  const cookies: Record<string, StoredCookie> = {}
  for (const [name, raw] of Object.entries(parsed)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const candidate = raw as { value?: unknown; expiresAt?: unknown }
    if (typeof candidate.value !== 'string') continue
    cookies[name] = {
      value: candidate.value,
      ...(typeof candidate.expiresAt === 'number' && Number.isFinite(candidate.expiresAt)
        ? { expiresAt: candidate.expiresAt }
        : {}),
    }
  }
  return cookies
}

function isTransient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket disconnected|TLS|fetch failed|terminated/i.test(message)
}

export function isXifanChallengePage(html: string): boolean {
  if (CF_MARKERS.some((marker) => html.includes(marker))) return true
  return html.includes('Checking your Browser')
    && (html.includes('UAM_CHECKING') || html.includes('X-FL-UA-Step'))
}

export function assertXifanResponse(response: XifanHttpResponse, action: string): string {
  const text = response.body.toString('utf8')
  if (isXifanChallengePage(text)) {
    throw new Error('稀饭要求浏览器安全验证，请稍后再试')
  }
  if (ORIGIN_DOWN_MARKERS.some((marker) => text.includes(marker))) {
    throw new Error('稀饭源站网关超时或不可用，请稍后再试')
  }
  if (response.status < 200 || response.status >= 300) {
    const retryAfter = response.headers.get('retry-after')
    let retryAfterSec: number | null = null
    if (retryAfter && /^\d+$/.test(retryAfter)) retryAfterSec = Number(retryAfter)
    else if (retryAfter) {
      const retryAt = Date.parse(retryAfter)
      if (Number.isFinite(retryAt)) retryAfterSec = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))
    }
    const message = response.status === 429
      ? `稀饭请求过于频繁${retryAfterSec !== null ? `，请在 ${retryAfterSec} 秒后再试` : '，请稍后再试'}`
      : `${action}失败：服务器返回 HTTP ${response.status}`
    throw new XifanUpstreamError(response.status, retryAfterSec, message)
  }
  return text
}

export class XifanCookieSession {
  private readonly cookies = new Map<string, StoredCookie>()
  private lastUsedAt = Date.now()
  private pacedQueue = Promise.resolve()
  private pacedPending = 0

  constructor(private readonly uid: number) {
    const row = loadSession.get(uid) as SessionRow | undefined
    if (!row) return
    try {
      const restored = decryptCookies(row.cookie_cipher)
      let removedExpired = false
      for (const [name, cookie] of Object.entries(restored)) {
        if (!cookie.expiresAt || cookie.expiresAt > Date.now()) this.cookies.set(name, cookie)
        else removedExpired = true
      }
      if (removedExpired) this.persist()
    } catch {
      deleteSession.run(uid)
    }
  }

  get idleSince(): number {
    return this.lastUsedAt
  }

  get loggedIn(): boolean {
    const userId = this.getCookie('user_id')
    return !!userId && userId !== '0'
  }

  getCookie(name: string): string | undefined {
    const cookie = this.cookies.get(name)
    if (!cookie) return undefined
    if (cookie.expiresAt && cookie.expiresAt <= Date.now()) {
      this.cookies.delete(name)
      this.persist()
      return undefined
    }
    return cookie.value
  }

  clear(): void {
    this.cookies.clear()
    deleteSession.run(this.uid)
  }

  private persist(): void {
    if (this.cookies.size === 0) {
      deleteSession.run(this.uid)
      return
    }
    saveSession.run(this.uid, encryptCookies(Object.fromEntries(this.cookies)), Date.now())
  }

  private cookieHeader(): string {
    let changed = false
    const now = Date.now()
    for (const [name, cookie] of this.cookies) {
      if (cookie.expiresAt && cookie.expiresAt <= now) {
        this.cookies.delete(name)
        changed = true
      }
    }
    if (changed) this.persist()
    return [...this.cookies.entries()].map(([name, cookie]) => `${name}=${cookie.value}`).join('; ')
  }

  private ingest(headers: Headers): void {
    let changed = false
    for (const raw of setCookieHeaders(headers)) {
      const pair = raw.split(';', 1)[0].trim()
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue
      const expiresRaw = raw.match(/(?:^|;)\s*expires=([^;]+)/i)?.[1]
      const expiresAt = expiresRaw ? Date.parse(expiresRaw) : undefined
      const maxAgeRaw = raw.match(/(?:^|;)\s*max-age\s*=\s*(-?\d+)(?:;|$)/i)?.[1]
      const maxAge = maxAgeRaw === undefined ? undefined : Number(maxAgeRaw)
      const deleted = !value
        || (maxAge !== undefined && maxAge <= 0)
        || (expiresAt !== undefined && Number.isFinite(expiresAt) && expiresAt <= Date.now())
      if (deleted) {
        changed = this.cookies.delete(name) || changed
      } else {
        const cookie: StoredCookie = {
          value,
          ...(maxAge !== undefined && maxAge > 0
            ? { expiresAt: Date.now() + maxAge * 1000 }
            : expiresAt !== undefined && Number.isFinite(expiresAt)
              ? { expiresAt }
              : { expiresAt: Date.now() + SESSION_COOKIE_MAX_AGE_MS }),
        }
        const previous = this.cookies.get(name)
        if (previous?.value === cookie.value && previous.expiresAt === cookie.expiresAt) continue
        this.cookies.set(name, cookie)
        changed = true
      }
    }
    if (changed) this.persist()
  }

  private async requestOnce(url: string, options: RequestOptions): Promise<XifanHttpResponse> {
    await proxyReady // 本地开发：等代理探测定盘，避免首个请求走错传输层
    let current = url
    if (new URL(current).origin !== BASE_ORIGIN) throw new Error('拒绝向稀饭站外发送登录会话')
    let method = options.method ?? 'GET'
    let body = options.body
    for (let redirectsLeft = 5; ; redirectsLeft--) {
      const headers = {
        ...BASE_HEADERS,
        ...(this.cookies.size > 0 ? { Cookie: this.cookieHeader() } : {}),
        ...options.headers,
      }
      const execute = (): Promise<Response> => fetch(current, {
        method,
        headers,
        body: method === 'POST' ? body : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
      })
      const response = options.paced === false ? await execute() : await scheduleRequest(execute)
      this.ingest(response.headers)

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (location) {
          if (redirectsLeft <= 0) throw new Error('稀饭重定向次数过多')
          const next = new URL(location, current)
          if (next.origin !== BASE_ORIGIN) throw new Error('稀饭返回了不安全的跨站重定向')
          current = next.href
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
            method = 'GET'
            body = undefined
          }
          continue
        }
      }

      return {
        status: response.status,
        headers: response.headers,
        body: Buffer.from(await response.arrayBuffer()),
        url: current,
      }
    }
  }

  private enqueuePaced<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pacedPending >= 5) return Promise.reject(new XifanLocalRateLimitError())
    this.pacedPending += 1
    const job = this.pacedQueue.then(fn)
    this.pacedQueue = job.then(() => undefined, () => undefined)
    return job.finally(() => {
      this.pacedPending -= 1
    })
  }

  async request(url: string, options: RequestOptions = {}): Promise<XifanHttpResponse> {
    this.lastUsedAt = Date.now()
    const execute = async (): Promise<XifanHttpResponse> => {
      try {
        return await this.requestOnce(url, options)
      } catch (error) {
        if (options.retryTransient && isTransient(error)) return this.requestOnce(url, options)
        throw error
      }
    }
    return options.paced === false ? execute() : this.enqueuePaced(execute)
  }

  get(
    url: string,
    headers: Record<string, string> = {},
    options: Omit<RequestOptions, 'method' | 'headers' | 'body'> = {},
  ): Promise<XifanHttpResponse> {
    return this.request(url, { ...options, method: 'GET', headers })
  }

  post(
    url: string,
    body: string,
    headers: Record<string, string> = {},
    options: Omit<RequestOptions, 'method' | 'headers' | 'body'> = {},
  ): Promise<XifanHttpResponse> {
    return this.request(url, { ...options, method: 'POST', headers, body })
  }
}

const sessions = new Map<number, XifanCookieSession>()

export function xifanSessionFor(uid: number): XifanCookieSession {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.idleSince > SESSION_TTL_MS) sessions.delete(id)
  }
  let session = sessions.get(uid)
  if (!session) {
    session = new XifanCookieSession(uid)
    sessions.set(uid, session)
  }
  return session
}
