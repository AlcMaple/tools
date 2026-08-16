// Google OIDC 登录 —— 授权码 + PKCE，浏览器整页跳进 Google、整页跳回来，服务端换 token
// 并对 id_token 做 JWKS 验签。挂在 /api/auth/oauth（index.ts），回调地址与 Google 控制台
// 登记的一致：/api/auth/oauth/google/callback。
//
// 设计约束：
//  - GOOGLE_CLIENT_ID / SECRET 任一未配则整个入口不出现（/providers 回 google:false，前端不画按钮）；
//  - state / nonce / PKCE verifier 不落库，塞进 5 分钟短效 HMAC 签名 cookie，回调时一次性消费；
//  - 账号键是 provider + subject（Google 的 sub，不随邮箱改名漂移）。Google 已核验（email_verified）
//    的邮箱与本站「验证码证明邮箱控制权」证明的是同一事实，允许直接并入现有邮箱账号，其余一律新建；
//  - 跳转 cookie 必须 SameSite=Lax：回调是 Google 发起的跨站顶层 GET 跳转，Strict 根本不会带上 cookie。
//    会话 cookie 本身仍是 Strict，不受影响。
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from 'node:crypto'
import { db } from './db'
import {
  REGISTER_MAX_PER_IP,
  REGISTER_WINDOW,
  SECURE,
  clientIp,
  findByEmail,
  findById,
  findByName,
  insertPasswordlessEmailUser,
  issueSession,
  makeEmailUsername,
  makeUnusablePasswordHash,
  normalizeEmail,
  rateLimited,
  type UserRow,
} from './auth'
import { AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from './secrets'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'

const CALLBACK_PATH = '/api/auth/oauth/google/callback'
const TX_COOKIE = 'mt_oauth_tx'
const TX_COOKIE_PATH = '/api/auth/oauth'
const TX_TTL = 5 * 60 * 1000
const OAUTH_START_MAX_PER_IP = 20 // 15 分钟；start 本身不建号，只挡恶意刷跳转

function googleConfigured(): boolean {
  return !!GOOGLE_CLIENT_ID && !!GOOGLE_CLIENT_SECRET
}

// 反代场景下 node 看到的是 http://127.0.0.1，回调 URI 必须按浏览器看到的 origin 拼
// （与 security.ts requestOrigin 同一套逻辑），否则和 Google 登记的 https URI 对不上。
function requestOrigin(c: Context): string {
  const url = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '')
  const host = c.req.header('host') || url.host
  return `${proto}://${host}`
}

// returnTo 只允许站内路径，且不能是 `//evil.com` 这种协议相对地址。
function sanitizeReturnTo(v: string | undefined): string {
  if (!v || !v.startsWith('/') || v.startsWith('//') || v.length > 512) return '/'
  return v
}

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

interface OAuthTx {
  /** 防 CSRF 的 state，回调查对。 */
  s: string
  /** id_token 里的 nonce，防重放。 */
  n: string
  /** PKCE code_verifier。 */
  v: string
  /** 登录完回跳的站内路径。 */
  r: string
  exp: number
}

function encodeTx(tx: OAuthTx): string {
  const payload = Buffer.from(JSON.stringify(tx)).toString('base64url')
  return `${payload}.${createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url')}`
}

function decodeTx(value: string | undefined): OAuthTx | null {
  if (!value) return null
  const dot = value.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  const expected = createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url')
  if (!safeEqualStr(sig, expected)) return null
  try {
    const tx = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OAuthTx
    if (typeof tx.exp !== 'number' || Date.now() > tx.exp) return null
    return tx
  } catch {
    return null
  }
}

interface GoogleJwk {
  kid?: string
  kty?: string
  alg?: string
  use?: string
  n?: string
  e?: string
}

// JWKS 缓存 1 小时；Google 轮换密钥后按 kid 未命中强制刷新一次。
let jwksCache: { keys: GoogleJwk[]; fetchedAt: number } | null = null

