// 账号体系 —— 开放注册 + 用户名/密码，另有邮箱验证码快捷注册 / 登录。规模小但开放（GitHub star 者互不认识，发不了邀请码，
// 所以不做邀请制，见 ideas/012 待调研 #3）。密码用 Node 内置 scrypt 哈希（不加 bcrypt 依赖），
// 会话用 JWT httpOnly 签名 cookie（无状态，不建 session 表）。
import { Hono } from 'hono'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { sign, verify } from 'hono/jwt'
import { createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { domainToASCII } from 'node:url'
import { db } from './db'
import { emailDeliveryConfigured, sendEmailCode } from './email-delivery'
import { USERNAME_MAX, USERNAME_MIN, usernameError } from './username'

const scryptAsync = promisify(scrypt)

// 生产没有强随机密钥就拒绝启动。继续用公开占位串会让攻击者直接伪造 JWT，会话保护等于零。
const IS_PRODUCTION = process.env.NODE_ENV === 'production'
const configuredSecret = process.env.AUTH_SECRET?.trim() ?? ''
if (IS_PRODUCTION && configuredSecret.length < 32) {
  throw new Error('[auth] 生产必须设置至少 32 个字符的随机 AUTH_SECRET')
}
const SECRET = configuredSecret || 'dev-insecure-secret-change-me'

// 生产用 __Host- 前缀：浏览器强制 Secure、Path=/ 且不允许 Domain，降低子域 / 路径投毒风险。
// 开发环境仍用普通名字，否则 http://localhost 不会回传 __Host- Cookie。
const COOKIE = IS_PRODUCTION ? '__Host-mt_session' : 'mt_session'
const LEGACY_COOKIE = 'mt_session'
const MAX_AGE = 60 * 60 * 24 * 30 // 30 天（秒）
// 生产走 HTTPS → secure cookie；dev 是 http://localhost，secure 会导致浏览器不回传，故按环境切。
const SECURE = IS_PRODUCTION

const PASSWORD_MIN = 6
const PASSWORD_MAX = 200
const ANSWER_MAX = 100
const EMAIL_MAX = 254
const EMAIL_CODE_TTL = 10 * 60 * 1000
const EMAIL_CODE_ATTEMPTS = 5
const EMAIL_SEND_COOLDOWN = 60 * 1000
const EMAIL_START_MAX_PER_IP = 10
const EMAIL_START_MAX_PER_ADDRESS = 5
const EMAIL_REGISTER_MAX_PER_IP = 10
const EMAIL_REGISTER_MAX_PER_ADDRESS = 10

/**
 * 密保问题用**预设列表**，不让用户自由填写。两头的坑都躲开了：
 *   - 自由填写 → 找回时要用户一字不差地重打一遍问题，基本没人记得住
 *   - 按用户名把问题显示出来 → 等于把问题泄露给任何知道你用户名的人
 * 预设下拉：两边都从同一个列表里选，好记、且不泄露。库里存 id，不存题面。
 */
export const SECURITY_QUESTIONS = [
  { id: 'first_anime', text: '我的第一部入坑番是？' },
  { id: 'mother_name', text: '我母亲的姓名是？' },
  { id: 'birth_city', text: '我出生的城市是？' },
  { id: 'primary_school', text: '我小学的校名是？' },
  { id: 'first_pet', text: '我养的第一只宠物叫？' },
]
const QUESTION_IDS = new Set(SECURITY_QUESTIONS.map((q) => q.id))

// scrypt 存成 `salt:hash`（都 hex）。密码和密保答案共用 —— 答案跟密码同级敏感（多是真实个人
// 信息、且会跨站复用），绝不存明文。
async function hashSecret(v: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = (await scryptAsync(v, salt, 64)) as Buffer
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

async function verifySecret(v: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const derived = (await scryptAsync(v, Buffer.from(saltHex, 'hex'), expected.length)) as Buffer
  // 长度不等时 timingSafeEqual 会抛，先挡一下；再做定时安全比较防时序侧信道。
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

// 密保答案比对前归一化 —— 否则「北京」和「 北京 」、Beijing / beijing 不匹配，用户会疯。
function normalizeAnswer(a: string): string {
  return a.trim().toLowerCase()
}

interface Session {
  uid: number
  username: string
  /** 签发时的 token_version。校验时跟库里对不上 → 拒绝（改密码后老 token 立即失效）。 */
  tv: number
}

// 签发会话 cookie。payload 带 exp（秒），hono/jwt verify 会据此判过期。
async function issueSession(c: Context, s: Session): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE
  const token = await sign({ ...s, exp }, SECRET, 'HS256')
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: SECURE,
    sameSite: 'Strict',
    path: '/',
    maxAge: MAX_AGE,
  })
}

