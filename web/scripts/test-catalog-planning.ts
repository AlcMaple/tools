import assert from 'node:assert/strict'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { exactDate, explicitEndDate, matchesPlanning } from '../shared/catalog-planning'
import { createAgentUiFixture } from './agent-ui-fixture'

process.env.NODE_ENV = 'test'
process.env.AGENT_UI_FIXTURE = '1'
const repoWeb = process.cwd()
const fixture = await createAgentUiFixture()
const path = join(process.cwd(), 'data/bgm_index.db')
const index = new Database(path)
index.exec('CREATE TABLE anime (bgm_id INTEGER PRIMARY KEY, name TEXT, name_cn TEXT, aliases TEXT, date TEXT, score REAL, tags TEXT, nsfw INTEGER, eps INTEGER, votes INTEGER, end_date TEXT); CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)')
index.prepare('INSERT INTO meta VALUES (?,?)').run('built_at', String(Date.now()))
const add = index.prepare('INSERT INTO anime VALUES (?,?,?,?,?,?,?,?,?,?,?)')
for (const [id, name, eps, end, nsfw, tags] of [
  [8101, '周末候选 · 午后小憩', 12, '2020-03-28', 0, ['治愈']],
  [8102, '周末候选 · 漫长旅途', 26, '2020-03-28', 0, ['治愈']],
  [8103, '周末候选 · 仍在连载', 12, '2099-03-28', 0, ['治愈']],
  [8104, '周末候选 · 状态未知', 12, '', 0, ['治愈']],
  [8105, '周末候选 · 集数未知', 0, '2020-03-28', 0, ['治愈']],
  [8106, '周末候选 · 访客不可见', 12, '2020-03-28', 1, ['治愈']],
  [8107, '周末候选 · 欢乐短片', 1, '2020-03-28', 0, ['搞笑']],
] as const) add.run(id, name, name, '[]', '2020-01-01', 8, JSON.stringify(tags), nsfw, eps, 100, end)
index.close()
if (process.argv.includes('--serve')) {
  console.log(JSON.stringify({ browserUrl: fixture.browserOrigin, dataDir: process.env.DATA_DIR, syntheticCatalog: true }))
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { console.log(JSON.stringify(fixture.metrics)); void fixture.close().then(() => process.exit(0)) })
} else {
  try {
    assert.equal(explicitEndDate('|播放结束=2020年3月28日', '2020-01-01'), '2020-03-28')
    assert.equal(explicitEndDate('|放送结束=2020-03-28', '2020-01-01'), '2020-03-28')
    for (const raw of ['', '|播放结束=2020年3月', '|播放结束=2020-02-30', '|播放结束=2019-12-31', '|播放结束=2020-03-28（予定）', '|播放结束={ [2020-03-28] }', '|播放结束=2020-03-28\n|放送结束=2020-04-01']) assert.equal(explicitEndDate(raw, '2020-01-01'), '', 'AMBIGUOUS_END_STAYS_UNKNOWN')
    assert.equal(exactDate('2020年3-28'), '')
    assert.equal(exactDate('2020-02-29'), '2020-02-29')
    assert.equal(matchesPlanning(12, '2020-03-28', 13, true, '2020-03-28'), false, 'ENDING_TODAY_NOT_YET_FINISHED')
    assert.equal(matchesPlanning(12, '2020-03-28', 13, true, '2020-03-29'), true)
    assert.equal(matchesPlanning(7, '', 13, true, '2026-11-13'), false)
    console.log('PASS exact wiki dates, invalid/conflicting dates, unknowns and day boundary')
    const request = async (values: Record<string, string>) => {
      const response = await fixture.originalFetch(fixture.origin + '/api/catalog?' + new URLSearchParams(values))
      return { status: response.status, data: await response.json() as { total: number; planningReady: boolean; items: { bgmId: number }[] } }
    }
    const filters = { maxEps: '13', finished: '1', include: '["治愈"]' }
    assert.deepEqual((await request(filters)).data.items.map(i => i.bgmId), [8101], 'ONLY_KNOWN_SHORT_FINISHED_VISIBLE_CANDIDATE')
    assert.equal((await request({})).data.planningReady, true)
    console.log('PASS combined length / finished / genre / visibility')
    assert.equal((await request({})).data.total, 6)
    assert.equal((await request({ maxEps: '13' })).data.total, 4)
    assert.equal((await request({ finished: '1' })).data.total, 4)
    assert.equal((await request({ ...filters, year: '2019' })).data.total, 0)
    assert.equal((await request({ ...filters, exclude: '["治愈"]' })).data.total, 0)
    assert.equal((await request({ maxEps: '13', finished: '1', limit: '1', offset: '1' })).data.items.length, 1)
    for (const bad of ['-1', '1.5', '12', 'abc', 'Infinity']) assert.equal((await request({ maxEps: bad })).status, 400)
    assert.equal((await request({ finished: 'yes' })).status, 400)
    const more = new Database(path)
    const insert = more.prepare('INSERT INTO anime VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    more.transaction(() => { for (let n = 0; n < 125; n++) insert.run(9000+n, '周末候选高分'+n, '周末候选高分'+n, '[]', '2020-01-01', 10, '["治愈"]', 0, 100, 100, '2020-03-28') })()
    more.close()
    assert.deepEqual((await request({ ...filters, q: '周末候选', sort: 'date' })).data.items.map(i => i.bgmId), [8101], 'PLANNING_FILTER_BEFORE_SEARCH_CAP')
    console.log('PASS reset, unknowns, pagination, input validation and before-search-cap filtering')
    const legacy = new Database(path)
    legacy.exec('ALTER TABLE anime DROP COLUMN end_date; ALTER TABLE anime DROP COLUMN eps')
    legacy.close()
    assert.equal((await request(filters)).data.planningReady, false)
    assert.equal((await request(filters)).data.total, 0, 'LEGACY_INDEX_MUST_NOT_CLAIM_FINISHED')
    assert.equal((await request({})).data.total, 131)
    assert.equal(fixture.metrics.externalRequests, 0)
    assert.equal(fixture.metrics.modelCalls, 0)
    console.log('PASS legacy index remains browsable; filtered unknowns excluded; zero external/model calls')
    const subjectFile = join(process.cwd(), 'subjects.jsonlines'), episodeFile = join(process.cwd(), 'episodes.jsonlines')
    writeFileSync(subjectFile, JSON.stringify({ id: 8001, type: 2, name: '本地归档样本', date: '2020-01-01', infobox: '|播放结束=2020年3月28日' }) + '\n')
    writeFileSync(episodeFile, [{ subject_id: 8001, type: 0 }, { subject_id: 8001, type: 0 }, { subject_id: 8001, type: 1 }].map(x => JSON.stringify(x)).join('\n'))
    const built = spawnSync('npm', ['run', 'sync:index', '--', '--file', subjectFile, '--episode-file', episodeFile, '--force'], { cwd: repoWeb, env: { ...process.env }, encoding: 'utf8' })
    assert.equal(built.status, 0, built.stdout + built.stderr)
    const imported = new Database(path, { readonly: true })
    assert.deepEqual(imported.prepare('SELECT eps,end_date FROM anime WHERE bgm_id=8001').get(), { eps: 2, end_date: '2020-03-28' })
    imported.close()
    assert.deepEqual((await request({ maxEps: '13', finished: '1' })).data.items.map(i => i.bgmId), [8001], 'ATOMIC_INDEX_REPLACEMENT_REFRESHES_SNAPSHOT')
    console.log('PASS actual npm index import, main-episode count and atomic snapshot refresh')
  } finally { await fixture.close() }
}
