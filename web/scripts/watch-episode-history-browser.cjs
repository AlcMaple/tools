const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const { app, BrowserWindow } = require('electron')
const origin = process.argv[2]
assert(origin && new URL(origin).hostname === 'agent-phase4.localhost')
app.setPath('userData', process.argv[3])
app.commandLine.appendSwitch('disable-gpu')
app.on('window-all-closed', () => {})
const historyKey = 'mapletools-watch-episodes-v1'
function configure(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false, width: 1360, height: 980, webPreferences: { contextIsolation: true, nodeIntegration: false } } }))
  window.webContents.on('did-create-window', child => configure(child))
  return window
}
function driver(window) {
  const read = source => window.webContents.executeJavaScript(source)
  const wait = async source => { const deadline = Date.now() + 12_000; while (Date.now() < deadline) { if (await read(source)) return; await delay(25) } throw new Error('WATCH_EPISODE_WAIT: ' + source) }
  const click = source => read(`(() => {const e=${source};if(!e)throw new Error('WATCH_EPISODE_TARGET');e.click()})()`)
  const article = "Array.from(document.querySelectorAll('main article')).find(a=>a.textContent.includes('葬送的芙莉莲'))"
  const continueButton = `Array.from((${article}).querySelectorAll('button')).find(b=>b.textContent.trim()==='继续看')`
  return { read, wait, click, continueButton, article }
}
async function chooseSource(window, d) {
  const opened = new Promise(resolve => window.webContents.once('did-create-window', resolve))
  await d.click("Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent.trim()==='在纱雾这儿看')")
  return opened
}
async function ready(window) {
  const d=driver(window)
  await d.wait("!!document.querySelector('video') && document.querySelector('video').readyState>=2 && document.querySelector('video').duration>0")
  return d
}
async function main() {
  await app.whenReady()
  const mainWindow = configure(new BrowserWindow({ show: false, width: 1360, height: 980, webPreferences: { contextIsolation: true, nodeIntegration: false } }))
  mainWindow.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (request, done) => done({cancel:new URL(request.url).origin!==origin}))
  await mainWindow.loadURL(origin+'/__agent-test/login/alice')
  const home=driver(mainWindow)
  await home.wait("document.querySelectorAll('main article').length===3")
  await home.click(home.continueButton)
  await home.wait("!!document.querySelector('[role=dialog] h3')")
  const player=await chooseSource(mainWindow,home)
  const p=await ready(player)
  assert(await p.read("document.querySelector('video').paused"), 'first load stays paused')
  await p.click("Array.from(document.querySelectorAll('#eps button')).find(b=>b.textContent.trim()==='2')")
  await p.wait("document.title.endsWith('EP2') && !!document.querySelector('video') && document.querySelector('video').readyState>=2")
  assert(await p.read("document.querySelector('video').paused"), 'selecting an episode does not autoplay')
  assert.equal(await p.read(`localStorage.getItem(${JSON.stringify(historyKey)})`), null, 'selecting without playing must not create watch history')
  await p.click("document.querySelector('.art-icon-play')")
  await p.wait("document.querySelector('video').currentTime>.2 && !document.querySelector('video').paused")
  assert(await p.read("!document.querySelector('#buf').classList.contains('show')"), 'first playing must not show rebuffer UI')
  await p.wait("document.querySelector('video').currentTime>=5.5")
  await p.click("document.querySelector('.art-icon-pause')")
  const savedTime=await p.read("document.querySelector('video').currentTime")
  const reloaded=new Promise(resolve=>player.webContents.once('did-finish-load',resolve))
  player.webContents.reload()
  await reloaded
  await ready(player)
  await p.wait("document.querySelector('video').paused && document.querySelector('video').currentTime>="+(savedTime-.5))
  await p.click("document.querySelector('a[href=\"/#/tracks\"]')")
  await p.wait("document.querySelectorAll('main article').length===3")
  assert(await p.read(`(${p.article}).textContent.includes('1 / 28')`), 'playback must not mark EP2 as watched')
  await p.click(p.continueButton)
  await p.wait("!!document.querySelector('[role=dialog] h3')")
  const selected=await p.read("document.querySelector('[role=dialog] h3').textContent")
  assert(/第\s*2\s*话/.test(selected), 'WATCH_CONTINUE_EPISODE_LOST: expected EP2, got '+selected)
  const resumed=await chooseSource(player,p)
  const r=await ready(resumed)
  assert.equal(new URL(resumed.webContents.getURL()).searchParams.get('ep'),'2')
  assert(await r.read("document.querySelector('video').paused"), 'continuing must retain the explicit play gesture')
  await r.wait("document.body.textContent.includes('上次看到')")
  console.log('PASS watch episode: paused reload keeps time; return remembers EP2 with its time prompt; record remains EP1')
  resumed.destroy()
  await p.click(`(${p.article}).querySelector('button[aria-label^="当前第"]')`)
  await p.read("(() => {const i=document.querySelector('input[aria-label=\"直接输入看到的集数\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'3');i.dispatchEvent(new Event('input',{bubbles:true}))})()")
  await p.read("document.querySelector('input[aria-label=\"直接输入看到的集数\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))")
  await p.wait("!!document.querySelector('button[aria-label=\"当前第 3 集，点击直接输入\"]')")
  await p.click(p.continueButton)
  await p.wait("!!document.querySelector('[role=dialog] h3')")
  assert(await p.read("/第\\s*3\\s*话/.test(document.querySelector('[role=dialog] h3').textContent)"), 'manual edit must take priority over saved playback')
  await p.click("document.querySelector('[role=dialog] .dlg-close')")
  console.log('PASS watch episode: deliberate manual progress edit overrides old continuation')
  await player.loadURL(origin+'/__agent-test/login/bob')
  await p.wait("document.querySelectorAll('main article').length===2")
  await p.click(p.continueButton)
  await p.wait("!!document.querySelector('[role=dialog] h3')")
  assert(await p.read("/第\\s*1\\s*话/.test(document.querySelector('[role=dialog] h3').textContent)"), 'other account must not inherit EP2')
  await p.click("document.querySelector('[role=dialog] .dlg-close')")
  await player.loadURL(origin+'/api/player/page?src=xifan&id=1001&ep=2&bgmId=101')
  const bob=await ready(player)
  assert(await bob.read("!document.body.textContent.includes('上次看到')"), 'other account must not inherit the time prompt')
  assert(await bob.read("document.querySelector('video').paused"))
  console.log('PASS watch episode: other account gets its own episode and time context')
  console.log('WATCH_EPISODE_CASES=3')
}
main().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1)})
