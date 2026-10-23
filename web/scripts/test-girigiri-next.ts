import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'production'
process.env.AUTH_SECRET = randomBytes(48).toString('hex')
const directory = mkdtempSync(join(tmpdir(), 'girigiri-next-test-'))
process.env.DATA_DIR = directory
const realFetch = globalThis.fetch
const fixture = JSON.parse(readFileSync(new URL('./fixtures/girigiri-next.json', import.meta.url), 'utf8')) as {
  detail: Record<string, { vod_id: number; vod_name: string; vod_play_from: string; vod_play_url: string }>
  search: { total: number; rows: Record<string, unknown>[] }
  week: unknown[]
}
const requests: URL[] = []
let checks = 0
let handler: (url: URL) => Response | Promise<Response> = () => { throw new Error('UNEXPECTED_UPSTREAM') }
const json = (info: unknown, code: number | string = 1, msg = '获取成功', status = 200): Response =>
  new Response(JSON.stringify({ code, msg, info }), { status, headers: { 'Content-Type': 'application/json' } })
const normal = (url: URL): Response => {
  if (url.pathname.endsWith('/Vod/get_detail')) return json(fixture.detail[url.searchParams.get('vod_id') ?? ''])
  if (url.pathname.endsWith('/Vod/get_list')) return json(fixture.search)
  if (url.pathname.endsWith('/App2/weekList')) return json(fixture.week)
  throw new Error('UNEXPECTED_PATH:' + url.pathname)
}
async function check(name: string, fn: () => unknown): Promise<void> {
  await fn()
  checks++
  console.log(`PASS G${String(checks).padStart(2, '0')} ${name}`)
}
if (!process.argv.includes('--live')) {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://m3u8.girigirilove.com')
    assert.equal(init?.redirect, 'manual')
    assert(init?.signal)
    assert(!new Headers(init?.headers).has('cookie'))
    requests.push(url)
    return handler(url)
  }
}
try {
  const api = await import('../server/girigiri/api')
  const { getPlaylist, resolveLine, getSourcePageUrl } = await import('../server/girigiri/resolve')
  const { searchGirigiri, getGirigiriCaptcha, verifyGirigiriCaptcha } = await import('../server/girigiri/search')
  const { fetchWeekday } = await import('../server/girigiri/weekday')
  if (process.argv.includes('--live')) {
    const search = await searchGirigiri(1, '死神')
    assert(!search.needsCaptcha && search.data.some(h => h.girigiriId === 'GV26595'))
    const bleach = await getPlaylist('GV26595', 53)
    assert.equal(bleach.first?.kind, 'mp4')
    assert.equal(bleach.eps.length, 366)
    const student = await getPlaylist('GV27203', 2)
    assert.equal(student.first?.kind, 'hls')
    assert.equal((await resolveLine('GV27203', 2, 2))?.source, 2)
    const week = await fetchWeekday()
    assert(week.length > 0)
    console.log(JSON.stringify({ live: true, searchHits: search.data.length, bleach: { title: bleach.title, episodes: bleach.eps.length, first: bleach.first }, student, sourcePage: await getSourcePageUrl('GV26595', 53), weekday: week.length }))
  } else {
    handler = normal
    await check('死神搜索返回15项，旧GV绑定保持不变', async () => {
      const result = await searchGirigiri(9, ' 死神 ')
      assert(!result.needsCaptcha)
      assert.equal(result.data.length, 15)
      assert(result.data.some(h => h.girigiriId === 'GV26595' && h.girigiriName === '死神'))
      assert.equal(requests[0].searchParams.get('vod_name'), '死神')
    })
    await check('同番同集/不同集并发单飞；MP4第53集和366集网格恢复', async () => {
      const before = requests.length
      const [a, b, c] = await Promise.all([getPlaylist('GV26595', 53), getPlaylist('gv26595', 54), resolveLine('GV26595', 53, 1)])
      assert.equal(requests.length - before, 1)
      assert.equal(a.title, '死神')
      assert.equal(a.eps.length, 366)
      assert.equal(a.first?.url, 'https://ana.girigirilove.com/zijian/oldanime/2024/0607/Bleach/53.mp4')
      assert.equal(a.first.kind, 'mp4')
      assert.match(b.first!.url, /54\.mp4$/)
      assert.deepEqual(a.first, c)
    })
    await check('新源站跳转使用零基索引，53集不是episodeIndex=53', async () => {
      assert.equal(await getSourcePageUrl('GV26595', 53), 'https://ani.girigirilove.com/play/26595?sourceIndex=0&episodeIndex=52')
    })
    await check('HLS两条线路同一详情，手动切线不重复请求', async () => {
      const before = requests.length
      const playlist = await getPlaylist('GV27203', 2)
      assert.deepEqual(playlist.lines, [{ source: 1, name: '繁中' }, { source: 2, name: '简中' }])
      assert.equal(playlist.first?.kind, 'hls')
      assert.deepEqual(playlist.eps, [1, 2, 3])
      assert.match((await resolveLine('GV27203', 2, 2))!.url, /SeitokainimoAnawaAru\/02\/playlist\.m3u8$/)
      assert.equal(requests.length - before, 1)
    })
    await check('缺集返回null，外跳明确报缺集，不偷换第一集', async () => {
      assert.equal(await resolveLine('GV27203', 999, 2), null)
      assert.equal(await resolveLine('GV27203', 2, 99), null)
      await assert.rejects(getSourcePageUrl('GV27203', 999), (e: unknown) => e instanceof api.GirigiriError && e.code === 'GIRIGIRI_EPISODE_NOT_FOUND')
    })
    await check('集号按标签匹配，空线路/PV不致使外跳错位，URL中的$保留', async () => {
      const d = api.parseDetail({ vod_id: 101, vod_name: '夹具', vod_play_from: 'empty$$$cht$$$chs', vod_play_url: '$$$PV$https://media.example/pv.mp4#01$https://media.example/one.mp4#03$https://media.example/three.mp4?token=a$b$$$01$https://media.example/1.mp4' }, 'GV101')
      assert.deepEqual(d.sources[0].episodes.map(e => e.number), [null, 1, 3])
      assert.equal(d.sources[0].episodes[2].url, 'https://media.example/three.mp4?token=a$b')
      assert.equal(api.sourcePageUrl(d, 3), 'https://ani.girigirilove.com/play/101?sourceIndex=0&episodeIndex=2')
      assert.throws(() => api.sourcePageUrl(d, 2), /没有第 2 集/)
      handler = () => json({ vod_id: 108, vod_name: '缺集夹具', vod_play_from: 'chs', vod_play_url: '01$https://media.example/1.mp4#03$https://media.example/3.mp4' })
      assert.match((await resolveLine('GV108', 3, 1))!.url, /3\.mp4$/)
      assert.equal(await resolveLine('GV108', 2, 1), null)
    })
    await check('单集电影正片映射为1，OVA/PV不冒充正片', () => {
      for (const [label, expected] of [['正片', 1], ['OVA', null], ['PV', null]] as const) {
        assert.equal(api.parseDetail({ vod_id: 102, vod_name: '电影', vod_play_from: 'chs', vod_play_url: `${label}$https://media.example/v.mp4` }, 'GV102').sources[0].episodes[0].number, expected)
      }
    })
    await check('不安全媒体地址不签发；详情ID/线路结构异常显式报错', async () => {
      handler = () => json({ vod_id: 103, vod_name: '夹具', vod_play_from: 'chs', vod_play_url: '01$javascript:alert(1)' })
      await assert.rejects(getPlaylist('GV103', 1), /无效的媒体地址/)
      assert.throws(() => api.parseDetail({ vod_id: 999, vod_name: '错番', vod_play_from: '', vod_play_url: '' }, 'GV104'), /编号不匹配/)
      assert.throws(() => api.parseDetail({ vod_id: 104, vod_name: '夹具', vod_play_from: 'cht$$$chs', vod_play_url: '01$x' }, 'GV104'), /数量不一致/)
    })
    await check('无效入参不访问源站，旧验证码端点不触发旧抓取', async () => {
      const before = requests.length
      assert.throws(() => api.getDetail('GV0'))
      assert.throws(() => api.getDetail('GV9007199254740993'))
      await assert.rejects(getPlaylist('GV26595', 0))
      await assert.rejects(resolveLine('GV26595', 1, 0))
      await assert.rejects(searchGirigiri(1, ''))
      await assert.rejects(searchGirigiri(1, 'x'.repeat(101)))
      await assert.rejects(getGirigiriCaptcha(1), /无需验证码/)
      await assert.rejects(verifyGirigiriCaptcha(1, 'abcd'), /无需验证码/)
      assert.equal(requests.length, before)
    })
    await check('搜索offset按原始条数推进，去重且保留站外封面', async () => {
      const before = requests.length
      handler = url => url.searchParams.get('offset') === '0'
        ? json({ total: 3, rows: [{ vod_id: 1, vod_name: '一', vod_pic: 'upload/a.webp' }, { vod_id: 2, vod_name: '二' }] })
        : json({ total: 3, rows: [{ vod_id: 2, vod_name: '二' }] })
      const result = await searchGirigiri(1, '分页')
      assert(!result.needsCaptcha)
      assert.equal(result.data.length, 2)
      assert.equal(result.data[0].cover, 'https://jpg.girigirilove.net/upload/a.webp')
      assert.equal(requests.at(-1)!.searchParams.get('offset'), '2')
      assert.equal(requests.length - before, 2)
    })
    await check('只有total=0的合法结果报空；缺字段/坏页/重复分页均抛错', async () => {
      handler = () => json({ total: 0, rows: [] })
      const result = await searchGirigiri(1, '不存在')
      assert(!result.needsCaptcha && result.data.length === 0)
      for (const data of [{}, { total: 'nan', rows: [] }, { total: 2, rows: [] }, { total: 1, rows: [{ vod_name: '缺ID' }] }]) {
        handler = () => json(data)
        await assert.rejects(searchGirigiri(1, '坏数据'), api.GirigiriError)
      }
      handler = () => json({ total: 10, rows: [{ vod_id: 1, vod_name: '同一页' }] })
      const before = requests.length
      await assert.rejects(searchGirigiri(1, '重复'), /分页重复/)
      assert.equal(requests.length - before, 2)
    })
    await check('429/503及业务码保留原因，每次调用只发一次，无自动重试', async () => {
      for (const [status, code, message] of [[429, 'DAILY_QUOTA_EXCEEDED', '今日额度用完'], [503, 'SERVICE_MAINTENANCE', '站点维护'], [200, 'SEARCH_BUSY', '搜索服务繁忙']] as const) {
        handler = () => json(null, code, message, status)
        const before = requests.length
        await assert.rejects(searchGirigiri(1, '死神'), (e: unknown) => e instanceof api.GirigiriError && e.code === code && e.message.includes(message))
        assert.equal(requests.length - before, 1)
      }
      handler = () => new Response(null, { status: 429 })
      await assert.rejects(searchGirigiri(1, '死神'), (e: unknown) => e instanceof api.GirigiriError && e.upstreamStatus === 429 && e.code === 'UPSTREAM_429')
      handler = () => new Response('cf-browser-verification', { status: 403 })
      await assert.rejects(searchGirigiri(1, '死神'), (e: unknown) => e instanceof api.GirigiriError && e.code === 'GIRIGIRI_BLOCKED' && e.upstreamStatus === 403)
    })
    await check('HTML壳/跨域跳转/超大响应/传输断开显式失败且不重试', async () => {
      for (const response of [new Response('<div id="app"></div>'), new Response('', { status: 302, headers: { Location: 'https://other.example/' } }), new Response('x', { headers: { 'Content-Length': String(3 * 1024 * 1024) } }), new Response('cf-browser-verification')]) {
        handler = () => response
        const before = requests.length
        await assert.rejects(searchGirigiri(1, '死神'), api.GirigiriError)
        assert.equal(requests.length - before, 1)
      }
      handler = () => { throw new Error('fetch failed') }
      const before = requests.length
      await assert.rejects(searchGirigiri(1, '死神'), /fetch failed/)
      assert.equal(requests.length - before, 1)
    })
    await check('失败详情不进缓存，用户下次主动请求可成功', async () => {
      handler = () => json(null, 'BUSY', '维护', 503)
      await assert.rejects(getPlaylist('GV105', 1))
      handler = () => json({ ...fixture.detail['27203'], vod_id: 105 })
      assert.equal((await getPlaylist('GV105', 1)).title, '学生会也有洞！')
    })
    await check('新周表一次请求返回七天，缓存/并发合并，不逐日探测', async () => {
      handler = normal
      const before = requests.length
      const [a, b] = await Promise.all([fetchWeekday(), fetchWeekday()])
      assert.deepEqual(a, b)
      assert(a.length > 0)
      assert(a.every(item => item.day >= 1 && item.day <= 7 && /^GV\d+$/.test(item.girigiriId)))
      assert.equal(requests.length - before, 1)
    })
    await check('HTTP层搜索、播放签名、外跳、认证和错误码真实路由回归', async () => {
      const { Hono } = await import('hono')
      const { db } = await import('../server/db')
      const { issueSession } = await import('../server/auth')
      const { default: giri } = await import('../server/girigiri')
      const { default: player } = await import('../server/player')
      const uid = Number(db.prepare('INSERT INTO users(username,pass_hash,created_at) VALUES(?,?,?)').run('fixture', 'unused', new Date().toISOString()).lastInsertRowid)
      const app = new Hono()
      app.get('/login', async c => { await issueSession(c, { uid, username: 'fixture', tv: 0 }); return c.text('fixture') })
      app.route('/api/girigiri', giri); app.route('/api/player', player)
      const cookie = (await app.request('/login')).headers.get('set-cookie')!.split(';')[0]
      const get = (url: string) => app.request(url, { headers: { Cookie: cookie } })
      const search = () => app.request('/api/girigiri/search', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ keyword: '死神' }) })
      handler = normal
      assert.equal((await app.request('/api/girigiri/source-page?animeId=GV26595&ep=53')).status, 401)
      assert.equal((await app.request('/api/player/playlist?src=girigiri&id=GV26595&ep=53')).status, 401)
      assert.equal((await get('/api/girigiri/source-page?animeId=GV26595&ep=53')).headers.get('location'), 'https://ani.girigirilove.com/play/26595?sourceIndex=0&episodeIndex=52')
      assert.equal((await get('/api/girigiri/source-page?animeId=GV27203&ep=999')).status, 404)
      const playlist = await (await get('/api/player/playlist?src=girigiri&id=GV27203&ep=2')).json() as { first: { s: string; kind: string }; eps: number[] }
      assert.equal(playlist.first.s.length, 32)
      assert.equal(playlist.first.kind, 'hls')
      assert.deepEqual(playlist.eps, [1, 2, 3])
      const empty = await get('/api/player/resolve?src=girigiri&id=GV27203&ep=999&source=2')
      assert.equal(empty.status, 404)
      assert.equal((await empty.json() as { code: string }).code, 'LINE_EMPTY')
      handler = () => json(null, 'DAILY_QUOTA_EXCEEDED', '今日额度用完', 429)
      const error = await search()
      assert.equal(error.status, 429)
      assert.equal((await error.json() as { code: string }).code, 'DAILY_QUOTA_EXCEEDED')
      const playbackError = await get('/api/player/playlist?src=girigiri&id=GV106&ep=1')
      assert.equal(playbackError.status, 429)
      assert.equal((await playbackError.json() as { code: string }).code, 'DAILY_QUOTA_EXCEEDED')
      db.close()
    })
    await check('详情30秒过期后重取，不沿用旧版一小时播放页缓存', async () => {
      handler = () => json({ ...fixture.detail['27203'], vod_id: 107 })
      const now = Date.now
      try {
        await getPlaylist('GV107', 1)
        const before = requests.length
        Date.now = () => now() + 31000
        await getPlaylist('GV107', 1)
        assert.equal(requests.length - before, 1)
      } finally { Date.now = now }
    })
    console.log(JSON.stringify({ checks, passed: true, upstreamFixtureRequests: requests.length, externalRequests: 0, mediaBytesDownloaded: 0 }))
  }
} finally {
  globalThis.fetch = realFetch
  rmSync(directory, { recursive: true, force: true })
}
