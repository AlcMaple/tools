// 账号体系 —— 开放注册 + 用户名/密码,另有邮箱验证码快捷注册 / 登录。
// 密码用 Node 内置 scrypt 哈希(不引 bcrypt 依赖),会话用 JWT httpOnly 签名 cookie(无状态,不建 session 表)。
import { Hono } from 'hono'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { sign, verify } from 'hono/jwt'
import { createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { domainToASCII } from 'node:url'
import { db } from './db'
import { emailDeliveryConfigured, sendEmailCode } from './email-delivery'
import { applyInvite, awardDailyLogin } from './rewards'
import { AUTH_SECRET, IS_PRODUCTION } from './secrets'
import { usernameError } from './username'

const scryptAsync = promisify(scrypt)

// 生产用 `__Host-` 前缀:浏览器强制 Secure、Path=/ 且不允许 Domain,降低子域 / 路径投毒风险。
// 开发环境仍用普通名字,否则 http://localhost 不会回传这种 cookie。
const COOKIE = IS_PRODUCTION ? '__Host-mt_session' : 'mt_session'
const LEGACY_COOKIE = 'mt_session'
const MAX_AGE = 60 * 60 * 24 * 30 // 30 天（秒）
// 生产走 HTTPS → secure cookie；dev 是 http://localhost，secure 会导致浏览器不回传，故按环境切。
// oauth.ts 的短期跳转 cookie 沿用同一个标记。
export const SECURE = IS_PRODUCTION

const PASSWORD_MIN = 6
const PASSWORD_MAX = 200
const ANSWER_MAX = 100
const EMAIL_MAX = 254
const EMAIL_CODE_TTL = 10 * 60 * 1000
const EMAIL_CODE_ATTEMPTS = 5
const EMAIL_SEND_COOLDOWN = 60 * 1000
const EMAIL_START_MAX_PER_IP = 10
const EMAIL_START_MAX_PER_ADDRESS = 5

// 不存在账号和无密码账号都必须走一次真实成本的 scrypt,避免普通登录接口通过耗时泄露账号类型。
// 固定 16-byte salt + 64-byte hash 只作等时占位,不对应任何可登录凭据。
const DUMMY_PASS_HASH = `${'00'.repeat(16)}:${'00'.repeat(64)}`

/**
 * 密保问题用**预设列表**,不让用户自由填写 —— 两头的坑都要躲:自由填写的话,找回时要用户
 * 一字不差重打一遍问题,基本没人记得住;而按用户名把问题显示出来,等于泄露给任何知道你用户名的人。
 * 预设下拉两边都从同一个列表里选,好记又不泄露。库里存 id,不存题面。
 */
export const SECURITY_QUESTIONS = [
  { id: 'first_anime', text: '我的第一部入坑番是？' },
  { id: 'mother_name', text: '我母亲的姓名是？' },
  { id: 'birth_city', text: '我出生的城市是？' },
  { id: 'primary_school', text: '我小学的校名是？' },
  { id: 'first_pet', text: '我养的第一只宠物叫？' },
]
const QUESTION_IDS = new Set(SECURITY_QUESTIONS.map((q) => q.id))

// scrypt 存成 `salt:hash`。密码和密保答案共用同一套 —— 答案跟密码同级敏感(多是真实个人信息、
// 且会跨站复用),**绝不存明文**。
async function hashSecret(v: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = (await scryptAsync(v, salt, 64)) as Buffer
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

export async function verifySecret(v: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const derived = (await scryptAsync(v, Buffer.from(saltHex, 'hex'), expected.length)) as Buffer
  // 长度不等时 timingSafeEqual 会抛,先挡一下;再做定时安全比较防时序侧信道。
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

// 密保答案比对前要归一化 —— 否则「北京」和「 北京 」、Beijing / beijing 不匹配,用户会疯。
function normalizeAnswer(a: string): string {
  return a.trim().toLowerCase()
}

interface Session {
  uid: number
  username: string
  /** 签发时的 token_version。与库里对不上就拒绝 —— 改密码后老 token 立即失效。 */
  tv: number
}

// 签发会话 cookie。payload 带 exp（秒），hono/jwt verify 会据此判过期。
// oauth.ts（第三方登录回调）也复用它签发同一套会话。
export async function issueSession(c: Context, s: Session): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE
  const token = await sign({ ...s, exp }, AUTH_SECRET, 'HS256')
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: SECURE,
    sameSite: 'Strict',
    path: '/',
    maxAge: MAX_AGE,
  })
}

