// 接单评估手动点的夹具：隔离的临时数据目录 + 固定回复的假 AI，不花额度，不碰生产数据
// 运行：npm run test:order-judge-ui:serve，按终端打印的登录地址打开；Ctrl+C 退出，临时数据一并删除
// 假 AI：第 1 次整理返回一单社区团购（商单 / 电商支付带 3 笔假行情，选学生单或个人单看没行情的样子），第 2 次起返回追加版；文字里写「余额」会模拟余额用完（402），写「限流」会模拟限流（429）
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

const it = (id: string | null, title: string, detail: string, priority: string, basis: string, hours: number, reason: string, unclear = '', kind = '新做') => ({ id, title, detail, priority, kind, basis, hours, reason, unclear })
const V1 = {
  title: '社区团购小程序', category: '电商支付', clientType: '商单', outcome: '年前上线，能收款，团长能自己管订单', budget: '', deadline: '12 月 20 日',
  items: [
    it(null, '商品列表和详情', '分类、搜索、规格', '必须', '直接做', 0, '直接能做'),
    it(null, '购物车和下单', '选规格、改数量、填地址', '必须', '直接做', 0, '直接能做'),
    it(null, '用户登录', '微信一键登录', '必须', '直接做', 0, '直接能做'),
    it(null, '订单列表', '查看状态、取消订单', '必须', '直接做', 0, '直接能做'),
    it(null, '商家后台', '商品、订单、用户管理', '必须', '直接做', 0, '直接能做'),
    it(null, '微信支付分账', '货款分给团长和平台', '必须', '验证', 8, '要验证客户的主体能否开通分账、分账比例上限', '客户的营业执照类型没说'),
    it(null, '收款上线保障', '掉单补偿、退款对账、重复回调', '必须', '上线', 4, '涉及收钱，要人工走通真实支付和退款'),
    it(null, '团长佣金规则', '按阶梯和商品计算', '必须', '确认', 2, '规则要和客户逐条确认', '阶梯比例没给'),
    it(null, '对接旧 ERP 库存', '同步客户现有系统的库存', '应该', '接手', 6, '要先读懂对方的旧接口', '有没有接口文档没说', '接手改'),
    it(null, '订阅消息通知', '发货、到货提醒', '应该', '验证', 2, '要确认类目能否申请模板'),
    it(null, '开团海报', '生成分享图', '可以', '直接做', 0, '直接能做'),
    it(null, '数据看板', '销售额、团长排行', '可以', '确认', 1, '要确认看哪些指标'),
    it(null, '多商户入驻', '客户提过一句', '不做', '确认', 0, '超出这次范围'),
  ],
  excluded: ['微信认证和类目申请费', '服务器费用', '上线后的新功能'], questions: ['这个项目的预算大概多少', '营业执照是企业还是个体户', '佣金的阶梯比例是多少', 'ERP 有接口文档吗'],
}
const V2 = {
  ...V1,
  budget: '8000',
  items: [
    it('r1', '商品列表和详情', '分类、搜索、规格、限时折扣', '必须', '直接做', 0, '直接能做'),
    ...V1.items.slice(1).filter(i => i.title !== '开团海报').map((i, n) => ({ ...i, id: `r${n + 2}` })),
    it(null, '接手修复旧小程序登录', '客户现有小程序登录报错', '必须', '接手', 3, '先读懂别人写的登录代码', '', '接手改'),
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
const { db } = await import('../server/db')
const month = Date.UTC(new Date().getFullYear(), new Date().getMonth(), 1)
for (const [i, price] of [3200, 5000, 8800].entries()) db.prepare('INSERT INTO order_judge_samples VALUES (?,?,?,?,?,?,?,?)').run(`seed${i}`, 'seed', '商单', '电商支付', '成交', price, null, month)
const registered = await fetch(origin + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'judgefixture', password: 'fixture-password', confirm: 'fixture-password' }) })
if (registered.status !== 200) throw new Error(`夹具账号注册失败：HTTP ${registered.status}`)
cookie = registered.headers.get('set-cookie')!.split(';')[0]
console.log(`接单评估夹具已启动，打开 ${origin}/__login 自动登录并进入接单评估\n账号 judgefixture / fixture-password（需要手动登录时用）\nCtrl+C 退出`)

const stop = async (): Promise<void> => { server.close(); await rm(root, { recursive: true, force: true }); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
