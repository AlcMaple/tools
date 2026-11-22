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
const fixture = await createAgentUiFixture()
const profile = mkdtempSync(join(tmpdir(), 'good-episodes-browser-'))
try {
  fixture.db.prepare('UPDATE tracks SET cover=?, air_date=?, score=?').run('/assets/sagiri-avatar.webp', '2025-01-01', 8)
  fixture.db.prepare('UPDATE tracks SET extra=? WHERE user_id=? AND bgm_id=102').run(
    JSON.stringify({ appOrder: 9, favorite: 4 }), fixture.alice,
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = createRequire(import.meta.url)('electron') as string
  const runner = fileURLToPath(new URL('./good-episodes-browser.cjs', import.meta.url))
  const child = spawn(electron, [runner, fixture.browserOrigin, profile], { env, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  }).finally(() => clearTimeout(timer))
  assert.equal(code, 0, 'GOOD_EPISODES_BROWSER_EXIT')
  const row = fixture.db.prepare('SELECT extra, episode, status FROM tracks WHERE user_id=? AND bgm_id=102')
    .get(fixture.alice) as { extra: string; episode: number; status: string }
  assert.deepEqual(JSON.parse(row.extra), { appOrder: 9, favorite: 4, goodEpisodes: [3, 6], goodEpisodeNotes: {} })
  assert.equal(row.episode, 12)
  assert.equal(row.status, 'done')
  assert.equal(fixture.metrics.externalRequests, 0)
  console.log('PASS 数据库回读 [3,6]，保留原进度、最爱值和桌面端字段')

  const login = await fixture.originalFetch(fixture.origin + '/__agent-test/login/alice', { redirect: 'manual' })
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  assert(cookie)
  const mark = { kind: 'set-mark', episode: 6, marked: true }
  const edit = (id: number, ownerId: number, change: unknown, session?: string) =>
    fixture.originalFetch(`${fixture.origin}/api/tracks/${id}/good-episodes`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(session ? { Cookie: session } : {}) },
      body: JSON.stringify({ ownerId, edit: change }),
    })
  const rev = () => (fixture.db.prepare('SELECT tracks_rev FROM users WHERE id=?').get(fixture.alice) as { tracks_rev: number }).tracks_rev
  const before = rev()
  assert.equal((await edit(102, fixture.alice, mark)).status, 401)
  assert.equal((await edit(102, fixture.bob, mark, cookie)).status, 409)
  assert.equal((await edit(102, fixture.alice, { ...mark, episode: 0 }, cookie)).status, 400)
  assert.equal((await edit(999, fixture.alice, mark, cookie)).status, 404)
  assert.equal((await edit(102, fixture.alice, mark, cookie)).status, 200)
  assert.equal(rev(), before)
  console.log('PASS 新接口保留账号校验，不复活已删条目，重复目标状态不增加版本号')
} finally {
  await fixture.close()
  rmSync(profile, { recursive: true, force: true })
}
