const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const { app, BrowserWindow } = require('electron')
const origin = process.argv[2]
assert(origin && new URL(origin).hostname === 'agent-phase4.localhost')
app.setPath('userData', process.argv[3])
app.commandLine.appendSwitch('disable-gpu')
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1360, height: 980, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => done({ cancel: new URL(request.url).origin !== origin }))
  const read = expression => window.webContents.executeJavaScript(expression)
  const waitFor = async expression => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (await read(expression)) return
      await delay(25)
    }
    throw new Error('CATALOG_SEARCH_YEAR_DOM_TIMEOUT: ' + expression)
  }
  const click = expression => read('(() => { const element = ' + expression + '; if (!element) throw new Error("CATALOG_SEARCH_YEAR_TARGET_MISSING"); element.click() })()')
  const namedButton = text => 'Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === ' + JSON.stringify(text) + ')'
  const fill = value => read('(() => { const input = document.querySelector("input[aria-label=\\"搜索全部番剧\\"]"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,' + JSON.stringify(value) + '); input.dispatchEvent(new Event("input",{bubbles:true})) })()')
  const selectYear = async label => {
    await click('document.querySelector(".catalog-year button")')
    await click(namedButton(label))
  }
  const count = () => read('document.querySelector(".catalog-grid").children.length')
  await window.loadURL(origin + '/')
  await waitFor('document.querySelector("main h1")?.textContent === "番剧周历"')
  await click('document.querySelector("a[href=\\"/#/anime\\"]")')
  await waitFor('document.querySelector(".catalog-grid")?.children.length === 5')
  await click(namedButton('最新'))
  await fill('芙莉莲')
  await waitFor('document.querySelector(".catalog-page .sketch-hero p")?.textContent.includes("搜到 5 部")')
  await selectYear('2023 年')
  await waitFor('document.querySelector(".catalog-page .sketch-hero p")?.textContent.includes("搜到 2 部")')
  assert.equal(await count(), 2)
  assert.equal(await read('document.querySelector(".catalog-grid").textContent.includes("2026 年")'), false)
  console.log('PASS catalog page: keyword plus selected 2023 shows two matching entries')
  await click('document.querySelector("a[href=\\"/#/\\"]")')
  await waitFor('document.querySelector("main h1")?.textContent === "番剧周历"')
  await click('document.querySelector("a[href=\\"/#/anime\\"]")')
  await waitFor('document.querySelector(".catalog-grid")?.children.length === 2')
  assert.equal(await read('document.querySelector("input[aria-label=\\"搜索全部番剧\\"]").value'), '芙莉莲')
  assert((await read('document.querySelector(".catalog-year").textContent')).includes('2023'))
  assert.equal(await read(namedButton('最新') + '.getAttribute("aria-pressed")'), 'true')
  console.log('PASS catalog page: query, year, remembered sort and filtered result survive navigation')
  await selectYear('2025 年')
  await waitFor('document.querySelector(".catalog-page .sketch-hero p")?.textContent.includes("搜到 1 部")')
  assert.equal(await count(), 1)
  await selectYear('1999 年')
  await waitFor('document.querySelector(\".catalog-page .page-state\")?.textContent.includes(\"没有找到 1999 年的「芙莉莲」\")')
  console.log('PASS catalog page: empty year names the active year rather than blaming the keyword')
  await selectYear('全部年份')
  await waitFor('document.querySelector(".catalog-page .sketch-hero p")?.textContent.includes("搜到 5 部")')
  assert.equal(await count(), 5)
  await selectYear('2023 年')
  await waitFor('document.querySelector(".catalog-page .sketch-hero p")?.textContent.includes("搜到 2 部")')
  await click('document.querySelector("button[aria-label=\\"清空搜索\\"]")')
  await waitFor('document.querySelector(".catalog-page .sketch-hero p")?.textContent.includes("共 2 部")')
  assert.equal(await count(), 2)
  console.log('PASS catalog page: changing year, all-years restore and clearing query preserve intended filters')
  console.log('CATALOG_SEARCH_YEAR_BROWSER_COMPLETE')
  window.destroy()
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1) })
