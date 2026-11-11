import assert from 'node:assert/strict'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createAgentUiFixture } from './agent-ui-fixture'

process.env.NODE_ENV = 'test'
process.env.AGENT_UI_FIXTURE = '1'
const fixture = await createAgentUiFixture()
const index = new Database(join(process.cwd(), 'data/bgm_index.db'))
index.exec('CREATE TABLE anime (bgm_id INTEGER PRIMARY KEY, name TEXT, name_cn TEXT, aliases TEXT, date TEXT, score REAL, tags TEXT, nsfw INTEGER, eps INTEGER, votes INTEGER); CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)')
index.prepare('INSERT INTO meta VALUES (?,?)').run('built_at', String(Date.now()))
const add = index.prepare('INSERT INTO anime VALUES (?,?,?,?,?,?,?,?,?,?)')
for (const [id, name, tags, nsfw] of [
  [8201, '午后的小小日常', ['日常', '喜剧'], 0],
  [8202, '恋爱日常', ['日常', '喜剧', '恋爱'], 0],
  [8203, '旅途里的日常', ['日常'], 0],
  [8204, '校园日常', ['日常系', '喜剧'], 0],
  [8205, '受限日常', ['日常', '喜剧', '悬疑'], 1],
  [8206, '改过题材的日常', ['日常', '喜剧'], 0],
] as const) add.run(id, name, name, '[]', '2023-01-01', 8, JSON.stringify(tags), nsfw, 12, 100)
fixture.db.prepare('INSERT INTO catalog_override(bgm_id,tags,updated_at) VALUES(?,?,?)').run(8206, JSON.stringify(['科幻']), Date.now())
index.close()
if (process.argv.includes('--serve')) {
  console.log(JSON.stringify({ browserUrl: fixture.browserOrigin, generatedFixture: true }))
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void fixture.close().then(() => process.exit(0)) })
} else {
  try {
    const request = async (values: Record<string, string>) => {
      const res = await fixture.originalFetch(fixture.origin + '/api/catalog?' + new URLSearchParams(values))
      return { status: res.status, data: await res.json() as { total: number; items: { bgmId: number; tags: string[] }[] } }
    }
    const include = JSON.stringify(['日常', '喜剧']), exclude = JSON.stringify(['恋爱'])
    const selected = await request({ include, exclude })
    assert.equal(selected.status, 200)
    assert.deepEqual(selected.data.items.map(x => x.bgmId), [8201], 'DISCOVERY_FILTER_MUST_NARROW_RESULTS')
    console.log('PASS include intersection, exclude, exact tag, override and guest boundaries')
    assert.equal((await request({ include, exclude, year: '2022' })).data.total, 0)
    assert.equal((await request({ include, exclude, q: '日常' })).data.total, 1)
    assert.equal((await request({ include: JSON.stringify(['科幻']) })).data.items[0].bgmId, 8206)
    const { saveCatalogText } = await import('../server/bgm/catalog')
    saveCatalogText(8203, { nameCn: null, tags: ['日常', '喜剧'] })
    assert.deepEqual((await request({ include, exclude })).data.items.map(x => x.bgmId).sort(), [8201, 8203], 'ADMIN_TAG_EDIT_MUST_REFRESH_CATALOG')
    saveCatalogText(8203, { nameCn: null, tags: null })
    assert.deepEqual((await request({ include, exclude })).data.items.map(x => x.bgmId), [8201], 'ADMIN_TAG_RESTORE_MUST_REFRESH_CATALOG')
    assert.equal((await request({ include: JSON.stringify(['日常']), exclude: JSON.stringify(['日常']) })).data.total, 0)
    const page = await request({ include: JSON.stringify(['日常']), limit: '1', offset: '1' })
    assert.equal(page.data.total, 3)
    assert.equal(page.data.items.length, 1)
    assert.equal((await request({})).data.total, 5)
    console.log('PASS keyword/year composition, count/pagination, conflict and reset')
    for (const value of ['not-json', '{}', '[1]', JSON.stringify(Array(6).fill('日常')), JSON.stringify(['x'.repeat(21)])]) {
      assert.equal((await request({ include: value })).status, 400)
    }
    const extra = new Database(join(process.cwd(), 'data/bgm_index.db'))
    const insert = extra.prepare('INSERT INTO anime VALUES (?,?,?,?,?,?,?,?,?,?)')
    extra.transaction(() => {
      for (let n = 0; n < 121; n++) insert.run(9000 + n, '日常高分干扰' + n, '日常高分干扰' + n, '[]', '2023-01-01', 10, '["恋爱"]', 0, 12, 100)
    })()
    extra.close()
    assert.deepEqual((await request({ q: '日常', include, exclude })).data.items.map(x => x.bgmId), [8201], 'TAG_FILTER_BEFORE_SEARCH_CAP')
    assert.equal(fixture.metrics.externalRequests, 0)
    assert.equal(fixture.metrics.modelCalls, 0)
    console.log('PASS malformed input, before-120-candidate filtering, zero external requests and model calls')
    const large = new Database(join(process.cwd(), 'data/bgm_index.db'))
    const fill = large.prepare('INSERT INTO anime VALUES (?,?,?,?,?,?,?,?,?,?)')
    large.transaction(() => {
      for (let n = 0; n < 30000; n++) fill.run(20000 + n, 'fixture-' + n, 'fixture-' + n, '[]', '2024-01-01', 7, n % 2 ? '["日常","喜剧"]' : '["恋爱"]', 0, 12, 100)
    })()
    large.close()
    const genreRows = new Database(join(process.cwd(), 'data/bgm_index.db'))
    const genreInsert = genreRows.prepare('INSERT INTO anime VALUES (?,?,?,?,?,?,?,?,?,?)')
    genreRows.transaction(() => {
      for (let n = 0; n < 120; n++) genreInsert.run(60000 + n, 'genre-' + n, 'genre-' + n, '[]', '2024-01-01', 6, '["2024","悬疑"]', 0, 12, 100)
      for (let n = 0; n < 120; n++) genreInsert.run(61000 + n, 'limited-' + n, 'limited-' + n, '[]', '2024-01-01', 6, '["限定题材"]', 1, 12, 100)
      for (let n = 0; n < 99; n++) genreInsert.run(62000 + n, 'rare-' + n, 'rare-' + n, '[]', '2024-01-01', 6, '["冷门题材"]', 0, 12, 100)
    })()
    genreRows.close()
    const genresOf = async (): Promise<string[]> => ((await request({})).data as unknown as { genres: string[] }).genres
    assert.deepEqual(await genresOf(), ['恋爱', '喜剧', '日常', '悬疑'], 'GENRES_THRESHOLD_VISIBLE_COUNT_AND_YEAR_DEFAULT')
    const { saveGenreVisibility, listGenresForAdmin } = await import('../server/bgm/catalog')
    saveGenreVisibility([{ tag: '悬疑', visible: false }, { tag: '2024', visible: true }])
    assert.deepEqual(await genresOf(), ['恋爱', '喜剧', '日常', '2024'], 'ADMIN_GENRE_VISIBILITY_MUST_APPLY')
    const adminRows = listGenresForAdmin()
    assert.deepEqual(adminRows.map(r => r.count), [...adminRows.map(r => r.count)].sort((a, b) => b - a), 'ADMIN_GENRES_SORTED_DESC')
    assert.ok(adminRows.some(r => r.tag === '限定题材' && r.count === 120) && adminRows.some(r => r.tag === '悬疑' && !r.visible), 'ADMIN_SEES_ALL_INCLUDING_HIDDEN')
    assert.ok(!adminRows.some(r => r.tag === '冷门题材'), 'GENRE_BELOW_THRESHOLD_HIDDEN')
    for (const bad of [null, [{ tag: '', visible: true }], [{ tag: '悬疑', visible: 'yes' }]]) assert.throws(() => saveGenreVisibility(bad))
    saveGenreVisibility([{ tag: '悬疑', visible: true }, { tag: '2024', visible: false }])
    const guestGenre = await fixture.originalFetch(fixture.origin + '/api/catalog/genres')
    assert.equal(guestGenre.status, 401, 'GENRE_ADMIN_REQUIRES_LOGIN')
    const guestSave = await fixture.originalFetch(fixture.origin + '/api/catalog/genres', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ genres: [{ tag: '恋爱', visible: false }] }) })
    assert.equal(guestSave.status, 401, 'GENRE_SAVE_REQUIRES_LOGIN')
    assert.ok((await genresOf()).includes('恋爱'), 'GUEST_SAVE_MUST_NOT_APPLY')
    console.log('PASS genre threshold, guest counting, year default, admin visibility and ordering')
    const elapsed: number[] = []
    for (let n = 0; n < 3; n++) {
      const start = performance.now()
      const result = await request({ include, exclude, offset: String(n * 48) })
      elapsed.push(Math.round(performance.now() - start))
      assert.equal(result.data.total, 15001)
      assert.equal(result.data.items.length, 48)
    }
    console.log('BENCHMARK synthetic 30000 additional rows, local HTTP milliseconds ' + JSON.stringify(elapsed))
    console.log('CATALOG_DISCOVERY_COMPLETE')
  } finally { await fixture.close() }
}
