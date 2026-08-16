// Google OIDC —— 授权码 + PKCE，浏览器整页跳进 Google、整页跳回来，服务端换 token
// 并对 id_token 做 JWKS 验签。挂在 /api/auth/oauth（index.ts）。
//
// 模型（2026-08-16 定稿）：**邮箱是身份本身，Google 只是 Gmail 的免验证码通道**。
//  - 登录：Google 已核验邮箱命中本站账号 → 直接登录；没命中 → 以该邮箱建号并登录。
//    「Google 快捷登录」和「该邮箱收验证码登录」永远进同一个账号，不存在第二种绑定。
//  - 换绑：设置页发起，Google 路径免验证码（OAuth 即证明控制新邮箱），验证码路径照旧。
//  - 早期按 oauth_identity(provider+subject) 匹配的登录逻辑已移除；表保留但不再读写，
//    换绑/解绑邮箱时顺手清掉旧记录，避免留下与邮箱脱节的僵尸关联。
//
// 设计约束：
//  - GOOGLE_CLIENT_ID / SECRET 任一未配则入口不出现（/providers 回 google:false）；
//  - state / nonce / PKCE verifier 不落库，塞进 5 分钟短效 HMAC 签名 cookie，回调时一次性消费；
//  - 跳转 cookie 必须 SameSite=Lax：回调是 Google 发起的跨站顶层 GET 跳转，Strict 根本不会带上 cookie。
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from 'node:crypto'
import { db } from './db'
import {
  REGISTER_MAX_PER_IP,
  REGISTER_WINDOW,
  SECURE,
  clientIp,
  deleteIdentitiesForUser,
  findByEmail,
  findById,
  getSession,
  insertPasswordlessEmailUser,
  issueSession,
  makeEmailUsername,
  makeUnusablePasswordHash,
  normalizeEmail,
  rateLimited,
  updateUserEmail,
  verifySecret,
  type UserRow,
} from './auth'
import { emailDeliveryConfigured } from './email-delivery'
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
  /** 完成后回跳的站内路径。 */
  r: string
  exp: number
  /** 换绑模式：目标用户与签发时的 token_version。回调时会话 cookie（SameSite=Strict）
   *  不随 Google 发起的跨站顶层 GET 回传，读不到登录态，所以把身份放进这枚签名短效
   *  cookie 里带过去；tv 对不上（改过密码/被踢）即拒绝。 */
  u?: number
  tv?: number
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

/** 邮箱落点（登录路径）：命中即登录，未命中建号。邮箱就是身份。 */
const resolveGoogleLogin = db.transaction((email: string, now: number): UserRow => {
  let user = findByEmail.get(email) as UserRow | undefined
  if (!user) {
    const username = makeEmailUsername()
    const createdAt = new Date(now).toISOString()
    insertPasswordlessEmailUser.run(username, makeUnusablePasswordHash(), email, createdAt, createdAt)
    user = findByEmail.get(email) as UserRow | undefined
    if (!user) throw new Error('账号创建后读取失败')
  }
  return user
})

/** 收尾：清跳转 cookie，回 returnTo。结果码区分登录与换绑两条流程：
 *  登录失败 oauth=failed（App 弹登录框）；换绑结果 bound / conflict / bind_failed
 *  由设置页就地提示，不会误触登录框。silent = 用户在 Google 页主动取消，静默回去。 */
type FinishCode = 'ok' | 'failed' | 'bound' | 'conflict' | 'bind_failed'

function finish(c: Context, tx: OAuthTx | null, code: FinishCode, silent = false): Response {
  deleteCookie(c, TX_COOKIE, { path: TX_COOKIE_PATH, secure: SECURE, sameSite: 'Lax' })
  const base = tx?.r ?? '/'
  if (code === 'ok' || silent) return c.redirect(base)
  const sep = base.includes('?') ? '&' : '?'
  return c.redirect(`${base}${sep}oauth=${code}`)
}

const oauth = new Hono()

oauth.get('/providers', (c) =>
  c.json({ google: googleConfigured(), email: emailDeliveryConfigured() }),
)

/** 组 Google 授权 URL（登录 / 换绑通用 —— 差异全在 tx 里：换绑模式带 u/tv）。 */
function googleAuthUrl(c: Context, tx: OAuthTx): string {
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
  return `${GOOGLE_AUTH_URL}?${params.toString()}`
}

/** 生成一张新票据（登录模式：不带 u/tv）。 */
function freshLoginTx(returnTo: string | undefined): OAuthTx {
  return {
    s: randomBytes(24).toString('base64url'),
    n: randomBytes(16).toString('base64url'),
    v: randomBytes(32).toString('base64url'),
    r: sanitizeReturnTo(returnTo),
    exp: Date.now() + TX_TTL,
  }
}