// 预编译语句
const findByName = db.prepare<[string]>(
  'SELECT id, username, pass_hash, email, email_verified_at, token_version, security_question, security_answer_hash, created_at FROM users WHERE username = ?',
)
const findByEmail = db.prepare<[string]>(
  'SELECT id, username, pass_hash, email, email_verified_at, token_version, security_question, security_answer_hash, created_at FROM users WHERE email = ?',
)
const findById = db.prepare<[number]>(
  'SELECT id, username, pass_hash, email, email_verified_at, token_version, security_question, security_answer_hash, created_at FROM users WHERE id = ?',
)
const insertUser = db.prepare<[string, string, string]>(
  'INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)',
)
const bumpPassword = db.prepare<[string, number]>(
  'UPDATE users SET pass_hash = ?, token_version = token_version + 1 WHERE id = ?',
)
const setSecurity = db.prepare<[string, string, number]>(
  'UPDATE users SET security_question = ?, security_answer_hash = ? WHERE id = ?',
)
const setEmailVerified = db.prepare<[string, number]>(
  'UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL',
)

const findChallenge = db.prepare<[string]>(
  'SELECT id, email, code_hash, attempts, created_at, expires_at, verified_at, consumed_at FROM email_challenge WHERE id = ?',
)
const findRecentChallenge = db.prepare<[string]>(
  'SELECT id, created_at FROM email_challenge WHERE email = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1',
)
const insertChallenge = db.prepare<[string, string, string, number, number]>(
  'INSERT INTO email_challenge (id, email, code_hash, attempts, created_at, expires_at) VALUES (?, ?, ?, 0, ?, ?)',
)
const incrementChallengeAttempts = db.prepare<[string]>(
  'UPDATE email_challenge SET attempts = attempts + 1 WHERE id = ?',
)
const markChallengeVerified = db.prepare<[number, string]>(
  'UPDATE email_challenge SET verified_at = ? WHERE id = ? AND consumed_at IS NULL',
)
const consumeChallenge = db.prepare<[number, string]>(
  'UPDATE email_challenge SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
)
const deleteChallenge = db.prepare<[string]>('DELETE FROM email_challenge WHERE id = ?')
const cleanupChallenges = db.prepare<[number]>(
  'DELETE FROM email_challenge WHERE expires_at < ? OR consumed_at IS NOT NULL',
)
const insertEmailUser = db.prepare<[string, string, string, string, string]>(
  'INSERT INTO users (username, pass_hash, email, email_verified_at, created_at) VALUES (?, ?, ?, ?, ?)',
)

interface UserRow {
  id: number
  username: string
  pass_hash: string
  email: string | null
  email_verified_at: string | null
  token_version: number
  security_question: string | null
  security_answer_hash: string | null
  created_at: string
}

/**
 * 从请求 cookie 解出会话；无 / 失效 / 过期 / token_version 对不上 → null。
 * 供后续 /api/tracks 等受保护路由复用。
 */
