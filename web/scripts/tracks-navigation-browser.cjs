const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const { app, BrowserWindow } = require('electron')

const origin = process.argv[2]
assert(origin && new URL(origin).hostname === 'agent-phase4.localhost')
app.setPath('userData', process.argv[3])
app.commandLine.appendSwitch('disable-gpu')

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1360, height: 980, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => {
    done({ cancel: new URL(request.url).origin !== origin })
  })
  const read = expression => window.webContents.executeJavaScript(expression)
  const waitFor = async expression => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (await read(expression)) return
      await delay(25)
    }
    throw new Error('TRACKS_NAVIGATION_DOM_TIMEOUT: ' + expression)
  }
  const click = expression => read(`(() => { const target = ${expression}; if (!target) throw new Error('TRACKS_NAVIGATION_TARGET_MISSING'); target.click() })()`)
  const selected = () => read("document.querySelector('.tabf.on')?.textContent.trim() ?? ''")
  const cards = () => read("document.querySelectorAll('main article').length")
  const query = () => read("document.querySelector('#trkSearch')?.value ?? ''")
  const fillQuery = value => read(`(() => { const input = document.querySelector('#trkSearch'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await window.loadURL(origin + '/__agent-test/login/alice')
  await waitFor("document.querySelectorAll('main article').length === 3")

  const searchGeometry = () => read(`(() => {
    const input = document.querySelector('#trkSearch')
    const field = input.parentElement
    const clear = field.querySelector('.search-clear')
    const bounds = el => {
      if (!el) return null
      const { left, right, top, width } = el.getBoundingClientRect()
      return { left, right, top, width }
    }
    return { field: bounds(field), input: bounds(input), clear: bounds(clear), next: bounds(field.nextElementSibling) }
  })()`)
  const longQuery = '魔法少女什么的已经够了啦'.repeat(6)
  // 筛选过后可能没有卡片；固定页面滚动槽只为测输入框本身有没有跳动。
  await read("document.body.style.minHeight = '200vh'")
  await read('document.fonts.ready.then(() => true)')
  for (const width of [1360, 961, 390]) {
    window.setContentSize(width, 980)
    await waitFor(`innerWidth === ${width} && !!document.querySelector('#trkSearch') &&
      Boolean(document.querySelector('.sketch-hero #trkSearch')) === ${width >= 961}`)
    const empty = await searchGeometry()
    await read("document.querySelector('#trkSearch').focus()")
    await window.webContents.insertText(longQuery)
    await waitFor(`document.querySelector('#trkSearch').value === ${JSON.stringify(longQuery)} &&
      !!document.querySelector('.search-clear')`)
    const filled = await searchGeometry()
    const clipEdge = filled.input.right
    const clearEdge = filled.clear.left
    console.log(`SEARCH_CLEAR_LAYOUT ${width}px: inputRight=${clipEdge}, clearLeft=${clearEdge}`)
    assert(clipEdge <= clearEdge, 'long input and clear button must occupy separate areas')
    assert(filled.input.width > 0 && filled.clear.right <= filled.field.right)
    assert.deepEqual(filled.field, empty.field, 'typing must not resize the search field')
    assert.deepEqual(filled.input, empty.input, 'the clear button slot must be reserved when empty')
    assert.deepEqual(filled.next, empty.next, 'typing must not move the neighboring filter')
    await waitFor("document.querySelector('#trkSearch').scrollLeft > 0")
    await read("document.querySelector('#trkSearch').scrollLeft = 0")
    assert.equal(await read("document.querySelector('#trkSearch').scrollLeft"), 0)
    assert.deepEqual((await searchGeometry()).clear, filled.clear, 'only the text may scroll')
    assert.equal(await query(), longQuery, 'scrolling must not truncate the query')
    await click("document.querySelector('#trkSearch + .search-clear')")
    await waitFor("document.querySelector('#trkSearch').value === '' && document.querySelectorAll('main article').length === 3")
  }
  await read("document.body.style.minHeight = ''")
  window.setContentSize(1360, 980)
  await waitFor("innerWidth === 1360 && !!document.querySelector('.sketch-hero #trkSearch')")
  console.log('PASS tracks search: fixed clear slot, horizontal text scroll and reset at 1360/961/390px')

  await click("Array.from(document.querySelectorAll('button.tabf')).find(button => button.textContent.trim().startsWith('在看'))")
  await waitFor("document.querySelector('.tabf.on')?.textContent.trim().startsWith('在看') && document.querySelectorAll('main article').length === 1")
  assert((await selected()).startsWith('在看'))
  assert.equal(await cards(), 1)
  await fillQuery('芙莉莲')
  await waitFor("document.querySelector('#trkSearch')?.value === '芙莉莲'")
  assert.equal(await query(), '芙莉莲')
  await click("document.querySelector('a[href=\"/#/\"]')")
  await waitFor("document.querySelector('main h1')?.textContent === '番剧周历'")
  await click("document.querySelector('a[href=\"/#/tracks\"]')")
  await waitFor("document.querySelector('main h1')?.textContent === '我的追番' && document.querySelectorAll('main article').length > 0")
  assert((await selected()).startsWith('在看'), 'returning to tracks must keep the selected watching filter')
  assert.equal(await cards(), 1, 'returning to tracks must not expand back to all three records')
  assert.equal(await query(), '芙莉莲', 'returning to tracks must keep the entered search query')
  console.log('PASS tracks navigation: watching filter, search query and one-card list survive calendar round trip')
  await click("Array.from(document.querySelectorAll('button.tabf')).find(button => button.textContent.trim().startsWith('全部'))")
  await waitFor("document.querySelector('.tabf.on')?.textContent.trim().startsWith('全部') && document.querySelectorAll('main article').length === 1")
  assert.equal(await cards(), 1, 'changing status must not clear the active search')
  await click("document.querySelector('button[aria-label=\"清空搜索\"]')")
  await waitFor("document.querySelector('#trkSearch')?.value === '' && document.querySelectorAll('main article').length === 3")
  assert.equal(await query(), '')
  assert.equal(await cards(), 3, 'clear search must restore the full list')
  console.log('PASS tracks navigation: clear search restores all three records')
  await click("Array.from(document.querySelectorAll('button.tabf')).find(button => button.textContent.trim().startsWith('在看'))")
  await fillQuery('芙莉莲')
  await waitFor("document.querySelector('#trkSearch')?.value === '芙莉莲' && document.querySelectorAll('main article').length === 1")
  const otherTab = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  await otherTab.loadURL(origin + '/__agent-test/login/bob')
  await waitFor("document.querySelector('main')?.textContent.includes('另一位用户的条目') && document.querySelectorAll('main article').length === 1")
  assert((await selected()).startsWith('全部'), 'account switch must select the new owner context')
  assert.equal(await query(), '', 'account switch must clear the previous query')
  await otherTab.loadURL(origin + '/__agent-test/login/alice')
  await waitFor("document.querySelectorAll('main article').length === 3")
  assert((await selected()).startsWith('全部'))
  assert.equal(await query(), '', 'switching back must not revive the previous owner context')
  otherTab.destroy()
  console.log('PASS tracks navigation: cross-tab owner changes start with empty context in the original page')
  await click("Array.from(document.querySelectorAll('button.tabf')).find(button => button.textContent.trim().startsWith('在看'))")
  await fillQuery('芙莉莲')
  await waitFor("document.querySelector('#trkSearch')?.value === '芙莉莲' && document.querySelectorAll('main article').length === 1")
  await click("Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '退出登录')")
  await waitFor("Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === '登录 / 注册')")
  await click("document.querySelector('a[href=\"/#/tracks\"]')")
  await waitFor("document.querySelector('main h1')?.textContent === '我的追番'")
  await waitFor("document.querySelector('.tabf.on')?.textContent.trim().startsWith('全部') && document.querySelector('#trkSearch')?.value === '' && document.querySelectorAll('main article').length === 0")
  assert((await selected()).startsWith('全部'), 'logout must clear the previous account filter')
  assert.equal(await cards(), 0)
  assert.equal(await query(), '', 'logout must clear the previous account search query')
  console.log('PASS tracks navigation: logout resets the previous account filter and query')
  console.log('TRACKS_NAVIGATION_CASES=5')
  window.destroy()
}

main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1) })
