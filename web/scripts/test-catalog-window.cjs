const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { readFile, mkdtemp, rm } = require('node:fs/promises')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const { extname, join, resolve, sep } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const TOTAL = 30000, SEED = TOTAL - 48, SMALL = 108

function item(bgmId) {
  const tags = bgmId % 8 < 4 ? [] : ['奇幻冒险题材', '社团与异世界', '季节限定角色故事', '架空历史推理', '喜剧日常生活', '轻小说改编']
  return {
    bgmId, name: 'Fixture #' + bgmId, nameCn: '样本番剧 #' + bgmId,
    date: '2024-01-01', score: 8, eps: 12, tags, cover: '',
  }
}

async function fixture() {
  const dist = resolve(process.env.CATALOG_WINDOW_DIST || join(__dirname, '../dist'))
  const rows = Array.from({ length: TOTAL }, (_, i) => item(i + 1))
  const requests = []
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp' }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const json = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) }
    const path = url.pathname
    if (path === '/__catalog-fixture') return json(requests)
    if (path === '/api/catalog') {
      const offset = Number(url.searchParams.get('offset'))
      const limit = Number(url.searchParams.get('limit'))
      const sort = url.searchParams.get('sort')
      requests.push({ sort, offset, limit })
      const count = sort === 'date' ? SMALL : TOTAL
      // 只把已翻过的条目一次注入，避免慢测 624 次网络往返；最后一批仍走正式的自动续载
      const end = sort === 'score' && offset === 0 ? SEED : Math.min(count, offset + limit)
      return json({ ready: true, total: count, items: rows.slice(offset, end), covered: 0, admin: false, genres: [], planningReady: true })
    }
    const details = /^\/api\/catalog\/(\d+)\/details$/.exec(path)
    if (details) return json({ item: rows[Number(details[1]) - 1], aliases: [], summary: '合成测试简介', summaryStatus: 'available' })
    if (path === '/api/auth/me') return json({ id: 1, username: 'testcatalog', hasSecurity: true, hasEmail: false, hasPassword: true })
    if (path === '/api/tracks' || path === '/api/tracks/revision') return json({ data: [], rev: 1, viewRev: 1 })
    if (path === '/api/xifan/bindings' || path === '/api/girigiri/bindings') return json({ data: {} })
    if (path === '/api/calendar') return json({ data: [], updatedAt: Date.now(), fromCache: true })
    if (path === '/api/calendar/seasons') return json({ seasons: [] })
    if (path === '/api/announcements/current') return json({ announcement: null })
    if (path === '/api/feedback/context') return json({ unread: 0, admin: false })
    if (path.startsWith('/api/')) return json({ error: '未配置的测试接口' }, 404)
    const file = resolve(dist, '.' + (path === '/' ? '/index.html' : path))
    if (!file.startsWith(dist + sep)) return json({ error: 'invalid fixture path' }, 404)
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' })
      res.end(path === '/' ? body.toString('utf8').replace(/<script async src="https:[^"]+" data-website-id="[^"]+"\s*><\/script>/, '') : body)
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(error)
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise(ok => server.listen(0, '127.0.0.1', ok))
  return { origin: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(ok => { server.close(ok); server.closeAllConnections() }) }
}

function locate(target) {
  const grid = document.querySelector('.catalog-grid')
  if (!grid) return null
  const css = getComputedStyle(grid)
  const columns = css.gridTemplateColumns.split(/\s+/).length
  const heights = css.gridTemplateRows.split(/\s+/).map(parseFloat)
  const gap = parseFloat(css.rowGap)
  const ids = Array.from(grid.children, card => Number(card.querySelector('.poster-title')?.textContent.split('#')[1]))
  let top = grid.getBoundingClientRect().top + parseFloat(css.paddingTop)
  let first = null, selected = null
  for (const [row, height] of heights.entries()) {
    const id = ids[row * columns]
    if (first === null && top + height > 0 && top < innerHeight) first = { id, top }
    if (ids.slice(row * columns, (row + 1) * columns).includes(target)) selected = top
    top += height + gap
  }
  return { first, selected, columns, mounted: ids.length, distinctHeights: new Set(heights).size,
    last: ids.at(-1), y: scrollY, height: document.scrollingElement.scrollHeight }
}