// 预编译语句（oauth.ts 复用其中带 export 的几条）
export const findByName = db.prepare<[string]>(
  'SELECT id, username, pass_hash, password_enabled, email, email_verified_at, bgm_uid, token_version, security_question, security_answer_hash, created_at FROM users WHERE username = ?',
)
export const findByEmail = db.prepare<[string]>(
  'SELECT id, username, pass_hash, password_enabled, email, email_verified_at, bgm_uid, token_version, security_question, security_answer_hash, created_at FROM users WHERE email = ?',
)
export const findById = db.prepare<[number]>(
  'SELECT id, username, pass_hash, password_enabled, email, email_verified_at, bgm_uid, token_version, security_question, security_answer_hash, created_at FROM users WHERE id = ?',
)
const insertUser = db.prepare<[string, string, string]>(
  'INSERT INTO users (username, pass_hash, password_enabled, created_at) VALUES (?, ?, 1, ?)',
)
const bumpPassword = db.prepare<[string, number]>(
  'UPDATE users SET pass_hash = ?, token_version = token_version + 1 WHERE id = ? AND password_enabled = 1',
)
// 无密码账号（Google / 验证码注册）首次补密码：不 bump token_version —— 补密码不是
// 「旧凭据泄露」事件，不该把现有会话全部踢下线。
const enablePassword = db.prepare<[string, number]>(
  'UPDATE users SET pass_hash = ?, password_enabled = 1 WHERE id = ? AND password_enabled = 0',
)
// 改用户名：条件更新防并发撞名（NOCASE 唯一索引是最后防线）。
const renameUser = db.prepare<[string, string, number]>(
  'UPDATE users SET username = ? WHERE username = ? AND id = ?',
)
const setSecurity = db.prepare<[string, string, number]>(
  'UPDATE users SET security_question = ?, security_answer_hash = ? WHERE id = ? AND password_enabled = 1',
)
const setEmailVerified = db.prepare<[string, number]>(
  'UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL',
)
const setBgmUid = db.prepare<[string, number]>('UPDATE users SET bgm_uid = ? WHERE id = ?')

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
const markChallengeVerified = db.prepare<[number, string, number, number]>(
  'UPDATE email_challenge SET verified_at = ? WHERE id = ? AND verified_at IS NULL AND consumed_at IS NULL AND expires_at > ? AND attempts < ?',
)
const consumeChallenge = db.prepare<[number, string, string, number]>(
  'UPDATE email_challenge SET consumed_at = ? WHERE id = ? AND email = ? AND verified_at IS NOT NULL AND consumed_at IS NULL AND expires_at > ?',
)
const deleteChallenge = db.prepare<[string]>('DELETE FROM email_challenge WHERE id = ?')
const cleanupChallenges = db.prepare<[number]>(
  'DELETE FROM email_challenge WHERE expires_at < ? OR consumed_at IS NOT NULL',
)
export const insertPasswordlessEmailUser = db.prepare<[string, string, string, string, string]>(
  `INSERT INTO users (username, pass_hash, password_enabled, email, email_verified_at, created_at)
   VALUES (?, ?, 0, ?, ?, ?)`,
)
export const updateUserEmail = db.prepare<[string, string, number]>(
  'UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?',
)
const clearUserEmail = db.prepare<[number, string]>(
  'UPDATE users SET email = NULL, email_verified_at = NULL WHERE id = ? AND email = ?',
)
// 换绑/解绑邮箱时清掉旧的身份记录 —— 邮箱变了，挂在旧邮箱上的 Google 关联即失效
//（oauth_identity 表已不参与登录匹配，清理只是不留僵尸数据）。
export const deleteIdentitiesForUser = db.prepare<[number]>(
  'DELETE FROM oauth_identity WHERE user_id = ?',
)

export interface UserRow {
  id: number
  username: string
  pass_hash: string
  password_enabled: number
  email: string | null
  email_verified_at: string | null
  bgm_uid: string
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
    const payload = (await verify(token, AUTH_SECRET, 'HS256')) as unknown as Session
    // 每个已登录请求多一次索引读(微秒级),换来「改密码能真正踢掉所有老会话」。
    const row = findById.get(payload.uid) as UserRow | undefined
    if (!row || row.token_version !== payload.tv) return null
    return { uid: row.id, username: row.username, tv: row.token_version }
  } catch {
    return null
  }
}

/**
 * 固定窗口限流 —— 凡是「拿密码/答案来猜」的入口都必须挂,否则等于敞开暴力破解。
 * 内存 Map、单进程有效,重启即清空(可接受:攻击者拿不到重启时机)。将来上多实例得换 Redis。
 */
const buckets = new Map<string, { n: number; resetAt: number }>()