function setTxCookie(c: Context, tx: OAuthTx): void {
  setCookie(c, TX_COOKIE, encodeTx(tx), {
    httpOnly: true,
    secure: SECURE,
    sameSite: 'Lax',
    path: TX_COOKIE_PATH,
    maxAge: Math.ceil(TX_TTL / 1000),
  })
}

oauth.get('/google/start', (c) => {
  if (!googleConfigured()) return c.json({ error: 'Google 登录未启用' }, 404)
  if (rateLimited(`oauth-start-ip:${clientIp(c)}`, OAUTH_START_MAX_PER_IP, 15 * 60 * 1000)) {
    return c.json({ error: '操作太频繁，请稍后再试' }, 429)
  }
  const tx = freshLoginTx(c.req.query('returnTo'))
  setTxCookie(c, tx)
  return c.redirect(googleAuthUrl(c, tx))
})

/**
 * 换绑邮箱的 Google 路径：授权即证明控制新 Gmail，免验证码。
 * POST 而非 GET 直跳 —— 前置门槛在这里把守：账号必须已设密码且验密码正确
 * （邮箱是身份，借来的会话换不了），过了才发授权 URL 给前端整页跳。
 */
oauth.post('/google/rebind-email', async (c) => {
  if (!googleConfigured()) return c.json({ error: 'Google 登录未启用' }, 404)
  const s = await getSession(c)
  if (!s) return c.json({ error: '未登录' }, 401)
  const row = findById.get(s.uid) as UserRow | undefined
  if (!row || row.token_version !== s.tv) return c.json({ error: '登录状态已失效' }, 401)
  if (rateLimited(`oauth-start-ip:${clientIp(c)}`, OAUTH_START_MAX_PER_IP, 15 * 60 * 1000)) {
    return c.json({ error: '操作太频繁，请稍后再试' }, 429)
  }
  if (row.password_enabled !== 1) {
    return c.json({ error: '请先设置密码，再更换或解绑邮箱' }, 403)
  }
  const body = (await c.req.json().catch(() => null)) as { currentPassword?: string } | null
  if (!(await verifySecret(body?.currentPassword ?? '', row.pass_hash))) {
    return c.json({ error: '原始密码不正确' }, 401)
  }

  const tx: OAuthTx = {
    ...freshLoginTx(c.req.query('returnTo')),
    u: row.id,
    tv: row.token_version,
  }
  setTxCookie(c, tx)
  return c.json({ url: googleAuthUrl(c, tx) })
})

oauth.get('/google/callback', async (c) => {
  if (!googleConfigured()) return finish(c, null, 'failed')

  const tx = decodeTx(getCookie(c, TX_COOKIE))
  const state = c.req.query('state') ?? ''
  const code = c.req.query('code') ?? ''
  const denied = c.req.query('error') ?? ''
  const bindMode = tx?.u !== undefined // 票据带 u/tv = 换绑模式
  // 用户在 Google 页面点了取消 —— 不是错误，静默回去，别拿红字吓人。
  if (denied) return finish(c, tx, bindMode ? 'bind_failed' : 'failed', denied === 'access_denied')
  if (!tx || !code || !safeEqualStr(tx.s, state)) return finish(c, tx, bindMode ? 'bind_failed' : 'failed')

  // 换 token：授权码 + PKCE verifier 一次性换取 id_token 并验签核对。
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
    return finish(c, tx, bindMode ? 'bind_failed' : 'failed')
  }

  // 邮箱就是身份：只有 Google 明确核验过的邮箱才参与命中 / 写入，未核验一律当失败。
  const verifiedEmail = claims.email && claims.email_verified === true ? normalizeEmail(claims.email) : ''
  if (!verifiedEmail) return finish(c, tx, bindMode ? 'bind_failed' : 'failed')

  // 换绑模式：把授权得到的 Gmail 写进目标账号（密码已在 rebind-email 前置验证过）。
  if (bindMode) {
    const user = findById.get(tx.u as number) as UserRow | undefined
    if (!user || user.token_version !== tx.tv) return finish(c, tx, 'bind_failed')
    const owner = findByEmail.get(verifiedEmail) as UserRow | undefined
    if (owner && owner.id !== user.id) return finish(c, tx, 'conflict')
    updateUserEmail.run(verifiedEmail, new Date().toISOString(), user.id)
    deleteIdentitiesForUser.run(user.id)
    return finish(c, tx, 'bound')
  }

  // 登录模式：按邮箱落点 —— 命中账号直接登录，新邮箱建号（与验证码登录进同一个账号）。
  if (rateLimited(`reg:${clientIp(c)}`, REGISTER_MAX_PER_IP, REGISTER_WINDOW)) {
    return finish(c, tx, 'failed')
  }

  let user: UserRow
  try {
    user = resolveGoogleLogin(verifiedEmail, Date.now())
  } catch {
    return finish(c, tx, 'failed')
  }

  await issueSession(c, { uid: user.id, username: user.username, tv: user.token_version })
  return finish(c, tx, 'ok')
})

export default oauth
