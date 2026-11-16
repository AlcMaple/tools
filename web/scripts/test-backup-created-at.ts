import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { addedAtOf, seasonOf } from '../src/tracks/TrackTimeline'
import { createAgentUiFixture } from './agent-ui-fixture'

type JsonRow = Record<string, unknown>
type StoredTrack = { bgm_id: number; created_at: number; updated_at: number; episode: number; status: string; total_episodes: number; user_tags: string; extra: string; cover_mime: string }
type ImportSummary = { tracks: { added: number; updated: number; skipped: number }; covers: { imported: number; missing: number }; foreignBackup: boolean }

const JANUARY = Date.UTC(2026, 0, 1, 12)
const APRIL = Date.UTC(2026, 3, 1, 12)
const JULY = Date.UTC(2026, 6, 1, 12)
const UPDATED = Date.UTC(2026, 10, 15, 12)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const EXTRA = { subjectType: 'anime', favorite: 4, goodEpisodes: [1], goodEpisodeNotes: { '1': '合成回贴备注' }, fixtureUnknown: { kept: true } }
const evidenceDir = process.env.BACKUP_CREATED_AT_EVIDENCE_DIR
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true })
const save = (name: string, content: string | Uint8Array): void => { if (evidenceDir) writeFileSync(join(evidenceDir, name), content) }
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const requests: { method: string; path: string; status: number }[] = []
const outcomes: { name: string; passed: boolean }[] = []
const inputs: { name: string; sha256: string }[] = []
let checks = 0