async function googleJwks(force = false): Promise<GoogleJwk[]> {
  if (!force && jwksCache && Date.now() - jwksCache.fetchedAt < 3600_000) return jwksCache.keys
  const res = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error('无法获取 Google 签名密钥')
  const data = (await res.json()) as { keys?: GoogleJwk[] }
  jwksCache = { keys: data.keys ?? [], fetchedAt: Date.now() }
  return jwksCache.keys
}

interface GoogleClaims {
  iss?: string
  aud?: string
  exp?: number
  nonce?: string
  sub?: string
  email?: string
  email_verified?: boolean | string
}

/** 验签 + 边界核对 id_token。任何一项不符直接抛错 —— 未验签的 id_token 等于别人递来的身份卡。 */
async function verifyGoogleIdToken(idToken: string, nonce: string): Promise<GoogleClaims> {
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new Error('id_token 格式错误')
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as {
    alg?: string
    kid?: string
  }
  if (header.alg !== 'RS256' || !header.kid) throw new Error('id_token 算法或密钥标识不符')

  let keys = await googleJwks()
  let jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) {
    keys = await googleJwks(true)
    jwk = keys.find((k) => k.kid === header.kid)
  }
  if (!jwk || !jwk.n || !jwk.e) throw new Error('Google 签名密钥不存在')
  const key = createPublicKey({ key: jwk as unknown as JsonWebKey, format: 'jwk' })
  const ok = verifySignature(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    key,
    Buffer.from(parts[2], 'base64url'),
  )
  if (!ok) throw new Error('id_token 签名校验失败')

  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as GoogleClaims
  const issOk = claims.iss === 'accounts.google.com' || claims.iss === 'https://accounts.google.com'
  if (!issOk || claims.aud !== GOOGLE_CLIENT_ID) throw new Error('id_token 签发者或受众不符')
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) throw new Error('id_token 已过期')
  if (typeof claims.nonce !== 'string' || !safeEqualStr(claims.nonce, nonce)) throw new Error('nonce 不匹配')
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('id_token 缺少 subject')
  return claims
}

const findIdentity = db.prepare<[string, string]>(
  'SELECT provider, subject, user_id FROM oauth_identity WHERE provider = ? AND subject = ?',
)
const insertIdentity = db.prepare<[string, string, number, string | null, string]>(
  'INSERT INTO oauth_identity (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)',
)
const insertIdentityOnlyUser = db.prepare<[string, string, string]>(
  'INSERT INTO users (username, pass_hash, password_enabled, created_at) VALUES (?, ?, 0, ?)',
)

/**
 * subject → 用户的最终落点，事务保证同一 subject 并发回调只有一个建号成功：
 *  - 已绑过 → 直接返回用户；
 *  - Google 已核验的邮箱命中现有账号 → 并入（证明的是同一事实：控制那个邮箱）；
 *  - 否则新建无密码账号（有已核验邮箱则带上邮箱，没有就不带）。
 */
const resolveGoogleUser = db.transaction((subject: string, email: string | null, now: number): UserRow => {
  const bound = findIdentity.get('google', subject) as { user_id: number } | undefined
  if (bound) {
    const user = findById.get(bound.user_id) as UserRow | undefined
    if (user) return user
    throw new Error('第三方身份指向的用户不存在')
  }

  let user = (email ? findByEmail.get(email) : undefined) as UserRow | undefined
  if (!user) {
    const username = makeEmailUsername()
    const createdAt = new Date(now).toISOString()
    if (email) {
      insertPasswordlessEmailUser.run(username, makeUnusablePasswordHash(), email, createdAt, createdAt)
      user = findByEmail.get(email) as UserRow | undefined
    } else {
      insertIdentityOnlyUser.run(username, makeUnusablePasswordHash(), createdAt)
      user = findByName.get(username) as UserRow | undefined
    }
    if (!user) throw new Error('账号创建后读取失败')
  }
  insertIdentity.run('google', subject, user.id, email, new Date(now).toISOString())
  return user
})