export function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  // 攻击者拿随机用户名刷会不停建桶、内存无上限,所以到阈值先清过期的。
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

export function clearRateLimit(key: string): void {
  buckets.delete(key)
}

const WINDOW = 15 * 60 * 1000
const LOGIN_MAX_PER_USER = 10 // 挡「盯着一个号猜密码」
const LOGIN_MAX_PER_IP = 20 // 挡「一个来源换着号猜」
const FORGOT_MAX = 5 // 密保答案熵很低（「你的出生地」猜几十次就中），给得比密码更紧
// oauth.ts 复用：第三方登录首次建号与邮箱验证码建号共用同一份注册限流，防刷号旁路。
export const REGISTER_MAX_PER_IP = 5
export const REGISTER_WINDOW = 60 * 60 * 1000

/**
 * 取客户端 IP。只认 `X-Real-IP` —— nginx 用 `$remote_addr` 直接覆写它，客户端伪造不了；
 * `X-Forwarded-For` 是**追加**的（伪造值在前、真 IP 在末尾），所以退化时取最后一段。
 * 前提是 node 只绑 127.0.0.1（见 node.ts）：nginx 之外没人能进来，这两个头才可信。
 */
export function clientIp(c: Context): string {
  const real = c.req.header('x-real-ip')
  if (real) return real
  const fwd = c.req.header('x-forwarded-for')
  return fwd?.split(',').pop()?.trim() || 'local'
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json() as unknown
    return body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null
  } catch {
    return null
  }
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * 邮箱比较策略：域名和本地部分统一转小写，不做 Gmail 点号 / plus alias 合并。
 * 这是本站自己的账号标识策略，避免同一邮箱在注册、登录、验证和找回流程里出现分歧。
 */
export function normalizeEmail(value: string): string {
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
  return createHmac('sha256', AUTH_SECRET).update(`${challengeId}:${code}`).digest()
}

function verifyEmailCodeHash(challengeId: string, code: string, storedHex: string): boolean {
  const expected = Buffer.from(storedHex, 'hex')
  const actual = emailCodeHash(challengeId, code)
  return expected.length === actual.length && timingSafeEqual(actual, expected)
}

function newChallengeId(): string {
  return randomBytes(24).toString('base64url')
}

export function makeEmailUsername(): string {
  // 显示名不能从邮箱 local-part 派生:导航栏和设置页都会展示 username,那会间接泄露邮箱。
  for (let i = 0; i < 50; i++) {
    const candidate = `maple-${randomBytes(3).toString('hex')}`
    if (!usernameError(candidate) && !findByName.get(candidate)) return candidate
  }
  throw new Error('无法生成唯一用户名')
}

export function makeUnusablePasswordHash(): string {
  // 继续满足 pass_hash 的 salt:hash 结构，但两段都用随机字节生成，不存在用户知道的原始密码。
  // password_enabled 才是权限边界；这个不可用哈希是防止未来漏判标志时意外出现空值快路径。
  return `${randomBytes(16).toString('hex')}:${randomBytes(64).toString('hex')}`
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

class EmailChallengeUnavailableError extends Error {}
class EmailTakenError extends Error {}

/** 邮箱绑定 / 换绑的最终落点：先独占 challenge，再占邮箱；被并发抢先占用时整体回滚。
 *  换绑同时清掉旧邮箱上的 Google 身份记录 —— 邮箱是身份，换了邮箱旧关联即失效。 */
const bindUserEmail = db.transaction(
  (uid: number, challengeId: string, email: string, now: number): void => {
    const claimed = consumeChallenge.run(now, challengeId, email, now)
    if (claimed.changes !== 1) throw new EmailChallengeUnavailableError()
    const existing = findByEmail.get(email) as UserRow | undefined
    if (existing && existing.id !== uid) throw new EmailTakenError()
    updateUserEmail.run(email, new Date(now).toISOString(), uid)
    deleteIdentitiesForUser.run(uid)
  },
)

/** 解绑邮箱的最终落点：先独占 challenge，再清邮箱。前置条件（已设密码）在 start 与此双重校验。 */
const unbindUserEmail = db.transaction(
  (uid: number, challengeId: string, email: string, now: number): void => {
    const claimed = consumeChallenge.run(now, challengeId, email, now)
    if (claimed.changes !== 1) throw new EmailChallengeUnavailableError()
    const cleared = clearUserEmail.run(uid, email)
    if (cleared.changes !== 1) throw new EmailChallengeUnavailableError()
    deleteIdentitiesForUser.run(uid)
  },
)

/**
 * 验证码校验的公共段（/email/verify 与 /email/bind-verify 共用）：
 * 格式 → IP / 地址限流 → 挑战存在性与时效 → HMAC 比对（错则计一次）→ 标记已验证。
 * 只读 + 计次，不消费挑战；消费（单次使用）由各流程自己的事务完成。
 */
type CodeCheck = { ok: true; row: EmailChallengeRow } | { ok: false; status: 400 | 401 | 429; error: string }

function checkEmailCode(c: Context, challengeId: string, code: string): CodeCheck {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(challengeId) || !/^\d{6}$/.test(code)) {
    return { ok: false, status: 400, error: '验证码格式不正确' }
  }
  if (rateLimited(`email-verify-ip:${clientIp(c)}`, EMAIL_CODE_ATTEMPTS * 4, WINDOW)) {
    return { ok: false, status: 429, error: '验证码尝试太频繁，请稍后再试' }
  }
  const row = findChallenge.get(challengeId) as EmailChallengeRow | undefined
  const now = Date.now()
  if (!row || row.consumed_at || row.expires_at <= now || row.attempts >= EMAIL_CODE_ATTEMPTS) {
    return { ok: false, status: 401, error: '验证码无效或已过期，请重新获取' }
  }
  if (rateLimited(`email-verify-address:${row.email}`, EMAIL_CODE_ATTEMPTS, WINDOW)) {
    return { ok: false, status: 429, error: '验证码尝试太频繁，请稍后再试' }
  }
  // 即使是旧版本留下的 verified_at challenge,也重新核对验证码；verified_at 不能单独当登录凭据。
  if (!verifyEmailCodeHash(challengeId, code, row.code_hash)) {
    incrementChallengeAttempts.run(challengeId)
    return { ok: false, status: 401, error: '验证码不正确' }
  }
  if (!row.verified_at) {
    const verified = markChallengeVerified.run(now, challengeId, now, EMAIL_CODE_ATTEMPTS)
    if (verified.changes !== 1) {
      return { ok: false, status: 401, error: '验证码无效或已过期，请重新获取' }
    }
  }
  return { ok: true, row }
}

