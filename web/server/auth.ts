// 账号体系 —— 开放注册 + 用户名/密码。规模小但开放（GitHub star 者互不认识，发不了邀请码，
// 所以不做邀请制，见 ideas/012 待调研 #3）。密码用 Node 内置 scrypt 哈希（不加 bcrypt 依赖），
// 会话用 JWT httpOnly 签名 cookie（无状态，不建 session 表）。
import { Hono } from 'hono'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { sign, verify } from 'hono/jwt'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { db } from './db'

const scryptAsync = promisify(scrypt)

// 生产必须在 env 设 AUTH_SECRET（够长的随机串）；dev 留个占位，起服务时会告警。
const SECRET = process.env.AUTH_SECRET || 'dev-insecure-secret-change-me'
if (SECRET === 'dev-insecure-secret-change-me') {
  console.warn('[auth] ⚠️  AUTH_SECRET 未设置，正在用不安全的开发占位串，生产务必设置')
}

const COOKIE = 'mt_session'
const MAX_AGE = 60 * 60 * 24 * 30 // 30 天（秒）
// 生产走 HTTPS → secure cookie；dev 是 http://localhost，secure 会导致浏览器不回传，故按环境切。
const SECURE = process.env.NODE_ENV === 'production'

const USERNAME_MIN = 2
// 12 个字符（中英文都算 1 个）。定这个数是因为顶栏用户名 chip 按内容伸缩：12 个中文 ≈ 205px，
// 放得下；原来的 20 会到 ≈305px，太宽。
const USERNAME_MAX = 12
const PASSWORD_MIN = 6
const PASSWORD_MAX = 200
const ANSWER_MAX = 100

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
    sameSite: 'Lax',
    path: '/',
    maxAge: MAX_AGE,
  })
}

// 预编译语句
const findByName = db.prepare<[string]>(
  'SELECT id, username, pass_hash, token_version, security_question, security_answer_hash, created_at FROM users WHERE username = ?',
)
const findById = db.prepare<[number]>(
  'SELECT id, username, pass_hash, token_version, security_question, security_answer_hash, created_at FROM users WHERE id = ?',
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

interface UserRow {
  id: number
  username: string
  pass_hash: string
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

// 找回密码限流 —— 密保答案熵很低（「你的出生地」猜几十次就中），不限流等于敞开暴力破解。
const forgotHits = new Map<string, { n: number; resetAt: number }>()
const FORGOT_MAX = 5
const FORGOT_WINDOW = 15 * 60 * 1000

function rateLimited(key: string): boolean {
  const now = Date.now()
  const hit = forgotHits.get(key)
  if (!hit || now > hit.resetAt) {
    forgotHits.set(key, { n: 1, resetAt: now + FORGOT_WINDOW })
    return false
  }
  hit.n += 1
  return hit.n > FORGOT_MAX
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    return (await c.req.json()) as Record<string, unknown>
  } catch {
    return null
  }
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const auth = new Hono()

// 密保问题预设列表 —— 前端下拉的单一事实源，别在前端再抄一份。
auth.get('/questions', (c) => c.json({ questions: SECURITY_QUESTIONS }))

auth.post('/register', async (c) => {
  const body = await readJson(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)
  const username = str(body.username).trim()
  const password = str(body.password)
  const confirm = str(body.confirm)

  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return c.json({ error: `用户名需 ${USERNAME_MIN}–${USERNAME_MAX} 个字符` }, 400)
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return c.json({ error: `密码需 ${PASSWORD_MIN}–${PASSWORD_MAX} 个字符` }, 400)
  }
  if (password !== confirm) return c.json({ error: '两次输入的密码不一致' }, 400)
  if (findByName.get(username)) return c.json({ error: '用户名已被占用' }, 409)

  const info = insertUser.run(username, await hashSecret(password), new Date().toISOString())
  await issueSession(c, { uid: Number(info.lastInsertRowid), username, tv: 0 })
  return c.json({ username, hasSecurity: false })
})

auth.post('/login', async (c) => {
  const body = await readJson(c)
  if (!body) return c.json({ error: '请求格式错误' }, 400)
  const username = str(body.username).trim()
  const password = str(body.password)

  const row = findByName.get(username) as UserRow | undefined
  // 用户名不存在也照样跑一次 verify，避免「用户名是否存在」被响应时间区分出来。
  const ok = row ? await verifySecret(password, row.pass_hash) : await verifySecret(password, 'x:x')
  if (!row || !ok) return c.json({ error: '用户名或密码错误' }, 401)

  await issueSession(c, { uid: row.id, username: row.username, tv: row.token_version })
  return c.json({ username: row.username, hasSecurity: !!row.security_answer_hash })
})

auth.post('/logout', (c) => {
  deleteCookie(c, COOKIE, { path: '/' })
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

  if (rateLimited(username.toLowerCase())) {
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
  forgotHits.delete(username.toLowerCase())
  return c.json({ ok: true })
})

export default auth
