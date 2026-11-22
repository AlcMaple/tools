const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const { app, BrowserWindow } = require('electron')

const origin = process.argv[2]
assert(origin && new URL(origin).hostname === 'agent-phase4.localhost')
app.setPath('userData', process.argv[3])
app.commandLine.appendSwitch('disable-gpu')

async function main() {
  await app.whenReady()
  const win = new BrowserWindow({ show: false, width: 1280, height: 900 })
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
    (request, done) => done({ cancel: new URL(request.url).origin !== origin }))

  const read = (fn, ...args) => win.webContents.executeJavaScript(
    '(' + fn.toString() + ')(...' + JSON.stringify(args) + ')',
  )
  const wait = async (fn, ...args) => {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      if (await read(fn, ...args)) return
      await delay(25)
    }
    throw new Error('GOOD_EPISODES_WAIT: ' + fn.toString())
  }
  const open = async () => {
    await wait(() => document.querySelectorAll('article').length === 3)
    await read(() => {
      const card = [...document.querySelectorAll('article')].find(el => el.textContent.includes('摇曳露营△'))
      card.querySelector('.trk-actions button[title="标记鉴赏神回"], .trk-actions button[title$="集好看"]').click()
    })
    await wait(() => document.querySelectorAll('.ge-ep').length === 12)
  }
  const clickEpisodes = (...episodes) => read(numbers => {
    const buttons = document.querySelectorAll('.ge-ep')
    for (const n of numbers) buttons[n - 1].click()
  }, episodes)
  const marked = () => read(() => [...document.querySelectorAll('.ge-ep.on')].map(el => Number(el.textContent)))
  const saved = () => read(async () => {
    const response = await window.__highlightFixture.fetch('/api/tracks/102/good-episodes')
    if (!response.ok) throw new Error('GOOD_EPISODES_FIXTURE_READ: ' + response.status)
    return response.json()
  })
  const counts = () => read(() => [window.__highlightFixture.writes, window.__highlightFixture.freshReads])
  const settle = ([writes, reads], added) => wait((w, r) => {
    const probe = window.__highlightFixture
    return probe.writes === w && probe.freshReads > r
  }, writes + added, reads)
  const draftNote = (episode, text, unmark = false) => read((n, value, remove) => {
    const row = [...document.querySelectorAll('.ge-row')].find(el => Number(el.querySelector('button').textContent) === n)
    const input = row.querySelector('input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    if (remove) row.querySelector('button').click()
  }, episode, text, unmark)

  await win.loadURL(origin + '/__agent-test/login/alice')
  await open()
  await read(() => {
    const originalFetch = window.fetch.bind(window)
    const probe = window.__highlightFixture = { fetch: originalFetch, writes: 0, freshReads: 0, holdRead: true, failNext: false }
    window.fetch = async (url, init) => {
      if ((url === '/api/tracks/102' && init?.method === 'PUT')
        || (url === '/api/tracks/102/good-episodes' && init?.method === 'PATCH')) {
        if (++probe.writes === 1) await new Promise(resolve => { probe.releaseWrite = resolve })
        if (probe.failNext) {
          probe.failNext = false
          return Response.json({ error: '测试维护中' }, { status: 503 })
        }
      }
      if (url !== '/api/tracks') return originalFetch(url, init)
      if (probe.holdRead) {
        probe.holdRead = false
        const response = await originalFetch(url, init)
        const body = await response.text()
        // 要检验版本闸门，而不只是 AbortController：让已经发出的旧快照迟到且仍返回成功。
        await new Promise(resolve => { probe.releaseRead = resolve })
        return new Response(body, { status: response.status, headers: response.headers })
      }
      const response = await originalFetch(url, init)
      await response.clone().text()
      probe.freshReads++
      return response
    }
    window.dispatchEvent(new StorageEvent('storage', { key: 'mt_cache:tracks:ui_alice', newValue: '{"data":[]}' }))
  })
  await wait(() => !!window.__highlightFixture.releaseRead)
  await clickEpisodes(1)
  await wait(() => !!window.__highlightFixture.releaseWrite)
  await clickEpisodes(2, 3)
  const immediate = await marked()
  assert.deepEqual(await counts(), [1, 0], '后两次点击先排队，不与第一笔并发')
  await read(async () => {
    const response = await window.__highlightFixture.fetch('/api/tracks/102', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goodEpisodes: [4], goodEpisodeNotes: { 4: '来自另一页' } }),
    })
    if (!response.ok) throw new Error('GOOD_EPISODES_FIXTURE_OTHER_WRITE: ' + response.status)
    await response.text()
    window.__highlightFixture.releaseRead()
    await new Promise(resolve => setTimeout(resolve, 50))
  })
  const afterOldRead = await marked()
  await read(() => window.__highlightFixture.releaseWrite())
  await settle([0, 0], 3)
  const persisted = await saved()
  console.log('并发回归', JSON.stringify({ immediate, afterOldRead, persisted }))
  assert.deepEqual({ immediate, afterOldRead, persisted }, {
    immediate: [1, 2, 3],
    afterOldRead: [1, 2, 3],
    persisted: { goodEpisodes: [1, 2, 3, 4], goodEpisodeNotes: { 4: '来自另一页' } },
  }, '同一批点击和另一个页面的集数都应该保留')
  await wait(() => document.querySelectorAll('.ge-ep.on').length === 4)

  let before = await counts()
  await read(() => document.querySelectorAll('.ge-view-btn')[1].click())
  await draftNote(2, '  本地备注  ')
  await read(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  await settle(before, 1)
  assert.deepEqual((await saved()).goodEpisodeNotes, { 2: '本地备注', 4: '来自另一页' })
  console.log('PASS 关闭弹窗仍保存当前集备注，保留另一集备注')

  await open()
  before = await counts()
  await read(() => document.querySelectorAll('.ge-view-btn')[1].click())
  await draftNote(2, '这条草稿不该回来', true)
  await read(() => document.querySelectorAll('.ge-view-btn')[0].click())
  await clickEpisodes(3, 3, 2)
  await settle(before, 4)
  await delay(500)
  assert.equal((await counts())[0], before[0] + 4, '取消标记要同时取消该集的备注计时器')
  assert.deepEqual(await saved(), { goodEpisodes: [1, 2, 3, 4], goodEpisodeNotes: { 4: '来自另一页' } })
  console.log('PASS 快速切换同一集，已清备注不会随重新点亮复活')

  before = await counts()
  await read(() => {
    document.querySelector('.ge-footer button').click()
    document.querySelectorAll('.ge-ep')[2].click()
  })
  await settle(before, 2)
  assert.deepEqual(await saved(), { goodEpisodes: [3], goodEpisodeNotes: {} })
  console.log('PASS 清空后马上点亮，第 3 集保留且旧备注全清')

  before = await counts()
  await read(() => { window.__highlightFixture.failNext = true })
  await clickEpisodes(5, 6)
  await settle(before, 2)
  assert.match(await read(() => document.querySelector('#toast-root')?.textContent ?? ''), /第 5 集.*测试维护中/)
  assert.deepEqual(await saved(), { goodEpisodes: [3, 6], goodEpisodeNotes: {} })
  await win.reload()
  await open()
  assert.deepEqual(await marked(), [3, 6])
  console.log('PASS 一次保存失败会提示，后续点击照常落库，刷新后仍正确')
  win.destroy()
}

main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1) })
