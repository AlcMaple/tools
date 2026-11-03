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
  let trackWrites = 0
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => {
    const url = new URL(request.url)
    if (request.method === 'PUT' && url.pathname.startsWith('/api/tracks/')) trackWrites++
    done({ cancel: url.origin !== origin })
  })
  const read = expression => window.webContents.executeJavaScript(expression)
  const waitFor = async expression => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (await read(expression)) return
      await delay(25)
    }
    throw new Error('MANUAL_ADD_DOM_TIMEOUT: ' + expression)
  }
  const click = expression => read(`(() => { const element = ${expression}; if (!element) throw new Error('MANUAL_ADD_TARGET_MISSING'); element.click() })()`)
  const namedButton = text => `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(text)})`
  const fill = value => read(`(() => { const input = document.querySelector('input[aria-label="自定义番名"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  const customSelected = () => read("Array.from(document.querySelectorAll('[role=tab]')).find(tab => tab.textContent.trim() === '自己记一条')?.getAttribute('aria-selected')")
  await window.loadURL(origin + '/__agent-test/login/empty')
  await waitFor("document.querySelector('main')?.textContent.includes('手帐还是空的')")
  await click(namedButton('加番'))
  await waitFor("document.querySelector('[role=dialog]')")
  await click("Array.from(document.querySelectorAll('[role=tab]')).find(tab => tab.textContent.trim() === '自己记一条')")
  await waitFor("document.querySelector('input[aria-label=\"自定义番名\"]')")
  await fill('手动回归一号')
  await click(namedButton('贴进手帐'))
  await waitFor("document.querySelector('main')?.textContent.includes('手动回归一号') && !document.querySelector('.custom-add-submit[disabled]')")
  assert.equal(await customSelected(), 'true', 'successful manual add must retain the selected input mode')
  await waitFor("document.activeElement === document.querySelector('input[aria-label=\"自定义番名\"]')")
  assert.equal(await read("document.querySelector('input[aria-label=\"自定义番名\"]').value"), '')
  console.log('PASS manual add: selected mode retained, submitted name cleared, focus ready for next record')
  const writesBeforeEmpty = trackWrites
  await click(namedButton('贴进手帐'))
  await waitFor("!document.querySelector('.custom-add-submit[disabled]')")
  assert.equal(trackWrites, writesBeforeEmpty, 'cleared title must not send another track write')
  assert.equal(await read("document.querySelector('[role=dialog] .form-note.err')?.textContent"), '先写个标题嘛……')
  console.log('PASS manual add: empty submission stays local without another write')
  await fill('手动回归二号')
  await click(namedButton('贴进手帐'))
  await waitFor("document.querySelector('main')?.textContent.includes('手动回归二号') && !document.querySelector('.custom-add-submit[disabled]')")
  assert.equal(await customSelected(), 'true')
  await waitFor("document.activeElement === document.querySelector('input[aria-label=\"自定义番名\"]')")
  assert.equal(trackWrites, 2)
  console.log('PASS manual add: two records use one manual-mode selection')
  await click("document.querySelector('[role=dialog] button[aria-label=\"关闭\"]')")
  await click(namedButton('加番'))
  await waitFor("document.querySelector('[role=dialog]')")
  assert.equal(await customSelected(), 'false', 'reopening must use the existing default search mode')
  await click("Array.from(document.querySelectorAll('[role=tab]')).find(tab => tab.textContent.trim() === '自己记一条')")
  assert.equal(await read("document.querySelector('input[aria-label=\"自定义番名\"]').value"), '')
  console.log('PASS manual add: reopening starts clean without leaking previous input')
  window.destroy()
}

main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1) })
