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
let trackWrites = 0
let identityFailure = false
let failedIdentityReads = 0
const fixture = await createAgentUiFixture((app, database) => {
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/tracks') && !['GET', 'HEAD'].includes(c.req.method)) trackWrites++
    await next()
  })
  app.get('/api/auth/me', async (c, next) => {
    if (identityFailure) { failedIdentityReads++; return c.html('<!doctype html><title>Unavailable</title>', 503) }
    await next()
  })
  app.post('/__tracks-return/identity-mode', async c => {
    const body = await c.req.json() as { failed?: boolean }
    identityFailure = body.failed === true
    return c.json({ failedIdentityReads })
  })
  app.post('/__tracks-return/switch-owner', async c => {
    const { issueSession } = await import('../server/auth')
    const user = database.prepare("SELECT id,username FROM users WHERE username='ui_bob'").get() as { id: number; username: string }
    await issueSession(c, { uid: user.id, username: user.username, tv: 0 })
    return c.json({ ok: true })
  })
  app.get('/api/xifan/source-page', c => c.redirect('/__tracks-return/source-destination'))
  app.get('/api/girigiri/source-page', c => c.redirect('/__tracks-return/source-destination'))
  app.get('/__tracks-return/source-destination', c => c.html('<!doctype html><title>Local source destination</title><p>Source destination fixture</p>'))
  app.post('/api/girigiri/locate', c => c.json({ candidates: [{ girigiriId: 'GV1001', girigiriName: '回程候选 · 本地验证片', day: 1, remarks: '本地候选', score: 1 }] }))
  app.post('/api/girigiri/search', c => c.json({ needsCaptcha: false, data: [{ girigiriId: 'GV1001', girigiriName: '回程候选 · 本地验证片', cover: '', episode: '本地验证片', year: '2026', area: '夹具' }] }))
  app.post('/__tracks-return/clear-xifan', c => {
    database.prepare('DELETE FROM xifan_binding').run()
    return c.json({ ok: true })
  })
  app.post('/__tracks-return/clear-girigiri', c => {
    database.prepare('DELETE FROM girigiri_binding').run()
    return c.json({ ok: true })
  })
})
const profile = mkdtempSync(join(tmpdir(), 'tracks-return-browser-'))
try {
  fixture.db.prepare('UPDATE tracks SET cover=?,bgm_tags=?,aliases=?,air_date=?,score=?').run('/assets/sagiri-avatar.webp', '["夹具"]', '["夹具别名"]', new Date().toISOString().slice(0, 10), 8)
  fixture.db.prepare('UPDATE tracks SET episode=11,user_tags=? WHERE user_id=? AND bgm_id=101').run('["回程组"]', fixture.alice)
  const snapshot = () => fixture.db.prepare('SELECT user_id,bgm_id,status,episode,total_episodes,user_tags,observe_count,extra FROM tracks ORDER BY user_id,bgm_id').all()
  const before = snapshot()
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = createRequire(import.meta.url)('electron') as string
  const runner = fileURLToPath(new URL('./tracks-player-return-browser.cjs', import.meta.url))
  const child = spawn(electron, [runner, fixture.browserOrigin, profile], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data.toString(); process.stdout.write(data) })
  child.stderr.on('data', data => process.stderr.write(data))
  const timer = setTimeout(() => child.kill('SIGTERM'), 180_000)
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => clearTimeout(timer))
  assert.equal(code, 0, `TRACKS_PLAYER_RETURN_BROWSER_EXIT: ${code}`)
  assert(output.includes('TRACKS_PLAYER_RETURN_CASES=19'), 'TRACKS_PLAYER_RETURN_CASES_INCOMPLETE')
  assert.equal(trackWrites, 0, 'return navigation must not write any track endpoint')
  assert.deepEqual(snapshot(), before, 'return navigation must preserve all original track fields')
  assert.equal(fixture.metrics.modelCalls, 0)
  assert.equal(fixture.metrics.externalRequests, 0)
  console.log('PASS tracks player return: 19 browser cases, unchanged tracks, 0 track writes, 0 model calls, 0 external fetches')
} finally {
  await fixture.close()
  rmSync(profile, { recursive: true, force: true })
}
