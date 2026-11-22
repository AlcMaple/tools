const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const { once } = require('node:events')
const { app, BrowserWindow } = require('electron')

const origin = process.argv[2]
assert(origin && new URL(origin).hostname === 'agent-phase4.localhost')
app.setPath('userData', process.argv[3])
app.commandLine.appendSwitch('disable-gpu')
const [burst, failure, navigation, reload, offline, ambiguous] = JSON.parse(process.argv[4])
const all = group => group.items.map((_, index) => index + 1)

async function main() {
  await app.whenReady()
  const win = new BrowserWindow({ show: false, width: 1360, height: 980, webPreferences: { backgroundThrottling: false } })
  const wire = []
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => {
    const url = new URL(request.url)
    if (url.origin !== origin) return done({ cancel: true })
    if (url.pathname === '/api/tracks/add' && request.method === 'POST') {
      const body = Buffer.concat((request.uploadData ?? []).flatMap(part => part.bytes ? [part.bytes] : []))
      wire.push(JSON.parse(body.toString()).bgmId)
    }
    done({})
  })
  const read = (fn, ...args) => win.webContents.executeJavaScript('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')')
  const wait = async (fn, ...args) => {
    const end = Date.now() + 9000
    while (Date.now() < end) {
      if (await read(fn, ...args)) return
      await delay(20)
    }
    throw new Error('TRACK_ADD_WAIT ' + fn.toString() + ' ' + JSON.stringify(args))
  }
  const open = async (group, find = false) => {
    if (find) {
      await read(() => window.dispatchEvent(new Event('maple-find-anime')))
      await wait(() => document.querySelector('.dlg-add .dlg-title')?.textContent === '找番')
    } else {
      await wait(() => [...document.querySelectorAll('main button')].some(b => b.textContent.trim() === '加番' && !b.disabled))
      await read(() => [...document.querySelectorAll('main button')].find(b => b.textContent.trim() === '加番' && !b.disabled).click())
    }
    await wait(() => !!document.querySelector('.dlg-add .add-search-row input'))
    await read(value => {
      const input = document.querySelector('.dlg-add .add-search-row input')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, group.query)
    await wait(titles => {
      const rows = [...document.querySelectorAll('#addList .add-hit-title')]
      return titles.every(title => rows.some(row => row.textContent === title))
    }, group.items.map(item => item.title))
  }
  const close = () => read(() => document.querySelector('.dlg-add button[aria-label="关闭"]').click())
  const click = (group, numbers) => read(titles => {
    const rows = [...document.querySelectorAll('#addList .add-hit')]
    for (const title of titles) {
      const row = rows.find(r => r.querySelector('.add-hit-title').textContent === title)
      const action = row?.querySelector('.add-hit-acts .btn-primary')
      if (!action) throw new Error('TRACK_ADD_ACTION_MISSING ' + title)
      action.click()
    }
  }, numbers.map(n => group.items[n - 1].title))
  const rowStates = group => read(titles => {
    const rows = [...document.querySelectorAll('#addList .add-hit')]
    return titles.map(title => {
      const row = rows.find(r => r.querySelector('.add-hit-title').textContent === title)
      const action = row.querySelector('.add-hit-acts .btn-primary')
      if (row.querySelector('.add-hit-acts .mine')?.textContent.trim() === '已加入') return 'saved'
      if (action?.disabled && action.getAttribute('aria-busy') === 'true') return 'pending'
      return action && !action.disabled ? 'ready' : 'unknown'
    })
  }, group.items.map(item => item.title))
  const actionSlot = (group, n) => read(title => {
    const row = [...document.querySelectorAll('#addList .add-hit')].find(item => item.querySelector('.add-hit-title').textContent === title)
    const slot = row.querySelector('.add-hit-write')
    const button = slot.querySelector('button')
    return { label: button?.textContent.trim(), disabled: button?.disabled, width: slot.offsetWidth }
  }, group.items[n - 1].title)
  const shown = async group => (await rowStates(group)).flatMap((state, i) => state === 'saved' ? [i + 1] : [])
  const untilShown = async (group, indices) => {
    const end = Date.now() + 9000
    while (Date.now() < end) {
      if (JSON.stringify(await shown(group)) === JSON.stringify(indices)) return
      await delay(20)
    }
    assert.deepEqual(await shown(group), indices)
  }
  const saved = group => read(async ids => {
    const response = await (window.__addProbe?.raw || window.fetch)('/api/tracks', { cache: 'no-store' })
    assertResponse(response.status)
    const { data } = await response.json()
    return ids.flatMap((id, i) => data.some(t => t.bgmId === id) ? [i + 1] : [])
    function assertResponse(status) {
      if (status !== 200) throw new Error('TRACK_ADD_SERVER_READ ' + status)
    }
  }, group.items.map(i => i.id))
  const go = async (href, heading) => {
    await read(url => [...document.querySelectorAll('a')].find(a => a.getAttribute('href') === url).click(), href)
    await wait(label => document.querySelector('main h1')?.textContent === label, heading)
  }
  const configure = (opts = {}) => read(options => {
    const probe = window.__addProbe
    Object.assign(probe, {
      started: [], completed: [], received: [], kept: [], freshReads: 0, releaseWrite: null, releaseRead: null,
      hold: 0, parked: 0, fail: 0, lose: 0, drop: 0, stale: false, holdCheck: false, ...options,
    })
    if (probe.stale) window.dispatchEvent(new StorageEvent('storage', { key: 'mt_cache:tracks:ui_alice', newValue: '{"data":[]}' }))
  }, opts)
  const settle = n => wait(count => window.__addProbe.completed.length === count && window.__addProbe.freshReads > 0, n)
  const release = () => read(() => window.__addProbe.releaseWrite())
  const install = () => read(() => {
    const raw = window.fetch.bind(window)
    const probe = window.__addProbe = { raw }
    window.fetch = async (url, init) => {
      if (url === '/api/tracks/add' && init?.method === 'POST') {
        const { bgmId: id } = JSON.parse(init.body)
        probe.started.push(id)
        if (init.keepalive) probe.kept.push(id)
        if (id === probe.hold) await new Promise(resolve => { probe.releaseWrite = resolve })
        if (id === probe.parked) return new Promise(() => {})
        if (id === probe.fail) {
          probe.completed.push([id, 503])
          return Response.json({ error: '测试保存失败', code: 'MAINTENANCE' }, { status: 503 })
        }
        const response = await raw(url, init)
        await response.clone().text()
        probe.received.push(id)
        if (id === probe.drop) return new Promise(() => {})
        if (id === probe.lose) {
          probe.completed.push([id, 502])
          return Response.json({ error: '测试网关回执中断' }, { status: 502 })
        }
        probe.completed.push([id, response.status])
        return response
      }
      if (url !== '/api/tracks') return raw(url, init)
      if (probe.stale) {
        probe.stale = false
        const response = await raw(url, init)
        const body = await response.text()
        // 即使 API 客户端尝试取消，旧时点的数据仍会迟到。
        await new Promise(resolve => { probe.releaseRead = resolve })
        return new Response(body, { status: response.status, headers: response.headers })
      }
      const response = await raw(url, init)
      await response.clone().text()
      if (probe.holdCheck) {
        probe.holdCheck = false
        await new Promise(resolve => { probe.releaseRead = resolve })
      }
      probe.freshReads++
      return response
    }
  })

  await win.loadURL(origin + '/__agent-test/login/alice')
  await wait(() => !!localStorage.getItem('mt_cache:tracksServer:ui_alice'))
  await install()

  await open(burst)
  const idle = await actionSlot(burst, 1)
  assert.equal(idle.label, '加入')
  await configure({ hold: burst.items[0].id, stale: true })
  await wait(() => !!window.__addProbe.releaseRead)
  await click(burst, [1, 1, ...all(burst).slice(1)])
  await wait(() => !!window.__addProbe.releaseWrite)
  const rest = all(burst).slice(1)
  await untilShown(burst, rest)
  assert.deepEqual(await saved(burst), rest)
  assert.deepEqual(await read(() => window.__addProbe.started), burst.items.map(i => i.id))
  assert.deepEqual(await read(() => window.__addProbe.kept), burst.items.map(i => i.id))
  assert.equal((await rowStates(burst))[0], 'pending')
  assert.deepEqual(await actionSlot(burst, 1), { label: '加入中…', disabled: true, width: idle.width })
  await close(); await open(burst)
  assert.equal((await rowStates(burst))[0], 'pending')
  await read(async () => { window.__addProbe.releaseRead(); await new Promise(resolve => setTimeout(resolve, 50)) })
  const afterOldRead = await shown(burst)
  assert.deepEqual(afterOldRead, rest)
  await release(); await settle(12); await untilShown(burst, all(burst))
  assert.deepEqual(await saved(burst), all(burst))
  assert.equal(await read(() => window.__addProbe.freshReads), 1)
  console.log('TRACK_ADD_BURST', JSON.stringify({ clicked: 12, savedBeforeFirst: rest.length, afterOldRead: afterOldRead.length, stored: 12, duplicateRequests: 0, backgroundFullReads: 1 }))
  await close()

  await open(failure)
  await configure({ hold: failure.items[2].id, fail: failure.items[1].id })
  await click(failure, all(failure))
  await wait(() => document.querySelector('#toast-root')?.textContent.includes('测试保存失败'))
  await untilShown(failure, [1])
  assert.deepEqual(await rowStates(failure), ['saved', 'ready', 'pending'])
  await release(); await settle(3); await untilShown(failure, [1, 3])
  const failureToast = await read(() => {
    const toast = document.querySelector('#toast-root')
    const dialog = document.querySelector('.dlg-add').closest('.dlg-backdrop')
    return toast?.textContent.includes('加入失败：测试保存失败') && +getComputedStyle(toast).zIndex > +getComputedStyle(dialog).zIndex
  })
  assert.equal(failureToast, true)
  assert.deepEqual(await saved(failure), [1, 3])
  assert.equal(await read(id => window.__addProbe.started.filter(i => i === id).length, failure.items[1].id), 1)
  console.log('TRACK_ADD_FAILURE', JSON.stringify({ status: 503, displayed: [1, 3], stored: [1, 3], failedButton: 'ready', toastAboveDialog: failureToast, attempts: 1 }))
  await close()

  await open(navigation)
  await configure({ hold: navigation.items[0].id })
  await click(navigation, all(navigation))
  await untilShown(navigation, [2, 3])
  await close(); await go('/#/', '番剧周历')
  await open(navigation, true)
  assert.deepEqual(await rowStates(navigation), ['pending', 'saved', 'saved'])
  await release(); await settle(3); await untilShown(navigation, all(navigation))
  await close(); await go('/#/tracks', '我的追番'); await open(navigation)
  assert.deepEqual(await shown(navigation), all(navigation))
  console.log('TRACK_ADD_NAVIGATION', JSON.stringify({ sharedFindState: ['pending', 'saved', 'saved'], stored: [1, 2, 3] }))
  await close()

  await open(ambiguous)
  await configure({ lose: ambiguous.items[0].id, holdCheck: true })
  await click(ambiguous, [1])
  await wait(() => document.querySelector('#toast-root')?.textContent.includes('暂未确认加入：测试网关回执中断'))
  await wait(() => !!window.__addProbe.releaseRead)
  assert.deepEqual(await actionSlot(ambiguous, 1), { label: '确认中…', disabled: true, width: idle.width })
  await read(() => window.__addProbe.releaseRead())
  await settle(1); await untilShown(ambiguous, [1])
  assert.deepEqual(await saved(ambiguous), [1])
  assert.equal(wire.filter(id => id === ambiguous.items[0].id).length, 1)
  console.log('TRACK_ADD_AMBIGUOUS', JSON.stringify({ response: 502, checkingLabel: '确认中…', authoritativeReadFound: true, attempts: 1 }))
  await close()

  await open(reload)
  await configure({ drop: reload.items[0].id, parked: reload.items[2].id })
  await click(reload, all(reload))
  await wait(id => window.__addProbe.received.includes(id), reload.items[0].id)
  await untilShown(reload, [2])
  assert.deepEqual(await saved(reload), [1, 2])
  assert.deepEqual(await rowStates(reload), ['pending', 'saved', 'pending'])
  const quiet = once(win.webContents, 'did-finish-load')
  win.reload()
  await quiet
  await open(reload)
  await untilShown(reload, [1, 2])
  assert.deepEqual(await rowStates(reload), ['saved', 'saved', 'ready'])
  const posted = reload.items.map(item => wire.filter(id => id === item.id).length)
  assert.deepEqual(posted, [1, 1, 0])
  console.log('TRACK_ADD_RELOAD', JSON.stringify({ storedBeforeRefresh: [1, 2], acknowledgedBeforeRefresh: [2], shownAfterRefresh: [1, 2], requestsPerWork: posted }))
  await close()
  await install()

  await open(offline)
  await configure()
  const network = win.webContents.debugger
  network.attach('1.3')
  await network.sendCommand('Network.enable')
  const setOffline = offline => network.sendCommand('Network.emulateNetworkConditions', {
    offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  })
  await setOffline(true)
  await wait(() => navigator.onLine === false)
  await click(offline, [1])
  await wait(() => document.querySelector('#toast-root')?.textContent.includes('加入失败：网络已断开'))
  assert.deepEqual(await rowStates(offline), ['ready'])
  assert.deepEqual(await actionSlot(offline, 1), idle)
  assert.equal(await read(() => window.__addProbe.started.length), 0)
  await setOffline(false)
  await wait(() => navigator.onLine === true)
  assert.equal(wire.filter(id => id === offline.items[0].id).length, 0)
  await click(offline, [1])
  await untilShown(offline, [1])
  assert.equal(wire.filter(id => id === offline.items[0].id).length, 1)
  console.log('TRACK_ADD_OFFLINE', JSON.stringify({ offlineRequests: 0, buttonStayedAvailable: true, manualAfterOnline: 1 }))
  network.detach()
  win.destroy()
}

main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1) })
