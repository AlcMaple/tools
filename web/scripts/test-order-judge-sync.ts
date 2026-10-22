import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { DocKind, DocWrite, DocReceipt, JudgePath, JudgePaths, JudgeSyncState, JudgeSyncEvent, JudgeEvent } from '../shared/order-judge-api'
import { judgeLineReader } from '../shared/order-judge-lines'
import { JudgeFileSync, localDocHash } from '../../src/main/order-judge/sync-core'

const root = await mkdtemp(join(tmpdir(), 'mt-judge-sync-'))
process.env.DATA_DIR = join(root, 'server')
process.env.AUTH_SECRET = 'fixture-only-order-judge-sync-secret-not-production'
let count = 0
const ok = (message: string): void => { count++; console.log('PASS ' + count + ': ' + message) }
const cleanups: (() => Promise<void>)[] = []
const { default: auth } = await import('../server/auth')
const { db } = await import('../server/db')
const { createOrderJudgeApi } = await import('../server/order-judge')
const { default: backupApi } = await import('../server/backup')
const { judgeData } = await import('../server/order-judge-data')
const { judgeEvents } = await import('../server/order-judge-events')
let modelCalls = 0, hook: (() => Promise<void>) | null = null
const prompts: string[] = []
const app = new Hono()
app.route('/api/auth', auth)
app.route('/api/backup', backupApi)
app.route('/api/order-judge', createOrderJudgeApi(async () => ({
  source: 'server', model: 'fixture-model', execute: action => action(), call: async body => {
    modelCalls++
    const messages = body.messages as { content: string }[]
    prompts.push(messages[0].content)
    const next = hook; hook = null; if (next) await next()
    return { choices: [{ message: { content: JSON.stringify({ verdict: '能', title: '同步夹具', summary: '夹具', reasons: [], gaps: [], questions: [] }) } }] }
  },
})))

async function request(path: string, method = 'GET', body?: unknown, cookie = ownerCookie): Promise<Response> {
  return app.request('http://localhost' + path, { method, headers: { cookie, 'content-type': 'application/json', 'x-real-ip': '127.0.0.1' }, body: body === undefined ? undefined : JSON.stringify(body) })
}
async function json<T>(path: string, method = 'GET', body?: unknown, cookie = ownerCookie): Promise<T> {
  const response = await request('/api/order-judge' + path, method, body, cookie)
  const value = await response.json() as T
  assert.equal(response.status, 200, JSON.stringify(value))
  return value
}
async function register(username: string): Promise<string> {
  const response = await request('/api/auth/register', 'POST', { username, password: 'fixture-pass-2026', confirm: 'fixture-pass-2026' }, '') // gitleaks:allow -- fixture-only test password
  const text = await response.text(); assert.equal(response.status, 200, text)
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  assert(cookie); return cookie
}
let ownerCookie = ''

