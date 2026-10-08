import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { fetchApi } from '../src/request'
import { coverUrl, fetchTracks, searchAnime, searchXifan, type Track, type TracksLoadProgress } from '../src/api'

const originalFetch = globalThis.fetch
const directory = mkdtempSync(join(tmpdir(), 'maple-tracks-loading-'))
const originalEnv = { ...process.env }
let calls = 0
let checks = 0
const check = async (name: string, run: () => Promise<void> | void): Promise<void> => {
  await run()
  console.log(`PASS ${++checks} ${name}`)
}
try {
  await check('截止时间中止未返回响应头的请求，且不重试', async () => {
    calls = 0
    globalThis.fetch = async (_url, init) => {
      calls++
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
    }
    await assert.rejects(fetchApi('/api/search', {}, 15), /请求超时/)
    assert.equal(calls, 1)
  })
  await check('响应头已到但响应体卡住，仍受同一截止时间控制', async () => {
    globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
      start(controller) { init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason)) },
    }))
    await assert.rejects(fetchApi('/api/tracks', {}, 15), /请求超时/)
  })
  await check('取消旧请求保留 AbortError，不冒充网络错误', async () => {
    const controller = new AbortController()
    globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })
    const request = fetchApi('/api/search', { signal: controller.signal })
    controller.abort()
    await assert.rejects(request, { name: 'AbortError' })
  })
  await check('离线搜索 HTTP 错误不再伪装成零结果，且无重试', async () => {
    calls = 0
    globalThis.fetch = async () => { calls++; return Response.json({ error: '今日额度已用完' }, { status: 429 }) }
    await assert.rejects(searchAnime('属性咖啡厅'), /今日额度已用完/)
    assert.equal(calls, 1)
  })
  await check('稀饭 503 原因透出，且无重试', async () => {
    calls = 0
    globalThis.fetch = async () => { calls++; return Response.json({ error: '稀饭服务维护中' }, { status: 503 }) }
    await assert.rejects(searchXifan('相恋'), /稀饭服务维护中/)
    assert.equal(calls, 1)
  })
  await check('失效百科封面只对已关联 BGM 的条目切换，手动封面保留', () => {
    const raw = 'https://bkimg.cdn.bcebos.com/pic/example'
    assert.equal(coverUrl(raw, 633618), '/api/subject-cover/633618')
    assert.equal(coverUrl(raw, -1), raw)
    assert.equal(coverUrl('/api/tracks/1/cover-file', 1), '/api/tracks/1/cover-file')
    assert.equal(coverUrl('https://example.com/image.png', 1), 'https://example.com/image.png')
  })

  const storage = new Map<string, string>()
  const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }
  const intervals = new Map<number, () => void>()
  const intervalDelays = new Map<number, number>()
  let nextInterval = 0
  const fakeWindow = Object.assign(new EventTarget(), {
    localStorage, setTimeout, clearTimeout,
    setInterval: (callback: () => void, delay: number) => { const id = ++nextInterval; intervals.set(id, callback); intervalDelays.set(id, delay); return id },
    clearInterval: (id: number) => { intervals.delete(id); intervalDelays.delete(id) },
  })
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true })
  Object.defineProperty(globalThis, 'document', { value: Object.assign(new EventTarget(), { visibilityState: 'visible' }), configurable: true })
  Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true })
  Object.defineProperty(globalThis, 'BroadcastChannel', { value: undefined, configurable: true })
  const { cacheSet, cachePeek } = await import('../src/dataCache')
  const { loadTracks, saveTracksCache, runTracksMutation, runTrackMutation } = await import('../src/tracksSync')
  const flush = () => new Promise(resolve => setTimeout(resolve, 10))
  const streamRows = Array.from({ length: 20 }, (_, index) => ({ bgmId: index + 1, title: `流式番剧${index + 1}`, subjectType: 'anime', status: 'watching' }))
  const streamCounts = { all: 20, watching: 20, plan: 0, considering: 0, done: 0 }
  const frame = (indices: number[], done = false) => new TextEncoder().encode(JSON.stringify({ rev: 10, total: 20, counts: streamCounts, indices, data: indices.map(index => streamRows[index]), done }) + '\n')
  await check('首批到达就通知页面，不等剩余响应；最后还原完整原始顺序', async () => {
    let output!: ReadableStreamDefaultController<Uint8Array>
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { output = controller } }), { headers: { 'Content-Type': 'application/x-ndjson' } })
    let loaded = 0, complete = false
    const request = fetchTracks((snapshot, progress) => { loaded = snapshot.data.length; assert.equal(progress.counts.all, 20) }).then(snapshot => { complete = true; return snapshot })
    await flush()
    const first = frame([19, ...Array.from({ length: 17 }, (_, index) => index)])
    output.enqueue(first.slice(0, first.length - 5))
    await flush()
    assert.equal(loaded, 0)
    output.enqueue(first.slice(first.length - 5))
    await flush()
    assert.equal(loaded, 18)
    assert.equal(complete, false)
    output.enqueue(frame([17, 18], true))
    output.close()
    assert.deepEqual((await request).data.map(row => row.bgmId), streamRows.map(row => row.bgmId))
  })
  await check('半份列表断流时保留可见卡片，但绝不能存成完整缓存', async () => {
    let output!: ReadableStreamDefaultController<Uint8Array>
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { output = controller } }), { headers: { 'Content-Type': 'application/x-ndjson' } })
    let length = 0, error = '', progress: TracksLoadProgress | null = null
    const stop = loadTracks('partial', rows => { length = rows.length; saveTracksCache('partial', rows) }, message => { error = message ?? '' }, value => { progress = value })
    await flush()
    output.enqueue(frame(Array.from({ length: 18 }, (_, index) => index)))
    await flush()
    const firstLength = length
    const savedPartial = storage.has('mt_cache:tracks:partial')
    output.close()
    await flush()
    assert.equal(firstLength, 18)
    assert.equal(savedPartial, false)
    assert.match(error, /传输中断/)
    assert.equal((progress as TracksLoadProgress | null)?.loading, false)
    assert.equal(storage.has('mt_cache:tracksServer:partial'), false)
    assert.equal(length, 18)
    stop()
  })
  await check('首批展示后修改进度，中止旧流并用新快照收口', async () => {
    let output!: ReadableStreamDefaultController<Uint8Array>
    let reads = 0, aborted = false, title = ''
    globalThis.fetch = async (_url, init) => {
      if (++reads > 1) return Response.json({ rev: 11, data: [{ ...streamRows[0], title: '最新修改' }] })
      return new Response(new ReadableStream({ start(controller) {
        output = controller
        init?.signal?.addEventListener('abort', () => { aborted = true; controller.error(init.signal?.reason) })
      } }), { headers: { 'Content-Type': 'application/x-ndjson' } })
    }
    const stop = loadTracks('mutation-stream', rows => { title = rows[0]?.title }, undefined, () => {})
    await flush()
    output.enqueue(frame(Array.from({ length: 18 }, (_, index) => index)))
    await flush()
    await runTracksMutation('mutation-stream', async () => {})
    await flush()
    assert.equal(aborted, true)
    assert.equal(title, '最新修改')
    assert.equal(reads, 2)
    stop()
  })
  await check('重开页面复用权威缓存，仅版本变化才拉全量，失败不周期探测', async () => {
    const data = [{ bgmId: 1, title: '权威标题', subjectType: 'anime' }]
    cacheSet('tracksServer:fixture', { rev: 7, data })
    cacheSet('tracks:fixture', [{ ...data[0], title: '未完成的乐观修改' }])
    const paths: string[] = []
    let revision = 7
    let fail = false
    globalThis.fetch = async url => {
      paths.push(String(url))
      if (fail) return Response.json({ error: '服务维护中' }, { status: 503 })
      return String(url).endsWith('/revision') ? Response.json({ rev: revision }) : Response.json({ rev: revision, data })
    }
    let visibleTitle = ''
    const stop = loadTracks('fixture', rows => { visibleTitle = rows[0]?.title })
    assert.equal(visibleTitle, '权威标题')
    await flush()
    assert.deepEqual(paths, ['/api/tracks/revision'])
    revision = 8
    for (const callback of intervals.values()) callback()
    await flush()
    assert.deepEqual(paths, ['/api/tracks/revision', '/api/tracks/revision', '/api/tracks'])
    fail = true
    for (const callback of intervals.values()) callback()
    await flush()
    const failureCount = paths.length
    for (const callback of intervals.values()) callback()
    await flush()
    assert.equal(paths.length, failureCount)
    assert.equal(visibleTitle, '权威标题')
    stop()
    assert.equal(intervals.size, 0)
  })
  await check('周历写入成功后立即更新共享列表，切页不等待卡住的全量校验', async () => {
    cacheSet('tracksServer:calendar-add', { rev: 1, data: [] })
    let finish!: (response: Response) => void
    globalThis.fetch = async (url, init) => {
      assert.equal(init?.cache, 'no-store')
      if (String(url).endsWith('/revision')) return Response.json({ rev: 1 })
      return new Promise((resolve, reject) => {
        finish = resolve
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    }
    let calendar: Track[] = [], list: Track[] = []
    const stopCalendar = loadTracks('calendar-add', rows => { calendar = rows })
    await flush()
    const saved = { ...streamRows[0], title: '世界最强的魔女，就此开始', episode: 0 } as Track
    await runTrackMutation('calendar-add', saved.bgmId, async () => saved)
    assert.equal(calendar[0]?.title, saved.title)
    assert.equal(cachePeek<Track[]>('tracks:calendar-add')?.[0]?.title, saved.title)
    const stopList = loadTracks('calendar-add', rows => { list = rows })
    assert.equal(list[0]?.title, saved.title)
    finish(Response.json({ rev: 2, data: [saved] }))
    await flush()
    assert.equal(list[0]?.title, saved.title)
    stopCalendar(); stopList()
  })
  await check('连续写入只发布最后的确认状态，失败加番不会留下幽灵条目', async () => {
    const saved = { ...streamRows[0], episode: 0 } as Track
    cacheSet('tracksServer:write-order', { rev: 1, data: [saved] })
    let revision = 1
    let server = [saved]
    globalThis.fetch = async url => String(url).endsWith('/revision')
      ? Response.json({ rev: revision }) : Response.json({ rev: revision, data: server })
    const episodes: number[] = []
    let rows: Track[] = []
    const stop = loadTracks('write-order', data => { rows = data; episodes.push(data[0]?.episode) })
    await flush()
    let first!: (track: Track) => void, second!: (track: Track) => void
    const a = runTrackMutation('write-order', saved.bgmId, () => new Promise(resolve => { first = resolve }))
    const b = runTrackMutation('write-order', saved.bgmId, () => new Promise(resolve => { second = resolve }))
    await flush()
    first({ ...saved, episode: 1 })
    await a; await flush()
    assert.deepEqual(episodes, [0])
    server = [{ ...saved, episode: 2 }]; revision++
    second(server[0])
    await b
    assert.equal(episodes.at(-1), 2)
    await flush()
    assert(!episodes.includes(1))
    await assert.rejects(runTrackMutation('write-order', 999, async () => { throw new Error('写入被拒绝') }), /写入被拒绝/)
    assert(!rows.some(track => track.bgmId === 999))
    await flush()
    await runTrackMutation('write-order', saved.bgmId, async () => { server = []; revision++ })
    assert.equal(rows.length, 0)
    stop()
  })
  await check('前台三秒检查版本，切回页面立即发现另一浏览器的新条目', async () => {
    cacheSet('tracksServer:other-browser', { rev: 1, data: [] })
    let revision = 1, rows: Track[] = []
    const saved = { ...streamRows[0], title: '最强魔女' } as Track
    globalThis.fetch = async url => String(url).endsWith('/revision')
      ? Response.json({ rev: revision }) : Response.json({ rev: revision, data: [saved] })
    const stop = loadTracks('other-browser', data => { rows = data })
    await flush()
    assert.deepEqual([...intervalDelays.values()], [3_000])
    revision++
    fakeWindow.dispatchEvent(new Event('focus'))
    await flush(); await flush()
    assert.equal(rows[0]?.title, saved.title)
    stop()
  })
  await check('登录态读取 503 不误退出，只有 401 才清除账号', async () => {
    const { auth } = await import('../src/auth')
    globalThis.fetch = async () => Response.json({ id: 1, username: 'fixture', aiConfig: {} })
    await auth.init()
    assert.equal(auth.user?.username, 'fixture')
    globalThis.fetch = async () => Response.json({ error: '维护中' }, { status: 503 })
    await auth.init()
    assert.equal(auth.user?.username, 'fixture')
    globalThis.fetch = async () => Response.json({ error: '未登录' }, { status: 401 })
    await auth.init()
    assert.equal(auth.user, null)
  })

  process.env.NODE_ENV = 'production'
  process.env.DATA_DIR = directory
  process.env.AUTH_SECRET = randomBytes(48).toString('hex')
  process.env.EMAIL_MODE = 'disabled'
  for (const key of Object.keys(process.env)) if (/^(SENTRY_|VITE_SENTRY_|SMTP_|MAPLETOOLS_ENV_FILE$)/.test(key)) delete process.env[key]
  const index = new Database(join(directory, 'bgm_index.db'))
  index.exec("CREATE TABLE anime (bgm_id INTEGER PRIMARY KEY, name TEXT, name_cn TEXT, aliases TEXT, date TEXT, score REAL); CREATE TABLE meta (k TEXT, v TEXT)")
  index.prepare('INSERT INTO anime VALUES (?,?,?,?,?,?)').run(633618, 'Unanswered//butterfly', '寂静不语的蝴蝶', '[]', '2026-01-01', 3.4)
  index.close()
  const { default: app } = await import('../server/index')
  await check('真实后端首帧 18 条、完整统计、禁止 nginx 缓冲、与旧 JSON 快照一致', async () => {
    const { db } = await import('../server/db')
    const { Hono } = await import('hono')
    const { issueSession } = await import('../server/auth')
    const uid = Number(db.prepare('INSERT INTO users(username,pass_hash,created_at) VALUES(?,?,?)').run('stream-fixture', 'unused', new Date().toISOString()).lastInsertRowid)
    const insert = db.prepare('INSERT INTO tracks(user_id,bgm_id,title,status,air_weekday,air_date) VALUES(?,?,?,?,?,?)')
    for (let index = 0; index < 240; index++) insert.run(uid, index + 1, `番剧${index}`, 'watching', index === 0 ? 5 : 0, new Date().toISOString().slice(0, 10))
    const issuer = new Hono().get('/', async c => { await issueSession(c, { uid, username: 'stream-fixture', tv: 0 }); return c.text('ok') })
    const cookie = (await issuer.request('/')).headers.get('set-cookie')!.split(';')[0]
    const response = await app.request('/api/tracks', { headers: { Cookie: cookie, Accept: 'application/x-ndjson', 'X-Calendar-Day': '5' } })
    assert.equal(response.headers.get('X-Accel-Buffering'), 'no')
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    const packets = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(packets[0].data.length, 18)
    assert.equal(packets[0].counts.all, 240)
    assert.equal(packets[0].data[0].bgmId, 1)
    assert.equal(packets.at(-1).done, true)
    const whole = await (await app.request('/api/tracks', { headers: { Cookie: cookie } })).json()
    const ordered = packets.flatMap(packet => packet.data.map((row: unknown, offset: number) => ({ row, index: packet.indices[offset] as number }))).sort((a, b) => a.index - b.index).map(item => item.row)
    assert.deepEqual(ordered, whole.data)
  })
  await check('已确认的稀饭 / Girigiri 片源不等待外网周表', async () => {
    const xifan = await import('../server/xifan/bindings')
    const girigiri = await import('../server/girigiri/bindings')
    xifan.putBinding(633618, 123, '测试片源')
    girigiri.putBinding(633618, '123', '测试片源')
    calls = 0
    globalThis.fetch = async () => { calls++; throw new Error('周表不可达') }
    const body = JSON.stringify({ bgmId: 633618, titles: ['蝴蝶'] })
    for (const source of ['xifan', 'girigiri']) {
      const response = await app.request(`/api/${source}/locate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      assert.equal(response.status, 200)
      assert.ok((await response.json()).bound)
    }
    assert.equal(calls, 0)
  })
  await check('离线搜索有结果 / 无结果均不向 BGM 发请求', async () => {
    calls = 0
    globalThis.fetch = async () => { calls++; throw new Error('不允许外网请求') }
    const found = await app.request('/api/search?q=' + encodeURIComponent('蝴蝶'))
    assert.equal(found.status, 200)
    assert.equal((await found.json()).data[0].bgmId, 633618)
    const missing = await app.request('/api/search?q=missing')
    assert.deepEqual((await missing.json()).data, [])
    assert.equal(calls, 0)
  })
  await check('图片中途断流必须返回不可缓存的失败，不能返回半张 200', async () => {
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.error(new Error('fixture truncated image'))
      },
    }), { headers: { 'Content-Type': 'image/jpeg' } })
    const response = await app.request('/api/cover/pic/cover/l/test.jpg')
    assert.equal(response.status, 502)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
  })
  await check('完整图片字节与缓存头一起返回', async () => {
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } })
    const response = await app.request('/api/cover/pic/cover/l/test.jpg')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('Cache-Control') ?? '', /immutable/)
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3])
  })
  await check('官方封面地址解析后只重定向到本机白名单代理，并缓存元数据', async () => {
    calls = 0
    globalThis.fetch = async () => {
      calls++
      return Response.json({ images: { common: 'https://lain.bgm.tv/r/400/pic/cover/l/test.jpg' } })
    }
    for (let i = 0; i < 2; i++) {
      const response = await app.request('/api/subject-cover/633618')
      assert.equal(response.status, 302)
      assert.equal(response.headers.get('Location'), '/api/cover/r/400/pic/cover/l/test.jpg')
    }
    assert.equal(calls, 1)
  })
  const { db } = await import('../server/db')
  db.close()
  // 索引只读句柄在 Windows 上仍可能持有文件；随进程退出释放，清理由下一轮临时目录回收负责。
  console.log(`${checks} checks passed; isolated fixture: ${directory}`)
} finally {
  globalThis.fetch = originalFetch
  process.env = originalEnv
  if (resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/')) {
    try { rmSync(directory, { recursive: true, force: true }) } catch { /* Windows 只读索引句柄尚未释放。 */ }
  }
}
