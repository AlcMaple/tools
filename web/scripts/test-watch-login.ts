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
process.env.AGENT_UI_WATCH_LOGIN = '1'
const fixture = await createAgentUiFixture()
const profile = mkdtempSync(join(tmpdir(), 'watch-login-browser-'))
try {
  assert(fixture.watchFixture?.password)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = createRequire(import.meta.url)('electron') as string
  const runner = fileURLToPath(new URL('./watch-login-browser.cjs', import.meta.url))
  const child = spawn(electron, [runner, fixture.browserOrigin, profile], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end(JSON.stringify({ password: fixture.watchFixture.password }))
  let completedOutput = ''
  child.stdout.on('data', data => { completedOutput += data.toString(); process.stdout.write(data) })
  child.stderr.on('data', data => process.stderr.write(data))
  const timer = setTimeout(() => child.kill('SIGTERM'), 90_000)
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => clearTimeout(timer))
  assert.equal(code, 0, `WATCH_LOGIN_BROWSER_EXIT: ${code}`)
  assert(completedOutput.includes('WATCH_LOGIN_CASES=8'), 'WATCH_LOGIN_CASES_INCOMPLETE')
  assert.equal(fixture.metrics.modelCalls, 0)
  assert.equal(fixture.metrics.externalRequests, 0)
  console.log('PASS watch login: 3 healthy, 3 interrupted, cancellation and confirmed-401 paths, 0 models, 0 external fetches, no real email')
} finally {
  await fixture.close()
  rmSync(profile, { recursive: true, force: true })
}
