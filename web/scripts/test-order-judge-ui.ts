// 接单评估整理流程回归：旧数据清理 → 新项目 → 追加第 2 版（差异标记）→ 项目列表切版本 → 删除；夹具模型，不花 AI 额度。
// 运行：JUDGE_BROWSER_MODULE=<playwright 目录> npm run test:order-judge-ui（可选 JUDGE_SCREENSHOT_DIR 保存截图）
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

assert(process.env.JUDGE_BROWSER_MODULE, '设置 JUDGE_BROWSER_MODULE 指向已安装的 Playwright')
const { chromium } = createRequire(import.meta.url)(process.env.JUDGE_BROWSER_MODULE) as typeof import('playwright')
const shots = process.env.JUDGE_SCREENSHOT_DIR
let checks = 0
const pass = (label: string): void => { console.log(`PASS ${++checks}: ${label}`) }

const root = await mkdtemp(join(tmpdir(), 'judge-ui-'))
process.env.DATA_DIR = join(root, 'data')
process.env.AUTH_SECRET = 'fixture-only-judge-ui-secret'
const { db } = await import('../server/db')
db.exec('CREATE TABLE order_judge_history (id TEXT PRIMARY KEY); CREATE TABLE order_judge_docs (user_id INTEGER)')
await mkdir(join(process.env.DATA_DIR, 'order-judge', '1', 'old'), { recursive: true })
await writeFile(join(process.env.DATA_DIR, 'order-judge', '1', 'old', '01.jpg'), 'old')
const { Hono } = await import('hono')
const { serve } = await import('@hono/node-server')
const { serveStatic } = await import('@hono/node-server/serve-static')
const { securityHeaders } = await import('../server/security')
const { default: auth } = await import('../server/auth')
const { createOrderJudgeApi } = await import('../server/order-judge')
assert.equal((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('order_judge_history','order_judge_docs')").get() as { n: number }).n, 0)
assert(!existsSync(join(process.env.DATA_DIR, 'order-judge', '1', 'old')))
pass('重做前的旧表和旧文件在启动时删除')

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
const replies = [V1, V2]
const prompts: string[] = []
const app = new Hono()
app.use('*', securityHeaders())
app.route('/api/auth', auth)
app.route('/api/order-judge', createOrderJudgeApi(async () => ({
  source: 'server', model: 'ui-fixture', execute: action => action(),
  call: async (body: unknown) => {
    prompts.push(JSON.stringify(body))
    return { choices: [{ message: { content: JSON.stringify(replies.shift()) } }] }
  },
})))
app.get('/api/agent/provider', c => c.json({ enabled: true, ready: true, source: 'server', model: 'ui-fixture' }))
app.all('/api/*', c => c.json({ error: 'fixture endpoint' }, 404))
app.use('/*', serveStatic({ root: resolve('dist') }))
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
await new Promise<void>(r => server.on('listening', r))
const address = server.address(); assert(address && typeof address !== 'string')
const origin = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch({ headless: true })
try {
  const registered = await fetch(origin + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'judgeui', password: 'fixture-password', confirm: 'fixture-password' }) })
  assert.equal(registered.status, 200)
  const cookie = registered.headers.get('set-cookie')!.split(';')[0]
  const context = await browser.newContext({ viewport: { width: 1360, height: 980 } })
  const split = cookie.indexOf('=')
  await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: origin }])
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(origin + '/#/judge')
  await page.getByRole('heading', { name: '接单评估', exact: true }).waitFor()
  assert.equal(await page.getByText('能力档案').count(), 0)
  assert.equal(await page.getByLabel('评估设置').count(), 0)
  pass('页面不再有能力档案、项目日志和评估设置入口')

  await page.locator('.oj-text').fill('做个社团报名小程序，12 月 20 日答辩')
  await page.getByRole('button', { name: '整理需求' }).click()
  await page.getByText('社团报名小程序', { exact: true }).first().waitFor()
  const sheet = page.locator('.oj-result .oj-sheet')
  assert.match(await sheet.innerText(), /第 1 版/)
  assert.match(await sheet.innerText(), /学生单/)
  assert.match(await sheet.locator('.oj-facts').innerText(), /预算\n待问/)
  assert.match(await sheet.innerText(), /必须\n4 小时/)
  assert.match(await sheet.innerText(), /导出字段没说/)
  assert.match(await sheet.innerText(), /论文正文/)
  assert.match(prompts[0], /MoSCoW|必须 \/ 应该|「必须」/)
  pass('新项目整理出第 1 版：客户类型、待问的预算、按优先级分组的小时、不清楚的点、不包含')
  if (shots) await page.screenshot({ path: join(shots, 'v1-desktop.png'), fullPage: true })

  // 基础 4×31=124 → 报价 160；推荐 +3×31 +兜底 1.5×31≈47 = 264 → 330；完整 +2×31 = 326 → 410
  const quote = sheet.locator('.oj-quote')
  const selfV1 = await quote.locator('.oj-qtext').innerText()
  assert.match(selfV1, /【基础档】底线 ¥124 · 报价 ¥160/)
  assert.match(selfV1, /【推荐档】底线 ¥264 · 报价 ¥330/)
  assert.match(selfV1, /兜底：管理员导出 Excel  1\.5 小时 × 31 = ¥47  未说清「导出字段没说」/)
  assert.match(selfV1, /预算：待问/)
  await quote.getByRole('group', { name: '人情折让' }).getByRole('button', { name: '10%' }).click()
  await quote.getByPlaceholder(/同学/).fill('同学')
  await quote.getByRole('group', { name: '状态' }).getByRole('button', { name: '已成交' }).click()
  await quote.getByRole('group', { name: '报价单版本' }).getByRole('button', { name: '客户版' }).click()
  const clientV1 = await quote.locator('.oj-qtext').innerText()
  assert(clientV1.indexOf('【完整档】¥410') < clientV1.indexOf('【推荐档】¥330（主推）'))
  assert.match(clientV1, /人情折让 −¥33（同学）\n实收 ¥297/)
  assert.match(clientV1, /14 天保修/)
  assert.doesNotMatch(clientV1, /小时|底线/)
  await quote.getByRole('button', { name: '保存' }).click()
  await quote.getByText('已保存').waitFor()
  const saved = JSON.parse((db.prepare('SELECT quote FROM order_judge_versions').get() as { quote: string }).quote) as { status: string; discount: { ratio: number } }
  assert.equal(saved.status, '已成交'); assert.equal(saved.discount.ratio, 0.1)
  pass('报价：三档底线逐行可查，报价 = 底线 ÷ 0.8，客户版完整档在前、不出现小时，人情折让单列，保存后落库')
  if (shots) await page.screenshot({ path: join(shots, 'v1-quote.png'), fullPage: true })

  assert.match(await page.locator('.oj-mat-name').innerText(), /给「社团报名小程序」追加需求/)
  await page.locator('.oj-text').fill('客户补充：表单要加手机号，不要推送了，旧登录页也帮忙修一下，预算 800')
  await page.getByRole('button', { name: '整理第 2 版' }).click()
  await sheet.getByText('这一版去掉了').waitFor()
  const revise = (JSON.parse(prompts[1]) as { messages: { content: string | { text?: string }[] }[] }).messages[1].content as { text?: string }[]
  assert.match(revise[0].text!, /上一版需求清单/)
  assert.match(revise[0].text!, /"id":"r1"/)
  const v2 = await sheet.innerText()
  assert.match(v2, /有改动/); assert.match(v2, /新增/)
  assert.match(v2, /这一版去掉了\n消息推送/)
  assert.match(await sheet.locator('.oj-facts').innerText(), /预算\n800/)
  assert.equal(await sheet.locator('.oj-item').filter({ hasText: '管理员导出 Excel' }).locator('.oj-flip').count(), 0)
  pass('追加需求带上一版清单给 AI，第 2 版标出改动、新增、去掉，没变的条目不标')
  if (shots) await page.screenshot({ path: join(shots, 'v2-desktop.png'), fullPage: true })

  // 第 1 版已成交，第 2 版是变更单：报名表单内容改了整条 5×31=155，旧登录新增 6×267=1602，导出没变不收，推送去掉不退
  const change = sheet.locator('.oj-quote')
  assert.match(await change.locator('h3').innerText(), /变更单 · 基于第 1 版/)
  const selfV2 = await change.locator('.oj-qtext').innerText()
  assert.match(selfV2, /底线 ¥1,757 · 报价 ¥2,200/)
  assert.doesNotMatch(selfV2, /管理员导出 Excel  \d/)
  assert.match(selfV2, /客户不提就不退\n· 消息推送/)
  assert.equal(await change.getByRole('group', { name: '人情折让' }).locator('.on').innerText(), '不让')
  pass('成交后追加的版本出变更单：只算新增和改动，去掉的不退，折让不沿用')

  await change.getByRole('group', { name: '状态' }).getByRole('button', { name: '已成交' }).click()
  await change.getByLabel('实际新做').fill('8')
  await change.getByLabel('实际接手改').fill('3')
  await change.getByRole('group', { name: '做完觉得' }).getByRole('button', { name: '亏' }).click()
  await change.getByRole('button', { name: '保存' }).click()
  await change.getByText('已保存').waitFor()
  const fed = JSON.parse((db.prepare('SELECT quote FROM order_judge_versions WHERE n=2').get() as { quote: string }).quote) as { actual: Record<string, number>; feeling: string; frozen: { rates: Record<string, number> } }
  assert.deepEqual(fed.actual, { 新做: 8, 接手改: 3 }); assert.equal(fed.feeling, '亏')
  assert.deepEqual(fed.frozen.rates, { 新做: 31, 接手改: 267 })
  assert.match(await change.locator('.oj-qtext').innerText(), /按报出去那一刻的/)
  pass('成交后按新做 / 接手改分别回填实际小时和感受，保存时冻结当时的时间值')

  await page.getByRole('button', { name: /^项目/ }).click()
  const rows = page.locator('.oj-row')
  assert.equal(await rows.count(), 1)
  assert.match(await rows.first().innerText(), /v2/)
  await page.getByRole('tab', { name: 'v1' }).click()
  const detail = page.locator('.oj-hist .oj-sheet')
  assert.match(await detail.innerText(), /消息推送/)
  assert.doesNotMatch(await detail.innerText(), /有改动/)
  const box = await page.getByRole('tab', { name: 'v1' }).boundingBox()
  await page.getByRole('tab', { name: 'v2' }).click()
  assert.deepEqual(await page.getByRole('tab', { name: 'v1' }).boundingBox(), box)
  pass('项目列表显示最新版本，可切回第 1 版查看，切换不挪动按钮')

  await page.getByRole('button', { name: '删除这个项目' }).click()
  await page.getByRole('button', { name: '确认删除' }).click()
  await page.getByText('还没有整理过的项目').waitFor()
  const left = db.prepare('SELECT (SELECT count(*) FROM order_judge_projects) AS p, (SELECT count(*) FROM order_judge_versions) AS v').get() as { p: number; v: number }
  assert.deepEqual(left, { p: 0, v: 0 })
  pass('删除项目连同所有版本一起删掉')

  replies.push(V1)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(origin + '/#/judge'); await page.reload()
  await page.locator('.oj-text').fill('做个社团报名小程序')
  await page.getByRole('button', { name: '整理需求' }).click()
  await page.getByText('社团报名小程序', { exact: true }).first().waitFor()
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1)
  assert(await page.locator('.oj-flowbar').isVisible())
  if (shots) await page.screenshot({ path: join(shots, 'v1-mobile.png'), fullPage: true })
  pass('手机宽度整理成功，无水平溢出')
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  server.closeAllConnections()
  await new Promise<void>(r => server.close(() => r()))
  db.close()
  await rm(root, { recursive: true, force: true })
}
console.log(`PASS ${checks} order-judge ui checks`)
