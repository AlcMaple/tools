import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const directory = mkdtempSync(join(tmpdir(), 'related-index-'))
const subjects = join(directory, 'subject.jsonlines'), relations = join(directory, 'subject-relations.jsonlines')
const target = join(directory, 'bgm_index.db')
const builder = fileURLToPath(new URL('./build-bgm-index.ts', import.meta.url))
writeFileSync(subjects, [...[1, 2, 3].map(id => JSON.stringify({ id, type: 2, name: '关联夹具' + id })), JSON.stringify({ id: 99, type: 1, name: '漫画夹具' })].join('\n'))
const row = (from: number, type: number, to: number, order = 0) => JSON.stringify({ subject_id: from, relation_type: type, related_subject_id: to, order })
writeFileSync(relations, [row(1, 3, 2, 8), row(1, 3, 2, 1), row(2, 2, 1), row(1, 6, 3), row(1, 3, 99), row(1, 3, 1)].join('\n'))
const build = (withRelations = true) => spawnSync(process.execPath, ['--import', 'tsx', builder, '--file', subjects, ...(withRelations ? ['--relation-file', relations] : [])], {
  cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production', DATA_DIR: directory }, encoding: 'utf8', timeout: 20000,
})
try {
  const good = build()
  assert.equal(good.status, 0, good.stdout + good.stderr)
  const db = new Database(target, { readonly: true })
  assert.deepEqual(db.prepare('SELECT * FROM anime_relation ORDER BY subject_id,relation_type').all(), [
    { subject_id: 1, relation_type: 3, related_subject_id: 2, sort: 1 },
    { subject_id: 1, relation_type: 6, related_subject_id: 3, sort: 0 },
    { subject_id: 2, relation_type: 2, related_subject_id: 1, sort: 0 },
  ])
  db.close()
  const hash = () => createHash('sha256').update(readFileSync(target)).digest('hex')
  const before = hash()
  writeFileSync(relations, row(1,3,2) + '\n{broken')
  const failed = build()
  assert.notEqual(failed.status, 0)
  assert.equal(hash(), before, 'FAILED_RELATION_IMPORT_MUST_PRESERVE_OLD_INDEX')
  console.log('PASS direct relation direction, duplicate minimum order, missing/non-anime endpoints, self edge')
  console.log('PASS malformed relation abort leaves the previous index byte-for-byte intact')
  const compatible = build(false)
  assert.equal(compatible.status, 0, compatible.stderr)
  const legacy = new Database(target, { readonly: true })
  assert.equal(legacy.prepare("SELECT 1 FROM sqlite_master WHERE name='anime_relation'").get(), undefined)
  assert.equal((legacy.prepare('SELECT COUNT(*) AS n FROM anime').get() as { n: number }).n, 3)
  legacy.close()
  console.log('PASS no relation file retains usable legacy index; no archive download invoked')
  writeFileSync(relations, row(1, 3, 2))
  writeFileSync(join(directory, 'episode.jsonlines'), JSON.stringify({ id: 1, subject_id: 1, type: 0 }))
  const zip = join(directory, 'fixture.zip')
  assert.equal(spawnSync('zip', ['-q', zip, 'subject-relations.jsonlines', 'subject.jsonlines', 'episode.jsonlines'], { cwd: directory }).status, 0)
  const archived = spawnSync(process.execPath, ['--import', 'tsx', builder, '--archive-file', zip], { env: { ...process.env, NODE_ENV: 'production', DATA_DIR: directory }, encoding: 'utf8', timeout: 20000 })
  assert.equal(archived.status, 0, archived.stdout + archived.stderr)
  assert(existsSync(zip), 'caller-owned archive must remain untouched')
  const rebuilt = new Database(target, { readonly: true })
  assert.equal((rebuilt.prepare('SELECT COUNT(*) AS n FROM anime_relation').get() as { n: number }).n, 1)
  assert.equal((rebuilt.prepare('SELECT COUNT(*) AS n FROM anime').get() as { n: number }).n, 3)
  rebuilt.close()
  console.log('PASS archive member selection ignores relation-first ordering and retains caller archive')
  console.log('RELATED_INDEX_COMPLETE')
} finally { rmSync(directory, { recursive: true, force: true }) }