/** 收尾：清跳转 cookie，回 returnTo；失败时带 oauth=failed 让前端弹登录框提示。 */
function finish(c: Context, tx: OAuthTx | null, ok: boolean, silent = false): Response {
  deleteCookie(c, TX_COOKIE, { path: TX_COOKIE_PATH, secure: SECURE, sameSite: 'Lax' })
  const base = tx?.r ?? '/'
  if (ok || silent) return c.redirect(base)
  return c.redirect(`${base}${base.includes('?') ? '&' : '?'}oauth=failed`)
}

const oauth = new Hono()

oauth.get('/providers', (c) => c.json({ google: googleConfigured() }))

oauth.get('/google/start', (c) => {
  if (!googleConfigured()) return c.json({ error: 'Google 登录未启用' }, 404)
  if (rateLimited(`oauth-start-ip:${clientIp(c)}`, OAUTH_START_MAX_PER_IP, 15 * 60 * 1000)) {
    return c.json({ error: '操作太频繁，请稍后再试' }, 429)
  }

  const tx: OAuthTx = {
    s: randomBytes(24).toString('base64url'),
    n: randomBytes(16).toString('base64url'),
    v: randomBytes(32).toString('base64url'),
    r: sanitizeReturnTo(c.req.query('returnTo')),
    exp: Date.now() + TX_TTL,
  }
  setCookie(c, TX_COOKIE, encodeTx(tx), {
    httpOnly: true,
    secure: SECURE,
    sameSite: 'Lax',
    path: TX_COOKIE_PATH,
    maxAge: Math.ceil(TX_TTL / 1000),
  })

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${requestOrigin(c)}${CALLBACK_PATH}`,
    response_type: 'code',
    scope: 'openid email profile',
    state: tx.s,
    nonce: tx.n,
    code_challenge: createHash('sha256').update(tx.v).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  })
  return c.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`)
})

oauth.get('/google/callback', async (c) => {
  if (!googleConfigured()) return finish(c, null, false)

  const tx = decodeTx(getCookie(c, TX_COOKIE))
  const state = c.req.query('state') ?? ''
  const code = c.req.query('code') ?? ''
  const denied = c.req.query('error') ?? ''
  // 用户在 Google 页面点了取消 —— 不是错误，静默回去，别拿红字吓人。
  if (denied) return finish(c, tx, false, denied === 'access_denied')
  if (!tx || !code || !safeEqualStr(tx.s, state)) return finish(c, tx, false)

  let claims: GoogleClaims
  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code_verifier: tx.v,
        redirect_uri: `${requestOrigin(c)}${CALLBACK_PATH}`,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!tokenRes.ok) throw new Error('token 换取失败')
    const tokens = (await tokenRes.json()) as { id_token?: string }
    if (!tokens.id_token) throw new Error('响应缺少 id_token')
    claims = await verifyGoogleIdToken(tokens.id_token, tx.n)
  } catch {
    return finish(c, tx, false)
  }

  // 只有 Google 明确核验过的邮箱才参与匹配与建号；未核验的邮箱当没有处理。
  const verifiedEmail = claims.email && claims.email_verified === true ? normalizeEmail(claims.email) : ''
  const bound = findIdentity.get('google', claims.sub as string) as { user_id: number } | undefined
  if (!bound && rateLimited(`reg:${clientIp(c)}`, REGISTER_MAX_PER_IP, REGISTER_WINDOW)) {
    return finish(c, tx, false)
  }

  let user: UserRow
  try {
    user = resolveGoogleUser(claims.sub as string, verifiedEmail || null, Date.now())
  } catch {
    return finish(c, tx, false)
  }

  await issueSession(c, { uid: user.id, username: user.username, tv: user.token_version })
  return finish(c, tx, true)
})

export default oauth
