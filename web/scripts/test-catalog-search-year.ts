import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { createAgentUiFixture } from './agent-ui-fixture'
import type { CatalogItem } from '../server/bgm/catalog'

type Reply = { ready: boolean; total: number; items: CatalogItem[] }
process.env.NODE_ENV = 'test'
process.env.AGENT_UI_FIXTURE = '1'
const fixture = await createAgentUiFixture()
const indexPath = join(process.cwd(), 'data/bgm_index.db')
const index = new Database(indexPath)
index.exec('CREATE TABLE anime (bgm_id INTEGER PRIMARY KEY, name TEXT, name_cn TEXT, aliases TEXT, date TEXT, score REAL, tags TEXT, nsfw INTEGER, eps INTEGER, votes INTEGER); CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)')
index.prepare('INSERT INTO meta VALUES (?,?)').run('built_at', String(Date.now()))
const insert = index.prepare('INSERT INTO anime VALUES (?,?,?,?,?,?,?,?,?,?)')
for (const row of [
  [8101, 'Frieren', '葬送的芙莉莲', '["魔法远行"]', '2023-09-29', 8.5, '[]', 0, 28, 100],
  [8102, 'Frieren Two', '葬送的芙莉莲 第二季', '[]', '2026-01-16', 7.5, '[]', 0, 10, 100],
  [8103, 'Frieren Future', '葬送的芙莉莲 未定档篇', '[]', '', 7.4, '[]', 0, 0, 100],
  [8104, 'Frieren Short', '葬送的芙莉莲 短篇', '[]', '2023-10-01', 6.8, '[]', 0, 11, 100],
  [8105, 'Frieren Short Two', '葬送的芙莉莲 短篇第二期', '[]', '2025-01-01', 6.6, '[]', 0, 11, 100],
  [8106, 'Restricted Fixture', '葬送的芙莉莲 受限夹具条目', '[]', '2023-01-01', 9.9, '[]', 1, 1, 100],
  [38069, 'K', '', '[]', '2012-10-04', 6.5, '[]', 0, 13, 100],
  [251986, 'K SEVEN STORIES Episode 3', '', '[]', '2018-09-01', 6.6, '[]', 0, 1, 100],
  [8201, 'K-ON!', '', '["Volume 8"]', '2009-04-02', 8.2, '[]', 0, 13, 100],
  [8202, 'Project', '', '["Code K: Side Story"]', '2012-12-01', 6.2, '[]', 0, 1, 100],
  [8203, 'Kiki', '', '["Volume 18"]', '1989-07-29', 9.9, '[]', 0, 1, 100],
]) insert.run(...row)
index.close()

