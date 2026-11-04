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
  const scenes = [
    { name: 'desktop horizontal', width: 1360, height: 980, layout: '横向', scroll: true },
    { name: 'desktop vertical', width: 1360, height: 980, layout: '纵向', scroll: true },
    { name: 'narrow vertical', width: 390, height: 844, layout: '纵向', scroll: true },
    { name: 'narrow horizontal', width: 390, height: 844, layout: '横向', scroll: false },
  ]
  const window = new BrowserWindow({ show: false, useContentSize: true, width: 1360, height: 980, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  let completed = 0
  for (const scene of scenes) {
    window.setContentSize(scene.width, scene.height)
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
      throw new Error('CALENDAR_TODAY_DOM_TIMEOUT: ' + expression)
    }
    const click = expression => read(`(() => { const button = ${expression}; if (!button) throw new Error('CALENDAR_TODAY_BUTTON_MISSING'); button.click() })()`)
    const button = text => `Array.from(document.querySelectorAll('button')).find(element => element.textContent.trim() === ${JSON.stringify(text)} || element.getAttribute('aria-label') === ${JSON.stringify(text)})`
    const settleScroll = async () => {
      let last = NaN, stable = 0
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const next = await read('window.scrollY')
        stable = Math.abs(next - last) < 0.25 ? stable + 1 : 0
        last = next
        if (stable >= 6) return
        await delay(40)
      }
      throw new Error('CALENDAR_TODAY_SCROLL_NOT_SETTLED')
    }
    await window.loadURL(origin + '/')
    await waitFor("document.querySelector('.day-head') && document.querySelector('.calendar-search input')")
    await click(button(scene.layout))
    if (scene.scroll) {
      await waitFor("document.querySelectorAll('.day-sec').length === 7")
      await click(button('回到今天'))
      await settleScroll()
      const geometry = await read(`(() => {
        const id = new Date().getDay() || 7
        const heading = document.querySelector('#day-sec-' + id + ' .day-head')
        const topbar = Array.from(document.querySelectorAll('.spine,.m-top')).find(element => element.getBoundingClientRect().height > 0)
        const rect = heading.getBoundingClientRect()
        return { text: heading.textContent, top: rect.top, bottom: rect.bottom, barBottom: topbar.getBoundingClientRect().bottom, viewportHeight: innerHeight, viewportWidth: innerWidth, scrollY }
      })()`)
      console.log('GEOMETRY ' + scene.name + ' ' + JSON.stringify(geometry))
      assert(geometry.text.includes('今天'), scene.name + ': must reach today')
      assert(geometry.top >= geometry.barBottom + 1, scene.name + ': today heading must stay below the sticky topbar')
      assert(geometry.bottom < geometry.viewportHeight, scene.name + ': full today heading must remain in the viewport')
      await click(button('回到页头'))
      await settleScroll()
      assert((await read('window.scrollY')) < 1, scene.name + ': return-to-top must still work')
      console.log('PASS calendar today: ' + scene.name + ' date visible and return-to-top preserved')
    } else {
      await waitFor("document.querySelectorAll('.dstamp').length === 7")
      await click("document.querySelector('.dstamp:not(.today)')")
      assert.equal(await read("document.querySelector('.dstamp.on').classList.contains('today')"), false)
      await click(button('回到今天'))
      assert.equal(await read("document.querySelector('.dstamp.on').classList.contains('today')"), true)
      console.log('PASS calendar today: narrow horizontal date selection preserved')
    }
    completed++
  }
  assert.equal(completed, scenes.length)
  console.log('CALENDAR_TODAY_CASES_COMPLETE=' + completed)
  window.destroy()
}

main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1) })
