import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { NextClient, NextError, NEXT_API, NEXT_ORIGIN, NEXT_PUBLIC_KEY, nextAnimeId, nextPage, parseNextDetail, type NextAuth, type NextResponse, type NextTransport } from '../shared/xifan-next'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/xifan-next.json', import.meta.url), 'utf8'))
function html(data: unknown): string {
  const flight = `1:${JSON.stringify(['$', 'section', null, data])}\n`
  return [flight.slice(0, 91), flight.slice(91)].map(s => `<script>self.__next_f.push(${JSON.stringify([1, s])})</script>`).join('')
}
const detailHtml = html(fixture.detail)
const detail = parseNextDetail(detailHtml, 3412)
assert.equal(detail.title, 'LV999的村民')
assert.deepEqual(detail.sources.map(s => s.id), [4, 1, 2])
assert.equal(nextPage(detail, 2, 4), `${NEXT_ORIGIN}/anime/3412/play/121198?source=xfxf1`)
assert.equal(nextAnimeId(`${NEXT_ORIGIN}/anime/3412`), 3412)
assert.throws(() => nextAnimeId('https://anime.xifanacg.com/watch/3535/1/1.html'), /重新搜索/)
assert.throws(() => nextAnimeId('https://evil.test/anime/3412'))
assert.throws(() => parseNextDetail(detailHtml, 999))
const missing = structuredClone(fixture.detail)
missing.sources[1].episodes.splice(0, 1)
assert.equal(parseNextDetail(html(missing), 3412).sources[1].episodes[0].number, 2)
assert.throws(() => nextPage(parseNextDetail(html(missing), 3412), 1, 1), /尚未提供/)
const special = structuredClone(fixture.detail)
special.sources[0].episodes.push({ id: 999999, kind: 'special', episode_number: 0, title: 'OVA' })
assert.equal(parseNextDetail(html(special), 3412).sources[0].episodes.at(-1)?.number, 13)

const calls: { url: string; headers: Record<string, string>; body?: string }[] = []
const transport: NextTransport = async (url, _method, headers, body) => {
  calls.push({ url, headers, body })
  if (url.endsWith('/anime/3412')) return { status: 200, body: detailHtml }
  if (url.endsWith('/schedule')) return { status: 200, body: html({ schedule: fixture.schedule }) }
  if (url.endsWith('/search_animes')) return { status: 200, body: JSON.stringify(fixture.search) }
  if (url.endsWith('/issue-web-playback')) return { status: 200, body: JSON.stringify(fixture.playback) }
  throw new Error(`unexpected request ${url}`)
}
const client = new NextClient(transport, async () => null, async () => {})
assert.equal((await client.search('花织'))[0].id, 3393)
assert.equal((await client.schedule())[0].day, 1)
await Promise.all([client.detail(3412), client.detail(3412)])
assert.equal(calls.filter(c => c.url.endsWith('/anime/3412')).length, 1)
const media = await client.playback(3412, 1, 4)
assert.equal(media.url, 'https://apn.moedot.net/d/wo/2607/LV01.mp4')
assert.deepEqual(JSON.parse(calls.at(-1)!.body!), { action: 'fallback', episode_id: 121197, source_id: 4 })
assert(calls.filter(c => c.url.startsWith(NEXT_API)).every(c => c.headers.apikey === NEXT_PUBLIC_KEY && !c.headers.Authorization))
for (const status of [401, 403, 429, 503]) {
  let count = 0
  const bad = new NextClient(async () => { count++; return { status, body: JSON.stringify({ error: status === 429 ? 'rate_limited' : 'upstream_error' }), retryAfter: '60' } }, async () => null, async () => {})
  await assert.rejects(bad.search('花织'), (e: unknown) => e instanceof NextError && e.status === status)
  assert.equal(count, 1)
}
let pageCount = 0
const paged = new NextClient(async () => {
  pageCount++
  return { status: 200, body: JSON.stringify([{ ...fixture.search[0], id: pageCount, total_count: 2 }]) }
}, async () => null, async () => {})
assert.deepEqual((await paged.search('番')).map(h => h.id), [1, 2])

let auth: NextAuth | null = { access_token: 'old', refresh_token: 'refresh', expires_at: 0 }
const fresh: NextAuth = { access_token: 'new', refresh_token: 'new-refresh', expires_at: Date.now() / 1000 + 3600 }
let refreshCount = 0
const authClient = new NextClient(async (url, _method, headers) => {
  if (url.includes('grant_type=refresh_token')) { refreshCount++; return { status: 200, body: JSON.stringify(fresh) } }
  if (url.endsWith('/auth/v1/user')) { assert.equal(headers.Authorization, 'Bearer new'); return { status: 200, body: '{"id":"user-a"}' } }
  if (url.includes('/logout')) return { status: 204, body: '' }
  return transport(url, 'GET', headers)
}, async () => auth, async value => { auth = value })
await Promise.all([authClient.auth(), authClient.auth()])
assert.equal(refreshCount, 1)
assert.equal(await authClient.status(), true)
await authClient.detail(3412)
assert(calls.at(-1)!.headers.Cookie.includes('sb-rzmsnqblptbceicadbyd-auth-token'))
await authClient.logout()
assert.equal(auth, null)
let completeLogin: (value: NextResponse) => void = () => {}
const raced = new NextClient(async () => new Promise(resolve => { completeLogin = resolve }), async () => null, async value => { auth = value })
const pending = raced.login('fixture@example.test', 'fixture')
await raced.logout()
completeLogin({ status: 200, body: JSON.stringify(fresh) })
await assert.rejects(pending, /状态已改变/)
assert.equal(auth, null)
console.log('PASS: 新站搜索/分页、分片详情、稳定线路与剧集ID、缺集/OVA、周表、播放地址、旧编号拒绝、单飞、401/403/429/503不重试、刷新/退出竞态')
