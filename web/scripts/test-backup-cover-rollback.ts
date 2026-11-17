import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setImmediate as immediate } from 'node:timers/promises'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { createAgentUiFixture } from './agent-ui-fixture'

type Row = Record<string, unknown>
type Event = Record<string, unknown>
type Entry = { path: string; kind: 'directory' | 'file'; sha256?: string; bytes?: number }
const assets = fileURLToPath(new URL('./fixtures/backup-cover-rollback/', import.meta.url))
const evidence = process.env.BACKUP_COVER_EVIDENCE_DIR
const sha = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
const A = fs.readFileSync(join(assets, 'cover-A.png'))
const B = fs.readFileSync(join(assets, 'cover-B.png'))
const C = fs.readFileSync(join(assets, 'cover-C.png'))
const ZIP = fs.readFileSync(join(assets, 'product-backup-B.zip'))
const source = JSON.parse(strFromU8(unzipSync(ZIP)['data.json'])) as { exportedBy: { userId: number }; tracks: Row[]; [key: string]: unknown }
const template = source.tracks.find(row => row.bgmId === 101)!
assert(template && template.episode === 9)
const started = Date.now()
const oldTime = Math.min(1794830400000, started - 120_000)
assert(oldTime < Math.min(Number(template.updatedAt), started), 'seed must be older than the import-normalized archive timestamp')
if (evidence) fs.mkdirSync(evidence, { recursive: true })
const save = (name: string, value: unknown): void => { if (evidence) fs.writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n') }
const saveBytes = (name: string, bytes: Uint8Array): void => { if (evidence) fs.writeFileSync(join(evidence, name), bytes) }
const events: Event[] = []
const requests: Event[] = []
const cases: Event[] = []
const inputs: Event[] = []
let activeCase = ''
const note = (kind: string, data: Event = {}): void => { events.push({ index: events.length, case: activeCase, kind, ...data }) }
const originals = { writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, unlinkSync: fs.unlinkSync, rmSync: fs.rmSync, lstatSync: fs.lstatSync, writeFile: fsp.writeFile, error: console.error, fileArrayBuffer: Object.getOwnPropertyDescriptor(File.prototype, 'arrayBuffer') }
const nativeArrayBuffer = File.prototype.arrayBuffer
process.env.NODE_ENV = 'test'
process.env.AGENT_UI_FIXTURE = '1'
delete process.env.AGENT_UI_WATCH
const fixture = await createAgentUiFixture()
const { trackInternals: T } = await import('../server/tracks')
const { coversDir } = await import('../server/data-dir')
const nativeLock = T.withCoverFileLocks
let lockDepth = 0
let importLockQueued: (() => void) | null = null
let uploadConsumed: (() => void) | null = null
let importing = false
let partialWrite = false
let partialWrites = 0
let failRestore = false
let restoreFailures = 0
let failCleanup = false
let cleanupFailures = 0
let budgetTarget: string | null = null
let budgetReads = 0
let immediateUpload = false
let faultRemaining = 0
let faultCalls = 0
let count = 0
const logs: string[] = []
const pathOf = (value: unknown): string | null => typeof value === 'string' ? resolve(value) : value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? resolve(value.toString()) : null
const inCovers = (value: unknown): string | null => { const path = pathOf(value); return path?.startsWith(coversDir + '/') ? path : null }
const bytesOf = (value: unknown): Uint8Array | null => typeof value === 'string' ? Buffer.from(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : value instanceof ArrayBuffer ? new Uint8Array(value) : null
const error = (message: string): NodeJS.ErrnoException => Object.assign(new Error(message), { code: 'EIO' })

T.withCoverFileLocks = async <Value>(uid: number, ids: number[], run: () => Promise<Value>): Promise<Value> => {
  importLockQueued?.()
  return nativeLock(uid, ids, async () => {
    lockDepth++
    note('import-lock-enter', { uid, ids })
    try { return await run() }
    finally { note('import-lock-leave', { uid, ids }); lockDepth-- }
  })
}
fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
  const path = inCovers(args[0]), bytes = bytesOf(args[1])
  if (importing && path && bytes) {
    note('sync-write', { path: relative(coversDir, path), sha256: sha(bytes), lockHeld: lockDepth > 0 })
    if (partialWrite && sha(bytes) === sha(B)) {
      partialWrite = false; partialWrites++
      originals.writeFileSync(args[0], bytes.subarray(0, 31))
      note('partial-write-fault', { path: relative(coversDir, path), bytes: 31 })
      throw error('CONTROLLED_PARTIAL_COVER_WRITE')
    }
  }
  return originals.writeFileSync(...args)
}) as typeof fs.writeFileSync
fs.renameSync = ((from, to) => {
  const sourcePath = inCovers(from), destination = inCovers(to)
  if (importing && sourcePath && destination) {
    const hash = fs.existsSync(sourcePath) ? sha(fs.readFileSync(sourcePath)) : null
    const restoring = hash === sha(A) && !relative(coversDir, destination).includes('/')
    note(restoring ? 'restore-old-cover' : 'rename-cover', { from: relative(coversDir, sourcePath), to: relative(coversDir, destination), sha256: hash, lockHeld: lockDepth > 0 })
    if (restoring && failRestore) { failRestore = false; restoreFailures++; throw error('CONTROLLED_RESTORE_RENAME_FAILURE') }
  }
  return originals.renameSync(from, to)
}) as typeof fs.renameSync
fs.unlinkSync = ((path) => {
  const target = inCovers(path)
  if (importing && target) note('remove-new-cover', { path: relative(coversDir, target), lockHeld: lockDepth > 0 })
  return originals.unlinkSync(path)
}) as typeof fs.unlinkSync
fs.rmSync = ((...args: Parameters<typeof fs.rmSync>) => {
  const path = inCovers(args[0])
  if (importing && path?.includes('/.backup-')) {
    note('cleanup-staging', { path: relative(coversDir, path), lockHeld: lockDepth > 0 })
    if (failCleanup) { failCleanup = false; cleanupFailures++; throw error('CONTROLLED_COMMITTED_CLEANUP_FAILURE') }
  }
  return originals.rmSync(...args)
}) as typeof fs.rmSync
fs.lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => {
  const value = originals.lstatSync(...args)
  if (importing && budgetTarget && inCovers(args[0]) === budgetTarget) {
    budgetReads++
    Object.defineProperty(value, 'size', { value: 200 * 1024 * 1024 + 1 })
    note('snapshot-budget-fault', { path: relative(coversDir, budgetTarget!) })
  }
  return value
}) as typeof fs.lstatSync
fsp.writeFile = (async (...args: Parameters<typeof fsp.writeFile>) => {
  const path = inCovers(args[0]), bytes = bytesOf(args[1])
  if (path && bytes && sha(bytes) === sha(C)) {
    note('upload-C-write', { path: relative(coversDir, path), importLockHeld: lockDepth > 0 })
    if (immediateUpload) {
      originals.writeFileSync(path, bytes)
      return
    }
  }
  return originals.writeFile(...args)
}) as typeof fsp.writeFile
Object.defineProperty(File.prototype, 'arrayBuffer', { configurable: true, writable: true, value: async function(this: File): Promise<ArrayBuffer> {
  const value = await nativeArrayBuffer.call(this)
  if (this.name === 'concurrent-C.png') { note('upload-C-body-consumed'); uploadConsumed?.() }
  return value
} })
console.error = (...values: unknown[]): void => {
  const text = values.map(value => value instanceof Error ? value.stack ?? value.message : String(value)).join(' ')
  logs.push(text)
  originals.error(...values)
}
syncBuiltinESMExports()

