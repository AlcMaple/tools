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
const profile = mkdtempSync(join(tmpdir(), 'tracks-navigation-browser-'))
try {
  fixture.db.prepare('UPDATE tracks SET cover=?,bgm_tags=?,aliases=?,air_date=?,score=?').run('/assets/sagiri-avatar.webp', '["夹具"]', '["夹具别名"]', '2026-09-01', 8)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = createRequire(import.meta.url)('electron') as string
  const runner = fileURLToPath(new URL('./tracks-navigation-browser.cjs', import.meta.url))
  const child = spawn(electron, [runner, fixture.browserOrigin, profile], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => process.stdout.write(data))
  child.stderr.on('data', data => process.stderr.write(data))
  const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  }).finally(() => clearTimeout(timer))
  assert.equal(code, 0, `TRACKS_NAVIGATION_BROWSER_EXIT: ${code}`)
  assert.equal(fixture.metrics.modelCalls, 0)
  assert.equal(fixture.metrics.externalRequests, 0)
  console.log('PASS tracks navigation: synthetic accounts, 0 model calls, 0 external fetches')
} finally {
  await fixture.close()
  rmSync(profile, { recursive: true, force: true })
}
