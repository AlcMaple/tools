// 接单评估手动点的夹具：隔离的临时数据目录 + 固定回复的假 AI，不花额度，不碰生产数据
// 运行：npm run test:order-judge-ui:serve，按终端打印的登录地址打开；Ctrl+C 退出，临时数据一并删除
// 假 AI：第 1 次整理返回第 1 版，第 2 次起返回第 2 版；文字里写「余额」会模拟余额用完（402），写「限流」会模拟限流（429）
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'judge-fixture-'))
process.env.DATA_DIR = join(root, 'data')
process.env.AUTH_SECRET = 'fixture-only-judge-secret'
const { Hono } = await import('hono')
const { serve } = await import('@hono/node-server')
const { serveStatic } = await import('@hono/node-server/serve-static')
const { securityHeaders } = await import('../server/security')
const { default: auth } = await import('../server/auth')
const { createOrderJudgeApi } = await import('../server/order-judge')
const { AgentRunError } = await import('../shared/agent-run')

const V1 = {
  title: '社团报名小程序', clientType: '学生单', outcome: '答辩前能演示报名流程', budget: '', deadline: '12 月 20 日', alternative: '',
  items: [
    { id: null, title: '报名表单页', detail: '姓名、学号、社团选择', priority: '必须', kind: '新做', hours: 4, reason: '一个表单页加校验', unclear: '' },
    { id: null, title: '管理员导出 Excel', detail: '导出全部报名', priority: '应该', kind: '新做', hours: 3, reason: '一个导出接口', unclear: '导出字段没说' },
    { id: null, title: '消息推送', detail: '报名成功后推送', priority: '可以', kind: '新做', hours: 2, reason: '订阅消息', unclear: '' },
  ],
  excluded: ['论文正文'], questions: ['预算大概多少'],
}
const V2 = {
  ...V1,
  budget: '800',
  items: [
    { id: 'r1', title: '报名表单页', detail: '姓名、学号、社团选择、手机号', priority: '必须', kind: '新做', hours: 5, reason: '多一个字段和校验', unclear: '' },
    { id: 'r2', title: '管理员导出 Excel', detail: '导出全部报名', priority: '应该', kind: '新做', hours: 3, reason: '一个导出接口', unclear: '导出字段没说' },
    { id: 'r9', title: '接手修改旧登录', detail: '客户已有登录页报错', priority: '必须', kind: '接手改', hours: 6, reason: '先读懂旧代码再修', unclear: '' },
  ],
}

let calls = 0
const app = new Hono()
app.use('*', securityHeaders())
app.route('/api/auth', auth)
app.route('/api/order-judge', createOrderJudgeApi(async () => ({
  source: 'server', model: 'fixture', execute: action => action(),
  call: async (body: unknown) => {
    const text = JSON.stringify(body)
    await new Promise(r => setTimeout(r, 1500))
    if (text.includes('余额')) throw new AgentRunError('PROVIDER_HTTP_402', 503)
    if (text.includes('限流')) throw new AgentRunError('PROVIDER_HTTP_429', 503)
    return { choices: [{ message: { content: JSON.stringify(calls++ === 0 ? V1 : V2) } }] }
  },
})))
app.get('/api/agent/provider', c => c.json({ enabled: true, ready: true, source: 'server', model: 'fixture' }))
let cookie = ''
app.get('/__login', c => {
  c.header('Set-Cookie', `${cookie}; Path=/; HttpOnly; SameSite=Lax`)
  return c.redirect('/#/judge')
})
app.all('/api/*', c => c.json({ error: 'fixture endpoint' }, 404))
app.use('/*', serveStatic({ root: resolve('dist') }))

const port = Number(process.env.FIXTURE_PORT ?? 5199)
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port })
await new Promise<void>(r => server.on('listening', r))
const origin = `http://127.0.0.1:${port}`
const registered = await fetch(origin + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'judgefixture', password: 'fixture-password', confirm: 'fixture-password' }) })
if (registered.status !== 200) throw new Error(`夹具账号注册失败：HTTP ${registered.status}`)
cookie = registered.headers.get('set-cookie')!.split(';')[0]
console.log(`接单评估夹具已启动，打开 ${origin}/__login 自动登录并进入接单评估\n账号 judgefixture / fixture-password（需要手动登录时用）\nCtrl+C 退出`)

const stop = async (): Promise<void> => { server.close(); await rm(root, { recursive: true, force: true }); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