export async function getSession(c: Context): Promise<Session | null> {
  const token = getCookie(c, COOKIE)
  if (!token) return null
  try {
    const payload = (await verify(token, SECRET, 'HS256')) as unknown as Session
    // 每个已登录请求多一次索引读（微秒级）—— 换来「改密码能真正踢掉所有老会话」。
    const row = findById.get(payload.uid) as UserRow | undefined
    if (!row || row.token_version !== payload.tv) return null
    return { uid: row.id, username: row.username, tv: row.token_version }
  } catch {
    return null
  }
}

/**
 * 固定窗口限流 —— 凡是「拿密码/答案来猜」的入口都必须挂，不然等于敞开暴力破解。
 * 内存 Map、单进程有效；重启即清空（可接受，攻击者拿不到重启时机）。将来上多实例得换 Redis。
 */
const buckets = new Map<string, { n: number; resetAt: number }>()

function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  // 攻击者拿随机用户名刷会不停建桶 → 内存无上限。到阈值先清过期的。
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) if (now > b.resetAt) buckets.delete(k)
  }
  const hit = buckets.get(key)
  if (!hit || now > hit.resetAt) {
    buckets.set(key, { n: 1, resetAt: now + windowMs })
    return false
  }
  hit.n += 1
  return hit.n > max
}

const WINDOW = 15 * 60 * 1000
const LOGIN_MAX_PER_USER = 10 // 挡「盯着一个号猜密码」
const LOGIN_MAX_PER_IP = 20 // 挡「一个来源换着号猜」
const FORGOT_MAX = 5 // 密保答案熵很低（「你的出生地」猜几十次就中），给得比密码更紧
const REGISTER_MAX_PER_IP = 5
const REGISTER_WINDOW = 60 * 60 * 1000

/**
 * 取客户端 IP。只认 `X-Real-IP` —— nginx 用 `$remote_addr` 直接覆写它，客户端伪造不了；
 * `X-Forwarded-For` 是**追加**的（伪造值在前、真 IP 在末尾），所以退化时取最后一段。
 * 前提是 node 只绑 127.0.0.1（见 node.ts）：nginx 之外没人能进来，这两个头才可信。
 */
function clientIp(c: Context): string {
  const real = c.req.header('x-real-ip')
  if (real) return real
  const fwd = c.req.header('x-forwarded-for')
  return fwd?.split(',').pop()?.trim() || 'local'
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    return (await c.req.json()) as Record<string, unknown>
  } catch {
    return null
  }
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * 邮箱比较策略：域名和本地部分统一转小写，不做 Gmail 点号 / plus alias 合并。
 * 这是本站自己的账号标识策略，避免同一邮箱在注册、登录、验证和找回流程里出现分歧。
 */
function normalizeEmail(value: string): string {
  const raw = value.trim()
  if (!raw || raw.length > EMAIL_MAX || /[\r\n]/.test(raw)) return ''
  const at = raw.lastIndexOf('@')
  if (at <= 0 || at === raw.length - 1 || raw.indexOf('@') !== at) return ''
  const local = raw.slice(0, at)
  const domain = domainToASCII(raw.slice(at + 1).toLowerCase())
  if (!domain || local.length > 64 || /\s/.test(local)) return ''
  return `${local.toLowerCase()}@${domain.toLowerCase()}`
}

function emailCodeHash(challengeId: string, code: string): Buffer {
  return createHmac('sha256', SECRET).update(`${challengeId}:${code}`).digest()
}

function verifyEmailCodeHash(challengeId: string, code: string, storedHex: string): boolean {
  const expected = Buffer.from(storedHex, 'hex')
  const actual = emailCodeHash(challengeId, code)
  return expected.length === actual.length && timingSafeEqual(actual, expected)
}

function newChallengeId(): string {
  return randomBytes(24).toString('base64url')
}

function makeEmailUsername(email: string): string {
  const local = email.slice(0, email.lastIndexOf('@')).replace(/[^\p{L}\p{N}_-]/gu, '')
  const base = (local.length >= USERNAME_MIN ? local : 'user').slice(0, USERNAME_MAX)
  let candidate = base
  for (let i = 0; i < 20 && (usernameError(candidate) || findByName.get(candidate)); i++) {
    const suffix = randomBytes(3).toString('hex').slice(0, 4)
    candidate = `${base.slice(0, USERNAME_MAX - suffix.length)}${suffix}`
  }
  return candidate
}