if (process.argv.includes('--serve')) {
  console.log(JSON.stringify({ origin: fixture.origin, browserUrl: fixture.browserOrigin + '/', mode: 'isolated-catalog-search-year', realAiCalls: 0, syntheticVisibleEntries: 10 }))
  let closing = false
  const close = (): void => {
    if (closing) return
    closing = true
    void fixture.close().then(() => process.exit(0))
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
} else {
  const profile = mkdtempSync(join(tmpdir(), 'catalog-search-year-browser-'))
  try {
    const request = async (q: string, year: number, offset = 0, limit = 48, sort = 'score'): Promise<Reply> => {
      const url = new URL('/api/catalog', fixture.origin)
      url.search = new URLSearchParams({ q, year: String(year), offset: String(offset), limit: String(limit), sort }).toString()
      const response = await fixture.originalFetch(url)
      assert.equal(response.status, 200)
      return await response.json() as Reply
    }
    const ids = (value: Reply): number[] => value.items.map(item => item.bgmId)
    const localIds = async (q: string, expectedSource = 'local'): Promise<number[]> => {
      const url = new URL('/api/search', fixture.origin)
      url.search = new URLSearchParams({ q, mode: 'local' }).toString()
      const response = await fixture.originalFetch(url)
      assert.equal(response.status, 200)
      const { source, data } = await response.json() as { source: string; data: { bgmId: number }[] }
      assert.equal(source, expectedSource)
      return data.map(hit => hit.bgmId)
    }
    const expected = [8201, 8202, 38069, 251986]
    for (const q of ['k', ' K ']) {
      assert.deepEqual((await localIds(q)).sort((a, b) => a - b), expected, 'local search includes standalone K in titles and aliases, not Kiki')
      assert.deepEqual(ids(await request(q, 0)), [8201, 251986, 38069, 8202], 'catalog keeps score order for matching entries')
    }
    assert.deepEqual(ids(await request('k', 2012, 0, 48, 'date')), [8202, 38069], 'catalog keeps year filter and latest order')
    assert.deepEqual(await localIds('8'), [8201], '8 is a standalone alias token; 18 is not')
    assert.deepEqual((await localIds('k Frieren')).sort(), (await localIds('Frieren')).sort(), 'one letter in a longer query must not add unrelated hits')
    fixture.db.prepare('INSERT INTO bgm_search_additions (bgm_id, name, name_cn, aliases, date, score, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(8301, 'Project', '', '["Code Q"]', '', 0, Date.now())
    assert.deepEqual(await localIds('q', 'learned'), [8301], 'additions must match single-letter aliases when the archive has no hits')
    console.log('PASS single-character local and catalog searches: case, whitespace, boundaries, aliases, year and sort')
    const filtered = await request('芙莉莲', 2023)
    assert.equal(filtered.ready, true)
    assert.equal(filtered.total, 2, 'keyword and selected year must combine before counting results')
    assert.deepEqual(ids(filtered), [8101, 8104])
    assert(filtered.items.every(item => item.date.startsWith('2023-')))
    console.log('PASS catalog search-year: 2023 contains only original and short, restricted fixture excluded')
    assert.deepEqual(ids(await request('芙莉莲', 2025)), [8105])
    const all = await request('芙莉莲', 0)
    assert.equal(all.total, 5)
    assert(ids(all).includes(8103), 'all years must retain undated matches')
    assert(!ids(all).includes(8106), 'guest visibility must remain unchanged')
    assert.equal((await request('芙莉莲', 1999)).total, 0)
    assert.equal((await request('', 2023)).total, 2)
    assert.deepEqual(ids(await request('魔法远行', 2023)), [8101])
    console.log('PASS catalog search-year: year changes, undated all-years, alias and browse behavior preserved')
    const first = await request('芙莉莲', 2023, 0, 1)
    const second = await request('芙莉莲', 2023, 1, 1)
    assert.equal(first.total, 2)
    assert.equal(second.total, 2)
    assert.deepEqual(ids(first), [8101])
    assert.deepEqual(ids(second), [8104])
    assert.deepEqual(ids(await request('芙莉莲', 2023, 2, 1)), [])
    console.log('PASS catalog search-year: count and pagination use the same year constraint')
    const extra = new Database(indexPath)
    const add = extra.prepare('INSERT INTO anime VALUES (?,?,?,?,?,?,?,?,?,?)')
    extra.transaction(() => {
      for (let n = 0; n < 121; n++) add.run(9000 + n, 'Other Year ' + n, '芙莉莲干扰条目' + n, '[]', '2026-01-01', 10, '[]', 0, 1, 100)
      for (let n = 0; n < 31; n++) add.run(9200 + n, 'K Series ' + n, '', '[]', '2026-01-01', 9, '[]', 0, 1, 100)
      add.run(9999, 'Late Matching Year', '芙莉莲尾部年份目标', '[]', '1998-01-01', 1, '[]', 0, 1, 100)
    })()
    extra.close()
    const beyondCap = await request('芙莉莲', 1998)
    assert.equal(beyondCap.total, 1, 'selected-year match beyond 120 other-year candidates must not disappear')
    assert.deepEqual(ids(beyondCap), [9999])
    console.log('PASS catalog search-year: year is applied before the 120-candidate cut')
    const capped = await localIds('k')
    assert.equal(capped.length, 30)
    assert.equal(capped[0], 38069, 'case-insensitive exact title must win before the 30-result cut')
    const reset = new Database(indexPath)
    reset.prepare('DELETE FROM anime WHERE bgm_id BETWEEN ? AND ?').run(9000, 9999)
    reset.close()
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const electron = createRequire(import.meta.url)('electron') as string
    const runner = fileURLToPath(new URL('./catalog-search-year-browser.cjs', import.meta.url))
    const child = spawn(electron, [runner, fixture.browserOrigin, profile], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += String(data); process.stdout.write(data) })
    child.stderr.on('data', data => process.stderr.write(data))
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    }).finally(() => clearTimeout(timer))
    assert.equal(code, 0, 'CATALOG_SEARCH_YEAR_BROWSER_EXIT: ' + code)
    assert.match(output, /CATALOG_SEARCH_YEAR_BROWSER_COMPLETE/, 'the real page journey must finish')
    assert.equal(fixture.metrics.modelCalls, 0)
    assert.equal(fixture.metrics.externalRequests, 0)
    console.log('PASS catalog search-year: API and real page complete, 0 model calls, 0 external fetches')
  } finally {
    await fixture.close()
    rmSync(profile, { recursive: true, force: true })
  }
}
