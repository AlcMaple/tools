// 接单评估手动点的夹具：隔离的临时数据目录 + 固定回复的假 AI，不花额度，不碰生产数据
// 运行：npm run test:order-judge-ui:serve，按终端打印的登录地址打开；Ctrl+C 退出，临时数据一并删除
// 假 AI：文字里写「数字螺丝」返回长期单，写「AI 客服」返回方案互补的一单（团购那单的方案互斥：店开在哪只能选一处）；第 1 次整理返回一单社区团购（商单 / 电商支付带 3 笔假行情，选学生单或个人单看没行情的样子），第 2 次起返回追加版；文字里写「余额」会模拟余额用完（402），写「限流」会模拟限流（429）
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
const { default: orderJudgeScope } = await import('../server/order-judge-scope')
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
    it(null, '微信群接龙下单', '团长在群里发接龙，系统自动汇总谁买了什么', '可以', '直接做', 0, '直接能做'),
    it(null, '收款码对账', '顾客扫团长的收款码付款，系统按金额对账', '可以', '确认', 1, '要确认对账口径', '收款是否允许走个人收款码没说'),
    it(null, '订单导出表格', '一键导出订单给供应商备货', '可以', '直接做', 0, '直接能做'),
    it(null, '团长专属开团页', '每个团长有自己的开团链接和店铺页', '可以', '直接做', 0, '直接能做'),
    it(null, '有赞开店配置', '在有赞后台上架商品、设好团购活动', '可以', '确认', 3, '要跟客户一起把商品和活动配好'),
    it(null, '有赞团长分销', '用有赞自带的分销给团长算佣金', '可以', '确认', 2, '要确认有赞分销能不能满足阶梯佣金'),
    it(null, '读懂旧小程序', '摸清客户现有小程序还能用多少', '可以', '接手', 4, '先读懂别人写的代码', '旧代码在谁手里没说', '接手改'),
    it(null, '修好旧小程序下单', '修掉下单和付款里现有的毛病', '可以', '接手', 4, '要先复现问题', '', '接手改'),
    it(null, '旧小程序加团长功能', '在旧小程序上加团长开团和佣金', '可以', '接手', 6, '要在别人的结构上加功能', '', '接手改'),
  ],
  excluded: ['微信认证和类目申请费', '服务器费用', '上线后的新功能'], questions: ['这个项目的预算大概多少', '营业执照是企业还是个体户', '佣金的阶梯比例是多少', 'ERP 有接口文档吗'],
}
// 流程图字段：ref 用条目下标，依赖按标题写更好读
const titles = V1.items.map(i => i.title)
const ref = (t: string): string => `n${titles.indexOf(t) + 1}`
const FLOW: Record<string, { stage: string; deps: string[] }> = {
  用户登录: { stage: '账号', deps: [] }, 商品列表和详情: { stage: '逛商品', deps: ['用户登录'] }, 购物车和下单: { stage: '下单付款', deps: ['商品列表和详情'] },
  微信支付分账: { stage: '下单付款', deps: ['购物车和下单'] }, 订单列表: { stage: '下单付款', deps: ['购物车和下单'] }, 收款上线保障: { stage: '下单付款', deps: ['微信支付分账'] },
  商家后台: { stage: '商家管理', deps: ['用户登录'] }, 团长佣金规则: { stage: '商家管理', deps: ['微信支付分账'] }, '对接旧 ERP 库存': { stage: '商家管理', deps: ['商家后台'] },
  订阅消息通知: { stage: '其他', deps: ['订单列表'] }, 开团海报: { stage: '其他', deps: ['团长专属开团页'] }, 微信群接龙下单: { stage: '下单付款', deps: [] }, 收款码对账: { stage: '下单付款', deps: ['微信群接龙下单'] }, 订单导出表格: { stage: '下单付款', deps: ['微信群接龙下单'] }, 团长专属开团页: { stage: '逛商品', deps: ['用户登录'] }, 有赞开店配置: { stage: '在哪开店', deps: [] }, 有赞团长分销: { stage: '在哪开店', deps: ['有赞开店配置'] }, 读懂旧小程序: { stage: '在哪开店', deps: [] }, 修好旧小程序下单: { stage: '在哪开店', deps: ['读懂旧小程序'] }, 旧小程序加团长功能: { stage: '在哪开店', deps: ['读懂旧小程序'] }, 数据看板: { stage: '商家管理', deps: ['商家后台'] }, 多商户入驻: { stage: '其他', deps: ['商家后台'] },
}
const flowed = V1.items.map(i => ({ ...i, ref: ref(i.title), stage: FLOW[i.title].stage, dependsOn: FLOW[i.title].deps.map(ref) }))
const pickRefs = (ps: string[]): string[] => flowed.filter(i => ps.includes(i.priority)).map(i => i.ref)
const byTitle = (ts: string[]): string[] => ts.map(ref)
const V1_FLOW = { ...V1, items: flowed, engagement: { mode: '一次性', reason: '范围能定下来', monthHours: 0, firstMonth: [] },
  // 互斥样例：店开在哪是客户定一次的事，三条路只能走一条；锁住别的路的起点，下游自动跟着锁。接龙、两种收款这些顾客每次能选的方式不互斥
  plans: [
    { name: '有赞上开团购店', summary: '在有赞上开一家团购店，商品、下单、付款都用有赞现成的，团长靠有赞分销拿佣金', fit: '一周内能开张，花钱最少；样子和规则只能按有赞来，每年交平台费', itemIds: byTitle(['有赞开店配置', '有赞团长分销']), blocks: byTitle(['用户登录', '读懂旧小程序']) },
    { name: '定制团购小程序', summary: '做一个属于自己的团购小程序，顾客挑商品、加购物车、微信付款，货款自动分给团长', fit: '想怎么做就怎么做，以后好加功能；周期最长，要等微信分账开通', itemIds: byTitle(['用户登录', '商品列表和详情', '购物车和下单', '订单列表', '微信支付分账', '收款上线保障', '商家后台', '团长佣金规则']), blocks: byTitle(['有赞开店配置', '读懂旧小程序']), recommended: true },
    { name: '修好旧小程序接着用', summary: '在你们现有的小程序上修好下单付款，再加上团长开团和佣金', fit: '顾客不用换地方；能做到什么要看旧代码的底子', itemIds: byTitle(['读懂旧小程序', '修好旧小程序下单', '旧小程序加团长功能']), blocks: byTitle(['有赞开店配置', '用户登录']) },
  ] }
