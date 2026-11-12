import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { createAgentUiFixture } from './agent-ui-fixture'

process.env.NODE_ENV = 'test'
process.env.AGENT_UI_FIXTURE = '1'
const fixture = await createAgentUiFixture()
fixture.db.prepare("UPDATE tracks SET cover='fixture-only', bgm_tags='[\"夹具\"]', aliases='[\"fixture\"]', air_date='2023-01-01', score=8").run()
const guardedFetch = globalThis.fetch
let mockedDetails = 0
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url === 'https://api.bgm.tv/v0/subjects/8302' && (!init?.method || init.method === 'GET')) {
    mockedDetails++
    return new Response(JSON.stringify({ name: '星旅 第二季', name_cn: '星旅 第二季', tags: [{ name: '夹具' }], infobox: [{ key: '别名', value: 'fixture' }], date: '2023-01-01', total_episodes: 12, rating: { score: 8 }, images: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return guardedFetch(input, init)
}
const index = new Database(join(process.cwd(), 'data/bgm_index.db'))
index.exec('CREATE TABLE anime (bgm_id INTEGER PRIMARY KEY, name TEXT, name_cn TEXT, aliases TEXT, date TEXT, score REAL, tags TEXT, nsfw INTEGER, eps INTEGER, votes INTEGER); CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)')
const add = index.prepare('INSERT INTO anime VALUES (?,?,?,?,?,?,?,?,?,?)')
for (const [id, title, nsfw] of [[8301, '星旅 第一季', 0], [8302, '星旅 第二季', 0], [8303, '星旅 小番外', 0], [8304, '星旅 不同演绎', 0], [8305, '受限关联夹具', 1]] as const) {
  add.run(id, title, title, '[]', '2023-01-01', 8, '[]', nsfw, 12, 100)
}
type Reply = { ready: boolean; source: { bgmId: number }; items: { bgmId: number; relation: string }[] }
const request = async (id: number) => {
  const response = await fixture.originalFetch(`${fixture.origin}/api/catalog/${id}/related`)
  return { status: response.status, data: response.status === 200 ? await response.json() as Reply : null }
}
try {
  const old = await request(8301)
  assert.equal(old.status, 200, 'RELATED_ENTRY_MUST_EXIST')
  assert.equal(old.data?.ready, false, 'old indexes must be distinct from no related works')
  index.exec('CREATE TABLE anime_relation (subject_id INTEGER, relation_type INTEGER, related_subject_id INTEGER, sort INTEGER, PRIMARY KEY(subject_id,relation_type,related_subject_id))')
  const insert = index.prepare('INSERT INTO anime_relation VALUES (?,?,?,?)')
  for (const row of [[8301,3,8302,0],[8301,6,8303,1],[8301,10,8304,2],[8301,3,8305,3],[8301,3,9999,4],[8301,3,8301,5],[8302,2,8301,0]]) insert.run(...row)
  const result = await request(8301)
  assert.equal(result.data?.ready, true)
  assert.deepEqual(result.data?.items.map(x => [x.bgmId, x.relation]), [[8302,'续集'],[8303,'番外篇'],[8304,'不同演绎']], 'RELATION_TARGET_VISIBILITY_AND_DIRECTION')
  assert.deepEqual((await request(8302)).data?.items.map(x => x.relation), ['前传'])
  assert.equal((await request(8303)).data?.items.length, 0)
  assert.equal((await request(8305)).status, 404)
  assert.equal((await request(9999)).status, 404)
  assert.equal((await request(-1)).status, 400)
  const login = await fixture.originalFetch(fixture.origin + '/__agent-test/login/alice', { redirect: 'manual' })
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  assert(cookie)
  const authenticated = await fixture.originalFetch(fixture.origin + '/api/catalog/8301/related', { headers: { Cookie: cookie } })
  const authenticatedData = await authenticated.json() as Reply
  assert(authenticatedData.items.some(item => item.bgmId === 8305), 'logged-in scope must retain its own visibility rules')
  assert.equal(fixture.metrics.externalRequests, 0)
  assert.equal(fixture.metrics.modelCalls, 0)
  console.log('PASS old-index, direction, self/missing target, guest source/target visibility, empty and invalid id')
  console.log('RELATED_ANIME_COMPLETE; externalRequests=0; modelCalls=0')
  if (process.argv.includes('--serve')) {
    console.log(JSON.stringify({ browserUrl: fixture.browserOrigin, localFixture: true }))
    await new Promise<void>(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve) })
  }
} finally {
  if (process.env.UX_RUN_DIR) writeFileSync(join(process.env.UX_RUN_DIR, 'related-fixture-final.json'), JSON.stringify({ metrics: fixture.metrics, mockedDetails, addedRows: fixture.db.prepare('SELECT bgm_id,status,episode FROM tracks WHERE user_id=? AND bgm_id=8302').all(fixture.alice) }, null, 2))
  index.close(); await fixture.close()
}
