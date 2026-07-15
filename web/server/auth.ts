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
const USERNAME_MAX = 20
const PASSWORD_MIN = 6
const PASSWORD_MAX = 200

// scrypt 存成 `salt:hash`（都 hex）。
async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = (await scryptAsync(pw, salt, 64)) as Buffer
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const derived = (await scryptAsync(pw, Buffer.from(saltHex, 'hex'), expected.length)) as Buffer
  // 长度不等时 timingSafeEqual 会抛，先挡一下；再做定时安全比较防时序侧信道。
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

interface Session {
  uid: number
  username: string
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

// 从请求 cookie 解出会话；无 / 失效 / 过期 → null。供后续 /api/tracks 等受保护路由复用。
export async function getSession(c: Context): Promise<Session | null> {
  const token = getCookie(c, COOKIE)
  if (!token) return null
  try {
    const payload = (await verify(token, SECRET, 'HS256')) as unknown as Session
    return { uid: payload.uid, username: payload.username }
  } catch {
    return null
  }
}

// 预编译语句
const findByName = db.prepare<[string]>('SELECT id, username, pass_hash FROM users WHERE username = ?')
const insertUser = db.prepare<[string, string, string]>(
  'INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)',
)

const auth = new Hono()

auth.post('/register', async (c) => {
  let body: { username?: unknown; password?: unknown; confirm?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: '请求格式错误' }, 400)
  }
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const confirm = typeof body.confirm === 'string' ? body.confirm : ''

  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return c.json({ error: `用户名需 ${USERNAME_MIN}–${USERNAME_MAX} 个字符` }, 400)
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return c.json({ error: `密码需 ${PASSWORD_MIN}–${PASSWORD_MAX} 个字符` }, 400)
  }
  if (password !== confirm) {
    return c.json({ error: '两次输入的密码不一致' }, 400)
  }
  if (findByName.get(username)) {
    return c.json({ error: '用户名已被占用' }, 409)
  }

  const hash = await hashPassword(password)
  const info = insertUser.run(username, hash, new Date().toISOString())
  const uid = Number(info.lastInsertRowid)
  await issueSession(c, { uid, username })
  return c.json({ username })
})

auth.post('/login', async (c) => {
  let body: { username?: unknown; password?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: '请求格式错误' }, 400)
  }
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''

  const row = findByName.get(username) as
    | { id: number; username: string; pass_hash: string }
    | undefined
  // 用户名不存在也照样跑一次 verify（拿存量 hash 或空串），避免"用户名是否存在"被时序区分。
  const ok = row
    ? await verifyPassword(password, row.pass_hash)
    : await verifyPassword(password, 'x:x').then(() => false)
  if (!row || !ok) {
    return c.json({ error: '用户名或密码错误' }, 401)
  }
  await issueSession(c, { uid: row.id, username: row.username })
  return c.json({ username: row.username })
})

auth.post('/logout', (c) => {
  deleteCookie(c, COOKIE, { path: '/' })
  return c.json({ ok: true })
})

auth.get('/me', async (c) => {
  const s = await getSession(c)
  if (!s) return c.json({ error: '未登录' }, 401)
  return c.json({ username: s.username })
})

export default auth
