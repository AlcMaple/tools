const assert = require('node:assert/strict')
const { mkdir } = require('node:fs/promises')
const path = require('node:path')

async function main() {
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
main().catch(error => { console.error(error); process.exitCode = 1 })