try {
  ownerCookie = await register('syncowner')
  const otherCookie = await register('syncother')
  const unauthorized = await request('/api/order-judge/sync', 'GET', undefined, '')
  assert.equal(unauthorized.status, 401); ok('未登录同步接口被拒绝')
  const webUpload = await request('/api/order-judge/docs/profile', 'PUT', { name: 'p.md', content: 'WEB_UPLOAD' })
  assert.equal(webUpload.status, 200); ok('网页手动上传直接整份覆盖，不再要求版本基线')

  const { createRequire } = await import('node:module')
  const { JudgeData } = await import('../server/order-judge-data')
  const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3').default
  const legacyDb = new Database(':memory:')
  legacyDb.exec("CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1); CREATE TABLE order_judge_docs(user_id INTEGER,kind TEXT,name TEXT,content TEXT,updated_at INTEGER,PRIMARY KEY(user_id,kind)); CREATE TABLE order_judge_conflicts(id TEXT); CREATE TABLE order_judge_versions(id TEXT);")
  legacyDb.prepare('INSERT INTO order_judge_docs VALUES (?,?,?,?,?)').run(1, 'profile', 'old.md', 'legacy\r\nbody', 1)
  const migrated = new JudgeData(legacyDb)
  assert.equal(migrated.doc(1, 'profile')?.content, 'legacy\nbody')
  assert.equal(migrated.doc(1, 'profile')?.hash, localDocHash('legacy\nbody'))
  const leftovers = legacyDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('order_judge_versions','order_judge_conflicts','order_judge_bases','order_judge_doc_ops')").all()
  assert.deepEqual(leftovers, [])
  legacyDb.close(); ok('旧库 MD 原地保留并补哈希；候选稿、旧版本、合并基线表被清掉')

  const write = async (kind: DocKind, input: DocWrite): Promise<DocReceipt> =>
    (await json<{ receipt: DocReceipt }>(`/docs/${kind}`, 'PUT', input)).receipt
  const snapshot = (): Promise<JudgeSyncState> => json('/sync')
  const setPaths = async (kind: DocKind, paths: JudgePath[]): Promise<JudgePaths> => (await json<{ paths: JudgePaths }>(`/paths/${kind}`, 'PUT', { paths })).paths
  const macDir = join(root, 'mac-source'), winDir = join(root, 'windows-other-path')
  await mkdir(macDir); await mkdir(winDir)
  const profile = join(macDir, 'ability.md'), macLog = join(macDir, 'log.md'), winLog = join(winDir, 'log.md')
  const missing = join(root, 'not-on-this-computer', 'log.md')
  await writeFile(profile, 'PROFILE_ORIGINAL_ONLY\n能做 Web')
  await writeFile(macLog, 'one\n'); await writeFile(winLog, 'one\n')
  const makeSource = (label: string): JudgeFileSync => {
    const core = new JudgeFileSync({ label, transport: { snapshot, write } })
    cleanups.push(async () => { core.stop() })
    return core
  }
  await setPaths('profile', [{ path: join(root, 'missing-profile.md'), device: 'Windows' }, { path: profile, device: 'Mac' }])
  await setPaths('log', [{ path: missing, device: 'Windows' }, { path: macLog, device: 'Mac' }])
  const mac = makeSource('Mac'), win = makeSource('Windows')
  await mac.sync()
  let state = await snapshot()
  assert.equal(state.docs.profile?.content, 'PROFILE_ORIGINAL_ONLY\n能做 Web'); assert.equal(state.docs.profile?.source, 'Mac')
  assert.equal(state.docs.log?.sourcePath, macLog)
  ok('账号里的路径列表按顺序跳过本机不存在的路径，取第一个存在的文件整份覆盖，并记下来自哪条路径')

  const merged = await json<{ paths: JudgePaths }>('/paths/merge', 'POST', { profile: [], log: [{ path: winLog, device: 'Windows' }, { path: macLog, device: 'Mac' }] })
  assert.deepEqual(merged.paths.log.map(p => p.path), [missing, macLog, winLog])
  assert.equal((await json<{ paths: JudgePaths }>('/paths/merge', 'POST', { profile: [], log: [{ path: winLog, device: 'Windows' }] })).paths.log.length, 3)
  ok('另一台电脑开启共用：新路径追加到末尾，已有的保留原顺序，重复合并不再追加')

  await writeFile(macLog, 'one\ntwo\n'); await mac.sync()
  await writeFile(macLog, 'one\n'); await mac.sync()
  assert.equal((await snapshot()).docs.log?.content, 'one\n'); ok('加一行再删掉（撤销）照常覆盖到云端')

  await writeFile(macLog, 'one\nMAC\n'); await mac.sync()
  await rename(macLog, macLog + '.elsewhere')
  await writeFile(winLog, 'one\nWIN\n'); await win.sync()
  await rename(macLog + '.elsewhere', macLog)
  state = await snapshot()
  assert.equal(state.docs.log?.content, 'one\nWIN\n'); assert.equal(state.docs.log?.source, 'Windows'); assert.equal(state.docs.log?.sourcePath, winLog)
  assert.equal(JSON.stringify(state).includes('conflict'), false); ok('两台电脑改同一段：最后同步的那份整份胜出，没有候选、不需要人工选')

  await setPaths('log', [{ path: winLog, device: 'Windows' }, { path: macLog, device: 'Mac' }, { path: missing, device: 'Windows' }])
  await writeFile(macLog, 'MAC_LOWER_PRIORITY\n'); await mac.sync()
  assert.equal((await snapshot()).docs.log?.content, 'one\nWIN\n'); ok('网页上调整顺序后，下次同步立即按新优先级取文件')
  const tooMany = await request('/api/order-judge/paths/log', 'PUT', { paths: Array.from({ length: 13 }, (_, i) => ({ path: '/p' + i, device: 'Mac' })) })
  assert.equal(tooMany.status, 400); ok('路径超过上限被拒绝，不静默截断')

  const seq = (await snapshot()).seq
  await win.sync()
  assert.equal((await snapshot()).seq, seq); ok('内容没变不重复写')

  await setPaths('log', [{ path: missing, device: 'Windows' }])
  await setPaths('profile', [{ path: missing, device: 'Windows' }])
  const quiet = (await snapshot()).seq
  await makeSource('Phone-like').sync()
  assert.equal((await snapshot()).seq, quiet); ok('所有路径都不存在时不上传，直接用服务器上的正文')
  await setPaths('profile', [{ path: profile, device: 'Mac' }])
  await setPaths('log', [{ path: winLog, device: 'Windows' }])

  await setPaths('log', [{ path: macLog, device: 'Mac' }])
  await writeFile(macLog, 'MAC_FILE\n'); await mac.sync()
  const uploaded = await json<{ paths: JudgePaths }>('/docs/log', 'PUT', { name: '手机上传.md', content: 'PHONE_UPLOAD' })
  assert.deepEqual(uploaded.paths.log.map(p => p.device), ['Mac', '网页']); assert(uploaded.paths.log[1].upload)
  assert.equal((await snapshot()).docs.log?.content, 'MAC_FILE\n'); ok('手机上传作为一条「网页」条目追加到末尾；排在电脑路径后面时电脑的文件仍是正文')
  await setPaths('log', [{ path: '手机上传.md', device: '网页' }, { path: macLog, device: 'Mac' }])
  state = await snapshot()
  assert.equal(state.docs.log?.content, 'PHONE_UPLOAD'); assert.equal(state.docs.log?.sourcePath, '手机上传.md')
  await writeFile(macLog, 'MAC_FILE_EDITED\n'); await mac.sync()
  assert.equal((await snapshot()).docs.log?.content, 'PHONE_UPLOAD'); ok('网页条目挪到最前立刻成为正文，电脑同步时不再覆盖')
  await json('/docs/log', 'PUT', { name: '手机上传.md', content: 'PHONE_UPLOAD_V2' })
  assert.equal((await snapshot()).docs.log?.content, 'PHONE_UPLOAD_V2'); assert.equal((await snapshot()).paths.log.length, 2)
  ok('同名文件再上传替换内容，不新增条目')
  await setPaths('log', [{ path: macLog, device: 'Mac' }, { path: '手机上传.md', device: '网页' }])
  await mac.sync()
  assert.equal((await snapshot()).docs.log?.content, 'MAC_FILE_EDITED\n'); ok('电脑路径挪回前面后，下次同步以电脑文件为准')
  const forged = await request('/api/order-judge/paths/log', 'PUT', { paths: [{ path: '伪造.md', device: '网页' }] })
  assert.equal(forged.status, 400); ok('客户端不能凭空塞入网页上传条目')
  await setPaths('log', [{ path: winLog, device: 'Windows' }])

  await writeFile(winLog, 'one\nWIN\nSELECTED\n'); await win.sync()
  const selected = { content: 'one\nWIN\nSELECTED\n' }

  const requestId = randomUUID(), input = { text: 'fixture order', images: [{ name: 'fixture-image', dataUrl: 'data:image/jpeg;base64,/9j/2Q==' }], requestId }
  const judged = await request('/api/order-judge/judge', 'POST', input)
  const events = (await judged.text()).trim().split('\n').map(line => JSON.parse(line) as JudgeEvent)
  const done = events.find((event): event is Extract<JudgeEvent, { type: 'done' }> => event.type === 'done')!
  assert(done); assert(prompts[0].includes('SELECTED')); assert(!prompts[0].includes('MAC'))
  assert.equal((prompts[0].match(/# 最新项目日志/g) ?? []).length, 1)
  assert.equal(done.entry.snapshot?.log?.hash, localDocHash(selected.content)); assert.equal(modelCalls, 1)
  ok('只发送一份档案、一份日志，历史记录精确版本哈希')
  const replay = await request('/api/order-judge/judge', 'POST', input)
  assert((await replay.text()).includes(done.entry.id)); assert.equal(modelCalls, 1); ok('评估幂等重放返回同一记录，不重复调用模型')
  const changedRequest = await request('/api/order-judge/judge', 'POST', { ...input, text: 'changed' })
  assert.equal(changedRequest.status, 409); ok('同一请求 ID 换材料被拒绝')
  const image = await request(`/api/order-judge/history/${done.entry.id}/01.jpg`)
  assert.equal(image.status, 200); assert.deepEqual(new Uint8Array(await image.arrayBuffer()), new Uint8Array(Buffer.from('/9j/2Q==', 'base64')))
  assert.equal((await request(`/api/order-judge/history/${done.entry.id}/01.jpg`, 'GET', undefined, otherCookie)).status, 404)
  assert.equal((await json<JudgeSyncState>('/sync', 'GET', undefined, otherCookie)).docs.profile, null)
  ok('历史图片真实落盘回读，其他账号隔离')

  const macDevice = randomUUID()
  const attached = new AbortController()
  const streamResponse = await app.request(`http://localhost/api/order-judge/sync/events?deviceId=${macDevice}`, { headers: { cookie: ownerCookie }, signal: attached.signal })
  const reader = streamResponse.body!.getReader(), decoder = new TextDecoder(), received: JudgeSyncEvent[] = []
  const parse = judgeLineReader(raw => {
    const event = raw as JudgeSyncEvent; received.push(event)
    if (event.type === 'check') void mac.sync().then(() => json(`/sync/check/${event.id}`, 'POST', { deviceId: macDevice })).catch(error => console.error(error))
  })
  const reading = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; parse(decoder.decode(value, { stream: true })) } })()
  const detach = async (): Promise<void> => { attached.abort(); await reader.cancel(); await reading; reader.releaseLock() }
  cleanups.push(detach)
  await new Promise(resolve => setTimeout(resolve, 30))
  await writeFile(profile, 'PROFILE_UPDATED_BEFORE_JUDGE')
  const barrier = await request('/api/order-judge/judge', 'POST', { text: 'barrier', images: [], requestId: randomUUID() })
  assert((await barrier.text()).includes('"type":"done"')); assert(prompts.at(-1)!.includes('PROFILE_UPDATED_BEFORE_JUDGE'))
  assert(received.some(e => e.type === 'check')); ok('手机评估前通知在线来源重读文件，等待发布后再冻结资料')
  await detach(); cleanups.pop()

  hook = async () => {
    const before = (await snapshot()).docs.profile!
    assert(before); await write('profile', { name: 'ability.md', content: 'PROFILE_CHANGED_DURING_AI' })
  }
  const frozen = await request('/api/order-judge/judge', 'POST', { text: 'frozen', images: [], requestId: randomUUID() })
  assert((await frozen.text()).includes('"type":"done"'))
  assert(prompts.at(-1)!.includes('PROFILE_UPDATED_BEFORE_JUDGE')); assert(!prompts.at(-1)!.includes('PROFILE_CHANGED_DURING_AI'))
  ok('评估中资料更新留到下次，本次快照不会混入后来的正文')

  await json(`/history/${done.entry.id}`, 'DELETE')
  const afterDelete = await request('/api/order-judge/judge', 'POST', input)
  assert.equal(afterDelete.status, 409); assert.equal(modelCalls, 3)
  assert.equal((await request(`/api/order-judge/history/${done.entry.id}/01.jpg`)).status, 404)
  ok('删除历史与图片一致；重放旧请求不复活记录、不再次计费')

  const legacy = { sourceId: randomUUID(), at: Date.now() - 5000, report: { verdict: '能', title: 'legacy', summary: 'legacy', reasons: [], gaps: [], questions: [] }, text: 'legacy order', images: input.images }
  const imported = await json<{ imported: boolean; id: string }>('/history/import', 'POST', legacy)
  assert(imported.imported)
  assert.equal((await json<{ imported: boolean }>('/history/import', 'POST', legacy)).imported, false)
  assert.equal(modelCalls, 3); ok('本机历史导入幂等，带图真实迁移，不额外调用 AI')
  await json(`/history/${imported.id}`, 'DELETE')
  assert.equal((await json<{ imported: boolean }>('/history/import', 'POST', legacy)).imported, false)
  assert.equal((await request(`/api/order-judge/history/${imported.id}/01.jpg`)).status, 404)
  ok('已删除的迁移记录留下映射，再导入不会复活')
  const backupHistory = await json<{ id: string }>('/history/import', 'POST', { ...legacy, sourceId: randomUUID() })
  const { collectJudgeBackup, prepareJudgeRestore } = await import('../server/order-judge-backup')
  const uid = (await snapshot()).accountId, archived = collectJudgeBackup(uid)
  const zipped = await request('/api/backup/export?format=zip')
  assert.equal(zipped.status, 200)
  const zipBytes = new Uint8Array(await zipped.arrayBuffer())
  assert(Object.keys(archived.files).length === 1)
  const existingRestore = prepareJudgeRestore(uid, archived.data, archived.files)
  db.transaction(() => existingRestore.apply())(); assert.equal(existingRestore.status(), 'existing-skipped')
  ok('备份包含两份正文、历史、幂等映射与图片；恢复不覆盖现有资料')
  const clear = async (): Promise<void> => {
    db.transaction(() => { for (const table of Object.keys(archived.data.tables)) db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(uid) })()
    await rm(join(process.env.DATA_DIR!, 'order-judge', String(uid)), { recursive: true, force: true })
  }
  await clear()
  const failedRestore = prepareJudgeRestore(uid, archived.data, archived.files)
  assert.throws(() => db.transaction(() => { failedRestore.apply(); throw new Error('fixture transaction failure') })(), /fixture transaction failure/)
  failedRestore.rollback()
  assert.equal((await request(`/api/order-judge/history/${backupHistory.id}/01.jpg`)).status, 404)
  assert.equal(db.prepare('SELECT 1 FROM order_judge_history WHERE user_id=?').get(uid), undefined)
  ok('恢复事务失败时新图片同步回滚，没有半份历史')
  const form = new FormData(); form.set('file', new File([zipBytes], 'judge-backup.zip', { type: 'application/zip' }))
  const restoredResponse = await app.request('http://localhost/api/backup/import', { method: 'POST', headers: { cookie: ownerCookie }, body: form })
  assert.equal(restoredResponse.status, 200, await restoredResponse.clone().text())
  assert.equal((await restoredResponse.json() as { orderJudge: string }).orderJudge, 'restored')
  assert.deepEqual(collectJudgeBackup(uid).data.tables, archived.data.tables)
  assert.equal((await request(`/api/order-judge/history/${backupHistory.id}/01.jpg`)).status, 200)
  ok('真实 ZIP 导出与 HTTP 导回：资料、历史逐字段一致，图片可再次读取')
  const corrupt = structuredClone(archived.data)
  corrupt.tables.order_judge_docs[0].content = 'tampered'
  assert.throws(() => prepareJudgeRestore(uid, corrupt, archived.files), /哈希/)
  ok('被篡改的正文备份在写入前被拒绝')

  await writeFile(profile, 'PROFILE_UNSENT_DURING_OUTAGE')
  const failing = new JudgeFileSync({ label: 'offline',
    transport: { snapshot, write: async () => { throw new Error('HTTP_503 fixture') } } })
  await assert.rejects(failing.sync(), /503/); failing.stop(); ok('源上传失败向调用者抛出，核心不自动重试')
  let writesAfterStop = 0
  const stopped = new JudgeFileSync({ label: 'stopped', transport: { snapshot, write: async () => { writesAfterStop++; throw new Error('unexpected') } } })
  stopped.stop(); await assert.rejects(stopped.sync(), /SYNC_CANCELLED/); assert.equal(writesAfterStop, 0); ok('取消 owner 后旧任务不再发布')

  const user = (await snapshot()).accountId
  let rejected: unknown
  const removePeer = judgeEvents.subscribe(user, 'fixture-device-timeout', () => {}, () => {})
  try { await judgeEvents.check(user, 20) } catch (error) { rejected = error }
  assert(rejected instanceof Error && rejected.message.includes('超时')); removePeer(); ok('在线来源不确认时屏障有界超时，不悄悄评估旧稿')

  console.log(`RESULT: ${count}/${count} passed; AI calls=${modelCalls} (mocked boundary only); real SQLite, routes, files and source core`)
} finally {
  for (const close of cleanups.reverse()) await close()
  db.close(); await rm(root, { recursive: true, force: true })
  console.log('Cleanup: source cores, streams, SQLite and temporary files closed; no live service retained')
}
