import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { createAgentUiFixture } from './agent-ui-fixture'

const groups = [
  { key: 'burst', query: '系列连加样本', base: 910010, count: 12 },
  { key: 'failure', query: '单部失败样本', base: 910030, count: 3 },
  { key: 'navigation', query: '站内切页样本', base: 910040, count: 3 },
  { key: 'reload', query: '浏览器刷新样本', base: 910050, count: 3 },
  { key: 'offline', query: '离线再点样本', base: 910060, count: 1 },
  { key: 'ambiguous', query: '回执中断样本', base: 910070, count: 1 },
].map(group => ({
  ...group,
  items: Array.from({ length: group.count }, (_, n) => ({
    id: group.base + n + 1, title: group.query + String(n + 1).padStart(2, '0'),
  })),
}))

process.env.NODE_ENV = 'test'
process.env.AGENT_UI_FIXTURE = '1'
const fixture = await createAgentUiFixture()
const blockedFetch = globalThis.fetch
const profile = mkdtempSync(join(tmpdir(), 'tracks-add-browser-'))
try {
  fixture.db.prepare('UPDATE tracks SET cover=?,bgm_tags=?,aliases=?,air_date=?,score=?')
    .run('/assets/sagiri-avatar.webp', '["样本"]', '["样本别名"]', '2025-01-01', 8)
  const index = new Database(join(process.cwd(), 'data/bgm_index.db'))
  try {
    index.exec('CREATE TABLE anime (bgm_id INTEGER PRIMARY KEY, name TEXT, name_cn TEXT, aliases TEXT, date TEXT, score REAL, tags TEXT, nsfw INTEGER, eps INTEGER, votes INTEGER); CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)')
    index.prepare('INSERT INTO meta VALUES (?,?)').run('built_at', String(Date.now()))
    const insert = index.prepare('INSERT INTO anime VALUES (?,?,?,?,?,?,?,?,?,?)')
    for (const { items } of groups) for (const { id, title } of items) {
      insert.run(id, 'Fixture ' + id, title, '[]', '2025-01-01', 7, '["样本"]', 0, 1, 100)
    }
  } finally {
    index.close()
  }

  const titles = new Map(groups.flatMap(group => group.items.map(item => [item.id, item.title] as const)))
  titles.set(910090, '接口只新增样本')
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const id = Number(url.pathname.split('/').at(-1))
    if (url.hostname === 'api.bgm.tv' && url.pathname.startsWith('/v0/subjects/') && titles.has(id)) {
      return Response.json({
        name: 'Fixture ' + id, name_cn: titles.get(id), date: '2025-01-01', total_episodes: 1,
        tags: [{ name: '样本' }], infobox: [{ key: '别名', value: '样本别名' }],
        images: { large: '/assets/sagiri-avatar.webp' }, rating: { score: 7 },
      })
    }
    return blockedFetch(input, init)
  }

  const { default: production } = await import('../server/index')
  const { issueSession } = await import('../server/auth')
  const { signSearchAddition } = await import('../server/bgm/search-additions')
  const { Hono } = await import('hono')
  const issuer = new Hono().get('/', async c => {
    await issueSession(c, { uid: fixture.alice, username: 'ui_alice', tv: 0 })
    return c.text('ok')
  })
  const cookie = (await issuer.request('/')).headers.get('set-cookie')!.split(';')[0]
  const request = (path: string, method: string, body: unknown) => production.request(path, {
    method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const id = 910090
  const candidate = { bgmId: id, name: 'API fixture', nameCn: titles.get(id)!, date: '2025-01-01', score: 7 }
  const payload = {
    expectedOwner: fixture.alice, bgmId: id, title: candidate.name, titleCn: candidate.nameCn,
    airDate: candidate.date, score: candidate.score, searchAdditionToken: signSearchAddition(candidate),
  }
  const anonymous = await production.request('/api/tracks/add', { method: 'POST' })
  assert.equal(anonymous.status, 401)
  const forbidden = await request('/api/tracks/add', 'POST', { ...payload, expectedOwner: fixture.bob })
  assert.equal(forbidden.status, 409)
  assert.equal((await forbidden.json()).code, 'OWNER_CHANGED')
  assert.equal(await fixture.db.prepare('SELECT 1 FROM tracks WHERE bgm_id=?').get(id), undefined)
  assert.equal((await production.request('/api/tracks', { headers: { Cookie: cookie, 'X-Tracks-Owner': String(fixture.bob) } })).status, 409)
  const malformed = await production.request('/api/tracks/add', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"bgmId":',
  })
  assert.equal(malformed.status, 400)
  const adds = await Promise.all([request('/api/tracks/add', 'POST', payload), request('/api/tracks/add', 'POST', payload)])
  assert.deepEqual(adds.map(r => r.status).sort(), [200, 201])
  for (const response of adds) assert.equal((await response.json()).status, 'plan')
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE bgm_id=?').pluck().get(id), 1)
  assert.equal(fixture.db.prepare('SELECT name_cn FROM bgm_search_additions WHERE bgm_id=?').pluck().get(id), candidate.nameCn)
  const updated = await request('/api/tracks/' + id, 'PUT', {
    status: 'watching', totalEpisodes: 12, episode: 7, userTags: ['我的标签'], cover: '/assets/my-fixture-cover.webp',
  })
  assert.equal(updated.status, 200)
  const revision = () => fixture.db.prepare('SELECT tracks_rev FROM users WHERE id=?').pluck().get(fixture.alice)
  const previousRev = revision()
  const replay = await request('/api/tracks/add', 'POST', payload)
  const row = await replay.json()
  assert.equal(replay.status, 200)
  assert.deepEqual([row.status, row.episode, row.userTags, row.cover], ['watching', 7, ['我的标签'], '/assets/my-fixture-cover.webp'])
  assert.equal(revision(), previousRev)
  console.log('TRACK_ADD_API', JSON.stringify({ anonymous: anonymous.status, crossAccount: forbidden.status, malformed: malformed.status, duplicate: adds.map(r => r.status).sort(), replayProgress: row.episode, replayPreservedRevision: true }))

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = createRequire(import.meta.url)('electron') as string
  const runner = fileURLToPath(new URL('./tracks-add-browser.cjs', import.meta.url))
  const child = spawn(electron, [runner, fixture.browserOrigin, profile, JSON.stringify(groups)], { env, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill('SIGTERM'), 90_000)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  }).finally(() => clearTimeout(timer))
  assert.equal(code, 0, 'TRACK_ADD_BROWSER_EXIT')

  const rows = fixture.db.prepare('SELECT bgm_id,status FROM tracks WHERE user_id=? AND bgm_id>910000 AND bgm_id<910090 ORDER BY bgm_id')
    .all(fixture.alice)
  const expected = groups.flatMap(group => group.items
    .filter((_, i) => !(group.key === 'failure' && i === 1) && !(group.key === 'reload' && i === 2))
    .map(item => ({ bgm_id: item.id, status: 'plan' })))
  assert.deepEqual(rows, expected)

  // 不在补详情队列仍有任务时解除夹具的网络隔离。
  const missingDetail = fixture.db.prepare("SELECT bgm_id FROM tracks WHERE user_id=? AND bgm_id>910000 AND bgm_tags='[]'")
  const until = Date.now() + 35_000
  while (missingDetail.all(fixture.alice).length && Date.now() < until) await delay(50)
  assert.deepEqual(missingDetail.all(fixture.alice), [])
  assert.equal(fixture.metrics.externalRequests, 0)
  assert.equal(fixture.metrics.modelCalls, 0)
  console.log('TRACK_ADD_DB', JSON.stringify({ confirmed: rows.length, mockedDetails: rows.length + 1, externalRequests: 0, modelCalls: 0 }))
} finally {
  try { await fixture.close() } finally {
    // 断言提早失败也不得让未收尾的测试任务落到真实网络。
    globalThis.fetch = blockedFetch
    rmSync(profile, { recursive: true, force: true })
  }
}
