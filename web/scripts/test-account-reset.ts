// 管理员强制重置：签发 → 校验 → 完成 → 旧链接作废，全程走真实路由与临时库。
process.env.DATA_DIR = process.env.DATA_DIR || `/tmp/mt-reset-test-${process.pid}`
process.env.FEEDBACK_ADMIN_USER_IDS = '1'
const { default: auth } = await import('../server/auth')

let cookie = ''
const call = async (path: string, body?: unknown, ck = cookie): Promise<{ status: number; json: Record<string, any> }> => {
  const res = await auth.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', cookie: ck, 'x-real-ip': '1.2.3.4' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]
  return { status: res.status, json: await res.json().catch(() => ({})) }
}
const ok = (cond: boolean, msg: string): void => { if (!cond) { console.error('FAIL', msg); process.exit(1) } console.log('ok  ', msg) }

await call('/register', { username: 'admin1', password: 'adminpw1', confirm: 'adminpw1' })
const adminCookie = cookie
cookie = ''
await call('/register', { username: 'victim', password: 'oldpass1', confirm: 'oldpass1' })
const userCookie = cookie

ok((await call('/reset/issue', { username: 'victim' }, userCookie)).status === 403, '普通用户不能签发')
ok((await call('/reset/issue', { username: 'victim' }, '')).status === 403, '未登录不能签发')
ok((await call('/reset/issue', { username: 'nobody' }, adminCookie)).status === 404, '用户不存在')

ok((await call('/reset/users', undefined, userCookie)).status === 403, '普通用户不能看用户列表')
const list = await call('/reset/users', undefined, adminCookie)
ok(list.json.total === 2 && list.json.users.find((u: any) => u.self)?.username === 'admin1', '管理员能看到用户列表并标出自己')

const a = await call('/reset/issue', { username: 'victim' }, adminCookie)
ok(a.status === 200 && /\/\?reset=/.test(a.json.url), '管理员签发成功')
const t1 = new URL(a.json.url).searchParams.get('reset')!
const b = await call('/reset/issue', { username: 'victim' }, adminCookie)
const t2 = new URL(b.json.url).searchParams.get('reset')!
ok((await call(`/reset/check?token=${t1}`)).status === 410, '再次签发后旧链接作废')
ok((await call(`/reset/check?token=${t2}`)).json.username === 'victim', '新链接可校验')

const bad = { token: t2, newPassword: 'newpass1', confirm: 'newpass1', questionId: 'bogus', answer: 'x' }
ok((await call('/reset/complete', bad)).status === 400, '密保问题非法被拒')
ok((await call('/reset/check?token=' + t2)).status === 200, '校验失败不消耗链接')
const done = await call('/reset/complete', { ...bad, questionId: 'first_anime', answer: ' Naruto ' })
ok(done.status === 200, '重置完成')
ok((await call('/reset/complete', { ...bad, questionId: 'first_anime', answer: 'x' })).status === 410, '链接只能用一次')
ok((await call('/login', { username: 'victim', password: 'oldpass1' }, '')).status === 401, '旧密码失效')
ok((await call('/login', { username: 'victim', password: 'newpass1' }, '')).status === 200, '新密码可登录')
ok((await call('/me', undefined, userCookie)).status === 401, '旧会话被踢下线')
const forgot = await call('/forgot', { username: 'victim', questionId: 'first_anime', answer: 'naruto', newPassword: 'again123', confirm: 'again123' }, '')
ok(forgot.status === 200, '新密保答案可用于自助找回')

const self = await call('/reset/issue', { username: 'admin1' }, adminCookie)
ok(self.status === 200, '管理员可给自己签发')
process.exit(0)