interface EmailChallengeRow {
  id: string
  email: string
  code_hash: string
  attempts: number
  created_at: number
  expires_at: number
  verified_at: number | null
  consumed_at: number | null
}

const auth = new Hono()

// 账号响应包含会话状态，不能被浏览器或 CDN 缓存后复用到别的请求。
auth.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})

// 密保问题预设列表 —— 前端下拉的单一事实源，别在前端再抄一份。
auth.get('/questions', (c) => c.json({ questions: SECURITY_QUESTIONS }))

auth.post('/register', async (c) => {
  const body = await readJson(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)
  const username = str(body.username).trim()
  const password = str(body.password)
  const confirm = str(body.confirm)

  const usernameProblem = usernameError(username)
  if (usernameProblem) return c.json({ error: usernameProblem }, 400)
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return c.json({ error: `密码需 ${PASSWORD_MIN}–${PASSWORD_MAX} 个字符` }, 400)
  }
  if (password !== confirm) return c.json({ error: '两次输入的密码不一致' }, 400)
  // 开放注册 = 谁都能刷号把库撑爆。按 IP 限流：正常人一小时不会注册第 6 个号。
  if (rateLimited(`reg:${clientIp(c)}`, REGISTER_MAX_PER_IP, REGISTER_WINDOW)) {
    return c.json({ error: '注册太频繁，请稍后再试' }, 429)
  }
  if (findByName.get(username)) return c.json({ error: '用户名已被占用' }, 409)

  const info = insertUser.run(username, await hashSecret(password), new Date().toISOString())
  await issueSession(c, { uid: Number(info.lastInsertRowid), username, tv: 0 })
  return c.json({ username, hasSecurity: false, hasEmail: false })
})

auth.post('/login', async (c) => {
  const body = await readJson(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)
  const username = str(body.username).trim()
  const password = str(body.password)

  // 两个维度都要挡：只按用户名挡不住「换着号猜」，只按 IP 挡不住「多 IP 盯一个号猜」。
  // 放在 verify 之前 —— scrypt 很吃 CPU，先限流也顺带挡住拿登录接口打 CPU 的玩法。
  const ipKey = `login-ip:${clientIp(c)}`
  const userKey = `login-user:${username.toLowerCase()}`
  if (
    rateLimited(ipKey, LOGIN_MAX_PER_IP, WINDOW) ||
    rateLimited(userKey, LOGIN_MAX_PER_USER, WINDOW)
  ) {
    return c.json({ error: '尝试次数过多，请 15 分钟后再试' }, 429)
  }

  const normalizedEmail = normalizeEmail(username)
  const row = (findByName.get(username) || (normalizedEmail ? findByEmail.get(normalizedEmail) : undefined)) as UserRow | undefined
  // 用户名不存在也照样跑一次 verify，避免「用户名是否存在」被响应时间区分出来。
  const ok = row ? await verifySecret(password, row.pass_hash) : await verifySecret(password, 'x:x')
  if (!row || !ok) return c.json({ error: '用户名或密码错误' }, 401)

  // 登录成功即清账 —— 否则自己前几次打错字，剩下的额度还替攻击者留着扣。
  buckets.delete(ipKey)
  buckets.delete(userKey)
  await issueSession(c, { uid: row.id, username: row.username, tv: row.token_version })
  return c.json({ username: row.username, hasSecurity: !!row.security_answer_hash, hasEmail: !!row.email && !!row.email_verified_at })
})

/**
 * 邮箱快捷入口第一步：不区分邮箱是否已注册，统一创建短期验证码挑战。
 * 这样响应不会成为邮箱枚举器；验证码验证成功后，已有账号登录，新邮箱进入设置密码。
 */
