const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const { app, BrowserWindow } = require('electron')

const origin = process.argv[2]
const alternateOrigin = origin.replace('agent-phase4.localhost', '127.0.0.1')
assert(origin && new URL(origin).hostname === 'agent-phase4.localhost')
app.setPath('userData', process.argv[3])
app.commandLine.appendSwitch('disable-gpu')
app.on('window-all-closed', () => {})

const navigationResponses = new Map()
const read = async (window, expression) => {
  if (window.isDestroyed()) throw new Error('RETURN_READ_DESTROYED_WINDOW')
  let timer
  try {
    return await Promise.race([window.webContents.executeJavaScript(expression, true), new Promise((_, reject) => {
      timer=setTimeout(() => reject(new Error('RETURN_EVALUATION_DEADLINE: '+JSON.stringify({url:window.isDestroyed()?'closed':window.webContents.getURL(),destroyed:window.isDestroyed(),expression}))), 5000)
    })])
  } catch (error) {
    throw new Error('RETURN_EVALUATION_FAILED: '+JSON.stringify({url:window.isDestroyed()?'closed':window.webContents.getURL(),expression,reason:String(error)}))
  } finally { clearTimeout(timer) }
}
const waitFor = async (window, expression) => {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (window.isDestroyed()) throw new Error('RETURN_WINDOW_CLOSED_BEFORE_ASSERTION')
    try { if (await read(window, expression)) return } catch (error) { if (Date.now() >= deadline - 50) throw error }
    await delay(25)
  }
  const visible = await read(window, '({title:document.title,body:document.body.innerText.slice(0,1200)})').catch(error => ({error:String(error)}))
  console.error('RETURN_DIAGNOSTIC '+JSON.stringify({url:window.webContents.getURL(),response:navigationResponses.get(window.webContents.id),visible}))
  throw new Error('TRACKS_PLAYER_RETURN_TIMEOUT: ' + expression)
}
const click = (window, expression) => read(window, `(() => { const target=${expression}; if (!target) throw new Error('RETURN_TARGET_MISSING: '+${JSON.stringify(expression)}); target.click() })()`)
const fill = (window, selector, value) => read(window, `(() => { const input=document.querySelector(${JSON.stringify(selector)}); if (!input) throw new Error('RETURN_INPUT_MISSING'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})) })()`)
const byText = (text, selector = 'button') => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(node => node.textContent.trim()===${JSON.stringify(text)})`
const viewState = window => read(window, `({filter:document.querySelector('.tabf.on')?.textContent.trim(),query:document.querySelector('#trkSearch')?.value,count:document.querySelectorAll('main article').length,list:!!document.querySelector('.trk-list'),tagCount:document.querySelector('.dd-host .tagx.mine')?.textContent.trim(),scroll:document.scrollingElement.scrollTop})`)
const makeWindow = () => {
  const window = new BrowserWindow({ show: false, width: 1360, height: 980, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  // Electron 默认把弹窗寿命绑到父窗；普通浏览器的新标签会在原页关闭后继续存在。
  window.webContents.setWindowOpenHandler(() => ({ action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: { show: false } }))
  return window
}
const closeAll = () => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }
let completed = 0
const pass = message => { completed++; console.log('PASS tracks player return: ' + message) }

async function tracks({ list = false, tag = false, query = '芙莉莲' } = {}) {
  const window = makeWindow()
  await window.loadURL(origin + '/__agent-test/login/alice')
  await waitFor(window, "document.querySelectorAll('main article').length===3")
  await click(window, "Array.from(document.querySelectorAll('button.tabf')).find(b=>b.textContent.trim().startsWith('在看'))")
  await fill(window, '#trkSearch', query)
  if (tag) {
    await click(window, "Array.from(document.querySelectorAll('.dd-trigger')).find(b=>b.textContent.includes('类型'))")
    await waitFor(window, "!!document.querySelector('.dd-tag-filter')")
    await click(window, "Array.from(document.querySelectorAll('.dd-tag-filter .dd-item')).find(b=>b.textContent.includes('回程组'))")
    await click(window, "Array.from(document.querySelectorAll('.dd-trigger')).find(b=>b.textContent.includes('类型'))")
  }
  if (list) await click(window, "Array.from(document.querySelectorAll('[role=\"radio\"],input[type=\"radio\"],button')).find(b=>b.textContent.trim()==='列表')")
  await waitFor(window, "document.querySelector('.tabf.on')?.textContent.trim().startsWith('在看') && document.querySelectorAll('main article').length===1")
  await read(window, "window.__returnTestDocument=crypto.randomUUID()")
  return window
}

async function openFromTracks(window, kind = 'bound', source = 'xifan') {
  await click(window, byText('继续看'))
  await waitFor(window, "!!document.querySelector('[aria-label=\"挑个播放源\"]')")
  const nextWindow = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RETURN_POPUP_NOT_CREATED')), 12_000)
    window.webContents.once('did-create-window', child => { clearTimeout(timer); resolve(child) })
  })
  const sourceIndex = source === 'girigiri' ? 1 : 0
  if (kind === 'search') {
    await click(window, "Array.from(document.querySelectorAll('[aria-label=\"挑个播放源\"] button')).find(b=>b.textContent.trim()==='不对，重认')")
    await waitFor(window, "!!document.querySelector('.cand-list a.sugg-item')")
    await click(window, "document.querySelector('.cand-list a.sugg-item')")
  } else {
    const label = kind.startsWith('source') ? '跳去源站看' : '在纱雾这儿看'
    await click(window, `Array.from(document.querySelectorAll('[aria-label="挑个播放源"] button')).filter(b=>b.textContent.trim()===${JSON.stringify(label)})[${sourceIndex}]`)
    if (kind === 'candidate' || kind === 'source-search') {
      await waitFor(window, "!!document.querySelector('.cand-list a.sugg-item')")
      await click(window, "document.querySelector('.cand-list a.sugg-item')")
    }
  }
  const player = await nextWindow
  if (kind.startsWith('source')) await waitFor(player, "document.title==='Local source destination'")
  else await waitFor(player, "document.querySelector('#ttl')?.textContent.includes('本地播放验证片')")
  return player
}

async function returnClick(player) {
  await click(player, "document.querySelector('#tracks-return') || document.querySelector('a[href=\"/#/tracks\"]')")
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    if (player.isDestroyed()) return 'closed'
    if (await read(player, "location.hash==='#/tracks' && !!document.querySelector('#trkSearch')")) return 'fallback'
    if (await read(player, "!!document.querySelector('#tracks-return-error')?.textContent")) return 'error'
    await delay(25)
  }
  throw new Error('RETURN_RESULT_NOT_OBSERVED')
}

async function assertOriginal(parent, player, before) {
  await read(parent, 'window.__returnTestDocument ||= crypto.randomUUID()')
  const documentId = await read(parent, 'window.__returnTestDocument')
  assert.equal(await returnClick(player), 'closed', 'RETURN_MUST_REUSE_ORIGINAL_TRACKS_WINDOW')
  assert(!parent.isDestroyed(), 'original tracks window must stay open')
  assert.equal(await read(parent, 'window.__returnTestDocument'), documentId, 'original document must not reload')
  assert.deepEqual(await viewState(parent), before, 'original view and scroll must be unchanged')
}

async function main() {
  await app.whenReady()
  const keeper = makeWindow()
  let externalRequests = 0
  let blockedMeWindow = null
  let blockedMeReads = 0
  keeper.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => {
    const url = new URL(request.url)
    if (url.origin !== origin && !(url.origin === alternateOrigin && url.pathname === '/__tracks-return/source-destination')) { externalRequests++; return done({ cancel: true }) }
    if (blockedMeWindow === request.webContentsId && url.pathname === '/api/auth/me') { blockedMeReads++; return done({ cancel: true }) }
    done({ cancel: false })
  })
  keeper.webContents.session.webRequest.onCompleted({ urls: ['http://*/*'] }, response => {
    if (response.resourceType === 'mainFrame') navigationResponses.set(response.webContentsId, { url: response.url, status: response.statusCode })
  })
  keeper.destroy()

  let parent = await tracks({ tag: true })
  let before = await viewState(parent)
  let player = await openFromTracks(parent)
  await waitFor(player, "!!document.querySelector('video')")
  assert(await read(player, "document.querySelector('video').paused && document.querySelector('video').currentTime===0"), 'test must not start playback')
  await assertOriginal(parent, player, before)
  pass('bound card returns to the same document with status, query, tag and scroll intact; playback stays paused')
  closeAll()

  parent = await tracks({ list: true, tag: true })
  before = await viewState(parent)
  assert(before.list, 'list view must be established')
  player = await openFromTracks(parent)
  await assertOriginal(parent, player, before)
  pass('list entry preserves the original list view and filters')
  closeAll()

  parent = await tracks()
  before = await viewState(parent)
  player = await openFromTracks(parent, 'search')
  await assertOriginal(parent, player, before)
  pass('explicit source-search candidate keeps the same return target')
  closeAll()

  parent = await tracks()
  await read(parent, "fetch('/__tracks-return/clear-girigiri',{method:'POST'})")
  await parent.reload()
  await waitFor(parent, "document.querySelectorAll('main article').length===3")
  await click(parent, "Array.from(document.querySelectorAll('button.tabf')).find(b=>b.textContent.trim().startsWith('在看'))")
  await fill(parent, '#trkSearch', '芙莉莲')
  before = await viewState(parent)
  player = await openFromTracks(parent, 'candidate', 'girigiri')
  await assertOriginal(parent, player, before)
  pass('Girigiri located candidate keeps the original tracks window')
  closeAll()

  parent = await tracks()
  before = await viewState(parent)
  player = await openFromTracks(parent)
  await click(player, "Array.from(document.querySelectorAll('#eps button')).find(b=>b.textContent.trim()==='12')")
  await waitFor(player, "new URL(location.href).searchParams.get('ep')==='12' && !!document.querySelector('#tracks-return')")
  await click(player, "Array.from(document.querySelectorAll('#sources button')).find(b=>b.textContent.trim()==='Girigiri')")
  await waitFor(player, "new URL(location.href).searchParams.get('src')==='girigiri' && !!document.querySelector('#tracks-return')")
  await assertOriginal(parent, player, before)
  pass('whole-page episode and source switches retain the original return relationship')
  closeAll()

  parent = await tracks()
  player = await openFromTracks(parent, 'source')
  assert.equal(await read(player, 'window.opener===null'), true, 'source redirect must never receive an opener')
  pass('same-origin source redirect still opens without an opener')
  closeAll()

  parent = await tracks()
  await read(parent, "fetch('/__tracks-return/clear-xifan',{method:'POST'})")
  await parent.webContents.session.clearStorageData({ storages: ['localstorage'] })
  await parent.reload()
  await waitFor(parent, "document.querySelectorAll('main article').length===3")
  await click(parent, "Array.from(document.querySelectorAll('button.tabf')).find(b=>b.textContent.trim().startsWith('在看'))")
  await fill(parent, '#trkSearch', '芙莉莲')
  player = await openFromTracks(parent, 'source-search')
  assert.equal(await read(player, 'window.opener===null'), true, 'source-search link must not create a return capability')
  pass('unbound source-search candidate preserves noreferrer through the local source redirect')
  closeAll()


  parent = await tracks()
  player = await openFromTracks(parent)
  parent.destroy()
  assert.equal(await returnClick(player), 'fallback')
  await waitFor(player, "document.querySelectorAll('main article').length===3")
  assert.equal(await read(player, "document.querySelector('#trkSearch').value"), '')
  pass('closed original page falls back to ordinary tracks navigation')
  closeAll()

  parent = await tracks()
  player = await openFromTracks(parent)
  await click(parent, "document.querySelector('a[href=\"/#/\"]')")
  await waitFor(parent, "document.querySelector('main h1')?.textContent==='番剧周历'")
  assert.equal(await returnClick(player), 'fallback')
  assert.equal(await read(parent, 'location.hash'), '#/')
  pass('original page leaving tracks is not commandeered by the player')
  closeAll()

  parent = await tracks()
  player = await openFromTracks(parent)
  await parent.loadURL(alternateOrigin + '/__tracks-return/source-destination')
  assert.equal(await returnClick(player), 'fallback')
  assert.equal(new URL(parent.webContents.getURL()).origin, alternateOrigin)
  pass('original page crossing origins is not read or navigated by the return bridge')
  closeAll()


  parent = await tracks()
  player = makeWindow()
  await player.loadURL(origin + '/api/player/page?src=xifan&id=1001&ep=11&bgmId=101')
  await waitFor(player, "!!document.querySelector('#ttl')")
  assert.equal(await read(player, 'window.opener===null'), true)
  assert.equal(await returnClick(player), 'fallback')
  pass('direct player entry retains a normal return link')
  closeAll()

  parent = await tracks()
  await click(parent, "document.querySelector('a[href=\"/#/\"]')")
  await waitFor(parent, "document.querySelector('main h1')?.textContent==='番剧周历'")
  player = await openFromTracks(parent)
  assert.equal(await read(player, 'window.opener===null'), true, 'calendar entry must not borrow the tracks return capability')
  assert.equal(await returnClick(player), 'fallback')
  pass('calendar player entry remains isolated from the tracks-only return capability')
  closeAll()


  parent = await tracks()
  player = await openFromTracks(parent)
  await read(player, "fetch('/__tracks-return/switch-owner',{method:'POST'}).then(response=>response.json())")
  assert.equal(await read(parent, "document.querySelector('#trkSearch').value"), '芙莉莲', 'test requires stale original auth context before the server identity check')
  assert.equal(await returnClick(player), 'fallback', 'current server identity must reject a stale same-origin opener')
  await waitFor(player, "document.querySelector('main')?.textContent.includes('另一位用户的条目')")
  assert.equal(await read(player, "document.querySelector('#trkSearch').value"), '')
  pass('silent cookie account change rejects stale original owner and starts fresh for the new account')
  closeAll()

  parent = await tracks()
  player = await openFromTracks(parent)
  const switched = makeWindow()
  await switched.loadURL(origin + '/__agent-test/login/bob')
  await waitFor(parent, "document.querySelector('main')?.textContent.includes('另一位用户的条目') && document.querySelectorAll('main article').length===1")
  await fill(parent, '#trkSearch', '另一位')
  await waitFor(parent, "document.querySelector('#trkSearch')?.value==='另一位'")
  assert.equal(await returnClick(player), 'fallback', 'an old-account player must not acquire a new-account return capability')
  await waitFor(player, "document.querySelector('main')?.textContent.includes('另一位用户的条目')")
  assert.equal(await read(player, "document.querySelector('#trkSearch').value"), '')
  assert.equal(await read(parent, "document.querySelector('#trkSearch').value"), '另一位')
  pass('broadcast account change cannot transfer an old player to the new owner context')
  closeAll()


  parent = await tracks()
  player = await openFromTracks(parent)
  await read(player, "fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(response=>response.ok)")
  assert.equal(await returnClick(player), 'fallback')
  await waitFor(player, "document.querySelector('main')?.textContent.includes('登录后就能开始追番')")
  pass('logout uses the guest fallback instead of restoring old-account tracks')
  closeAll()

  const first = await tracks({ tag: true })
  const firstState = await viewState(first)
  const firstPlayer = await openFromTracks(first)
  const second = await tracks({ list: true })
  const secondState = await viewState(second)
  const secondPlayer = await openFromTracks(second)
  await assertOriginal(first, firstPlayer, firstState)
  assert(!secondPlayer.isDestroyed(), 'returning first player must not close the second')
  await assertOriginal(second, secondPlayer, secondState)
  pass('two independent original pages return only their own player windows')
  closeAll()

  parent = await tracks()
  player = await openFromTracks(parent)
  const ownerId = await read(player, "fetch('/api/auth/me').then(response=>response.json()).then(user=>user.id)")
  await player.loadURL(origin + '/__tracks-return/source-destination')
  assert.equal(await read(player, `window.opener.__mapleReturnToTracks(window,${ownerId})`), false, 'a non-player document must not invoke the return bridge')
  pass('same-origin non-player pages are rejected by the restricted return bridge')
  closeAll()

  parent = await tracks()
  player = await openFromTracks(parent)
  blockedMeWindow = player.webContents.id
  assert.equal(await returnClick(player), 'error')
  assert.equal(blockedMeReads, 1, 'failed identity check must not retry or load a new SPA that retries')
  assert(!player.isDestroyed())
  assert(new URL(player.webContents.getURL()).pathname==='/api/player/page')
  pass('failed current-identity read stays on the player with one request and no implicit retry')
  closeAll()

  parent = await tracks()
  player = await openFromTracks(parent)
  await read(player, "fetch('/__tracks-return/identity-mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({failed:true})}).then(response=>response.json())")
  assert.equal(await returnClick(player), 'error')
  assert((await read(player, "document.querySelector('#tracks-return-error').textContent")).includes('HTTP 503'), 'a non-JSON service failure must retain its HTTP status')
  assert(new URL(player.webContents.getURL()).pathname==='/api/player/page')
  const failureState = await read(player, "fetch('/__tracks-return/identity-mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({failed:false})}).then(response=>response.json())")
  assert.equal(failureState.failedIdentityReads, 1, 'HTML 503 must not trigger an identity retry or fallback-page request')
  pass('non-JSON HTTP 503 remains visible on the player and makes only one identity request')
  closeAll()

  assert.equal(externalRequests, 0, 'browser must not attempt external requests')
  console.log('TRACKS_PLAYER_RETURN_CASES=' + completed)
  console.log('NOTE actual browser focus and narrow viewport are verified separately through CUA')
}
main().then(() => app.exit(0)).catch(error => { console.error(error); closeAll(); app.exit(1) })