process.env.NODE_ENV = 'test'
process.env.AGENT_UI_FIXTURE = '1'
delete process.env.AGENT_UI_WATCH
const fixture = await createAgentUiFixture()
try {
  const login = await fixture.originalFetch(fixture.origin + '/__agent-test/login/alice', { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  assert.equal(login.status, 302)
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  assert(cookie, 'synthetic fixture session must be issued')
  const request = async (path: string, init: RequestInit = {}, authenticated = true): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('Origin', fixture.origin)
    if (authenticated) headers.set('Cookie', cookie)
    let body = init.body
    if (body instanceof FormData) {
      // 同进程服务替换了 Request/Response；显式编码 multipart，避免测试客户端丢失文件字段。
      const encoded = new Request(fixture.origin + path, { method: init.method ?? 'POST', body })
      headers.set('Content-Type', encoded.headers.get('Content-Type')!)
      body = await encoded.arrayBuffer()
    }
    const response = await fixture.originalFetch(fixture.origin + path, { ...init, headers, body, signal: AbortSignal.timeout(10_000), redirect: 'manual' })
    requests.push({ method: init.method ?? 'GET', path: new URL(path, fixture.origin).pathname, status: response.status })
    if (response.status >= 400) console.error('BACKUP_API_FAILURE', new URL(path, fixture.origin).pathname, response.status, await response.clone().text())
    return response
  }
  const json = (path: string, method: string, body?: unknown) => request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const row = (id: number): StoredTrack => {
    const value = fixture.db.prepare('SELECT * FROM tracks WHERE user_id=? AND bgm_id=?').get(fixture.alice, id) as StoredTrack | undefined
    assert(value, `track ${id} must exist`)
    return value
  }
  const wireTrack = async (id: number): Promise<JsonRow> => {
    const response = await request('/api/tracks')
    assert.equal(response.status, 200)
    const value = await response.json() as { data: JsonRow[] }
    const track = value.data.find(track => track.bgmId === id)
    assert(track, `public tracks response must include ${id}`)
    return track
  }
  const bodyFor = (tracks: JsonRow[]) => ({ format: 'mapletools-backup', version: 1, exportedBy: { userId: fixture.alice, username: 'ui_alice' }, tracks, reviews: [] })
  const importBytes = async (name: string, bytes: Uint8Array, extension: 'zip' | 'json'): Promise<ImportSummary> => {
    inputs.push({ name, sha256: hash(bytes) })
    save(name + '.' + extension, bytes)
    const form = new FormData()
    form.append('file', new File([bytes as BlobPart], name + '.' + extension))
    const response = await request('/api/backup/import', { method: 'POST', body: form })
    const value = await response.json() as ImportSummary & { error?: string }
    assert.equal(response.status, 200, JSON.stringify(value))
    return value
  }
  const importRows = (name: string, tracks: JsonRow[], extension: 'zip' | 'json' = 'json'): Promise<ImportSummary> => {
    const bytes = strToU8(JSON.stringify(bodyFor(tracks)))
    return importBytes(name, extension === 'zip' ? zipSync({ 'data.json': bytes }) : bytes, extension)
  }
  const incoming = (id: number): JsonRow => ({ bgmId: id, status: 'watching', episode: 2, totalEpisodes: 12, title: 'Synthetic backup row', titleCn: `回贴夹具 ${id}`, cover: '', airWeekday: 1, airDate: '2026-01-01', score: 8, bgmTags: ['夹具'], userTags: ['回贴分组'], aliases: [], observeCount: 0, extra: { subjectType: 'anime', fixtureUnknown: { id } }, updatedAt: UPDATED })
  const seed = (id: number, createdAt = APRIL): void => {
    fixture.db.prepare('INSERT INTO tracks(user_id,bgm_id,status,episode,total_episodes,title,title_cn,cover,air_weekday,air_date,score,bgm_tags,user_tags,aliases,extra,observe_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(fixture.alice, id, 'plan', 0, 12, 'Local seed', `原有夹具 ${id}`, '/assets/sagiri-avatar.webp', 1, '2026-01-01', 8, '["夹具"]', '["原分组"]', '[]', '{"subjectType":"anime"}', 0, createdAt, JANUARY)
  }
  const check = async (name: string, action: () => Promise<void>): Promise<void> => {
    try { await action(); checks++; outcomes.push({ name, passed: true }); console.log(`PASS C${checks} ${name}`) }
    catch (error) { outcomes.push({ name, passed: false }); throw error }
  }

  fixture.db.prepare('UPDATE tracks SET cover=?,air_weekday=1,air_date=?,score=8,bgm_tags=?,aliases=?,created_at=?,updated_at=?').run('/assets/sagiri-avatar.webp', '2026-01-01', '["夹具"]', '["合成别名"]', JANUARY, UPDATED)
  fixture.db.prepare('UPDATE tracks SET status=?,episode=1,total_episodes=12,title=?,title_cn=?,user_tags=?,extra=?,created_at=? WHERE user_id=? AND bgm_id=101').run('watching', 'Archive fixture four', '候补手帐四号', '["周末再看","接着看"]', JSON.stringify(EXTRA), JULY, fixture.alice)
  const coverForm = new FormData()
  coverForm.append('file', new File([PNG], 'fixture.png', { type: 'image/png' }))
  assert.equal((await request('/api/tracks/101/cover', { method: 'POST', body: coverForm })).status, 200)
  fixture.db.prepare('UPDATE tracks SET updated_at=?,created_at=? WHERE user_id=? AND bgm_id=101').run(UPDATED, JULY, fixture.alice)
  save('seed.json', JSON.stringify({ createdAt: JULY, updatedAt: UPDATED, episode: 1, totalEpisodes: 12, userTags: ['周末再看', '接着看'], extra: EXTRA, coverSha256: hash(PNG) }, null, 2))
  let exportedTrack: JsonRow = {}

  await check('产品 ZIP 导出、真实删除后导回，仍归 7 月并保留进度、标签、extra 与封面', async () => {
    const ticketResponse = await json('/api/backup/export-ticket', 'POST', { format: 'zip-md' })
    assert.equal(ticketResponse.status, 200)
    const ticket = await ticketResponse.json() as { url: string }
    const exported = await request(ticket.url, {}, false)
    assert.equal(exported.status, 200)
    const producedBytes = new Uint8Array(await exported.arrayBuffer())
    save('product-export.zip', producedBytes)
    const produced = JSON.parse(strFromU8(unzipSync(producedBytes)['data.json'])) as { tracks: JsonRow[] }
    const producedTrack = produced.tracks.find(track => track.bgmId === 101)
    assert(producedTrack)
    assert.equal(producedTrack.createdAt, JULY, 'ZIP_EXPORT_CREATED_AT')
    const bytes = process.env.BACKUP_CREATED_AT_REPLAY_ZIP ? new Uint8Array(readFileSync(process.env.BACKUP_CREATED_AT_REPLAY_ZIP)) : producedBytes
    const files = unzipSync(bytes)
    const data = JSON.parse(strFromU8(files['data.json'])) as { exportedBy: { userId: number }; tracks: JsonRow[] }
    assert.equal(data.exportedBy.userId, fixture.alice, 'replayed ZIP must belong to this deterministic synthetic account')
    const track = data.tracks.find(track => track.bgmId === 101)
    assert(track)
    exportedTrack = track
    assert.equal(track.createdAt, JULY)
    assert.equal(track.updatedAt, UPDATED)
    assert.deepEqual(new Uint8Array(files['covers/101.png']), new Uint8Array(PNG))
    assert.equal((await request('/api/tracks/101', { method: 'DELETE' })).status, 200)
    const removed = fixture.db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE user_id=? AND bgm_id=101').get(fixture.alice) as { n: number }
    assert.equal(removed.n, 0, 'production DELETE must remove the record before restore')
    const summary = await importBytes('roundtrip-input', bytes, 'zip')
    assert.deepEqual(summary.tracks, { added: 1, updated: 0, skipped: 2 })
    assert.deepEqual(summary.covers, { imported: 1, missing: 0 })
    const restored = row(101)
    assert.equal(restored.created_at, JULY, 'CREATED_AT_INSERT_RESTORES_ARCHIVE_TIME')
    assert.equal(restored.updated_at, UPDATED)
    assert.equal(restored.episode, 1)
    assert.equal(restored.total_episodes, 12)
    assert.deepEqual(JSON.parse(restored.user_tags), ['周末再看', '接着看'])
    assert.deepEqual(JSON.parse(restored.extra), EXTRA)
    const wire = await wireTrack(101)
    assert.equal(wire.createdAt, JULY)
    assert.deepEqual(seasonOf(addedAtOf({ createdAt: Number(wire.createdAt), updatedAt: Number(wire.updatedAt) })), { year: 2026, q: 2 })
    const cover = await request('/api/tracks/101/cover-file')
    assert.equal(cover.status, 200)
    assert.equal(cover.headers.get('content-type'), 'image/png')
    assert.deepEqual(new Uint8Array(await cover.arrayBuffer()), new Uint8Array(PNG))
  })

  await check('较新 JSON 备份更新已有记录的归档时间，裸 JSON 保留本地封面', async () => {
    const { coverFile: _coverFile, ...track } = exportedTrack
    const summary = await importRows('newer-existing', [{ ...track, createdAt: APRIL, updatedAt: UPDATED + 1000 }])
    assert.deepEqual(summary.tracks, { added: 0, updated: 1, skipped: 0 })
    assert.equal(row(101).created_at, APRIL, 'CREATED_AT_UPDATE_RESTORES_ARCHIVE_TIME')
    assert.equal(row(101).episode, 1)
    assert.deepEqual(JSON.parse(row(101).extra), EXTRA)
    const cover = await request('/api/tracks/101/cover-file')
    assert.equal(cover.status, 200)
    assert.deepEqual(new Uint8Array(await cover.arrayBuffer()), new Uint8Array(PNG))
  })

  await check('旧或相同 updatedAt 整条跳过，不改归档时间或进度', async () => {
    const before = [row(101), row(102)]
    const summary = await importRows('older-and-equal', [
      { ...incoming(101), createdAt: JANUARY, updatedAt: UPDATED },
      { ...incoming(102), createdAt: APRIL, updatedAt: UPDATED },
    ])
    assert.deepEqual(summary.tracks, { added: 0, updated: 0, skipped: 2 })
    assert.deepEqual([row(101), row(102)], before)
  })

  const invalid: { name: string; value?: unknown }[] = [
    { name: 'missing' }, { name: 'zero', value: 0 }, { name: 'negative', value: -1 },
    { name: 'fraction', value: 1.5 }, { name: 'numeric-string', value: String(JULY) },
    { name: 'date-string', value: '2026-07-01' }, { name: 'NaN-string', value: 'NaN' },
    { name: 'Infinity-string', value: 'Infinity' }, { name: 'native-NaN-serialized-null', value: Number.NaN },
    { name: 'native-Infinity-serialized-null', value: Number.POSITIVE_INFINITY },
    { name: 'null', value: null }, { name: 'boolean', value: true }, { name: 'array', value: [1] },
    { name: 'object', value: { timestamp: JULY } }, { name: 'future-date-limit', value: 8_640_000_000_000_000 },
    { name: 'beyond-date-limit', value: Number.MAX_SAFE_INTEGER },
  ]
  save('created-at-input-matrix.json', JSON.stringify(invalid.map(item => ({ name: item.name, jsonInput: JSON.parse(JSON.stringify({ createdAt: item.value })) })), null, 2))

  await check('缺失与非法 createdAt 更新时保留原值，包括严格 JSON 类型边界', async () => {
    const tracks = invalid.map((item, index) => {
      const id = -1000 - index
      seed(id)
      return { ...incoming(id), createdAt: item.value }
    })
    const summary = await importRows('invalid-existing', tracks)
    assert.equal(summary.tracks.updated, tracks.length)
    for (let index = 0; index < tracks.length; index++) {
      const restored = row(Number(tracks[index].bgmId))
      assert.equal(restored.created_at, APRIL, `CREATED_AT_INVALID_UPDATE_PRESERVES:${invalid[index].name}`)
      assert.equal(restored.updated_at, UPDATED)
      assert.equal(restored.episode, 2)
    }
  })

  await check('旧包及非法 createdAt 新增时沿用规范化 updatedAt 兜底', async () => {
    const tracks = invalid.map((item, index) => ({ ...incoming(-2000 - index), createdAt: item.value }))
    const summary = await importRows('invalid-new', tracks, 'zip')
    assert.equal(summary.tracks.added, tracks.length)
    for (let index = 0; index < tracks.length; index++) {
      const restored = row(Number(tracks[index].bgmId))
      assert.equal(restored.created_at, UPDATED, `CREATED_AT_INVALID_INSERT_FALLBACK:${invalid[index].name}`)
      assert.equal(restored.updated_at, UPDATED)
    }
  })

  await check('正整数边界 1 可新增及更新，updatedAt 无效时仍沿用既有当前时间兜底', async () => {
    seed(-3001)
    const before = Date.now()
    const summary = await importRows('positive-boundary-and-updated-fallback', [
      { ...incoming(-3000), createdAt: 1 },
      { ...incoming(-3001), createdAt: 1 },
      { ...incoming(-3002), updatedAt: 'invalid' },
    ], 'zip')
    const after = Date.now()
    assert.deepEqual(summary.tracks, { added: 2, updated: 1, skipped: 0 })
    assert.equal(row(-3000).created_at, 1)
    assert.equal(row(-3001).created_at, 1)
    const fallback = row(-3002)
    assert.equal(fallback.created_at, fallback.updated_at)
    assert(fallback.created_at >= before && fallback.created_at <= after)
  })

  assert.equal(fixture.metrics.externalRequests, 0)
  assert.equal(fixture.metrics.modelCalls, 0)
  console.log(`BACKUP_CREATED_AT_CASES=${checks}`)
  console.log('PASS backup createdAt: real export/import/delete routes, preserved archive quarter and data, 0 external requests, 0 model calls')
} finally {
  save('verification.json', JSON.stringify({ cases: outcomes, requests, inputs, metrics: fixture.metrics, uiRoundtripClaimed: false }, null, 2))
  await fixture.close()
}