auth.post('/email/start', async (c) => {
  if (!emailDeliveryConfigured()) return c.json({ error: '邮箱快捷登录暂不可用，请使用用户名和密码' }, 503)
  const body = await readJson(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)
  const email = normalizeEmail(str(body.email))
  if (!email) return c.json({ error: '请输入有效的邮箱地址' }, 400)

  const now = Date.now()
  cleanupChallenges.run(now)
  if (
    rateLimited(`email-start-ip:${clientIp(c)}`, EMAIL_START_MAX_PER_IP, WINDOW) ||
    rateLimited(`email-start-address:${email}`, EMAIL_START_MAX_PER_ADDRESS, WINDOW)
  ) {
    return c.json({ error: '验证码发送太频繁，请稍后再试' }, 429)
  }
  const recent = findRecentChallenge.get(email) as { id: string; created_at: number } | undefined
  if (recent && now - recent.created_at < EMAIL_SEND_COOLDOWN) {
    return c.json({ error: '验证码已发送，请稍后再试' }, 429)
  }
  if (recent) deleteChallenge.run(recent.id)

  const challengeId = newChallengeId()
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0')
  insertChallenge.run(
    challengeId,
    email,
    emailCodeHash(challengeId, code).toString('hex'),
    now,
    now + EMAIL_CODE_TTL,
  )
  try {
    await sendEmailCode(email, code)
  } catch {
    deleteChallenge.run(challengeId)
    return c.json({ error: '验证码邮件发送失败，请稍后再试' }, 502)
  }
  return c.json({ challengeId, expiresIn: EMAIL_CODE_TTL / 1000 })
})

/** 邮箱快捷入口第二步：验证码正确后，已有邮箱账号直接登录，新邮箱只拿到一次性建号资格。 */
auth.post('/email/verify', async (c) => {
  const body = await readJson(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)
  const challengeId = str(body.challengeId)
  const code = str(body.code).trim()
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(challengeId) || !/^\d{6}$/.test(code)) {
    return c.json({ error: '验证码格式不正确' }, 400)
  }
  if (rateLimited(`email-verify-ip:${clientIp(c)}`, EMAIL_CODE_ATTEMPTS * 4, WINDOW)) {
    return c.json({ error: '验证码尝试太频繁，请稍后再试' }, 429)
  }

  const row = findChallenge.get(challengeId) as EmailChallengeRow | undefined
  const now = Date.now()
  if (!row || row.consumed_at || row.expires_at <= now || row.attempts >= EMAIL_CODE_ATTEMPTS) {
    return c.json({ error: '验证码无效或已过期，请重新获取' }, 401)
  }
  if (rateLimited(`email-verify-address:${row.email}`, EMAIL_CODE_ATTEMPTS, WINDOW)) {
    return c.json({ error: '验证码尝试太频繁，请稍后再试' }, 429)
  }
  if (!row.verified_at) {
    if (!verifyEmailCodeHash(challengeId, code, row.code_hash)) {
      incrementChallengeAttempts.run(challengeId)
      return c.json({ error: '验证码不正确' }, 401)
    }
    markChallengeVerified.run(now, challengeId)
  }

  const existing = findByEmail.get(row.email) as UserRow | undefined
  if (existing) {
    setEmailVerified.run(new Date(now).toISOString(), existing.id)
    consumeChallenge.run(now, challengeId)
    await issueSession(c, { uid: existing.id, username: existing.username, tv: existing.token_version })
    return c.json({ status: 'login', username: existing.username, hasSecurity: !!existing.security_answer_hash, hasEmail: true })
  }
  return c.json({ status: 'set-password', challengeId, expiresIn: Math.max(0, Math.floor((row.expires_at - now) / 1000)) })
})

