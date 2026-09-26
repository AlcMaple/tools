import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, createHmac } from 'node:crypto'

const cwd = process.cwd()
const directory = mkdtempSync(join(tmpdir(), 'linuxdo-oauth-'))
process.chdir(directory)
Object.assign(process.env, {
  NODE_ENV: 'production', DATA_DIR: directory, MAPLETOOLS_ENV_FILE: '',
  AUTH_SECRET: randomBytes(48).toString('hex'),
  LINUXDO_CLIENT_ID: process.argv.includes('--disabled') ? '' : 'fixture-client',
  LINUXDO_CLIENT_SECRET: 'fixture-secret', GOOGLE_CLIENT_ID: 'google-fixture',
  GOOGLE_CLIENT_SECRET: 'google-secret', GITHUB_CLIENT_ID: 'github-fixture', GITHUB_CLIENT_SECRET: 'github-secret',
  REWARDS_ENABLED: '1', INVITES_ENABLED: '1', REWARD_TEST_USERS: '',
})
const { default: oauth } = await import('../server/oauth')
const { db } = await import('../server/db')
const { getSession, deleteIdentitiesForUser, rateLimited, REGISTER_MAX_PER_IP, REGISTER_WINDOW } = await import('../server/auth')
const { Hono } = await import('hono')
const app = new Hono().route('/api/auth/oauth', oauth).get('/session', async c => c.json(await getSession(c)))
const root = 'https://fixture.test', prefix = '/api/auth/oauth'
let serial = 0, calls = 0, checks = 0
let profile: unknown = { id: 123, username: 'existing', active: true, email: 'existing@example.com' }
let tokenBody: unknown = { access_token: 'fixture-token', token_type: 'Bearer' }
let tokenStatus = 200, userStatus = 200
const originalFetch = globalThis.fetch
const usedCodes = new Set<string>()
globalThis.fetch = async (input, init) => {
  calls++
  assert.equal(init?.redirect, 'error')
  assert.ok(init?.signal)
  if (String(input) === 'https://connect.linux.do/oauth2/token') {
    const body = new URLSearchParams(String(init?.body))
    assert.equal(body.get('client_secret'), 'fixture-secret')
    assert.equal(body.get('grant_type'), 'authorization_code')
    assert.equal(body.get('redirect_uri'), root + prefix + '/linuxdo/callback')
    const code = body.get('code')!
    if (usedCodes.has(code)) return Response.json({ error: 'invalid_grant' }, { status: 400 })
    usedCodes.add(code)
    return Response.json(tokenBody, { status: tokenStatus })
  }
  assert.equal(String(input), 'https://connect.linux.do/api/user')
  assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-token')
  return Response.json(profile, { status: userStatus })
}
type Tx = { s: string; exp: number; p?: string; r: string }
async function start(returnTo = '/#/tracks', provider = 'linuxdo', ip = `192.0.2.${++serial}`) {
  const headers = { host: 'fixture.test', 'x-forwarded-for': ip }
  const response = await app.request(root + prefix + `/${provider}/start?` + new URLSearchParams({ returnTo, invite: 'INVITE01' }), { headers })
  assert.equal(response.status, 302)
  const rawCookie = response.headers.getSetCookie().find(c => c.startsWith('mt_oauth_tx='))!
  assert.match(rawCookie, /HttpOnly/)
  assert.match(rawCookie, /Secure/)
  assert.match(rawCookie, /SameSite=Lax/)
  const cookie = rawCookie.split(';')[0]
  const tx = JSON.parse(Buffer.from(decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)).split('.')[0], 'base64url').toString()) as Tx
  return { headers, cookie, tx, url: new URL(response.headers.get('location')!) }
}
async function callback(flow: Awaited<ReturnType<typeof start>>, query: Record<string, string> = {}) {
  return app.request(root + prefix + '/linuxdo/callback?' + new URLSearchParams({ state: flow.tx.s, code: flow.tx.s, ...query }), { headers: { ...flow.headers, cookie: flow.cookie } })
}
async function sessionId(response: Response): Promise<number> {
  const cookie = response.headers.getSetCookie().find(c => c.startsWith('__Host-mt_session='))!.split(';')[0]
  return (await (await app.request(root + '/session', { headers: { cookie } })).json()).uid as number
}
async function check(name: string, run: () => Promise<void>) { await run(); console.log(`PASS ${++checks} ${name}`) }
try {
  if (process.argv.includes('--disabled')) {
    await check('缺少凭据隐藏入口且不请求上游', async () => {
      assert.equal((await (await app.request(root + prefix + '/providers')).json()).linuxdo, false)
      assert.equal((await app.request(root + prefix + '/linuxdo/start')).status, 404)
      assert.equal(calls, 0)
    })
  } else {
    const existingId = Number(db.prepare("INSERT INTO users(username,pass_hash,email,created_at) VALUES('existing','unused','existing@example.com','2026-09-26')").run().lastInsertRowid)
    db.prepare('INSERT INTO invite_codes(user_id,code,created_at) VALUES(?,?,?)').run(existingId, 'INVITE01', Date.now())
    let linuxdoId = 0
    await check('入口配置与授权参数', async () => {
      const { enabledSiteFeatures } = await import('../server/agent/site-features')
      const flags = { email: false, google: false, github: false, rewards: false, invites: false, lottery: false }
      assert.ok(!enabledSiteFeatures(flags).includes('web.linuxdo'))
      assert.ok(enabledSiteFeatures({ ...flags, linuxdo: true }, true).includes('web.linuxdo'))
      const providers = await (await app.request(root + prefix + '/providers')).json()
      assert.equal(providers.linuxdo, true); assert.equal(providers.github, true)
      assert.ok(!JSON.stringify(providers).includes('secret'))
      const flow = await start()
      assert.equal(flow.url.origin, 'https://connect.linux.do')
      assert.equal(flow.url.searchParams.get('scope'), 'user')
      assert.equal(flow.url.searchParams.get('state'), flow.tx.s)
      assert.equal(flow.tx.p, 'linuxdo')
    })
    await check('首次注册不合并同名同邮箱账号，签发会话和邀请奖励', async () => {
      const flow = await start(), response = await callback(flow)
      assert.equal(response.headers.get('location'), '/#/tracks')
      linuxdoId = await sessionId(response)
      assert.notEqual(linuxdoId, existingId)
      const user = db.prepare('SELECT email,password_enabled FROM users WHERE id=?').get(linuxdoId) as { email: string | null; password_enabled: number }
      assert.equal(user.email, null); assert.equal(user.password_enabled, 0)
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM invite_relations').get() as { n: number }).n, 1)
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM reward_ledger').get() as { n: number }).n, 2)
      assert.match(response.headers.getSetCookie().find(c => c.startsWith('mt_oauth_tx='))!, /Max-Age=0/)
      assert.match((await callback(flow)).headers.get('location')!, /linuxdo_failed/)
    })
    await check('改论坛名字及本站邮箱后仍进入原账号，不重复奖励', async () => {
      profile = { id: 123, username: 'renamed', active: true }
      db.prepare('UPDATE users SET email=? WHERE id=?').run('bound@example.com', linuxdoId)
      deleteIdentitiesForUser.run(linuxdoId)
      assert.equal(await sessionId(await callback(await start())), linuxdoId)
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 2)
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM reward_ledger').get() as { n: number }).n, 2)
    })
    await check('state、签名、过期及跨 provider 防护不访问上游', async () => {
      const f = await start(), before = calls
      await callback(f, { state: 'wrong' })
      await callback({ ...f, cookie: f.cookie + 'tampered' })
      const payload = Buffer.from(JSON.stringify({ ...f.tx, exp: Date.now() - 1 })).toString('base64url')
      await callback({ ...f, cookie: 'mt_oauth_tx=' + payload + '.' + createHmac('sha256', process.env.AUTH_SECRET!).update(payload).digest('base64url') })
      await callback(await start('/', 'google'))
      await callback(await start('/', 'github'))
      for (const provider of ['google', 'github']) await app.request(root + prefix + `/${provider}/callback?` + new URLSearchParams({ state: f.tx.s, code: 'fake' }), { headers: { ...f.headers, cookie: f.cookie } })
      assert.equal(calls, before)
    })
    await check('取消授权保留 hash，外站回跳被拒绝', async () => {
      const f = await start('/?view=1#/settings'), before = calls
      assert.equal((await callback(f, { error: 'access_denied' })).headers.get('location'), '/?view=1#/settings')
      assert.equal(calls, before)
      for (const value of ['//evil.example', '/\\evil.example', 'https://evil.example']) assert.equal((await start(value)).tx.r, '/')
    })
    await check('无效身份与未激活账号不建号', async () => {
      for (const value of [{ id: 0, active: true }, { id: '123', active: true }, { id: 999, active: false }, { id: 999 }]) {
        profile = value
        assert.match((await callback(await start())).headers.get('location')!, /linuxdo_(failed|inactive)/)
      }
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 2)
    })
    await check('token 与用户接口限流/503不重试，错误区分', async () => {
      for (const stage of ['token', 'user']) for (const status of [429, 503]) {
        tokenStatus = stage === 'token' ? status : 200; userStatus = stage === 'user' ? status : 200
        const before = calls, response = await callback(await start())
        assert.match(response.headers.get('location')!, status === 429 ? /linuxdo_busy/ : /linuxdo_unavailable/)
        assert.equal(calls - before, stage === 'token' ? 1 : 2)
      }
      tokenStatus = userStatus = 200
      tokenBody = { error: 'invalid_grant' }
      const before = calls
      assert.match((await callback(await start())).headers.get('location')!, /linuxdo_failed/)
      assert.equal(calls - before, 1)
      tokenBody = { access_token: 'fixture-token', token_type: 'bearer' }
    })
    await check('注册限流不阻碍老账号，新账号不能绕过', async () => {
      const ip = '203.0.113.1'
      for (let i = 0; i < REGISTER_MAX_PER_IP; i++) rateLimited(`reg:${ip}`, REGISTER_MAX_PER_IP, REGISTER_WINDOW)
      profile = { id: 123, active: true }
      assert.equal(await sessionId(await callback(await start('/', 'linuxdo', ip))), linuxdoId)
      profile = { id: 999, active: true }
      assert.match((await callback(await start('/', 'linuxdo', ip))).headers.get('location')!, /linuxdo_busy/)
    })
    await check('授权入口限流', async () => {
      for (let i = 0; i < 20; i++) await start('/', 'linuxdo', '198.51.100.1')
      assert.equal((await app.request(root + prefix + '/linuxdo/start', { headers: { 'x-forwarded-for': '198.51.100.1' } })).status, 429)
    })
  }
  console.log(`RESULT ${checks} checks passed; external network calls=0`)
} finally {
  globalThis.fetch = originalFetch
  db.close()
  process.chdir(cwd)
  rmSync(directory, { recursive: true, force: true })
}
