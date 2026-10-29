const assert = require('node:assert/strict')
const { mkdir } = require('node:fs/promises')
const path = require('node:path')

async function main() {
  if (process.argv.includes('--delete-history')) return testDeleteHistory()
  const origin = process.env.JUDGE_UI_ORIGIN, cookie = process.env.JUDGE_UI_COOKIE
  assert(origin && new URL(origin).hostname === '127.0.0.1' && cookie)
  assert(process.env.JUDGE_BROWSER_MODULE, 'Set JUDGE_BROWSER_MODULE to an existing Playwright module')
  const { chromium } = require(process.env.JUDGE_BROWSER_MODULE)
  const browser = await chromium.launch({ headless: true, ...(process.env.JUDGE_CHROME_BIN ? { executablePath: process.env.JUDGE_CHROME_BIN } : {}) })
  try {
    const desktop = await browser.newContext({ viewport: { width: 1360, height: 980 } })
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
    const split = cookie.indexOf('=')
    for (const context of [desktop, mobile]) await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: origin, httpOnly: true, sameSite: 'Strict' }])
    const pc = await desktop.newPage(), phone = await mobile.newPage()
    const pageErrors = []
    pc.on('pageerror', error => pageErrors.push(error.message)); phone.on('pageerror', error => pageErrors.push(error.message))
    await Promise.all([pc.goto(origin + '/#/judge'), phone.goto(origin + '/#/judge')])
    for (const page of [pc, phone]) {
      await page.getByRole('heading', { name: '接单评估', exact: true }).waitFor()
      await page.getByRole('button', { name: '评估设置', exact: true }).click()
      await page.getByText('能力档案', { exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: '处理冲突', exact: true }).count(), 0)
    }
    const screenshots = process.env.JUDGE_SCREENSHOT_DIR
    if (screenshots) { await mkdir(screenshots, { recursive: true }); await pc.screenshot({ path: path.join(screenshots, 'desktop-settings.png'), fullPage: true }) }
    await pc.getByRole('button', { name: '完成', exact: true }).click()
    console.log('PASS UI1: 电脑与手机尺寸的评估设置里只有两份资料，没有冲突处理入口')
    await phone.getByRole('button', { name: '完成', exact: true }).click()
    await phone.getByPlaceholder('把派单的文字、网址贴在这里').fill('browser phone fixture')
    await phone.locator('.oj-go').click()
    await phone.getByText('共享评估夹具', { exact: true }).first().waitFor({ timeout: 20_000 })
    assert(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    if (screenshots) await phone.screenshot({ path: path.join(screenshots, 'phone-judged.png'), fullPage: true })
    assert.deepEqual(pageErrors, [])
    console.log('PASS UI2: 真实手机尺寸网页评估完成，无水平溢出、无页面异常')
  } finally { await browser.close() }
}

