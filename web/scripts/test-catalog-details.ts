import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { createAgentUiFixture } from './agent-ui-fixture'

process.env.NODE_ENV = 'test'
process.env.AGENT_UI_FIXTURE = '1'
const webRoot = fileURLToPath(new URL('../', import.meta.url))
const fixture = await createAgentUiFixture()
// 用户明确加番后的既有元数据补全也只读合成响应，浏览简介本身不应走到这里
const blockedFetch = globalThis.fetch
let syntheticSubjectReads = 0
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.hostname === 'api.bgm.tv' && /^\/v0\/subjects\/(101|102|103|104|810[1-6])$/.test(url.pathname)) {
    syntheticSubjectReads++
    return new Response(JSON.stringify({ id: Number(url.pathname.split('/').pop()), name: '合成作品', name_cn: '合成作品', images: {}, tags: [{ name: '冒险' }], infobox: [{ key: '别名', value: '合成别名' }], date: '2023-09-29', rating: { score: 8 }, total_episodes: 28 }), { headers: { 'Content-Type': 'application/json' } })
  }
  return blockedFetch(input, init)
}
const data = process.env.DATA_DIR!
const archive = join(data, 'subject.jsonlines')
const summary = '勇者一行结束旅途后，精灵魔法使踏上理解人类的新旅程。\n\n本段为合成验收简介，不代表官方原文。<script>window.catalogInjected=1</script>'
const rows = [
  { id: 8101, name: 'Sousou no Frieren', name_cn: '葬送的芙莉莲', summary, infobox: '|别名= 芙莉莲的旅程' },
  { id: 8102, name: 'Frieren Two', name_cn: '葬送的芙莉莲 第二季', summary: '第二段合成旅程，仅用于区分作品，不能串到第一季' },
  { id: 8103, name: 'Frieren Short', name_cn: '葬送的芙莉莲 短篇', summary: '' },
  { id: 8104, name: 'Long Text', name_cn: '长简介夹具', summary: '甲'.repeat(24000) },
  { id: 8105, name: 'Restricted', name_cn: '受限夹具', summary: 'restricted-summary', nsfw: true },
  { id: 8106, name: 'Tag Restricted', name_cn: '标签受限夹具', summary: 'tag-restricted', tags: ['R18'] },
]
writeFileSync(archive, rows.map(row => JSON.stringify({ type: 2, tags: ['冒险'], score: 8, date: '2023-09-29', ...row })).join('\n'))
const build = spawnSync('npm', ['run', 'sync:index', '--', '--file', archive], { cwd: webRoot, env: process.env, encoding: 'utf8' })
process.stdout.write(build.stdout); process.stderr.write(build.stderr)
assert.equal(build.status, 0, 'LOCAL_ARCHIVE_BUILD')
const request = async (id: string, cookie = '') => {
  const res = await fixture.originalFetch(`${fixture.origin}/api/catalog/${id}/details`, { headers: cookie ? { cookie } : {} })
  return { status: res.status, text: await res.text(), cache: res.headers.get('cache-control') }
}
if (process.argv.includes('--serve')) {
  console.log(JSON.stringify({ browserUrl: fixture.browserOrigin, fixtureOnly: true, data }))
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void fixture.close().then(() => process.exit(0)) })
} else {
  try {
    const first = await request('8101')
    assert.equal(first.status, 200, 'PUBLIC_DETAILS_MUST_EXIST')
    assert.equal(first.cache, 'no-store')
    const detail = JSON.parse(first.text)
    assert.equal(detail.summary, summary)
    assert.equal(detail.summaryStatus, 'available')
    assert.deepEqual(detail.aliases, ['芙莉莲的旅程'])
    assert.equal(detail.item.bgmId, 8101)
    assert(!first.text.includes('goodEpisodeNotes') && !first.text.includes('edited'))
    assert.equal(JSON.parse((await request('8102')).text).summary, rows[1].summary)
    assert.equal(JSON.parse((await request('8103')).text).summaryStatus, 'empty')
    assert.equal(JSON.parse((await request('8104')).text).summary.length, 20000)
    console.log('PASS archive import, per-ID summary/aliases, empty and bounded text, no private material')
    for (const id of ['8105', '8106', '999999']) assert.equal((await request(id)).status, 404, 'GUEST_VISIBILITY_MUST_MATCH_CATALOG')
    for (const id of ['0', '-1', '1.2', 'bad']) assert.equal((await request(id)).status, 400)
    const login = await fixture.originalFetch(fixture.origin + '/__agent-test/login/alice', { redirect: 'manual' })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    assert.equal((await request('8105', cookie)).status, 200)
    assert.equal((await request('8105')).status, 404, 'GUEST_AFTER_AUTH_MUST_NOT_INHERIT_PRIVATE_VISIBILITY')
    const catalog = await fixture.originalFetch(fixture.origin + '/api/catalog')
    const list = await catalog.json() as { items: object[] }
    assert(list.items.every(item => !('summary' in item) && !('aliases' in item)))
    assert.equal(syntheticSubjectReads, 0, 'DETAIL_READ_MUST_NOT_FETCH_SUBJECT')
    const { saveCatalogText } = await import('../server/bgm/catalog')
    saveCatalogText(8101, { nameCn: '管理员更正片名', tags: ['奇幻'] })
    const edited = JSON.parse((await request('8101')).text)
    assert.equal(edited.item.nameCn, '管理员更正片名')
    assert.deepEqual(edited.item.tags, ['奇幻'])
    saveCatalogText(8101, { nameCn: null, tags: null })
    console.log('PASS visibility, invalid IDs, authenticated/guest separation, overrides and lean list payload')
    const index = new Database(join(data, 'bgm_index.db'))
    index.exec('ALTER TABLE anime DROP COLUMN summary'); index.close()
    assert.equal(JSON.parse((await request('8101')).text).summaryStatus, 'unavailable', 'LEGACY_SCHEMA_MUST_NOT_PRETEND_EMPTY')
    assert.equal((await request('8105')).status, 404)
    const missing = new Database(join(data, 'bgm_index.db')); missing.exec('DROP TABLE anime'); missing.close()
    assert.equal(JSON.parse((await request('8101')).text).code, 'CATALOG_NOT_READY')
    assert.equal(fixture.metrics.externalRequests, 0)
    assert.equal(fixture.metrics.modelCalls, 0)
    console.log('PASS legacy schema and unready index; zero external/model requests')
    console.log('CATALOG_DETAILS_COMPLETE')
  } finally { await fixture.close() }
}
