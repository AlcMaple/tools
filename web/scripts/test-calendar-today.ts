import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentUiFixture } from './agent-ui-fixture'

process.env.NODE_ENV = 'test'
process.env.AGENT_UI_FIXTURE = '1'
const fixture = await createAgentUiFixture()
const profile = mkdtempSync(join(tmpdir(), 'calendar-today-browser-'))
try {
  const labels = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']
  const data = labels.map((label, day) => ({
    id: day + 1,
    label,
    items: Array.from({ length: 4 }, (_, item) => ({
      id: -(5000 + day * 10 + item),
      name: '周历定位夹具 ' + (day + 1) + '-' + (item + 1),
      name_cn: '周历定位夹具 ' + (day + 1) + '-' + (item + 1),
      url: '', cover: '', airDate: '2026-09-01', episodes: 12, score: 0,
    })),
  }))
  writeFileSync(join(process.cwd(), 'data/calendar-cache.json'), JSON.stringify({ at: Date.now(), data }))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = createRequire(import.meta.url)('electron') as string
  const runner = fileURLToPath(new URL('./calendar-today-browser.cjs', import.meta.url))
  const child = spawn(electron, [runner, fixture.browserOrigin, profile], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += String(data); process.stdout.write(data) })
  child.stderr.on('data', data => process.stderr.write(data))
  const timer = setTimeout(() => child.kill('SIGTERM'), 90_000)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  }).finally(() => clearTimeout(timer))
  assert.equal(code, 0, 'CALENDAR_TODAY_BROWSER_EXIT: ' + code)
  assert.match(output, /CALENDAR_TODAY_CASES_COMPLETE=4/, 'all four viewport/layout cases must complete')
  assert.equal(fixture.metrics.modelCalls, 0)
  assert.equal(fixture.metrics.externalRequests, 0)
  console.log('PASS calendar today: 7 synthetic days, 0 model calls, 0 external fetches')
} finally {
  await fixture.close()
  rmSync(profile, { recursive: true, force: true })
}
