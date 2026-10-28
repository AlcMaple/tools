const assert = require('node:assert/strict')
const path = require('node:path')
const { mkdir } = require('node:fs/promises')
const { chromium } = require(process.env.JUDGE_BROWSER_MODULE)
const workerRoute = `**/archive/${require('libarchive.js/package.json').version}/worker-bundle.js`

async function main() {
  const origin = process.env.JUDGE_UI_ORIGIN, cookie = process.env.JUDGE_UI_COOKIE, fixtures = process.env.JUDGE_ARCHIVE_FIXTURES
  assert(origin && new URL(origin).hostname === '127.0.0.1' && cookie && fixtures)
  const browser = await chromium.launch({ headless: true, ...(process.env.JUDGE_CHROME_BIN ? { executablePath: process.env.JUDGE_CHROME_BIN } : {}) })
  let page
  try {
    const context = await browser.newContext({ viewport: { width: 1360, height: 980 } })
    const split = cookie.indexOf('=')
    await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: origin }])
    page = await context.newPage()
    const errors = [], requests = [], workers = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('worker', worker => { const item = { closed: false }; workers.push(item); worker.on('close', () => { item.closed = true }) })
    await page.route('**/api/order-judge/judge', async route => {
      const body = route.request().postDataJSON(); requests.push(body)
      // 仅关闭估价子任务，评估正文和附件仍通过真实服务端/历史接口。
      await route.continue({ postData: JSON.stringify({ ...body, estimate: false }) })
    })
    const open = async () => {
      await page.goto(origin + '/#/judge')
      await page.reload()
      await page.getByRole('heading', { name: '接单评估', exact: true }).waitFor()
      await page.waitForFunction(() => !document.querySelector('.oj-go')?.disabled)
    }
    const send = async file => {
      await page.locator('input[type=file]').first().setInputFiles(file)
      assert.equal(await page.locator('.oj-file.bad').count(), 0)
      await page.locator('.oj-go').click()
    }
    await open()
    const help = page.locator('.oj-how')
    assert.equal(await help.locator('dt').filter({ hasText: '登录页、小程序' }).count(), 1)
    assert.equal(await help.getByText('请提供截图、长图或录屏。', { exact: true }).count(), 1)
    assert.match(await help.innerText(), /截图。聊天记录请展开后截图。/)
    assert.match(await help.innerText(), /不识别声音/)
    console.log('PASS B: 材料说明合并登录页与小程序，明确截图/长图/录屏，并保留视频无声音提示')
    if (process.env.JUDGE_SCREENSHOT_DIR) {
      await mkdir(process.env.JUDGE_SCREENSHOT_DIR, { recursive: true })
      await help.screenshot({ path: path.join(process.env.JUDGE_SCREENSHOT_DIR, 'materials-help-desktop.png') })
    }
    assert.match(await page.locator('input[type=file]').first().getAttribute('accept'), /\.zip,\.rar/)
    const response = await page.request.get(origin)
    const csp = response.headers()['content-security-policy']
    assert(csp.includes("'wasm-unsafe-eval'")); assert(!csp.includes("'unsafe-eval'"))
    assert.match(await response.text(), /wasm-unsafe-eval/)
    await send(path.join(fixtures, 'materials.zip'))
    await page.getByText('压缩包回归通过', { exact: true }).first().waitFor({ timeout: 40_000 })
    assert.match(requests[0].text, /客户已有小程序/); assert.match(requests[0].text, /DOCX_REQUIREMENT/)
    assert(!requests[0].text.includes('IGNORE_ME')); assert(!requests[0].text.includes('NESTED_NOT_READ'))
    assert.equal(requests[0].images.length, 1); assert.equal(requests[0].files.length, 1)
    console.log('PASS B1: 生产 CSP 下真实 ZIP 中文目录/TXT/DOCX/图片进入评估；嵌套包与程序明确跳过')
    if (process.env.JUDGE_SCREENSHOT_DIR) {
      await mkdir(process.env.JUDGE_SCREENSHOT_DIR, { recursive: true })
      await page.screenshot({ path: path.join(process.env.JUDGE_SCREENSHOT_DIR, 'archive-success.png'), fullPage: true })
    }
    await open()
    await send(path.resolve('scripts/fixtures/order-judge-archives/rar4-small.rar'))
    await page.getByText('压缩包回归通过', { exact: true }).first().waitFor({ timeout: 40_000 })
    assert.match(requests.at(-1).text, /RAR4_FIXTURE/)
    console.log('PASS B2: 真实 RAR4 成功读取并评估')
    await open()
    await send(path.resolve('scripts/fixtures/order-judge-archives/rar5-unicode.rar'))
    await page.getByText('压缩包回归通过', { exact: true }).first().waitFor({ timeout: 40_000 })
    assert.match(requests.at(-1).text, /Hello, world!/)
    console.log('PASS B3: 真实 RAR5 Unicode 文件名成功读取并评估')
    for (const [file, message] of [
      [path.join(fixtures, 'empty.zip'), '没有可读取'],
      [path.join(fixtures, 'corrupt.rar'), '损坏'],
      [path.join(fixtures, 'huge.zip'), '16 MB'],
      [path.join(fixtures, 'traversal.zip'), '路径异常'],
      [path.resolve('scripts/fixtures/order-judge-archives/encrypted.rar'), '加密'],
      [path.resolve('scripts/fixtures/order-judge-archives/rar5.rar'), '没有可读取'],
      [path.resolve('scripts/fixtures/order-judge-archives/rar4.rar'), '20 万字'],
    ]) {
      await open(); const count = requests.length
      await send(file)
      await page.getByText(new RegExp(message)).first().waitFor({ timeout: 40_000 })
      assert.equal(requests.length, count)
      console.log(`PASS B: ${path.basename(file)} 展示具体原因，未提交空材料评估`)
    }
    await open()
    let release
    const gate = new Promise(resolve => { release = resolve })
    await page.route(workerRoute, async route => { await gate; await route.continue().catch(() => {}) })
    const count = requests.length
    await send(path.join(fixtures, 'materials.zip'))
    await page.getByRole('button', { name: '取消评估', exact: true }).click()
    release()
    await page.unroute(workerRoute)
    assert.equal(requests.length, count)
    await page.waitForFunction(() => !document.querySelector('.oj-go')?.disabled)
    assert.equal(await page.locator('.oj-file').count(), 1)
    console.log('PASS B: 解包期间取消保留附件，终止 Worker，不提交评估')
    await page.setViewportSize({ width: 390, height: 844 })
    await open()
    assert.match(await help.innerText(), /点「粘贴」添加截图。聊天记录请展开后截图。/)
    if (process.env.JUDGE_SCREENSHOT_DIR) await help.screenshot({ path: path.join(process.env.JUDGE_SCREENSHOT_DIR, 'materials-help-mobile.png') })
    await send(path.join(fixtures, 'materials.zip'))
    await page.getByText('压缩包回归通过', { exact: true }).first().waitFor({ timeout: 40_000 })
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1)
    if (process.env.JUDGE_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.JUDGE_SCREENSHOT_DIR, 'archive-mobile.png'), fullPage: true })
    console.log('PASS B: 手机宽度 ZIP 评估成功，无水平溢出')
    await page.close()
    assert(workers.length >= 5); assert(workers.every(worker => worker.closed))
    assert.deepEqual(errors, [])
    console.log(`PASS B: ${workers.length} 个解包 Worker 全部终止，页面无运行时异常`)
  } catch (error) {
    if (page) {
      console.error('BROWSER_STATE', (await page.locator('body').innerText()).slice(-7000))
      console.error('OVERFLOW', await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => ({ tag: el.tagName, cls: el.className, right: el.getBoundingClientRect().right, text: el.textContent.slice(0, 100) })).slice(0, 25)))
      if (process.env.JUDGE_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.JUDGE_SCREENSHOT_DIR, 'failure.png'), fullPage: true })
    }
    throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