async function browser(origin, data) {
  const executable = process.env.CHROME_BIN || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.platform === 'win32'
      ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')
      : 'google-chrome')
  const chrome = spawn(executable, [
    '--headless', '--no-first-run', '--disable-background-networking', '--disable-component-update',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--remote-debugging-pipe', '--user-data-dir=' + data,
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
  let stderr = '', buffer = '', seq = 0
  const pending = new Map()
  chrome.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1500) })
  const closed = new Promise(ok => chrome.once('close', (code, signal) => {
    for (const [id, accept] of pending) accept({ id, error: { message: 'Chrome exited ' + (code ?? signal) + ': ' + stderr } })
    ok()
  }))
  chrome.on('error', error => { stderr += error.message })
  chrome.stdio[3].on('error', error => { stderr += error.message })
  chrome.stdio[4].setEncoding('utf8').on('data', chunk => {
    buffer += chunk
    for (let i = buffer.indexOf('\0'); i >= 0; i = buffer.indexOf('\0')) {
      const message = JSON.parse(buffer.slice(0, i))
      buffer = buffer.slice(i + 1)
      if (message.id) pending.get(message.id)?.(message)
    }
  })
  const send = (method, params, sessionId) => {
    const id = ++seq
    return new Promise((ok, fail) => {
      const timeout = setTimeout(() => { pending.delete(id); fail(new Error(method + ' timed out: ' + stderr)) }, 20000)
      pending.set(id, message => {
        clearTimeout(timeout)
        pending.delete(id)
        if (message.error) fail(new Error(method + ': ' + message.error.message))
        else ok(message.result)
      })
      chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0')
    })
  }
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    const rpc = (method, params) => send(method, params, sessionId)
    const read = async expression => {
      const response = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
      return response.result.value
    }
    const snap = (id = 0) => read('(' + locate.toString() + ')(' + id + ')')
    const settled = async () => {
      await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
      await delay(100)
    }
    const waitFor = async (probe, name) => {
      const end = Date.now() + 15000
      while (Date.now() < end) {
        if (await probe()) return
        await delay(30)
      }
      throw new Error(name + ': ' + JSON.stringify(await snap()))
    }
    const go = async y => {
      await read('window.scrollTo({top:' + y + ',behavior:"instant"});true')
      await settled()
    }
    const requests = () => read('fetch("/__catalog-fixture").then(r => r.json())')
    const emulation = (width, height) => rpc('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 3, mobile: true })
    await emulation(390, 844)
    await rpc('Network.enable')
    await rpc('Network.setBlockedURLs', { urls: ['https://*'] })
    await rpc('Page.navigate', { url: origin })
    await waitFor(() => read('!!document.querySelector(".spine-user")'), 'synthetic login')
    await read('location.hash="/anime";true')
    await waitFor(async () => (await snap())?.mounted > 0, 'initial scored catalog')
    await settled()
    const initial = await snap()
    assert.equal(initial.columns, 2)
    assert(initial.mounted <= 36, 'MOUNTED_AFTER_SEED=' + initial.mounted)
    assert(initial.height > 3000000, 'virtual spacers must preserve the long document')

    await go(initial.height)
    await waitFor(() => read('!document.querySelector(".catalog-page > .trk-more")'), 'last 48 append at bottom')
    await go((await snap()).height)
    const end = await snap()
    assert.equal(end.last, TOTAL)
    assert(end.mounted <= 36)
    const firstRequests = [{ sort: 'score', offset: 0, limit: 48 }, { sort: 'score', offset: SEED, limit: 48 }]
    assert.deepEqual(await requests(), firstRequests)
    console.log('PASS 30,000 条，末批续载一次，末尾挂载 ' + end.mounted + ' 张卡片')

    await go(end.height * 0.83)
    const deep = await snap()
    assert(deep.first?.id > 20000 && deep.distinctHeights > 1 && deep.mounted <= 36)
    await go(0)
    assert.equal(await read('document.querySelector(".catalog-grid .poster-title").textContent'), '样本番剧 #1')
    await go(deep.y)
    const returned = await snap()
    assert.equal(returned.first.id, deep.first.id)
    assert(Math.abs(returned.first.top - deep.first.top) <= 1)
    await emulation(844, 390)
    await waitFor(async () => {
      const current = await snap(deep.first.id)
      return current.columns > 2 && current.selected !== null && Math.abs(current.selected - deep.first.top) <= 3
    }, 'resize preserves the measured row and its screen offset')
    const wide = await snap(deep.first.id)
    assert.deepEqual(await requests(), firstRequests)
    console.log('PASS 变高行回滑，转屏 ' + deep.columns + '→' + wide.columns + ' 列，锚定第 ' + deep.first.id + ' 部且目录零重查')

    await read('(() => { const title = Array.from(document.querySelectorAll(".catalog-grid .poster-title")).find(e => e.textContent === "样本番剧 #' + deep.first.id + '"); title.focus({preventScroll:true}); title.click(); return true })()')
    await waitFor(() => read('document.querySelector(".catalog-details[open]")?.textContent.includes("合成测试简介")'), 'deep details')
    await read('document.querySelector(".catalog-details .dlg-close").click();true')
    await settled()
    assert.equal(await read('document.activeElement.textContent'), '样本番剧 #' + deep.first.id)
    assert(Math.abs((await snap()).y - wide.y) <= 1)
    console.log('PASS 深处作品简介关闭后回到原卡片位置与焦点')

    await read('document.activeElement.closest(".poster").querySelector(".poster-watch button").click();true')
    await waitFor(() => read('!!document.querySelector(".dlg-wsrc")'), 'source chooser')
    await go(0)
    assert.equal(await read('!!document.querySelector(".dlg-wsrc")'), true, 'SOURCE_CHOOSER_UNMOUNTED_WITH_CARD')
    assert.equal((await snap(deep.first.id)).selected, null, 'source card really left the mounted window')
    await read('document.querySelector(".dlg-wsrc .dlg-close").click();true')
    await read('Array.from(document.querySelectorAll(".catalog-toolbar .seg button")).find(e => e.textContent === "最新").click();true')
    await waitFor(() => read('document.querySelector(".catalog-page .sketch-hero p")?.textContent.includes("共 ' + SMALL + ' 部")'), 'new sort replaces loaded range')
    await emulation(390, 844)
    await settled()
    const sorted = await snap()
    assert(sorted.height < 15000 && sorted.first?.id === 1)
    const sortedRequests = [...firstRequests, { sort: 'date', offset: 0, limit: 48 }]
    assert.deepEqual(await requests(), sortedRequests)
    for (const offset of [48, 96]) {
      await go((await snap()).height)
      sortedRequests.push({ sort: 'date', offset, limit: 48 })
      await waitFor(async () => (await requests()).length >= sortedRequests.length, 'automatic batch at ' + offset)
      await settled()
    }
    await go((await snap()).height)
    assert.equal((await snap()).last, SMALL)
    assert.deepEqual(await requests(), sortedRequests)
    console.log('PASS 离屏不关闭片源选择；排序后 0、48、96 各取一次，续载到末尾')
  } finally {
    chrome.kill('SIGTERM')
    await closed
  }
}

async function run() {
  const data = await mkdtemp(join(tmpdir(), 'catalog-window-chrome-'))
  const server = await fixture()
  try {
    await browser(server.origin, data)
  } finally {
    await server.close()
    await rm(data, { recursive: true, force: true })
  }
}

run().catch(error => { console.error(error); process.exitCode = 1 })
