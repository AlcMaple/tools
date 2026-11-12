import assert from 'node:assert/strict'
import { createAgentUiFixture } from './agent-ui-fixture'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.AGENT_UI_FIXTURE = '1'
process.env.AGENT_UI_WATCH = '1'
const fixture = await createAgentUiFixture()
fixture.db.prepare("UPDATE tracks SET cover='fixture-only',bgm_tags='[\"夹具\"]',aliases='[\"fixture\"]',air_date='2023-01-01',score=8").run()
fixture.db.prepare('UPDATE tracks SET episode=5 WHERE user_id=? AND bgm_id=101').run(fixture.alice)
const cookieFor = async (who: string) => {
  const response = await fixture.originalFetch(fixture.origin + '/__agent-test/login/' + who, { redirect: 'manual' })
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  assert(cookie)
  return cookie
}
const alice = await cookieFor('alice'), bob = await cookieFor('bob')
const read = async () => {
  const r = await fixture.originalFetch(fixture.origin + '/api/tracks/101/playback-progress', { headers: { Cookie: alice } })
  assert.equal(r.status, 200, 'JOURNAL_SNAPSHOT_MUST_EXIST')
  return await r.json() as { ownerId: number; revision: number; episode: number }
}
const row = () => fixture.db.prepare('SELECT episode,status FROM tracks WHERE user_id=? AND bgm_id=101').get(fixture.alice) as { episode: number; status: string }
const save = (episode: number, guard: { ownerId: number; revision: number }, cookie = alice, id = 101) => fixture.originalFetch(fixture.origin + '/api/tracks/' + id, {
  method: 'PUT', headers: { Cookie: cookie, Origin: fixture.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ episode, playbackProgress: guard }),
})
try {
  const first = await read()
  assert.equal(first.episode, 5)
  const page = await fixture.originalFetch(fixture.origin + '/api/player/page?src=xifan&id=1001&ep=28&bgmId=101', { headers: { Cookie: alice } })
  const html = await page.text()
  assert.equal(page.status, 200)
  assert(html.includes('journal-save'), 'EXPLICIT_JOURNAL_ACTION_MUST_EXIST')
  assert(!html.includes('mapletools-watch-episodes-v1'))
  assert.equal(row().episode, 5, 'opening last episode must not move journal progress')
  assert.equal((await save(6, first, bob)).status, 409, 'ACCOUNT_BOUNDARY_MUST_HOLD')
  assert.equal((await save(6, first, alice, 999999)).status, 404)
  assert.equal((await save(29, first)).status, 400)
  assert.equal((await save(0, first)).status, 400)
  assert.equal(row().episode, 5)
  const saved = await save(6, first)
  assert.equal(saved.status, 200)
  assert.equal(row().episode, 6)
  assert.equal((await save(8, first)).status, 409, 'STALE_REVISION_MUST_NOT_OVERWRITE')
  const fresh = await read()
  assert.equal(fresh.revision, first.revision + 1)
  assert.equal((await save(3, fresh)).status, 200)
  assert.equal(row().episode, 6, 'rewatching must not lower journal')
  assert.equal((await read()).revision, fresh.revision)
  const beforeDelete = await read()
  fixture.db.prepare('DELETE FROM tracks WHERE user_id=? AND bgm_id=101').run(fixture.alice)
  assert.equal((await save(7, beforeDelete)).status, 404)
  assert.equal(row(), undefined, 'removed entry must not be recreated')
  console.log('PASS read-only open, explicit save, owner, revision, max episode, rewatch and removed-record guards')
  console.log('PLAYER_JOURNAL_COMPLETE; no automatic progress write')
  if (process.argv.includes('--serve')) {
    fixture.db.prepare("INSERT INTO tracks(user_id,bgm_id,title,title_cn,status,episode,total_episodes,air_date,score,cover,bgm_tags,aliases) VALUES(?,101,'Frieren','葬送的芙莉莲','watching',5,28,'2023-01-01',8,'fixture-only','[\"夹具\"]','[\"fixture\"]')").run(fixture.alice)
    console.log(JSON.stringify({ browserUrl: fixture.browserOrigin + '/__agent-test/login/alice', generatedMediaOnly: true, journalEpisode: 5 }))
    await new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
  }
  assert.equal(fixture.metrics.externalRequests, 0)
  assert.equal(fixture.metrics.modelCalls, 0)
} finally {
  if (process.env.UX_RUN_DIR) writeFileSync(join(process.env.UX_RUN_DIR, 'journal-final.json'), JSON.stringify({ row: row(), metrics: fixture.metrics }, null, 2))
  await fixture.close()
}
