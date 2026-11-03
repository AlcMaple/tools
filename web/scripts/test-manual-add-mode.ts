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
const profile = mkdtempSync(join(tmpdir(), 'manual-add-browser-'))
try {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = createRequire(import.meta.url)('electron') as string
  const runner = fileURLToPath(new URL('./manual-add-browser.cjs', import.meta.url))
  const child = spawn(electron, [runner, fixture.browserOrigin, profile], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => process.stdout.write(data))
  child.stderr.on('data', data => process.stderr.write(data))
  const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  }).finally(() => clearTimeout(timer))
  assert.equal(code, 0, `MANUAL_ADD_BROWSER_EXIT: ${code}`)
  const user = fixture.db.prepare('SELECT id FROM users WHERE username=?').get('ui_empty') as { id: number } | undefined
  assert(user)
  const rows = fixture.db.prepare('SELECT title FROM tracks WHERE user_id=? ORDER BY title').all(user.id) as { title: string }[]
  assert.deepEqual(rows.map(row => row.title), ['手动回归一号', '手动回归二号'])
  assert.equal(fixture.metrics.modelCalls, 0)
  assert.equal(fixture.metrics.externalRequests, 0)
  console.log('PASS manual add: exactly two persisted records, 0 model calls, 0 external fetches')
} finally {
  await fixture.close()
  rmSync(profile, { recursive: true, force: true })
}