async function testDeleteHistory() {
  assert(process.env.JUDGE_BROWSER_MODULE, 'Set JUDGE_BROWSER_MODULE to an existing Playwright module')
  const { chromium } = require(process.env.JUDGE_BROWSER_MODULE)
  const { Hono } = require('hono')
  const { serve } = require('@hono/node-server')
  const { serveStatic } = require('@hono/node-server/serve-static')
  const app = new Hono()
  app.use('/*', serveStatic({ root: path.resolve(__dirname, '../dist') }))
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.on('listening', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  let browser
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.JUDGE_CHROME_BIN ? { executablePath: process.env.JUDGE_CHROME_BIN } : {}) })
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1360, height: 980 }, isMobile: mobile, hasTouch: mobile })
      const page = await context.newPage(), deletes = [], errors = [], logs = []
      const original = ['第一条评估', '第二条评估', '很长的评估标题'.repeat(15)].map((title, index) => ({
        id: `00000000-0000-4000-8000-00000000000${index + 1}`, at: 1793160000000 - index,
        order: 'fixture', images: [], files: [], report: { verdict: '能', title, headline: title, summary: '回归材料', reasons: [], gaps: [], questions: [] },
      }))
      let history = [...original], seq = 1, failNext = false, gate = null, release = () => {}, openingDelete = null
      page.on('pageerror', error => errors.push(error.message))
      await page.route('**/api/**', async route => {
        const request = route.request(), pathname = new URL(request.url()).pathname
        const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
        if (pathname === '/api/auth/me') return reply({ id: 1, username: 'fixture', createdAt: '', bgmUid: '', hasSecurity: true, aiConfig: {} })
        if (pathname === '/api/order-judge') return reply({ docs: { profile: null, log: null }, paths: { profile: [], log: [] }, history, seq })
        if (pathname === '/api/order-judge/sync/events') return
        if (pathname === '/api/agent/provider') return reply({ enabled: true, ready: true, source: 'server', model: 'fixture' })
        if (pathname === '/api/order-judge/log') { logs.push(request.postDataJSON()); return reply({ ok: true }) }
        if (request.method() === 'DELETE' && pathname.startsWith('/api/order-judge/history/')) {
          const id = pathname.split('/').at(-1); deletes.push(id); openingDelete?.()
          if (gate) await gate
          if (failNext) { failNext = false; return reply({ code: 'FIXTURE_BUSY', error: '维护中，请稍后手动重试' }, 503) }
          history = history.filter(entry => entry.id !== id); seq++
          return reply({ ok: true })
        }
        return reply({ data: [], enabled: false, unread: 0 })
      })
      await page.goto(origin + '/#/judge')
      await page.getByRole('heading', { name: '接单评估', exact: true }).waitFor()
      if (mobile) {
        await page.locator('.oj-mode .dd-trigger').click()
        await page.locator('.dd-item').filter({ hasText: '历史' }).click()
      } else await page.getByRole('button', { name: /^历史/ }).click()
      await page.locator('.oj-row').nth(2).waitFor()
      const row = title => page.locator('.oj-row').filter({ hasText: title })
      const target = row('第二条评估').getByRole('button', { name: '删除这条', exact: true })
      const dialog = page.getByRole('alertdialog', { name: '删除评估记录' })
      const open = async () => {
        const unexpectedDelete = new Promise(resolve => { openingDelete = () => resolve('deleted') })
        try {
          const outcome = await Promise.race([(async () => { await target.click(); await dialog.waitFor(); return 'dialog' })(), unexpectedDelete])
          assert.equal(outcome, 'dialog', 'Trash click sent DELETE before confirmation')
        } finally { openingDelete = null }
      }
      if (process.env.JUDGE_EXPECT_DIRECT_DELETE === '1') {
        await target.click()
        await page.waitForFunction(() => document.querySelectorAll('.oj-row').length === 2)
        assert.deepEqual(deletes, [original[1].id]); assert.equal(await dialog.count(), 0)
        console.log('PASS baseline: trash click sends DELETE immediately without confirmation')
        await context.close(); break
      }
      await open()
      assert.deepEqual(deletes, []); assert.equal(history.length, 3)
      assert.match(await dialog.innerText(), /第二条评估/)
      assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).evaluate(el => el === document.activeElement), true)
      await page.keyboard.press('Tab')
      assert.equal(await dialog.getByRole('button', { name: '确认删除', exact: true }).evaluate(el => el === document.activeElement), true)
      await page.keyboard.press('Tab')
      assert(await dialog.evaluate(el => el.contains(document.activeElement)))
      if (process.env.JUDGE_SCREENSHOT_DIR) {
        await mkdir(process.env.JUDGE_SCREENSHOT_DIR, { recursive: true })
        await page.screenshot({ path: path.join(process.env.JUDGE_SCREENSHOT_DIR, mobile ? 'delete-mobile.png' : 'delete-desktop.png') })
      }
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      assert.equal(await target.evaluate(el => el === document.activeElement), true)
      for (const dismiss of ['Escape', 'Enter', 'close', 'backdrop']) {
        await open()
        if (dismiss === 'close') await dialog.getByRole('button', { name: '关闭', exact: true }).click()
        else if (dismiss === 'backdrop') await page.mouse.click(4, 4)
        else await page.keyboard.press(dismiss)
        await dialog.waitFor({ state: 'detached' })
        assert.equal(deletes.length, 0); assert.equal(history.length, 3)
      }
      console.log(`PASS ${mobile ? 'mobile' : 'desktop'}: trash only opens a named dialog; cancel/Escape/default Enter/close/backdrop send no DELETE`)
      await open(); failNext = true
      const before = await dialog.getByRole('button', { name: '取消', exact: true }).boundingBox()
      await dialog.getByRole('button', { name: '确认删除', exact: true }).click()
      await dialog.getByRole('alert').filter({ hasText: '维护中，请稍后手动重试' }).waitFor()
      const after = await dialog.getByRole('button', { name: '取消', exact: true }).boundingBox()
      assert(Math.abs(before.y - after.y) < 1)
      assert.equal(history.length, 3); assert.equal(await page.locator('.oj-row').count(), 3); assert.equal(deletes.length, 1)
      await page.waitForFunction(() => !document.querySelector('.oj-delete-dialog .btn-danger').disabled)
      assert(logs.some(log => log.tag === 'order-judge:delete' && log.detail.includes('维护中')))
      gate = new Promise(resolve => { release = resolve })
      await dialog.getByRole('button', { name: '确认删除', exact: true }).evaluate(el => { el.click(); el.click() })
      await dialog.getByRole('button', { name: '删除中…', exact: true }).waitFor()
      assert.equal(deletes.length, 2); assert.equal(history.length, 3)
      await page.keyboard.press('Escape'); await page.mouse.click(4, 4)
      assert.equal(await dialog.count(), 1)
      release(); gate = null
      await dialog.waitFor({ state: 'detached' })
      assert.deepEqual(deletes, [original[1].id, original[1].id]); assert.equal(history.length, 2)
      assert.equal(await row('第二条评估').count(), 0); assert.equal(await row('第一条评估').count(), 1)
      console.log(`PASS ${mobile ? 'mobile' : 'desktop'}: failed deletion keeps data and reason; explicit retry sends once, deletes only the confirmed ID`)
      await row(original[2].report.title).getByRole('button', { name: '删除这条', exact: true }).click()
      await dialog.waitFor()
      await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1)
      const bounds = await dialog.boundingBox()
      assert(bounds.x >= 0 && bounds.x + bounds.width <= (mobile ? 390 : 1360))
      await dialog.getByRole('button', { name: '确认删除', exact: true }).click(); await dialog.waitFor({ state: 'detached' })
      await row('第一条评估').getByRole('button', { name: '删除这条', exact: true }).click()
      await dialog.getByRole('button', { name: '确认删除', exact: true }).click(); await dialog.waitFor({ state: 'detached' })
      await page.getByText('还没有评估过的派单', { exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: '评估设置', exact: true }).evaluate(el => el === document.activeElement), true)
      assert.equal(history.length, 0); assert.equal(deletes.length, 4); assert.deepEqual(errors, [])
      console.log(`PASS ${mobile ? 'mobile' : 'desktop'}: long titles stay within viewport; final confirmed deletion shows empty history`)
      await context.close()
    }
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