// 互补样例：三个方案主打的渠道不同，彼此的条目都能加上，没有 blocks
const csItems = [
  { ...it(null, '商品知识库', '把商品说明、退换规则整理给 AI 读', '必须', '确认', 2, '要客户提供资料'), stage: '准备', deps: [] },
  { ...it(null, '网页聊天窗', '店铺网页右下角能和 AI 聊天', '应该', '直接做', 0, '直接能做'), stage: '接待顾客', deps: ['商品知识库'] },
  { ...it(null, '转人工', 'AI 答不了时转给店员', '应该', '直接做', 0, '直接能做'), stage: '接待顾客', deps: ['网页聊天窗'] },
  { ...it(null, '公众号自动回复', '顾客在公众号留言，AI 自动回答', '可以', '验证', 2, '要确认公众号类型'), stage: '接待顾客', deps: ['商品知识库'] },
  { ...it(null, '关键词菜单', '公众号底部菜单直达常见问题', '可以', '直接做', 0, '直接能做'), stage: '接待顾客', deps: ['公众号自动回复'] },
  { ...it(null, '售后工单', 'AI 收集订单号和问题，生成工单给店员', '可以', '直接做', 0, '直接能做'), stage: '售后', deps: ['商品知识库'] },
  { ...it(null, '工单进度提醒', '处理完自动通知顾客', '可以', '直接做', 0, '直接能做'), stage: '售后', deps: ['售后工单'] },
]
const csRef = (t: string): string => `n${csItems.findIndex(i => i.title === t) + 1}`
const CS = { title: '网店 AI 客服', category: '其他', clientType: '商单', outcome: '顾客问问题有人秒回，店员少回重复问题', budget: '', deadline: '',
  items: csItems.map(({ deps, ...i }) => ({ ...i, ref: csRef(i.title), dependsOn: deps.map(csRef) })),
  excluded: ['AI 调用费用'], questions: ['顾客平时主要从哪里来问'], engagement: { mode: '一次性', reason: '范围能定下来', monthHours: 0, firstMonth: [] },
  plans: [
    { name: '网页聊天客服', summary: '顾客在店铺网页点右下角就能问，AI 秒回，答不了转店员', fit: '最快上线；只照顾到网页来的顾客', itemIds: ['商品知识库', '网页聊天窗', '转人工'].map(csRef), recommended: true },
    { name: '公众号客服', summary: '顾客在公众号里留言，AI 自动回答，底部菜单直达常见问题', fit: '老顾客多在公众号时最省事；网页那边还是没人回', itemIds: ['商品知识库', '公众号自动回复', '关键词菜单'].map(csRef) },
    { name: '售后工单助手', summary: 'AI 不闲聊，专门收集退换货问题生成工单，处理完通知顾客', fit: '售后压力大时最见效；售前咨询不管', itemIds: ['商品知识库', '售后工单', '工单进度提醒'].map(csRef) },
  ] }
const LONG = { title: '数字螺丝', category: '其他', clientType: '商单', outcome: '把各螺丝厂的数据核对清楚，形成可用的数字目录', budget: '', deadline: '',
  items: [it(null, '各厂资料收集', '联系螺丝厂拿规格表', '必须', '确认', 20, '要反复对接工厂'), it(null, '规格数据核对', '统一标准并逐项核对', '必须', '验证', 30, '数据口径未知')],
  excluded: [], questions: ['第一批对接哪几家厂'], engagement: { mode: '长期', reason: '要联系多家工厂核对数据，沉淀数月才能落地', monthHours: 40, firstMonth: ['需求路线图', '两家工厂数据的可行性结论'] } }
const ESTIMATE = { items: [{ id: 'c1', hours: 3, basis: '确认', kind: '新做', reason: '要确认积分规则', unclear: '积分怎么抵扣' }], outcome: '', budget: '8000', deadline: '', questions: [] }
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
    if (text.includes('客户已经确认了需求清单')) return { choices: [{ message: { content: JSON.stringify(ESTIMATE) } }] }
    if (text.includes('AI 客服')) return { choices: [{ message: { content: JSON.stringify(CS) } }] }
    if (text.includes('数字螺丝')) return { choices: [{ message: { content: JSON.stringify(LONG) } }] }
    return { choices: [{ message: { content: JSON.stringify(calls++ === 0 ? V1_FLOW : V2) } }] }
  },
})))
app.route('/api/order-judge-scope', orderJudgeScope)
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