/** 新邮箱完成验证码后设置密码；用户名可选，留空时从邮箱本地部分生成显示名。 */
auth.post('/email/register', async (c) => {
  const body = await readJson(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)
  const challengeId = str(body.challengeId)
  const password = str(body.password)
  const confirm = str(body.confirm)
  const requestedUsername = str(body.username).trim()
  const row = findChallenge.get(challengeId) as EmailChallengeRow | undefined
  const now = Date.now()

  if (!row || !row.verified_at || row.consumed_at || row.expires_at <= now) {
    return c.json({ error: '邮箱验证已失效，请重新获取验证码' }, 401)
  }
  const registerIpKey = `email-register-ip:${clientIp(c)}`
  const registerAddressKey = `email-register-address:${row.email}`
  if (
    rateLimited(registerIpKey, EMAIL_REGISTER_MAX_PER_IP, WINDOW) ||
    rateLimited(registerAddressKey, EMAIL_REGISTER_MAX_PER_ADDRESS, WINDOW)
  ) {
    return c.json({ error: '注册尝试太频繁，请稍后再试' }, 429)
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return c.json({ error: `密码需 ${PASSWORD_MIN}–${PASSWORD_MAX} 个字符` }, 400)
  }
  if (password !== confirm) return c.json({ error: '两次输入的密码不一致' }, 400)
  const usernameProblem = requestedUsername ? usernameError(requestedUsername) : null
  if (usernameProblem) return c.json({ error: usernameProblem }, 400)
  if (findByEmail.get(row.email)) return c.json({ error: '该邮箱已经注册，请返回登录' }, 409)

  const username = requestedUsername || makeEmailUsername(row.email)
  if (findByName.get(username)) return c.json({ error: '用户名已被占用，请换一个' }, 409)
  const passHash = await hashSecret(password)
  const createdAt = new Date(now).toISOString()
  try {
    const create = db.transaction(() => {
      insertEmailUser.run(username, passHash, row.email, createdAt, createdAt)
      consumeChallenge.run(now, challengeId)
    })
    create()
  } catch {
    return c.json({ error: '账号创建失败，请稍后再试' }, 409)
  }

  const user = findByEmail.get(row.email) as UserRow
  buckets.delete(registerIpKey)
  buckets.delete(registerAddressKey)
  await issueSession(c, { uid: user.id, username: user.username, tv: user.token_version })
  return c.json({ username: user.username, hasSecurity: false, hasEmail: true })
})

auth.post('/logout', (c) => {
  deleteCookie(c, COOKIE, { path: '/', secure: SECURE, sameSite: 'Strict' })
  // 升级到 __Host- 名字时顺便清掉旧 Cookie，避免浏览器继续携带过期的会话材料。
  if (COOKIE !== LEGACY_COOKIE) deleteCookie(c, LEGACY_COOKIE, { path: '/', secure: SECURE, sameSite: 'Strict' })
  return c.json({ ok: true })
})

auth.get('/me', async (c) => {
  const s = await getSession(c)
  if (!s) return c.json({ error: '未登录' }, 401)
  const row = findById.get(s.uid) as UserRow
  return c.json({
    username: row.username,
    createdAt: row.created_at,
    // 只报「设没设」，**绝不回显问题和答案** —— 问题本身也是秘密，泄露了等于告诉别人该去查什么。
    hasSecurity: !!row.security_answer_hash,
    hasEmail: !!row.email && !!row.email_verified_at,
  })
})

/**
 * 账号安全设置 —— 改密码 和 / 或 改密保。
 * 新密码留空 = 不改密码（只改密保）。**两条路都强制验原始密码**：否则别人借你没锁屏的电脑
 * 就能悄悄把密保换成自己的，从此随时能接管账号。
 */
