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
  await window.loadURL(origin + '/__agent-test/login/alice')
  await waitFor("document.querySelectorAll('main article').length === 3")
  await click("Array.from(document.querySelectorAll('button.tabf')).find(button => button.textContent.trim().startsWith('在看'))")
  assert((await selected()).startsWith('在看'))
  assert.equal(await cards(), 1)
  await click("document.querySelector('a[href=\"/#/\"]')")
  await waitFor("document.querySelector('main h1')?.textContent === '番剧周历'")
  await click("document.querySelector('a[href=\"/#/tracks\"]')")
  await waitFor("document.querySelector('main h1')?.textContent === '我的追番' && document.querySelectorAll('main article').length > 0")
  assert((await selected()).startsWith('在看'), 'returning to tracks must keep the selected watching filter')
  assert.equal(await cards(), 1, 'returning to tracks must not expand back to all three records')
  console.log('PASS tracks navigation: watching filter and one-card list survive calendar round trip')
  await click("Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '退出登录')")
  await waitFor("Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === '登录 / 注册')")
  await click("document.querySelector('a[href=\"/#/tracks\"]')")
  await waitFor("document.querySelector('main h1')?.textContent === '我的追番'")
  assert((await selected()).startsWith('全部'), 'logout must clear the previous account filter')
  assert.equal(await cards(), 0)
  console.log('PASS tracks navigation: logout resets the previous account filter')
  window.destroy()
}

main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1) })
