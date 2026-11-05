import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentUiFixture } from './agent-ui-fixture'

process.env.NODE_ENV = 'test'
process.env.AGENT_UI_FIXTURE = '1'
process.env.AGENT_UI_WATCH = '1'
const fixture = await createAgentUiFixture()
const profile = mkdtempSync(join(tmpdir(), 'watch-episode-history-'))
try {
  const revision = Date.now()
  fixture.db.prepare('UPDATE tracks SET episode=CASE WHEN bgm_id=101 THEN 1 ELSE episode END,cover=?,bgm_tags=?,aliases=?,air_date=?,score=?,updated_at=?').run('/assets/sagiri-avatar.webp', '["夹具"]', '[]', '2024-01-01', 7, revision)
  fixture.db.prepare('INSERT INTO tracks(user_id,bgm_id,title,title_cn,status,episode,total_episodes,cover,air_date,bgm_tags,aliases,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(fixture.bob,101,'Frieren','葬送的芙莉莲','watching',1,28,'/assets/sagiri-avatar.webp','2024-01-01','["夹具"]','[]',revision)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = createRequire(import.meta.url)('electron') as string
  const runner = fileURLToPath(new URL('./watch-episode-history-browser.cjs', import.meta.url))
  const child = spawn(electron, [runner, fixture.browserOrigin, profile], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data.toString(); process.stdout.write(data) })
  child.stderr.on('data', data => process.stderr.write(data))
  const timer = setTimeout(() => child.kill('SIGTERM'), 120_000)
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => clearTimeout(timer))
  assert.equal(code, 0, `WATCH_EPISODE_BROWSER_EXIT: ${code}`)
  assert(output.includes('WATCH_EPISODE_CASES=3'), 'WATCH_EPISODE_CASES_INCOMPLETE')
  const { checkWatchHistory } = await import('./watch-history-checks')
  checkWatchHistory()
  assert.equal(fixture.metrics.modelCalls, 0)
  assert.equal(fixture.metrics.externalRequests, 0)
  const alice = fixture.db.prepare('SELECT episode FROM tracks WHERE user_id=? AND bgm_id=101').get(fixture.alice) as { episode: number }
  const bob = fixture.db.prepare('SELECT episode FROM tracks WHERE user_id=? AND bgm_id=101').get(fixture.bob) as { episode: number }
  assert.equal(alice.episode, 3, 'only the deliberate manual edit changes the record')
  assert.equal(bob.episode, 1)
  const login = await fixture.originalFetch(fixture.origin + '/__agent-test/login/alice', { redirect: 'manual' })
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  assert(cookie)
  const { default: playerApi } = await import('../server/player')
  const page = await playerApi.request(`/page?src=xifan&id=1001&ep=2&bgmId=101&ownerId=${fixture.bob}&trackUpdatedAt=1`, { headers: { Cookie: cookie } })
  const html = await page.text()
  const args = JSON.parse(html.match(/var ARGS = (\{[^\n]*\})/)![1]) as { ownerId: number; watchContext: { ownerId: number; bgmId: number; trackUpdatedAt: number } | null }
  const row = fixture.db.prepare('SELECT updated_at FROM tracks WHERE user_id=? AND bgm_id=101').get(fixture.alice) as { updated_at: number }
  assert.equal(args.ownerId, fixture.alice)
  assert.deepEqual(args.watchContext, { ownerId: fixture.alice, bgmId: 101, trackUpdatedAt: row.updated_at })
  const trial = await playerApi.request('/page?src=xifan&id=1001&ep=2&bgmId=999999', { headers: { Cookie: cookie } })
  const trialArgs = JSON.parse((await trial.text()).match(/var ARGS = (\{[^\n]*\})/)![1]) as { watchContext: unknown }
  assert.equal(trialArgs.watchContext, null)
  const asset = await playerApi.request('/vendor/watch-history.js')
  assert.equal(asset.status, 200)
  assert.equal(asset.headers.get('cache-control'), 'no-cache')
  assert((await asset.text()).includes('MapleWatchHistory'))
  console.log('WATCH_EPISODE_ROUTE_CHECKS=3')
  console.log('PASS watch episode history: 3 browser paths, manual progress unchanged by playback, 0 models, 0 external requests')
} finally {
  await fixture.close()
  rmSync(profile, { recursive: true, force: true })
}
