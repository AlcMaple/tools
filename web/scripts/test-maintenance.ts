// 维护模式：普通访客被挡；已登录管理员、持有维护口令的浏览器放行；口令轮换后旧 cookie 作废。
process.env.DATA_DIR = process.env.DATA_DIR || `/tmp/mt-maint-test-${process.pid}`
process.env.FEEDBACK_ADMIN_USER_IDS = '1'
const { Hono } = await import('hono')
const { default: auth } = await import('../server/auth')
const { maintenanceMode } = await import('../server/maintenance')
const { dataDir } = await import('../server/data-dir')
const { writeFileSync, rmSync } = await import('node:fs')
const { join } = await import('node:path')

const app = new Hono()
app.use('*', maintenanceMode())
app.get('/api/health', (c) => c.json({ ok: true }))
app.get('/api/ping', (c) => c.json({ ok: true }))
app.get('/', (c) => c.html('home'))

const flag = join(dataDir, 'MAINTENANCE')
const ok = (cond: boolean, msg: string): void => { if (!cond) { console.error('FAIL', msg); process.exit(1) } console.log('ok  ', msg) }
const get = (path: string, cookie = '', html = false) =>
  app.request(path, { headers: { cookie, 'x-real-ip': '5.5.5.5', ...(html ? { accept: 'text/html' } : {}) } })
const register = async (name: string): Promise<string> => {
  const r = await auth.request('/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '8.8.8.8' }, body: JSON.stringify({ username: name, password: 'pass1234', confirm: 'pass1234' }) })
  return (r.headers.get('set-cookie') ?? '').split(';')[0]
}

const adminCookie = await register('admin1')
const userCookie = await register('someone')

ok((await get('/api/ping')).status === 200, '没开维护：正常放行')

writeFileSync(flag, '')
ok((await get('/api/ping')).status === 503, '空文件：接口 503')
ok((await get('/', '', true)).status === 503, '空文件：页面 503')
ok((await get('/api/health')).status === 200, '健康检查始终放行')
ok((await get('/api/ping', userCookie)).status === 503, '普通登录用户仍被挡')
ok((await get('/api/ping', adminCookie)).status === 200, '已登录管理员放行（空文件）')
ok((await get('/?maint-key=anything', '', true)).status === 503, '空文件没有口令可用')

writeFileSync(flag, 'secret-key-1\n')
ok((await get('/api/ping')).status === 503, '有口令：无凭据仍被挡')
ok((await get('/?maint-key=wrong', '', true)).status === 503, '错误口令被挡')
const entry = await get('/some/page?maint-key=secret-key-1&x=1', '', true)
const cookie = (entry.headers.get('set-cookie') ?? '').split(';')[0]
ok(entry.status === 302 && entry.headers.get('location') === '/some/page?x=1', '正确口令：跳转并抹掉口令参数')
ok(/HttpOnly/i.test(entry.headers.get('set-cookie') ?? ''), 'cookie 是 httpOnly')
ok((await get('/api/ping', cookie)).status === 200, '带 cookie 的浏览器整站放行（含接口）')
ok((await get('/', cookie, true)).status === 200, '带 cookie 的浏览器可打开页面')
ok((await get('/api/ping', userCookie)).status === 503, '普通用户不因此放行')

writeFileSync(flag, 'secret-key-2')
ok((await get('/api/ping', cookie)).status === 503, '口令轮换后旧 cookie 作废')

rmSync(flag)
ok((await get('/api/ping')).status === 200, '关闭维护后恢复')
process.exit(0)