try {
  assert.equal(source.exportedBy.userId, fixture.alice)
  const cookieFor = async (owner: 'alice' | 'bob'): Promise<string> => {
    const response = await fixture.originalFetch(fixture.origin + '/__agent-test/login/' + owner, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    assert.equal(response.status, 302)
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    assert(cookie)
    return cookie
  }
  const aliceCookie = await cookieFor('alice'), bobCookie = await cookieFor('bob')
  const request = async (path: string, init: RequestInit = {}, uid = fixture.alice): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('Origin', fixture.origin)
    headers.set('Cookie', uid === fixture.alice ? aliceCookie : bobCookie)
    let body = init.body
    if (body instanceof FormData) {
      const encoded = new Request(fixture.origin + path, { method: init.method ?? 'POST', body })
      headers.set('Content-Type', encoded.headers.get('Content-Type')!)
      body = await encoded.arrayBuffer()
    }
    const response = await fixture.originalFetch(fixture.origin + path, { ...init, headers, body, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    requests.push({ case: activeCase, method: init.method ?? 'GET', path, uid, status: response.status })
    return response
  }
  const rows = (uid = fixture.alice): Row[] => fixture.db.prepare('SELECT * FROM tracks WHERE user_id=? ORDER BY bgm_id').all(uid) as Row[]
  const tree = (): Entry[] => {
    const out: Entry[] = []
    const walk = (directory: string): void => {
      for (const name of fs.readdirSync(directory).sort()) {
        const path = join(directory, name), stat = originals.lstatSync(path), rel = relative(coversDir, path)
        if (stat.isDirectory()) { out.push({ path: rel, kind: 'directory' }); walk(path) }
        else { const bytes = fs.readFileSync(path); out.push({ path: rel, kind: 'file', sha256: sha(bytes), bytes: bytes.byteLength }) }
      }
    }
    walk(coversDir)
    return out
  }
  const snapshot = async (name: string, ids: number[], uid = fixture.alice): Promise<{ rows: Row[]; files: Entry[]; http: Event[] }> => {
    const http: Event[] = []
    for (const id of ids) {
      const response = await request(`/api/tracks/${id}/cover-file?fixture=${count}`, {}, uid)
      const bytes = new Uint8Array(await response.arrayBuffer())
      http.push({ id, status: response.status, mime: response.headers.get('content-type'), sha256: response.ok ? sha(bytes) : null })
    }
    const result = { rows: rows(uid), files: tree(), http }
    save(name + '.json', result)
    return result
  }
  const upload = async (id: number, bytes: Uint8Array, uid = fixture.alice, name = 'fixture.png'): Promise<void> => {
    const form = new FormData(); form.append('file', new File([bytes as BlobPart], name, { type: 'image/png' }))
    const response = await request(`/api/tracks/${id}/cover`, { method: 'POST', body: form }, uid)
    assert.equal(response.status, 200, await response.text())
  }
  const prepare = async (ids = [101]): Promise<void> => {
    for (const id of ids) {
      await upload(id, A)
      fixture.db.prepare('UPDATE tracks SET updated_at=? WHERE user_id=? AND bgm_id=?').run(oldTime, fixture.alice, id)
    }
  }
  const customZip = (ids: number[]): Uint8Array => {
    const tracks = ids.map(id => ({ ...template, bgmId: id, coverFile: `covers/${id}.png` }))
    const entries: Record<string, Uint8Array> = { 'data.json': strToU8(JSON.stringify({ ...source, tracks, reviews: [] })) }
    for (const id of ids) entries[`covers/${id}.png`] = B
    return zipSync(entries, { mtime: new Date(2026, 0, 1) })
  }
  const importZip = async (name: string, bytes = ZIP, expected = 500, uid = fixture.alice): Promise<void> => {
    inputs.push({ case: activeCase, name, sha256: sha(bytes) }); saveBytes(name + '.zip', bytes)
    const form = new FormData(); form.append('file', new File([bytes as BlobPart], name + '.zip'))
    importing = true
    try {
      const response = await request('/api/backup/import', { method: 'POST', body: form }, uid)
      const body = await response.text()
      note('import-response', { status: response.status, body })
      assert.equal(response.status, expected, `BACKUP_IMPORT_STATUS:${name}: ${body}`)
      assert(!body.includes(coversDir), 'client errors must not expose recovery paths')
    } finally { importing = false }
  }
  fixture.db.function('ux_cover_test_fault', () => { faultRemaining--; faultCalls++; note('database-fault', { files: tree(), lockHeld: lockDepth > 0 }); return 1 })
  fixture.db.function('ux_cover_test_armed', () => faultRemaining > 0 ? 1 : 0)
  const disarm = (): void => { fixture.db.exec('DROP TRIGGER IF EXISTS temp.ux_cover_test_abort'); faultRemaining = 0 }
  const arm = (id: number, kind: 'UPDATE' | 'INSERT' = 'UPDATE'): void => {
    disarm(); faultRemaining = 1; faultCalls = 0
    fixture.db.exec(`CREATE TEMP TRIGGER ux_cover_test_abort BEFORE ${kind} ON main.tracks FOR EACH ROW WHEN NEW.user_id=${fixture.alice} AND NEW.bgm_id=${id} AND ux_cover_test_armed()=1 BEGIN SELECT ux_cover_test_fault(); SELECT RAISE(ABORT,'CONTROLLED_BACKUP_DB_FAILURE'); END;`)
  }
  const unchanged = (before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>, label: string): void => {
    assert.deepEqual(after.rows, before.rows, label + '_DB')
    assert.deepEqual(after.files, before.files, label + '_FILES')
    assert.deepEqual(after.http, before.http, label + '_HTTP')
  }
  const check = async (name: string, action: () => Promise<void>): Promise<void> => {
    activeCase = name
    const start = events.length
    try { await action(); count++; cases.push({ name, passed: true, events: [start, events.length] }); console.log(`PASS R${count} ${name}`) }
    catch (failure) { cases.push({ name, passed: false, events: [start, events.length] }); throw failure }
    finally { disarm(); importing = false; partialWrite = false; failRestore = false; failCleanup = false; budgetTarget = null; immediateUpload = false; importLockQueued = null; uploadConsumed = null }
  }
  for (const track of source.tracks) fixture.db.prepare('UPDATE tracks SET status=?,episode=?,total_episodes=?,title=?,title_cn=?,cover=?,air_weekday=?,air_date=?,score=?,bgm_tags=?,user_tags=?,aliases=?,extra=?,observe_count=?,created_at=0,updated_at=? WHERE user_id=? AND bgm_id=?').run(track.status, track.episode, track.totalEpisodes, track.title, track.titleCn, '/assets/sagiri-avatar.webp', track.airWeekday, track.airDate, track.score, JSON.stringify(track.bgmTags), JSON.stringify(track.userTags), JSON.stringify(track.aliases), JSON.stringify(track.extra), track.observeCount, oldTime, fixture.alice, track.bgmId)
  fixture.db.prepare('UPDATE tracks SET bgm_id=101,cover=?,air_date=?,score=8,bgm_tags=? WHERE user_id=?').run('/assets/sagiri-avatar.webp', '2026-09-01', '["夹具"]', fixture.bob)
  save('input-clock.json', { started, archiveUpdatedAt: template.updatedAt, localUpdatedAt: oldTime, importNormalizedAtStart: Math.min(Number(template.updatedAt), started), seedOlder: true, syntheticTimeOrdering: true })

  await check('old uploaded A survives a database failure byte-for-byte', async () => {
    await prepare(); const before = await snapshot('old-before', [101]); arm(101)
    await importZip('fixed-product'); assert.equal(faultCalls, 1)
    const after = await snapshot('old-after', [101]); unchanged(before, after, 'BACKUP_ROLLBACK_RESTORES_ORIGINAL_COVER')
    const restoreEvents = events.filter(e => e.case === activeCase && e.kind === 'restore-old-cover')
    assert(restoreEvents.length > 0 && restoreEvents.every(e => e.lockHeld === true), 'BACKUP_ROLLBACK_MUST_HOLD_COVER_LOCK')
  })
  await check('a failed new record leaves neither a row nor an orphan cover', async () => {
    const before = await snapshot('new-before', [501]); arm(501, 'INSERT')
    await importZip('new-record', customZip([501])); assert.equal(faultCalls, 1)
    unchanged(before, await snapshot('new-after', [501]), 'BACKUP_ROLLBACK_CLEANS_NEW_COVER')
  })
  await check('a later record failure restores all earlier old and new files', async () => {
    await prepare([101, 102]); const before = await snapshot('multi-before', [101, 102, 601]); arm(102)
    await importZip('multi-record', customZip([101, 601, 102])); assert.equal(faultCalls, 1)
    unchanged(before, await snapshot('multi-after', [101, 102, 601]), 'BACKUP_MULTI_RECORD_ATOMIC')
  })
  await check('a partial staged write preserves old A and removes partial files', async () => {
    await prepare(); const before = await snapshot('partial-old-before', [101]); partialWrite = true; partialWrites = 0
    await importZip('partial-old'); assert.equal(partialWrites, 1)
    unchanged(before, await snapshot('partial-old-after', [101]), 'BACKUP_PARTIAL_WRITE_OLD')
  })
  await check('a partial staged write for a new record leaves no half-file', async () => {
    const before = await snapshot('partial-new-before', [502]); partialWrite = true; partialWrites = 0
    await importZip('partial-new', customZip([502])); assert.equal(partialWrites, 1)
    unchanged(before, await snapshot('partial-new-after', [502]), 'BACKUP_PARTIAL_WRITE_NEW')
  })
  await check('without faults the same fixed ZIP commits B rather than disabling import', async () => {
    await prepare(); await importZip('positive-same-fixed-product', ZIP, 200)
    const after = await snapshot('positive-after', [101])
    assert.equal(after.http[0].status, 200); assert.equal(after.http[0].sha256, sha(B))
    assert.equal(after.rows.find(row => row.bgm_id === 101)?.episode, 9)
    assert.equal(after.rows.length, 3)
  })
  await check('queued upload C waits for rollback and another account stays independent', async () => {
    await prepare(); await upload(101, A, fixture.bob)
    const before = rows(); const bobBefore = rows(fixture.bob)
    let release!: () => void, acquired!: () => void, queued!: () => void, consumed!: () => void
    const gate = new Promise<void>(resolveGate => { release = resolveGate })
    const entered = new Promise<void>(resolveGate => { acquired = resolveGate })
    const importQueued = new Promise<void>(resolveGate => { queued = resolveGate })
    const consumedBody = new Promise<void>(resolveGate => { consumed = resolveGate })
    const hold = nativeLock(fixture.alice, [101], async () => { acquired(); await gate })
    await entered; importLockQueued = queued; uploadConsumed = consumed; arm(101); immediateUpload = true
    const importingRequest = importZip('concurrent-import')
    let uploading: Promise<void> | null = null
    const bounded = async (promise: Promise<void>, reason: string): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), 5000) })]) }
      finally { clearTimeout(timer) }
    }
    try {
      await bounded(importQueued, 'IMPORT_DID_NOT_QUEUE_ON_COVER_LOCK')
      uploading = upload(101, C, fixture.alice, 'concurrent-C.png')
      await bounded(consumedBody, 'CONCURRENT_UPLOAD_NOT_CONSUMED'); await immediate()
      assert.equal(events.filter(e => e.case === activeCase && e.kind === 'upload-C-write' && e.path === `${fixture.alice}_101`).length, 0, 'same-owner upload must wait behind the held import lock')
      await bounded(upload(101, C, fixture.bob, 'other-owner-C.png'), 'OTHER_OWNER_WRONGLY_BLOCKED')
      assert.equal(sha(fs.readFileSync(T.coverFilePath(fixture.bob, 101))), sha(C), 'another owner must not be blocked by Alice cover lock')
      release(); await hold; await Promise.all([importingRequest, uploading])
    } finally { release(); await hold; await Promise.allSettled([importingRequest, ...(uploading ? [uploading] : [])]) }
    const after = await snapshot('concurrent-after', [101])
    assert.equal(after.http[0].sha256, sha(C), 'BACKUP_CONCURRENT_UPLOAD_MUST_WIN_AFTER_ROLLBACK')
    assert.equal(after.rows.length, before.length)
    for (const field of ['status', 'episode', 'total_episodes', 'user_tags', 'extra']) assert.equal(after.rows.find(row => row.bgm_id === 101)?.[field], before.find(row => row.bgm_id === 101)?.[field])
    assert.equal(rows(fixture.bob)[0].episode, bobBefore[0].episode)
    assert.equal(sha(fs.readFileSync(T.coverFilePath(fixture.bob, 101))), sha(C))
    const restored = events.findIndex(e => e.case === activeCase && e.kind === 'restore-old-cover' && e.to === `${fixture.alice}_101`)
    const uploaded = events.findIndex(e => e.case === activeCase && e.kind === 'upload-C-write' && e.path === `${fixture.alice}_101`)
    assert(restored >= 0 && uploaded > restored, 'BACKUP_UPLOAD_ORDER_ROLLBACK_THEN_C')
  })
  await check('snapshot budget rejection rolls back earlier replacements', async () => {
    await prepare([101, 102]); const before = await snapshot('budget-before', [101, 102]); budgetTarget = T.coverFilePath(fixture.alice, 102); budgetReads = 0
    await importZip('snapshot-budget', customZip([101, 102]), 413); assert(budgetReads > 0)
    unchanged(before, await snapshot('budget-after', [101, 102]), 'BACKUP_BUDGET_ROLLBACK')
  })
  await check('a failed compensation retains rescue bytes and both error reasons', async () => {
    await prepare(); const before = rows(); const start = logs.length; arm(101); failRestore = true; restoreFailures = 0
    await importZip('restore-error'); assert.equal(restoreFailures, 1); assert.deepEqual(rows(), before)
    const recovery = tree().find(entry => entry.kind === 'file' && entry.path.includes('/') && entry.sha256 === sha(A))
    assert(recovery, 'BACKUP_RESTORE_FAILURE_MUST_RETAIN_RESCUE_BYTES')
    saveBytes('rescue-A.png', fs.readFileSync(join(coversDir, recovery.path)))
    const emitted = logs.slice(start).join('\n')
    assert(emitted.includes('CONTROLLED_BACKUP_DB_FAILURE') && emitted.includes('CONTROLLED_RESTORE_RENAME_FAILURE'), 'both original and compensation failures must be logged')
    await snapshot('restore-error-after', [101])
    for (const name of fs.readdirSync(coversDir)) if (name.startsWith('.backup-')) originals.rmSync(join(coversDir, name), { recursive: true, force: true })
  })
  await check('post-commit cleanup failure warns without reporting a failed import', async () => {
    await upload(101, A, fixture.bob)
    fixture.db.prepare('UPDATE tracks SET updated_at=? WHERE user_id=? AND bgm_id=101').run(oldTime, fixture.bob)
    const start = logs.length; failCleanup = true; cleanupFailures = 0
    await importZip('committed-cleanup-error', ZIP, 200, fixture.bob); assert.equal(cleanupFailures, 1)
    const after = await snapshot('cleanup-error-after', [101], fixture.bob)
    assert.equal(after.http[0].sha256, sha(B)); assert.equal(after.rows.find(row => row.bgm_id === 101)?.episode, 9)
    assert(logs.slice(start).join('\n').includes('CONTROLLED_COMMITTED_CLEANUP_FAILURE'))
  })
  await check('budget failure plus failed compensation reports 500 and retains recovery bytes', async () => {
    for (const name of fs.readdirSync(coversDir)) if (name.startsWith('.backup-')) originals.rmSync(join(coversDir, name), { recursive: true, force: true })
    await prepare([101, 102, 103]); const before = rows(); const start = logs.length
    budgetTarget = T.coverFilePath(fixture.alice, 103); budgetReads = 0; failRestore = true; restoreFailures = 0
    await importZip('budget-and-restore-error', customZip([101, 102, 103]), 500)
    assert(budgetReads > 0); assert.equal(restoreFailures, 1); assert.deepEqual(rows(), before)
    assert.equal(sha(fs.readFileSync(T.coverFilePath(fixture.alice, 101))), sha(A), 'other journal entries must still be restored after one compensation error')
    assert.equal(sha(fs.readFileSync(T.coverFilePath(fixture.alice, 103))), sha(A))
    const recovery = tree().find(entry => entry.kind === 'file' && entry.path.includes('/') && entry.sha256 === sha(A))
    assert(recovery, 'BUDGET_PLUS_RESTORE_ERROR_MUST_KEEP_RESCUE_BYTES')
    saveBytes('budget-rescue-A.png', fs.readFileSync(join(coversDir, recovery.path)))
    assert(logs.slice(start).join('\n').includes('CONTROLLED_RESTORE_RENAME_FAILURE'))
    assert(logs.slice(start).join('\n').includes('200 MB'), 'original snapshot budget reason must remain logged')
    await snapshot('budget-restore-error-after', [101, 102, 103])
  })
  assert.equal(fixture.metrics.externalRequests, 0); assert.equal(fixture.metrics.modelCalls, 0)
  console.log(`BACKUP_COVER_ROLLBACK_CASES=${count}`)
  console.log('PASS backup cover rollback: actual API/database/files, fixed ZIP, queued uploads, 0 external requests, 0 model calls')
} finally {
  T.withCoverFileLocks = nativeLock
  fs.writeFileSync = originals.writeFileSync; fs.renameSync = originals.renameSync; fs.unlinkSync = originals.unlinkSync; fs.rmSync = originals.rmSync; fs.lstatSync = originals.lstatSync; fsp.writeFile = originals.writeFile
  console.error = originals.error
  if (originals.fileArrayBuffer) Object.defineProperty(File.prototype, 'arrayBuffer', originals.fileArrayBuffer)
  else Reflect.deleteProperty(File.prototype, 'arrayBuffer')
  syncBuiltinESMExports()
  save('verification.json', { cases, events, requests, inputs, logs, metrics: fixture.metrics, uiProofSeparate: true, assetHashes: { A: sha(A), B: sha(B), C: sha(C), zip: sha(ZIP) } })
  await fixture.close()
}