/**
 * 正确验证码的最终领取点。先用条件 UPDATE 独占 challenge,再在同一个事务里查找 / 创建账号:
 * - 同一 challenge 并发或重放时只有 changes === 1 的请求能继续;
 * - 不同 challenge 同时验证同一邮箱时,后拿锁的请求会看到已有账号并直接登录,不会重复建号。
 */
const completeEmailVerification = db.transaction(
  (challengeId: string, email: string, now: number): { user: UserRow; created: boolean } => {
    const claimed = consumeChallenge.run(now, challengeId, email, now)
    if (claimed.changes !== 1) throw new EmailChallengeUnavailableError()

    let user = findByEmail.get(email) as UserRow | undefined
    let created = false
    if (user) {
      setEmailVerified.run(new Date(now).toISOString(), user.id)
    } else {
      const username = makeEmailUsername()
      const createdAt = new Date(now).toISOString()
      insertPasswordlessEmailUser.run(username, makeUnusablePasswordHash(), email, createdAt, createdAt)
      user = findByEmail.get(email) as UserRow | undefined
      if (!user) throw new Error('账号创建后读取失败')
      created = true
    }
    return { user, created }
  },
)

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
  const inviteCode = str(body.inviteCode)

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
  const uid = Number(info.lastInsertRowid)
  applyInvite(uid, inviteCode)
  await issueSession(c, { uid, username, tv: 0 })
  return c.json({ username, hasSecurity: false, hasEmail: false, hasPassword: true })
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
  const row = (findByName.get(username) ||
    (normalizedEmail ? findByEmail.get(normalizedEmail) : undefined)) as UserRow | undefined
  // 无密码邮箱账号与不存在账号走同一份完整 scrypt 和同一报错,不能借响应耗时枚举账号类型。
  const hasPassword = row?.password_enabled === 1
  const ok = await verifySecret(password, hasPassword ? row.pass_hash : DUMMY_PASS_HASH)
  if (!row || !hasPassword || !ok) return c.json({ error: '用户名或密码错误' }, 401)

  // 登录成功即清账 —— 否则自己前几次打错字，剩下的额度还替攻击者留着扣。
  buckets.delete(ipKey)
  buckets.delete(userKey)
  await issueSession(c, { uid: row.id, username: row.username, tv: row.token_version })
  return c.json({
    username: row.username,
    hasSecurity: !!row.security_answer_hash,
    hasEmail: !!row.email && !!row.email_verified_at,
    hasPassword: true,
  })
})

/**
 * 邮箱快捷入口第一步：不区分邮箱是否已注册，统一创建短期验证码挑战。
 * 这样响应不会成为邮箱枚举器；验证码验证成功后，已有账号登录，新邮箱自动建号并登录。
 */
