import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentUiFixture } from './agent-ui-fixture'
import { tracksNavigationForOwner } from '../src/tracks/navigationMemory'

const aliceMemory = tracksNavigationForOwner(null, 1)
aliceMemory.filter = 'watching'
aliceMemory.query = '芙莉莲'
assert.equal(tracksNavigationForOwner(aliceMemory, 1), aliceMemory, 'same owner keeps the navigation object')
for (const ownerId of [2, null, 1]) {
  const prior = ownerId === 1 ? tracksNavigationForOwner(aliceMemory, 2) : aliceMemory
  const next = tracksNavigationForOwner(prior, ownerId)
  assert.notEqual(next, prior, 'owner boundary selects a fresh object before render')
  assert.equal(next.filter, 'all')
  assert.equal(next.query, '')
}
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
assert(!/setTracks(?:Query|Filter)/.test(appSource), 'search and filter updates must stay in TracksPage')
assert(appSource.includes("key={user?.id ?? 'guest'} navigation={tracksNavigation}"), 'owner change remounts the page')
console.log('PASS tracks memory: owner boundary is synchronous; input updates stay in the page')

process.env.NODE_ENV = 'test'
process.env.AGENT_UI_FIXTURE = '1'
const fixture = await createAgentUiFixture()
const profile = mkdtempSync(join(tmpdir(), 'tracks-navigation-browser-'))
try {
  fixture.db.prepare('UPDATE tracks SET cover=?,bgm_tags=?,aliases=?,air_date=?,score=?').run('/assets/sagiri-avatar.webp', '["夹具"]', '["夹具别名"]', '2026-09-01', 8)
  if (process.argv.includes('--serve')) {
    console.log(JSON.stringify({ origin: fixture.origin, browserUrl: fixture.browserOrigin + '/', mode: 'isolated-tracks-navigation', realAiCalls: 0 }))
    await new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
  } else {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const electron = createRequire(import.meta.url)('electron') as string
    const runner = fileURLToPath(new URL('./tracks-navigation-browser.cjs', import.meta.url))
    const child = spawn(electron, [runner, fixture.browserOrigin, profile], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let completedOutput = ''
    child.stdout.on('data', data => { completedOutput += data.toString(); process.stdout.write(data) })
    child.stderr.on('data', data => process.stderr.write(data))
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    }).finally(() => clearTimeout(timer))
    assert.equal(code, 0, `TRACKS_NAVIGATION_BROWSER_EXIT: ${code}`)
    assert(completedOutput.includes('TRACKS_NAVIGATION_CASES=4'), 'TRACKS_NAVIGATION_CASES_INCOMPLETE')
    assert.equal(fixture.metrics.modelCalls, 0)
    assert.equal(fixture.metrics.externalRequests, 0)
    console.log('PASS tracks navigation: synthetic accounts, 0 model calls, 0 external fetches')
  }
} finally {
  await fixture.close()
  rmSync(profile, { recursive: true, force: true })
}