auth.post('/settings', async (c) => {
  const s = await getSession(c)
  if (!s) return c.json({ error: '未登录' }, 401)
  const body = await readJson(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)

  const current = str(body.currentPassword)
  const next = str(body.newPassword)
  const confirm = str(body.confirm)
  const questionId = str(body.questionId)
  const answer = str(body.answer)

  const row = findById.get(s.uid) as UserRow
  const settingsIpKey = `settings-ip:${clientIp(c)}`
  const settingsUserKey = `settings-user:${s.uid}`
  if (
    rateLimited(settingsIpKey, LOGIN_MAX_PER_IP, WINDOW) ||
    rateLimited(settingsUserKey, LOGIN_MAX_PER_USER, WINDOW)
  ) {
    return c.json({ error: '尝试次数过多，请 15 分钟后再试' }, 429)
  }
  if (!(await verifySecret(current, row.pass_hash))) {
    return c.json({ error: '原始密码不正确' }, 401)
  }

  const wantPassword = next.length > 0 || confirm.length > 0
  const wantSecurity = questionId.length > 0 || answer.length > 0
  if (!wantPassword && !wantSecurity) return c.json({ error: '没有要修改的内容' }, 400)

  if (wantSecurity) {
    if (!QUESTION_IDS.has(questionId)) return c.json({ error: '请选择一个密保问题' }, 400)
    const a = normalizeAnswer(answer)
    if (!a || a.length > ANSWER_MAX) return c.json({ error: '请填写密保答案' }, 400)
    setSecurity.run(questionId, await hashSecret(a), s.uid)
  }

  if (wantPassword) {
    if (next.length < PASSWORD_MIN || next.length > PASSWORD_MAX) {
      return c.json({ error: `新密码需 ${PASSWORD_MIN}–${PASSWORD_MAX} 个字符` }, 400)
    }
    if (next !== confirm) return c.json({ error: '两次输入的新密码不一致' }, 400)
    bumpPassword.run(await hashSecret(next), s.uid)
    // token_version 变了 → 刚才那张 token（含当前这台设备的）全废，给本机补发一张新的，
    // 否则改完密码自己也被踢下线。其它设备上的老 token 依然失效，正是我们要的。
    const fresh = findById.get(s.uid) as UserRow
    await issueSession(c, { uid: fresh.id, username: fresh.username, tv: fresh.token_version })
  }

  const after = findById.get(s.uid) as UserRow
  buckets.delete(settingsIpKey)
  buckets.delete(settingsUserKey)
  return c.json({ ok: true, hasSecurity: !!after.security_answer_hash })
})

/**
 * 找回密码 —— 用密保问题 + 答案重置。成功后**不自动登录**（让用户拿新密码走正常登录），
 * 并 bump token_version 踢掉所有老会话（号可能是被盗才要找回的）。
 */
auth.post('/forgot', async (c) => {
  const body = await readJson(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)
  const username = str(body.username).trim()
  const questionId = str(body.questionId)
  const answer = str(body.answer)
  const next = str(body.newPassword)
  const confirm = str(body.confirm)

  if (
    rateLimited(`forgot-ip:${clientIp(c)}`, FORGOT_MAX, WINDOW) ||
    rateLimited(`forgot-user:${username.toLowerCase()}`, FORGOT_MAX, WINDOW)
  ) {
    return c.json({ error: '尝试次数过多，请 15 分钟后再试' }, 429)
  }
  if (next.length < PASSWORD_MIN || next.length > PASSWORD_MAX) {
    return c.json({ error: `新密码需 ${PASSWORD_MIN}–${PASSWORD_MAX} 个字符` }, 400)
  }
  if (next !== confirm) return c.json({ error: '两次输入的新密码不一致' }, 400)

  const row = findByName.get(username) as UserRow | undefined
  const ok =
    row && row.security_answer_hash && row.security_question === questionId
      ? await verifySecret(normalizeAnswer(answer), row.security_answer_hash)
      : await verifySecret('x', 'x:x').then(() => false)
  // 统一的模糊报错 —— 不告诉攻击者「用户名对不对 / 问题选没选对 / 答案错了」是哪一步错。
  if (!row || !ok) return c.json({ error: '账号、密保问题或答案不正确' }, 401)

  bumpPassword.run(await hashSecret(next), row.id)
  buckets.delete(`forgot-user:${username.toLowerCase()}`)
  return c.json({ ok: true })
})

export default auth
