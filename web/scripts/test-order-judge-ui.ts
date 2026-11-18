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
  title: '社团报名小程序', clientType: '个人单', outcome: '答辩前能演示报名流程', budget: '', deadline: '12 月 20 日',
  items: [
    { id: null, title: '报名表单页', detail: '姓名、学号、社团选择', priority: '必须', kind: '新做', hours: 4, reason: '一个表单页加校验', unclear: '' },
    { id: null, title: '管理员导出 Excel', detail: '导出全部报名', priority: '应该', kind: '新做', hours: 3, reason: '一个导出接口', unclear: '导出字段没说' },
    { id: null, title: '消息推送', detail: '报名成功后推送', priority: '可以', kind: '新做', hours: 2, reason: '订阅消息', unclear: '' },
  ],
  excluded: ['论文正文'], questions: ['预算大概多少'],
}
const V2 = {
  ...V1,
  engagement: { mode: '长期', reason: '客户每月追加需求', monthHours: 0, firstMonth: ['核对报名流程'] },
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
const browser = await chromium.launch({ headless: true, executablePath: process.env.JUDGE_CHROME_BIN })
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
  await page.getByText('先选客户类型').waitFor({ state: 'visible' })
  assert.equal(prompts.length, 0)
  await page.getByRole('group', { name: '客户类型' }).getByRole('button', { name: '个人单' }).click()
  await page.getByRole('button', { name: '整理需求' }).click()
  await page.getByText('社团报名小程序', { exact: true }).first().waitFor()
  const sheet = page.locator('.oj-result .oj-sheet')
  assert.match(await sheet.innerText(), /第 1 版/)
  assert.match(await sheet.innerText(), /个人单/)
  assert.match(await sheet.locator('.oj-facts').innerText(), /预算\n待问/)
  assert.match(await sheet.innerText(), /导出字段没说/)
  assert.match(await sheet.innerText(), /论文正文/)
  assert.match(prompts[0], /MoSCoW|必须 \/ 应该|「必须」/)
  pass('新项目整理出第 1 版：客户类型、待问的预算、按优先级分组的小时、不清楚的点、不包含')
  if (shots) await page.screenshot({ path: join(shots, 'v1-desktop.png'), fullPage: true })

  // 个人单没有兜底：基础 4×67=268 → 报价 340；推荐 +3×67 = 469 → 590；完整 +2×67 = 603 → 760
  const quote = sheet.locator('.oj-quote')
  assert.equal(await sheet.locator('.oj-maint').count(), 0)
  const selfV1 = await quote.locator('.oj-qtext').evaluate(e => e.textContent ?? '')
  assert.match(selfV1, /【基础档】底线 ¥268 · 报价 ¥340/)
  assert.match(selfV1, /【推荐档】底线 ¥469 · 报价 ¥590/)
  assert.doesNotMatch(selfV1, /兜底/)
  assert.match(selfV1, /基础档  4 小时 ÷ 8 = 1 天，从今天开工最早 \d+ 月 \d+ 日交付/)
  assert.match(selfV1, /截止 12 月 20 日（材料里写的「12 月 20 日」）：每一档都来得及/)
  assert.match(selfV1, /预算：待问/)
  assert.equal(await quote.getByRole('group', { name: '成效奖金' }).count(), 0)
  await quote.getByLabel('整体小时倍率').fill('2')
  assert.match(await quote.locator('.oj-qtext').evaluate(e => e.textContent ?? ''), /【基础档】底线 ¥536/)
  await quote.getByRole('slider', { name: '报名表单页的小时', exact: true }).fill('12')
  assert.equal(await quote.getByRole('spinbutton', { name: '报名表单页的小时数' }).inputValue(), '12')
  assert.equal(await quote.getByTitle('1 天 4 小时', { exact: true }).count(), 1)
  assert.match(await quote.locator('.oj-qtext').evaluate(e => e.textContent ?? ''), /【基础档】底线 ¥804/)
  if (shots) await quote.locator('.oj-hours').screenshot({ path: join(shots, 'hours-desktop.png') })
  await quote.getByRole('button', { name: '恢复 AI 的估计' }).click()
  assert.match(await quote.locator('.oj-qtext').evaluate(e => e.textContent ?? ''), /【基础档】底线 ¥268/)
  // 真实鼠标：按住后拖到滑块外仍然跟手，行不换位，按下的位置就是滑块去的位置
  const sliders = quote.locator('.oj-hrow input[type=range]')
  const namesBefore = await quote.locator('.oj-hrow > span:first-child').allInnerTexts()
  const sliderBox = (await sliders.nth(1).boundingBox())!
  await page.mouse.move(sliderBox.x + sliderBox.width * 0.75, sliderBox.y + sliderBox.height / 2)
  await page.mouse.down()
  const max = Number(await sliders.nth(1).getAttribute('max'))
  const atClick = Number(await sliders.nth(1).inputValue())
  assert.ok(Math.abs(atClick / max - 0.75) < 0.05, `点击位置 ${atClick}/${max}`)
  await page.mouse.move(sliderBox.x + sliderBox.width * 0.4, sliderBox.y + 200, { steps: 8 })
  const dragged = Number(await sliders.nth(1).inputValue())
  assert.ok(Math.abs(dragged / max - 0.4) < 0.05, `拖到框外 ${dragged}/${max}`)
  await page.mouse.up()
  assert.equal(Number(await sliders.nth(1).getAttribute('max')), max)
  assert.deepEqual(await quote.locator('.oj-hrow > span:first-child').allInnerTexts(), namesBefore)
  await quote.getByRole('button', { name: '恢复 AI 的估计' }).click()
  pass('滑块拖整体和单项，报价立刻变，能一键恢复')
  await quote.getByText('更多设置').click()
  await quote.getByRole('group', { name: '人情折让' }).getByRole('button', { name: '10%' }).click()
  await quote.getByPlaceholder(/同学/).fill('同学')
  await quote.getByRole('group', { name: '状态' }).getByRole('button', { name: '已成交' }).click()
  await quote.getByRole('group', { name: '报价单版本' }).getByRole('button', { name: '客户版' }).click()
  const clientV1 = await quote.locator('.oj-qtext').evaluate(e => e.textContent ?? '')
  assert(clientV1.indexOf('【完整档】¥760') < clientV1.indexOf('【推荐档】¥590（主推）'))
  assert.match(clientV1, /人情折让 −¥59（同学）\n实收 ¥531/)
  assert.match(clientV1, /14 天保修，不另外收费/)
  assert.match(clientV1, /预计 1 天交付/)
  assert.doesNotMatch(clientV1, /小时|底线/)
  await quote.getByRole('button', { name: '保存' }).click()
  await quote.getByText('已保存').waitFor()
  const saved = JSON.parse((db.prepare('SELECT quote FROM order_judge_versions').get() as { quote: string }).quote) as { status: string; discount: { ratio: number } }
  assert.equal(saved.status, '已成交'); assert.equal(saved.discount.ratio, 0.1)
  pass('报价：三档底线逐行可查，报价 = 底线 ÷ 0.8，客户版完整档在前、不出现小时，人情折让单列，保存后落库')
  if (shots) await page.screenshot({ path: join(shots, 'v1-quote.png'), fullPage: true })

  assert.match(await page.locator('.oj-mat-name').innerText(), /给「社团报名小程序」追加需求/)
  await page.getByRole('button', { name: '追加需求', exact: true }).first().click()
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

  // 第 1 版已成交，第 2 版是变更单：报名表单内容改了整条 5×67=335，旧登录新增 6×67=402，导出没变不收，推送去掉不退
  const change = sheet.locator('.oj-quote')
  assert.equal(await sheet.locator('.oj-maint').count(), 0)
  assert.equal(await sheet.getByRole('button', { name: /^(一次性|长期合作)$/ }).count(), 0)
  pass('首次按一次性估价；追加的模型改判长期也不换方式，更没有切换按钮')
  assert.match(await change.locator('h3').innerText(), /变更单 · 基于第 1 版/)
  const selfV2 = await change.locator('.oj-qtext').evaluate(e => e.textContent ?? '')
  assert.match(selfV2, /底线 ¥737 · 报价 ¥930/)
  assert.doesNotMatch(selfV2, /管理员导出 Excel  \d/)
  assert.match(selfV2, /客户不提就不退\n· 消息推送/)
  await change.getByText('更多设置').click()
  assert.equal(await change.getByRole('group', { name: '人情折让' }).locator('.on').innerText(), '不让')
  pass('成交后追加的版本出变更单：只算新增和改动，去掉的不退，折让不沿用')

  await change.getByRole('group', { name: '状态' }).getByRole('button', { name: '已成交' }).click()
  await change.getByLabel('从零做的部分用时').fill('8')
  await change.getByLabel('验证和改旧代码用时').fill('3')
  await change.getByRole('group', { name: '做完觉得' }).getByRole('button', { name: '亏' }).click()
  await change.getByRole('button', { name: '保存' }).click()
  await change.getByText('已保存').waitFor()
  const fed = JSON.parse((db.prepare('SELECT quote FROM order_judge_versions WHERE n=2').get() as { quote: string }).quote) as { actual: Record<string, number>; feeling: string; frozen: { rates: Record<string, number> } }
  assert.deepEqual(fed.actual, { 新做: 8, 接手改: 3 }); assert.equal(fed.feeling, '亏')
  assert.deepEqual(fed.frozen.rates, { 新做: 67, 接手改: 67 })
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
  await page.getByRole('group', { name: '客户类型' }).getByRole('button', { name: '商单' }).click()
  await page.getByRole('button', { name: '整理需求' }).click()
  await page.getByText('社团报名小程序', { exact: true }).first().waitFor()
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1)
  assert(await page.locator('.oj-flowbar').isVisible())
  // 商单：底线 570、报价 720，把握 5 成 → 奖金 (720 − 570) ÷ 0.5 = 300
  const shop = page.locator('.oj-result .oj-quote')
  await shop.getByText('更多设置').click()
  await shop.getByRole('group', { name: '成效奖金' }).getByRole('button', { name: '加', exact: true }).click()
  await shop.getByLabel('看什么').fill('报名转化率')
  await shop.getByRole('group', { name: '报价单版本' }).getByRole('button', { name: '客户版' }).click()
  assert.match(await shop.locator('.oj-qtext').evaluate(e => e.textContent ?? ''), /先付 ¥570，交付时付清\n达标后再付 ¥300\n· 看什么：报名转化率/)
  assert.equal(await shop.getByRole('group', { name: '人情折让' }).count(), 0)
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1)
  if (shots) await shop.screenshot({ path: join(shots, 'bonus-mobile.png') })
  pass('商单可加成效奖金：先付底线，奖金按把握倒推，手机上不溢出')
  if (shots) await page.screenshot({ path: join(shots, 'v1-mobile.png'), fullPage: true })
  pass('手机宽度整理成功，无水平溢出')
  assert.equal(await shop.getByRole('button', { name: /^(一次性|长期合作)$/ }).count(), 0)
  await shop.getByRole('group', { name: '状态', exact: true }).getByRole('button', { name: '已报价' }).click()
  const onceReply = shop.getByRole('group', { name: '一次性客户回复' })
  await onceReply.getByRole('button').click()
  await page.locator('.dd.pop-float').getByRole('button', { name: '嫌贵没成交' }).click()
  assert(await shop.getByLabel('客户说的预算').isVisible())
  await shop.getByRole('button', { name: '保存', exact: true }).click()
  await shop.getByText('已保存', { exact: true }).waitFor()
  const longSample = { ...V1, title: '长期示例', engagement: { ...V2.engagement, monthHours: 11 } }
  replies.push(longSample)
  await page.getByRole('button', { name: '新项目', exact: true }).click()
  await page.locator('.oj-text').fill('长期示例：每个月都需要对接')
  await page.getByRole('button', { name: '整理需求', exact: true }).click()
  const maint = page.locator('.oj-maint:visible')
  await maint.getByRole('heading', { name: '长期合作' }).waitFor()
  assert.equal(await page.locator('.oj-quote:visible').count(), 0)
  assert.equal(await page.getByRole('button', { name: /^(一次性|长期合作)$/ }).count(), 0)
  const progression = maint.getByRole('group', { name: '合作进度' })
  const state = maint.getByRole('group', { name: '月费报价状态' })
  const reply = maint.getByRole('group', { name: '月费客户回复' })
  const fee = maint.getByRole('textbox', { name: '月费', exact: true })
  const saveMonthly = async () => {
    await maint.getByRole('button', { name: '保存', exact: true }).click()
    await maint.getByText('已保存', { exact: true }).waitFor()
  }
  assert.equal(await reply.count(), 0)
  assert.equal(await progression.count(), 0)
  await state.getByRole('button', { name: '已报价' }).click()
  assert.equal(await reply.getByRole('button').innerText(), '待回复')
  const suggested = Number((await fee.getAttribute('placeholder'))?.split(' ')[1])
  assert(suggested > 0)
  await saveMonthly()
  assert.equal(Number(await fee.inputValue()), suggested)
  assert.equal(await maint.getByLabel('每月投入小时').inputValue(), '11')
  for (const width of [320, 384, 390, 768, 1360]) {
    await page.setViewportSize({ width, height: 740 })
    const trigger = reply.getByRole('button')
    await trigger.click()
    const menu = page.locator('.dd.pop-float')
    const a = (await trigger.boundingBox())!, b = (await menu.boundingBox())!, card = (await maint.boundingBox())!
    assert(b && a && Math.abs(a.width - b.width) <= 1 && a.height <= 48, `回复触发器和菜单宽度：${width}`)
    assert(b.x >= card.x - 1 && b.x + b.width <= card.x + card.width + 1 && b.x >= 0 && b.x + b.width <= width + 1)
    assert(b.y >= 0 && b.y + b.height <= 741)
    assert.equal(await menu.getByRole('button').count(), 7)
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
  }
  await page.setViewportSize({ width: 384, height: 740 })
  const chooseReply = async (name: string) => {
    await reply.getByRole('button').click()
    await page.locator('.dd.pop-float').getByRole('button', { name, exact: true }).click()
  }
  await chooseReply('嫌贵')
  await maint.getByLabel('客户月预算').fill('500')
  await maint.getByLabel('客户原话').fill('每月最多五百')
  await saveMonthly()
  const row = db.prepare('SELECT id, maintenance FROM order_judge_projects ORDER BY created_at DESC LIMIT 1').get() as { id: string; maintenance: string }
  const { reply: _reply, replyNote: _note, clientBudget: _budget, ...legacy } = JSON.parse(row.maintenance)
  const older = await context.request.put(origin + `/api/order-judge/projects/${row.id}/maintenance`, { data: legacy })
  assert.equal(older.status(), 200)
  const preserved = (await older.json()).project.maintenance
  assert.deepEqual([preserved.reply, preserved.replyNote, preserved.clientBudget], ['嫌贵', '每月最多五百', 500])
  if (shots) await maint.screenshot({ path: join(shots, 'monthly-feedback.png') })
  assert.equal(await progression.count(), 0)
  assert.equal(await maint.getByRole('button', { name: '记一个月' }).count(), 0)
  const planWrite = await context.request.put(origin + `/api/order-judge/projects/${row.id}/maintenance`, { data: { plan: '一次性' } })
  assert.equal(planWrite.status(), 409)
  assert.equal((await planWrite.json()).code, 'PLAN_FIXED')
  const stale = await context.request.put(origin + `/api/order-judge/projects/${row.id}/maintenance`, { data: { ...legacy, plan: '一次性' } })
  assert.equal(stale.status(), 200)
  assert.equal((await stale.json()).project.maintenance.plan, '')
  await page.reload()
  await page.locator('.oj-mode').getByRole('button', { name: '整理' }).click()
  await page.getByRole('button', { name: /^项目/ }).click()
  await page.locator('.oj-row-main').filter({ hasText: '长期示例' }).click()
  assert.equal(await maint.getByRole('group', { name: '月费客户回复' }).getByRole('button').innerText(), '嫌贵')
  assert.equal(await maint.getByLabel('客户月预算').inputValue(), '500')
  assert.equal(await maint.getByLabel('客户原话').inputValue(), '每月最多五百')
  await maint.getByRole('button', { name: '客户版' }).click()
  assert.doesNotMatch(await maint.locator('.oj-qtext').innerText(), /每月最多五百|嫌贵|预算/)
  await maint.getByRole('button', { name: '自用版' }).click()
  await chooseReply('同意')
  assert.equal(await progression.locator('.on').innerText(), '待开始')
  await progression.getByRole('button', { name: '在做' }).click()
  pass('月费报出冻结金额和投入；嫌贵可回填预算和原话，刷新后保留，未同意不出现开工记录')
  await fee.fill('600')
  await maint.getByRole('button', { name: '记一个月' }).click()
  await maint.getByRole('textbox', { name: '月份', exact: true }).fill('2026-11')
  await maint.getByRole('textbox', { name: '实际小时' }).fill('10')
  await maint.getByRole('textbox', { name: '交付了什么' }).fill('积分系统')
  await maint.getByRole('group', { name: '2026-11觉得' }).getByRole('button', { name: '值' }).click()
  assert.match(await maint.locator('.oj-qtext').evaluate(e => e.textContent ?? ''), /2026 年 11 月  10 小时，每小时 ¥60  值  交付：积分系统/)
  await maint.getByRole('button', { name: '保存' }).click()
  await maint.getByText('已保存').waitFor()
  assert(await fee.isDisabled())
  const saved2 = JSON.parse((db.prepare('SELECT maintenance FROM order_judge_projects WHERE id=?').get(row.id) as { maintenance: string }).maintenance) as { fee: number; months: unknown[] }
  assert.equal(saved2.fee, 600); assert.equal(saved2.months.length, 1)
  await maint.getByRole('group', { name: '月维护说明版本' }).getByRole('button', { name: '客户版' }).click()
  const mt = await maint.locator('.oj-qtext').evaluate(e => e.textContent ?? '')
  assert.match(mt, /每月 ¥600/); assert.doesNotMatch(mt, /小时/)
  pass('长期合作成交后：按每月投入给建议月费，记过月份后月费锁定，客户版不出现小时')
  if (shots) await maint.screenshot({ path: join(shots, 'maintenance.png') })

  assert.equal(await reply.getByRole('button').count(), 0)
  assert.match(await reply.innerText(), /同意/)
  pass('回复下拉在 320 至 1360 像素内与触发器对齐，7 个结果可选，履约后的同意只读')
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  server.closeAllConnections()
  await new Promise<void>(r => server.close(() => r()))
  db.close()
  await rm(root, { recursive: true, force: true })
}
console.log(`PASS ${checks} order-judge ui checks`)
