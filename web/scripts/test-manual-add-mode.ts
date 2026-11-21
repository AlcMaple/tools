import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { createAgentUiFixture } from './agent-ui-fixture'

process.env.NODE_ENV = 'test'
process.env.AGENT_UI_FIXTURE = '1'
const fixture = await createAgentUiFixture()
const profile = mkdtempSync(join(tmpdir(), 'manual-add-browser-'))
try {
  const index = new Database(join(process.cwd(), 'data/bgm_index.db'))
  try {
    index.exec('CREATE TABLE anime (bgm_id INTEGER PRIMARY KEY, name TEXT, name_cn TEXT, aliases TEXT, date TEXT, score REAL); CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)')
    index.prepare('INSERT INTO meta VALUES (?,?)').run('built_at', String(Date.now()))
    const add = index.prepare('INSERT INTO anime VALUES (?,?,?,?,?,?)')
    add.run(38069, 'K', '', '[]', '2012-10-04', 6.5)
    add.run(8801, 'K SEVEN STORIES', '', '[]', '2018-09-01', 6.6)
    add.run(8802, 'Side Story', '番外篇', '["Side K"]', '2015-01-01', 9)
    add.run(8803, 'Kiki', '', '[]', '2019-01-01', 10)
  } finally {
    index.close()
  }
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