auth.post('/email/start', async (c) => {
  if (!emailDeliveryConfigured()) return c.json({ error: '邮箱验证码暂不可用，请稍后再试' }, 503)
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

/** 邮箱快捷入口第二步：验证码正确后，已有邮箱账号直接登录，新邮箱自动建无密码账号并登录。 */
auth.post('/email/verify', async (c) => {
  const body = await readJson(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)
  const challengeId = str(body.challengeId)
  const code = str(body.code).trim()
  const inviteCode = str(body.inviteCode)

  const check = checkEmailCode(c, challengeId, code)
  if (!check.ok) return c.json({ error: check.error }, check.status)
  const row = check.row
  const now = Date.now()

  // 新邮箱建号与旧用户名注册共用同一小时 / IP 限流,避免验证码入口成为刷号旁路。
  const existing = findByEmail.get(row.email) as UserRow | undefined
  if (!existing && rateLimited(`reg:${clientIp(c)}`, REGISTER_MAX_PER_IP, REGISTER_WINDOW)) {
    return c.json({ error: '注册太频繁，请稍后再试' }, 429)
  }

  let completed: { user: UserRow; created: boolean }
  try {
    completed = completeEmailVerification(challengeId, row.email, now)
  } catch (error) {
    if (error instanceof EmailChallengeUnavailableError) {
      return c.json({ error: '验证码无效或已过期，请重新获取' }, 401)
    }
    return c.json({ error: '账号创建失败，请稍后再试' }, 409)
  }
  const user = completed.user
  if (completed.created) applyInvite(user.id, inviteCode)

  buckets.delete(`email-verify-ip:${clientIp(c)}`)
  buckets.delete(`email-verify-address:${row.email}`)
  await issueSession(c, { uid: user.id, username: user.username, tv: user.token_version })
  return c.json({
    status: 'login',
    username: user.username,
    hasSecurity: !!user.security_answer_hash,
    hasEmail: true,
    hasPassword: user.password_enabled === 1,
  })
})

/**
 * 已登录账号绑定 / 换绑邮箱第一步（验证码路径）：验密码 → 查占用 → 向**新邮箱**发验证码。
 * 邮箱是身份本身，动它一律先证明账号主人：有密码必须验原始密码（同 /settings）；
 * 没密码的账号拒绝 —— 邮箱是其唯一登录方式（Google 通道也依赖它），先去 /password/set。
 * Gmail 的免验证码换绑走 POST /oauth/google/rebind-email，不经这里。
 */
auth.post('/email/bind-start', async (c) => {
  const s = await getSession(c)
  if (!s) return c.json({ error: '未登录' }, 401)
  const body = await readJson(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)
  const email = normalizeEmail(str(body.email))
  if (!email) return c.json({ error: '请输入有效的邮箱地址' }, 400)

  const row = findById.get(s.uid) as UserRow
  if (row.password_enabled === 1) {
    if (rateLimited(`email-bind-user:${s.uid}`, LOGIN_MAX_PER_USER, WINDOW)) {
      return c.json({ error: '尝试次数过多，请 15 分钟后再试' }, 429)
    }
    if (!(await verifySecret(str(body.currentPassword), row.pass_hash))) {
      return c.json({ error: '原始密码不正确' }, 401)
    }
  } else {
    // 邮箱即身份：无密码账号的邮箱是唯一登录方式（Google 也依赖它），动邮箱前必须先设密码。
    return c.json({ error: '请先设置密码，再更换或解绑邮箱' }, 403)
  }

  const other = findByEmail.get(email) as UserRow | undefined
  if (other && other.id !== s.uid) return c.json({ error: '该邮箱已绑定其它账号' }, 409)

  // 发送节奏与登录入口共用同一套冷却与限流（同邮箱 60 秒冷却、按 IP / 地址限频）。
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

/** 绑定 / 更换邮箱第二步：验证码正确后把邮箱写进当前账号（事务内防并发占用）。 */
auth.post('/email/bind-verify', async (c) => {
  const s = await getSession(c)
  if (!s) return c.json({ error: '未登录' }, 401)
  const body = await readJson(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)

  const check = checkEmailCode(c, str(body.challengeId), str(body.code).trim())
  if (!check.ok) return c.json({ error: check.error }, check.status)
  try {
    bindUserEmail(s.uid, check.row.id, check.row.email, Date.now())
  } catch (error) {
    if (error instanceof EmailChallengeUnavailableError) {
      return c.json({ error: '验证码无效或已过期，请重新获取' }, 401)
    }
    if (error instanceof EmailTakenError) {
      return c.json({ error: '该邮箱已绑定其它账号' }, 409)
    }
    return c.json({ error: '邮箱绑定失败，请稍后再试' }, 409)
  }
  buckets.delete(`email-verify-ip:${clientIp(c)}`)
  buckets.delete(`email-verify-address:${check.row.email}`)
  return c.json({ ok: true, email: check.row.email })
})

/** 向 row.email 发验证码的公共段（解绑 / 改用户名共用）：
 *  冷却 / 限流与登录入口同套。业务前置（解绑要密码、改名不要）由各调用方把关。
 *  返回 null = 发送成功（挑战 id 由调用方查最近一条拿）。 */
async function sendCurrentEmailCode(c: Context, row: UserRow & { email: string }): Promise<Response | null> {
  const now = Date.now()
  cleanupChallenges.run(now)
  if (
    rateLimited(`email-start-ip:${clientIp(c)}`, EMAIL_START_MAX_PER_IP, WINDOW) ||
    rateLimited(`email-start-address:${row.email}`, EMAIL_START_MAX_PER_ADDRESS, WINDOW)
  ) {
    return c.json({ error: '验证码发送太频繁，请稍后再试' }, 429)
  }
  const recent = findRecentChallenge.get(row.email) as { id: string; created_at: number } | undefined
  if (recent && now - recent.created_at < EMAIL_SEND_COOLDOWN) {
    return c.json({ error: '验证码已发送，请稍后再试' }, 429)
  }
  if (recent) deleteChallenge.run(recent.id)

  const challengeId = newChallengeId()
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0')
  insertChallenge.run(
    challengeId,
    row.email as string,
    emailCodeHash(challengeId, code).toString('hex'),
    now,
    now + EMAIL_CODE_TTL,
  )
  try {
    await sendEmailCode(row.email, code)
  } catch {
    deleteChallenge.run(challengeId)
    return c.json({ error: '验证码邮件发送失败，请稍后再试' }, 502)
  }
  return null // 发送成功；挑战 id 由调用方重新查最近一条拿（见 current-start 路由）
}

/** 向**当前绑定的邮箱**发验证码（证明仍控制现身份）：解绑与改用户名共用入口。 */
auth.post('/email/current-start', async (c) => {
  const s = await getSession(c)
  if (!s) return c.json({ error: '未登录' }, 401)
  const row = findById.get(s.uid) as UserRow
  if (!row.email || !row.email_verified_at) return c.json({ error: '该账号未绑定邮箱' }, 400)
  const sent = await sendCurrentEmailCode(c, row as UserRow & { email: string })
  if (sent) return sent
  const recent = findRecentChallenge.get(row.email) as { id: string } | undefined
  return c.json({ challengeId: recent?.id ?? '', expiresIn: EMAIL_CODE_TTL / 1000, email: row.email })
})

/**
 * 解绑邮箱第一步（兼容旧名）：改用户名与解绑都改走 /email/current-start，
 * 保留此路由转发语义，前置校验（已设密码）不变。
 */
auth.post('/email/unbind-start', async (c) => {
  const s = await getSession(c)
  if (!s) return c.json({ error: '未登录' }, 401)
  const row = findById.get(s.uid) as UserRow
  if (row.password_enabled !== 1) {
    return c.json({ error: '请先设置密码，再解绑邮箱' }, 403)
  }
  if (!row.email || !row.email_verified_at) return c.json({ error: '该账号未绑定邮箱' }, 400)
  const sent = await sendCurrentEmailCode(c, row as UserRow & { email: string })
  if (sent) return sent
  const recent = findRecentChallenge.get(row.email) as { id: string } | undefined
  return c.json({ challengeId: recent?.id ?? '', expiresIn: EMAIL_CODE_TTL / 1000, email: row.email })
})

/** 解绑邮箱第二步：验证码正确后清空邮箱与关联身份记录（账号与数据保留，仅剩密码登录）。 */
auth.post('/email/unbind-verify', async (c) => {
  const s = await getSession(c)
  if (!s) return c.json({ error: '未登录' }, 401)
  const body = await readJson(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)

  const row = findById.get(s.uid) as UserRow
  if (row.password_enabled !== 1) {
    return c.json({ error: '请先设置密码，再解绑邮箱' }, 403)
  }
  const check = checkEmailCode(c, str(body.challengeId), str(body.code).trim())
  if (!check.ok) return c.json({ error: check.error }, check.status)
  try {
    unbindUserEmail(s.uid, check.row.id, check.row.email, Date.now())
  } catch (error) {
    if (error instanceof EmailChallengeUnavailableError) {
      return c.json({ error: '验证码无效或已过期，请重新获取' }, 401)
    }
    return c.json({ error: '解绑失败，请稍后再试' }, 409)
  }
  buckets.delete(`email-verify-ip:${clientIp(c)}`)
  buckets.delete(`email-verify-address:${check.row.email}`)
  return c.json({ ok: true })
})

// 旧前端若仍提交密码,必须明确失败；不能把收到的密码静默丢掉后创建成无密码账号。
auth.post('/email/register', (c) => {
  return c.json({ error: '邮箱注册已改为验证码验证后自动完成，请重新获取验证码' }, 410)
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
  const dailyReward = awardDailyLogin(s.uid) ? 5 : 0
  const row = findById.get(s.uid) as UserRow
  return c.json({
    id: s.uid,
    username: row.username,
    createdAt: row.created_at,
    // 只回显已核验的邮箱地址本身（设置页展示用）；密保仍只报「设没设」，
    // **绝不回显问题和答案** —— 问题本身也是秘密，泄露了等于告诉别人该去查什么。
    email: row.email && row.email_verified_at ? row.email : null,
    bgmUid: row.bgm_uid,
    hasSecurity: !!row.security_answer_hash,
    hasEmail: !!row.email && !!row.email_verified_at,
    hasPassword: row.password_enabled === 1,
    dailyReward,
  })
})

/**
 * 修改用户名。凭据门槛与换绑邮箱同级：账号主人证明 = 密码（有密码的账号），
 * 或登录态 + 当前邮箱验证码（没密码也能改 —— 用户名不是登录凭据，改它不换身份；
 * 随机 maple-xxxx 用户名是系统起的，用户应该能改成一个记得住的）。
 */
auth.post('/username/change', async (c) => {
  const s = await getSession(c)
  if (!s) return c.json({ error: '未登录' }, 401)
  const body = await readJson(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)
  const next = str(body.username).trim()

  const row = findById.get(s.uid) as UserRow
  if (next === row.username) return c.json({ error: '新用户名与当前相同' }, 400)
  const problem = usernameError(next)
  if (problem) return c.json({ error: problem }, 400)
  // 撞名与保留词：usernameError 只查保留词，占用在这里查（NOCASE 唯一索引兜底并发）。
  if (findByName.get(next)) return c.json({ error: '用户名已被占用' }, 409)

  const userKey = `username-user:${s.uid}`
  if (rateLimited(userKey, LOGIN_MAX_PER_USER, WINDOW)) {
    return c.json({ error: '尝试次数过多，请 15 分钟后再试' }, 429)
  }

  // 路径一：验密码（有密码账号的默认路径）
  const currentPassword = str(body.currentPassword)
  const code = str(body.code).trim()
  const challengeId = str(body.challengeId)
  if (row.password_enabled === 1) {
    if (currentPassword) {
      if (!(await verifySecret(currentPassword, row.pass_hash))) {
        return c.json({ error: '原始密码不正确' }, 401)
      }
    } else if (row.email && row.email_verified_at) {
      // 不想输密码 / 忘了密码时：当前邮箱验证码同样证明主人身份
      const check = checkEmailCode(c, challengeId, code)
      if (!check.ok) return c.json({ error: check.error }, check.status)
      if (check.row.email !== row.email) {
        return c.json({ error: '验证码与当前邮箱不匹配' }, 401)
      }
      consumeChallenge.run(Date.now(), check.row.id, row.email, Date.now())
    } else {
      return c.json({ error: '请输入当前密码，或先绑定邮箱' }, 400)
    }
  } else if (row.email && row.email_verified_at) {
    // 路径二：无密码账号（验证码 / Google 注册）—— 当前邮箱验证码
    const check = checkEmailCode(c, challengeId, code)
    if (!check.ok) return c.json({ error: check.error }, check.status)
    if (check.row.email !== row.email) {
      return c.json({ error: '验证码与当前邮箱不匹配' }, 401)
    }
    consumeChallenge.run(Date.now(), check.row.id, row.email, Date.now())
  } else {
    // 既没密码也没邮箱：理论不可达（账密注册必有密码，其余必有邮箱），防御性兜底
    return c.json({ error: '请先设置密码或绑定邮箱' }, 400)
  }

  const applied = renameUser.run(next, row.username, s.uid)
  if (applied.changes !== 1) {
    return c.json({ error: '用户名已被占用' }, 409)
  }
  buckets.delete(userKey)
  // 用户名变了，旧会话 JWT 里的 username 过期了 —— 补发新会话，不用重新登录。
  await issueSession(c, { uid: row.id, username: next, tv: row.token_version })
  return c.json({ ok: true, username: next })
})

/**
 * 账号安全设置 —— 改密码 和 / 或 改密保。
 * 新密码留空 = 不改密码（只改密保）。**两条路都强制验原始密码**：否则别人借你没锁屏的电脑
 * 就能悄悄把密保换成自己的，从此随时能接管账号。
 */
/**
 * 无密码账号（Google / 邮箱验证码注册）首次设置密码。与账密账号的 /settings 不同，
 * 没有「原始密码」可验，门槛是登录态本身——与绑定邮箱 / Google 同一等级：
 * 会话 + 新凭据验证后生效。设置成功后即可用用户名 + 密码登录、走账号安全改密保。
 */
auth.post('/password/set', async (c) => {
  const s = await getSession(c)
  if (!s) return c.json({ error: '未登录' }, 401)
  const body = await readJson(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)
  const next = str(body.newPassword)
  const confirm = str(body.confirm)
  if (next.length < PASSWORD_MIN || next.length > PASSWORD_MAX) {
    return c.json({ error: `密码需 ${PASSWORD_MIN}–${PASSWORD_MAX} 个字符` }, 400)
  }
  if (next !== confirm) return c.json({ error: '两次输入的密码不一致' }, 400)
  if (rateLimited(`pwd-set-user:${s.uid}`, LOGIN_MAX_PER_USER, WINDOW)) {
    return c.json({ error: '尝试次数过多，请 15 分钟后再试' }, 429)
  }
  const row = findById.get(s.uid) as UserRow
  if (row.password_enabled === 1) {
    return c.json({ error: '该账号已设置密码，请在账号安全中修改' }, 409)
  }
  const applied = enablePassword.run(await hashSecret(next), s.uid)
  if (applied.changes !== 1) return c.json({ error: '该账号已设置密码，请在账号安全中修改' }, 409)
  return c.json({ ok: true, hasPassword: true })
})

auth.post('/settings', async (c) => {
  const s = await getSession(c)
  if (!s) return c.json({ error: '未登录' }, 401)
  const row = findById.get(s.uid) as UserRow
  const body = await readJson(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)

  const hasBgmUid = 'bgmUid' in body
  if (hasBgmUid && typeof body.bgmUid !== 'string') return c.json({ error: 'Bangumi 用户标识不合法' }, 400)
  const bgmUid = hasBgmUid ? str(body.bgmUid).trim() : ''
  if (bgmUid.length > 100 || /[\u0000-\u001f\u007f]/.test(bgmUid)) {
    return c.json({ error: 'Bangumi 用户标识不合法' }, 400)
  }

  const current = str(body.currentPassword)
  const next = str(body.newPassword)
  const confirm = str(body.confirm)
  const questionId = str(body.questionId)
  const answer = str(body.answer)

  const wantPassword = next.length > 0 || confirm.length > 0
  const wantSecurity = questionId.length > 0 || answer.length > 0
  const wantAccountSecurity = wantPassword || wantSecurity
  if (!wantAccountSecurity && !hasBgmUid) return c.json({ error: '没有要修改的内容' }, 400)

  if (wantAccountSecurity) {
    if (row.password_enabled !== 1) {
      return c.json(
        { error: '该账号使用邮箱验证码登录，不支持密码与密保设置', hasPassword: false },
        403,
      )
    }

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

    buckets.delete(settingsIpKey)
    buckets.delete(settingsUserKey)
  }

  if (hasBgmUid) setBgmUid.run(bgmUid, s.uid)
  const after = findById.get(s.uid) as UserRow
  return c.json({
    ok: true,
    bgmUid: after.bgm_uid,
    hasSecurity: !!after.security_answer_hash,
    hasPassword: after.password_enabled === 1,
  })
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
  let ok = false
  if (
    row?.password_enabled === 1 &&
    row.security_answer_hash &&
    row.security_question === questionId
  ) {
    ok = await verifySecret(normalizeAnswer(answer), row.security_answer_hash)
  } else {
    // 不存在、无密码、未设密保和问题不匹配都做同成本 scrypt,并返回同一模糊错误。
    await verifySecret(normalizeAnswer(answer), DUMMY_PASS_HASH)
  }
  // 统一的模糊报错 —— 不告诉攻击者「用户名对不对 / 问题选没选对 / 答案错了」是哪一步错。
  if (!row || row.password_enabled !== 1 || !ok) {
    return c.json({ error: '账号、密保问题或答案不正确' }, 401)
  }

  bumpPassword.run(await hashSecret(next), row.id)
  buckets.delete(`forgot-user:${username.toLowerCase()}`)
  return c.json({ ok: true, hasPassword: true })
})

export default auth
