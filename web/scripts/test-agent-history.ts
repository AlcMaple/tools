import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'
import type { HistorySession, HistoryMessage, HistorySnapshot, HistoryAction, AssistantMessageContent } from '../shared/agent-history'

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

if (process.argv[2] === '--probe') {
  const [dir, uid, sessionId] = process.argv.slice(3)
  assert.equal(readFileSync(join(dir, 'fixture-marker'), 'utf8'), 'agent-history-test-v1')
  const { default: Database } = await import('better-sqlite3')
  const { AgentHistoryStore } = await import('../server/agent/history-store')
  const reopened = new Database(join(dir, 'data/web.db'), { readonly: true, fileMustExist: true })
  const snapshot = new AgentHistoryStore(reopened).snapshot(Number(uid), sessionId, { limit: 50 })
  reopened.close()
  console.log(JSON.stringify({ snapshotHash: fingerprint(snapshot) }))
  process.exit(0)
}

const originalCwd = process.cwd(), originalEnv = { ...process.env }, originalFetch = globalThis.fetch
const fixture = mkdtempSync(join(tmpdir(), 'maple-agent-history-'))
mkdirSync(join(fixture, 'data'))
writeFileSync(join(fixture, 'fixture-marker'), 'agent-history-test-v1')
// 先换到新建的空目录再导入服务端，secrets.ts 只会看到夹具配置，不读取工作区 .env。
process.chdir(fixture)
for (const key of Object.keys(process.env)) {
  if (/^(SENTRY_|VITE_SENTRY_|SMTP_|AI_|GOOGLE_|MAPLETOOLS_ENV_FILE$|VERCEL$)/.test(key) || /^(?:https?_proxy|all_proxy|no_proxy)$/i.test(key)) delete process.env[key]
}
process.env.NODE_ENV = 'production'
process.env.AUTH_SECRET = randomBytes(48).toString('hex')
process.env.DATA_DIR = join(fixture, 'data')
process.env.EMAIL_MODE = 'disabled'
let externalRequests = 0
globalThis.fetch = async () => { externalRequests++; throw new Error('EXTERNAL_NETWORK_DISABLED_FOR_HISTORY_TEST') }

let cleanup: (() => Promise<void>) | undefined
let cleanupNetwork: (() => Promise<void>) | undefined
let checks = 0, requests = 0
try {
  const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = await import('undici')
  const previousDispatcher = getGlobalDispatcher(), network = new MockAgent()
  network.disableNetConnect()
  let allowedHost = ''
  const dispatch = network.dispatch.bind(network)
  network.dispatch = (options, handler) => {
    if (!allowedHost || new URL(String(options.origin)).host !== allowedHost) externalRequests++
    return dispatch(options, handler)
  }
  setGlobalDispatcher(network)
  cleanupNetwork = async () => { await network.close(); setGlobalDispatcher(previousDispatcher) }
  const { default: Database } = await import('better-sqlite3')
  const { Hono } = await import('hono')
  const { serve } = await import('@hono/node-server')
  const { db } = await import('../server/db')
  const { issueSession, clearRateLimit } = await import('../server/auth')
  const { AgentHistoryStore, initializeAgentHistorySchema } = await import('../server/agent/history-store')
  const { AgentHistoryError, HISTORY_LIMITS } = await import('../shared/agent-history')
  const { agentHistoryStore: store } = await import('../server/agent/history-api')
  const { default: app } = await import('../server/index')
  const server = serve({ fetch: app.fetch, hostname: 'localhost', port: 0 })
  await once(server, 'listening')
  cleanup = async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()))
    ;(server as Server).closeAllConnections()
    await closed
    await cleanupNetwork?.(); cleanupNetwork = undefined
    db.close()
  }
  const address = server.address()
  assert(address && typeof address !== 'string')
  const origin = `http://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}`
  allowedHost = new URL(origin).host
  network.enableNetConnect(allowedHost)
  const insert = db.prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)')
  const user = (name: string) => Number(insert.run(name, randomBytes(32).toString('hex'), new Date().toISOString()).lastInsertRowid)
  const alice = user('history_a'), bob = user('history_b'), carol = user('history_c')
  async function cookieFor(uid: number, username: string) {
    const issuer = new Hono().get('/', async c => { await issueSession(c, { uid, username, tv: 0 }); return c.text('fixture') })
    const response = await issuer.request(origin + '/')
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    assert(cookie)
    return cookie
  }
  const cookieA = await cookieFor(alice, 'history_a'), cookieA2 = await cookieFor(alice, 'history_a'), cookieB = await cookieFor(bob, 'history_b')
  type Options = { method?: string; payload?: unknown; rawBody?: string; cookie?: string; headers?: Record<string, string> }
  async function request<T = Record<string, unknown>>(path: string, options: Options = {}) {
    requests++
    const response = await originalFetch(origin + '/api/agent' + path, {
      method: options.method ?? 'GET', signal: AbortSignal.timeout(10_000),
      headers: { Origin: origin, Cookie: options.cookie ?? cookieA, 'Content-Type': 'application/json', ...options.headers },
      body: options.rawBody ?? (options.payload === undefined ? undefined : JSON.stringify(options.payload)),
    })
    const text = await response.text()
    let body: unknown
    try { body = JSON.parse(text) } catch { body = { text } }
    assert.equal(response.headers.get('cache-control'), 'no-store')
    return { response, body: body as T }
  }
  async function check(name: string, run: () => void | Promise<void>) {
    for (const uid of [alice, bob, carol]) for (const op of ['read', 'write', 'export']) clearRateLimit(`agent-history:${op}:${uid}`)
    await run(); checks++; console.log(`PASS H${String(checks).padStart(2, '0')} ${name}`)
  }
  function expectError(run: () => unknown, code: string) {
    assert.throws(run, (e: unknown) => e instanceof AgentHistoryError && e.code === code)
  }
  const fresh = (title = '会话夹具') => ({ requestId: randomUUID(), title })
  const content = (body: string, status: AssistantMessageContent['status'] = 'completed'): AssistantMessageContent =>
    ({ body, status, sources: [], toolSummaries: [], actions: [], usage: [] })
  const initial = { ...fresh('第一本私人手帐'), currentBgmId: 101 }
  let s!: HistorySession, firstUser!: HistoryMessage

  await check('旧数据库新增表、重复初始化无损，追番版本不变', () => {
    initializeAgentHistorySchema(db); initializeAgentHistorySchema(db)
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'agent_%'").get() as { n: number }).n, 3)
    assert.equal((db.prepare('SELECT tracks_rev AS rev FROM users WHERE id = ?').get(alice) as { rev: number }).rev, 0)
  })
  await check('所有历史入口都需要真实会话 Cookie', async () => {
    const id = randomUUID()
    for (const [path, method] of [['/sessions', 'GET'], ['/sessions', 'POST'], [`/sessions/${id}`, 'GET'], [`/sessions/${id}`, 'PATCH'], [`/sessions/${id}`, 'DELETE'], [`/sessions/${id}/messages`, 'POST'], [`/sessions/${id}/clear`, 'POST'], [`/sessions/${id}/export`, 'GET']]) {
      const r = await request(path, { method, cookie: '', ...(method === 'GET' ? {} : { payload: {} }) })
      assert.equal(r.response.status, 401); assert.equal(r.body.code, 'AUTH_REQUIRED')
    }
  })
  await check('创建会话，默认模型/档位与公开字段投影正确', async () => {
    const r = await request<{ session: HistorySession }>('/sessions', { method: 'POST', payload: initial })
    assert.equal(r.response.status, 201); s = r.body.session
    assert.equal(s.messageCount, 0); assert.equal(s.revision, 0); assert.equal(s.currentBgmId, 101)
    assert.equal(s.provider, 'server'); assert.equal(s.model, 'deepseek-v4-flash-vision-exp'); assert.equal(s.contextTier, '128k')
    assert.equal('ownerUid' in s || 'create_hash' in s || 'create_request_id' in s, false)
  })
  await check('创建重试不重复，修改同一请求的内容返回冲突', async () => {
    const retry = await request<{ session: HistorySession }>('/sessions', { method: 'POST', payload: initial })
    assert.equal(retry.body.session.id, s.id)
    const conflict = await request('/sessions', { method: 'POST', payload: { ...initial, title: '另一份内容' } })
    assert.equal(conflict.response.status, 409); assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT')
  })
  await check('其他账号的读取、修改、消息、清空、删除和导出均为 404', async () => {
    for (const [suffix, method] of [['', 'GET'], ['', 'PATCH'], ['', 'DELETE'], ['/messages', 'POST'], ['/clear', 'POST'], ['/export', 'GET']]) {
      const payload = suffix === '/messages' ? { requestId: randomUUID(), expectedRevision: 0, body: '别人的消息' } : method === 'PATCH' ? { expectedRevision: 0, title: '别人的标题' } : { expectedRevision: 0 }
      const r = await request(`/sessions/${s.id}${suffix}`, { method, cookie: cookieB, ...(method === 'GET' ? {} : { payload }) })
      assert.equal(r.response.status, 404); assert.equal(r.body.code, 'NOT_FOUND')
    }
    assert.deepEqual((await request<{ sessions: HistorySession[] }>('/sessions', { cookie: cookieB })).body.sessions, [])
  })
  await check('身份、模型来源、凭据及任意新增字段不接受客户端注入', async () => {
    const sample = randomUUID()
    for (const fields of [{ ownerUid: bob }, { provider: 'fake' }, { apiKey: sample }, { systemPrompt: '替换规则' }, { currentBgmId: 0 }]) {
      const r = await request('/sessions', { method: 'POST', payload: { ...fresh(), ...fields } })
      assert.equal(r.response.status, 400)
    }
    assert.equal((await request('/sessions?userId=2')).response.status, 400)
  })
  await check('用户消息保留原文，HTML 作为 JSON 字符串返回', async () => {
    const body = '  想找点轻松的番\n<img src=x onerror="alert(1)">  '
    const r = await request<{ session: HistorySession; message: HistoryMessage }>(`/sessions/${s.id}/messages`, { method: 'POST', payload: { requestId: 'message-first', expectedRevision: s.revision, body } })
    assert.equal(r.response.status, 201); s = r.body.session; firstUser = r.body.message
    assert.equal(firstUser.body, body); assert.equal(firstUser.role, 'user'); assert.equal(firstUser.seq, 1)
    assert.equal(s.messageCount, 1); assert.equal(s.revision, 1)
  })
  await check('消息幂等与旧 revision：重复返回原记录，冲突不追加', async () => {
    const duplicate = await request<{ session: HistorySession; message: HistoryMessage }>(`/sessions/${s.id}/messages`, { method: 'POST', payload: { requestId: 'message-first', expectedRevision: 0, body: firstUser.body } })
    assert.equal(duplicate.body.message.id, firstUser.id); assert.equal(duplicate.body.session.revision, 1)
    for (const payload of [{ requestId: 'message-first', expectedRevision: 1, body: '改变同一个请求' }, { requestId: randomUUID(), expectedRevision: 0, body: '过期请求' }]) {
      assert.equal((await request(`/sessions/${s.id}/messages`, { method: 'POST', payload })).response.status, 409)
    }
    assert.equal(store.snapshot(alice, s.id).session.messageCount, 1)
  })
  await check('浏览器不写助手角色、来源、动作回执或原始工具 JSON', async () => {
    for (const fields of [{ role: 'assistant' }, { sources: [] }, { actions: [] }, { rawToolOutput: {} }, { usage: [] }]) {
      const r = await request(`/sessions/${s.id}/messages`, { method: 'POST', payload: { requestId: randomUUID(), expectedRevision: s.revision, body: '普通内容', ...fields } })
      assert.equal(r.response.status, 400)
    }
    assert.equal((await request(`/sessions/${s.id}/assistant`, { method: 'POST', payload: {} })).response.status, 404)
  })
  await check('第二个会话客户端恢复同一历史，且看不到其他账号记录', async () => {
    const r = await request<HistorySnapshot>(`/sessions/${s.id}`, { cookie: cookieA2 })
    assert.equal(r.body.messages[0].id, firstUser.id); assert.equal(r.body.messages[0].body, firstUser.body)
    assert.equal(r.body.session.revision, s.revision)
  })
  await check('两端同时基于相同 revision 写入，仅一个成功', async () => {
    const results = await Promise.all([cookieA, cookieA2].map(cookie => request(`/sessions/${s.id}/messages`, { method: 'POST', cookie, payload: { requestId: randomUUID(), expectedRevision: s.revision, body: '并发测试' } })))
    assert.deepEqual(results.map(r => r.response.status).sort(), [201, 409])
    s = store.snapshot(alice, s.id).session; assert.equal(s.messageCount, 2)
  })
  await check('独立数据库连接读取权威版本，过期写入没有覆盖', () => {
    const secondDb = new Database(join(fixture, 'data/web.db')); secondDb.pragma('foreign_keys = ON')
    try {
      const second = new AgentHistoryStore(secondDb)
      assert.equal(second.snapshot(alice, s.id).session.revision, s.revision)
      expectError(() => second.appendUser(alice, s.id, { requestId: randomUUID(), expectedRevision: s.revision - 1, body: '旧版本' }), 'REVISION_CONFLICT')
    } finally { secondDb.close() }
  })
  await check('重命名与当前番剧更新保留消息，空补丁和空标题被挡住', async () => {
    const r = await request<{ session: HistorySession }>(`/sessions/${s.id}`, { method: 'PATCH', payload: { expectedRevision: s.revision, title: '改名后的私人手帐', currentBgmId: -7 } })
    assert.equal(r.response.status, 200); s = r.body.session
    assert.equal(s.title, '改名后的私人手帐'); assert.equal(s.currentBgmId, -7); assert.equal(s.messageCount, 2)
    for (const extra of [{}, { title: '  ' }]) assert.equal((await request(`/sessions/${s.id}`, { method: 'PATCH', payload: { expectedRevision: s.revision, ...extra } })).response.status, 400)
  })
  await check('助手正文、来源、工具摘要与用量原样持久化，额外内部字段不进入历史', async () => {
    const data: AssistantMessageContent = {
      ...content('资料整理好了。'),
      sources: [{ sourceId: 'offline-101', kind: 'offline_index', label: '离线测试条目', bgmId: 101, retrievedAt: Date.now() }],
      toolSummaries: [{ tool: 'searchOfflineAnime', status: 'ok', summary: '找到 1 条本地资料' }],
      usage: [{ operation: 'model', provider: 'server', model: 'fixture-model', inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, durationMs: 5, resultCount: 1, estimatedCost: null, currency: null, priceVersion: null }],
    }
    const saved = store.appendAssistant(alice, s.id, { requestId: 'assistant-1', expectedRevision: s.revision, ...data }); s = saved.session
    const r = await request<HistorySnapshot>(`/sessions/${s.id}`, { cookie: cookieA2 })
    assert.deepEqual(r.body.messages.at(-1)?.sources, data.sources)
    assert.deepEqual(r.body.messages.at(-1)?.usage, data.usage)
    assert.deepEqual(r.body.messages.at(-1)?.sourceIds, ['offline-101'])
    expectError(() => store.appendAssistant(alice, s.id, { requestId: 'bad-assistant', expectedRevision: s.revision, ...data, reasoning: '隐藏推理夹具' }), 'INVALID_ARGUMENT')
    expectError(() => store.appendAssistant(alice, s.id, { requestId: 'bad-source', expectedRevision: s.revision, ...data, sources: [...data.sources, ...data.sources] }), 'INVALID_ARGUMENT')
  })
  await check('部分回复保留；进行中阻止清空/删除/归档；失败收口后晚到更新被挡住', async () => {
    const partial = store.appendAssistant(alice, s.id, { requestId: 'partial', expectedRevision: s.revision, ...content('已经生成的半句话', 'streaming') }); s = partial.session
    for (const [suffix, method, extra] of [['/clear', 'POST', {}], ['', 'DELETE', {}], ['', 'PATCH', { archived: true }]] as const) {
      const r = await request(`/sessions/${s.id}${suffix}`, { method, payload: { expectedRevision: s.revision, ...extra } })
      assert.equal(r.response.status, 409); assert.equal(r.body.code, 'SESSION_BUSY')
    }
    expectError(() => store.appendUser(alice, s.id, { requestId: randomUUID(), expectedRevision: s.revision, body: '先别覆盖' }), 'SESSION_BUSY')
    const failed = store.updateAssistant(alice, s.id, partial.message.id, { expectedRevision: s.revision, ...content(partial.message.body, 'failed') }); s = failed.session
    assert.equal(failed.message.body, partial.message.body)
    expectError(() => store.updateAssistant(alice, s.id, partial.message.id, { expectedRevision: s.revision, ...content('晚到的覆盖') }), 'MESSAGE_FINALIZED')
  })
  await check('已完成回复中的待确认动作可单独更新摘要，正文不变且旧事件不回退', async () => {
    const action: HistoryAction = { actionId: 'action-1', kind: 'playback_open', state: 'prepared', eventSeq: 1, updatedAt: Date.now(), evidence: 'preview', errorCode: null, userReportedSuccess: false, summary: '测试预览，没有打开源站' }
    const saved = store.appendAssistant(alice, s.id, { requestId: 'action-message', expectedRevision: s.revision, ...content('点确认后才打开。'), actions: [action] }); s = saved.session
    assert.equal((await request(`/sessions/${s.id}/clear`, { method: 'POST', payload: { expectedRevision: s.revision } })).body.code, 'SESSION_BUSY')
    const cancelled: HistoryAction = { ...action, state: 'cancelled', eventSeq: 2, evidence: 'user_click' }
    const updated = store.updateActionSummary(alice, s.id, saved.message.id, { expectedRevision: s.revision, action: cancelled }); s = updated.session
    assert.equal(updated.message.body, saved.message.body)
    assert.equal(updated.message.actions[0].state, 'cancelled')
    assert.equal(store.updateActionSummary(alice, s.id, saved.message.id, { expectedRevision: 0, action: cancelled }).session.revision, s.revision)
    expectError(() => store.updateActionSummary(alice, s.id, saved.message.id, { expectedRevision: s.revision, action }), 'ACTION_RECEIPT_CONFLICT')
  })
  await check('归档/恢复会话，归档后保留读取和导出但暂停追加', async () => {
    let r = await request<{ session: HistorySession }>(`/sessions/${s.id}`, { method: 'PATCH', payload: { expectedRevision: s.revision, archived: true } }); s = r.body.session
    assert(s.archivedAt !== null)
    assert.equal((await request<{ sessions: HistorySession[] }>('/sessions')).body.sessions.some(x => x.id === s.id), false)
    assert.equal((await request<{ sessions: HistorySession[] }>('/sessions?archived=archived')).body.sessions[0].id, s.id)
    assert.equal((await request(`/sessions/${s.id}/messages`, { method: 'POST', payload: { requestId: randomUUID(), expectedRevision: s.revision, body: '归档后追加' } })).body.code, 'SESSION_ARCHIVED')
    assert.equal((await request(`/sessions/${s.id}/export`)).response.status, 200)
    r = await request<{ session: HistorySession }>(`/sessions/${s.id}`, { method: 'PATCH', payload: { expectedRevision: s.revision, archived: false } }); s = r.body.session
    assert.equal(s.archivedAt, null)
  })
  await check('历史前后翻页按 seq 稳定排序，不重复或丢掉边界消息', async () => {
    const all = store.exportSession(alice, s.id).messages
    const latest = (await request<HistorySnapshot>(`/sessions/${s.id}?limit=2`)).body
    assert.deepEqual(latest.messages.map(m => m.id), all.slice(-2).map(m => m.id))
    assert(latest.nextBeforeSeq !== null)
    const older = (await request<HistorySnapshot>(`/sessions/${s.id}?limit=2&beforeSeq=${latest.nextBeforeSeq}`)).body
    assert.deepEqual(older.messages.map(m => m.id), all.slice(-4, -2).map(m => m.id))
    const after = (await request<HistorySnapshot>(`/sessions/${s.id}?limit=2&afterSeq=${all[0].seq}`)).body
    assert.deepEqual(after.messages.map(m => m.id), all.slice(1, 3).map(m => m.id))
  })
  await check('同毫秒会话使用时间/ID 双游标，列表不漏项', () => {
    const now = Date.now
    try {
      const fixed = now(); Date.now = () => fixed
      const ids = Array.from({ length: 3 }, () => store.createSession(carol, fresh()).id).sort().reverse()
      let page = store.listSessions(carol, { limit: 1 })
      assert.equal(page.sessions[0].id, ids[0])
      for (let i = 1; i < 3; i++) { assert(page.nextCursor); page = store.listSessions(carol, { limit: 1, ...page.nextCursor }); assert.equal(page.sessions[0].id, ids[i]) }
      assert.equal(page.nextCursor, null)
    } finally { Date.now = now }
  })
  await check('查询、JSON 与请求大小校验，跨站写入保持 403', async () => {
    for (const q of ['limit=0', 'limit=51', 'limit=-1', 'limit=1&limit=2', 'beforeUpdatedAt=1', '__proto__=x']) assert.equal((await request('/sessions?' + q)).response.status, 400)
    assert.equal((await request(`/sessions/${s.id}?beforeSeq=2&afterSeq=0`)).response.status, 400)
    assert.equal((await request('/sessions', { method: 'POST', rawBody: '{' })).response.status, 400)
    assert.equal((await request('/sessions', { method: 'POST', payload: fresh(), headers: { 'Content-Type': 'text/plain' } })).response.status, 400)
    assert.equal((await request(`/sessions/${s.id}/messages`, { method: 'POST', payload: { requestId: randomUUID(), expectedRevision: s.revision, body: 'x'.repeat(HISTORY_LIMITS.bodyChars + 1) } })).response.status, 400)
    assert.equal((await request('/sessions', { method: 'POST', rawBody: 'x'.repeat(HISTORY_LIMITS.requestBytes + 1) })).response.status, 413)
    assert.equal((await request('/sessions', { method: 'POST', payload: fresh(), headers: { Origin: 'https://example.invalid' } })).response.status, 403)
  })
  await check('完整 JSON 导出不是第一页，不包含配置、内部身份或原始工具响应', async () => {
    let large = store.createSession(alice, fresh('导出夹具'))
    for (let i = 0; i < 65; i++) large = store.appendUser(alice, large.id, { requestId: randomUUID(), expectedRevision: large.revision, body: '导出消息 ' + i }).session
    const r = await request<ReturnType<typeof store.exportSession>>(`/sessions/${large.id}/export`)
    assert.equal(r.response.status, 200); assert.equal(r.body.messages.length, 65)
    assert.equal(r.body.format, 'mapletools-agent-history'); assert.match(r.response.headers.get('content-disposition') ?? '', /^attachment;/)
    assert.equal(/"(?:ownerUid|user_id|create_hash|initial_hash|apiKey|confirmationToken|reasoning|rawToolOutput)"/.test(JSON.stringify(r.body)), false)
    assert.equal((await request(`/sessions/${large.id}/export`)).response.status, 200)
    const limited = await request(`/sessions/${large.id}/export`); assert.equal(limited.response.status, 429); assert.equal(limited.response.headers.get('retry-after'), '60')
  })
  await check('独立新进程从磁盘回读相同消息、来源、动作与元数据', () => {
    const expected = fingerprint(store.snapshot(alice, s.id, { limit: 50 }))
    const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url), '--probe', fixture, String(alice), s.id], { cwd: originalCwd, env: process.env, encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    assert.equal((JSON.parse(child.stdout) as { snapshotHash: string }).snapshotHash, expected)
  })
  await check('会话数、消息数、会话空间和账号总空间均有上限，失败不丢旧内容', () => {
    const owner = user('history_quota')
    const limited = new AgentHistoryStore(db, { sessionsPerUser: 1, messagesPerSession: 1, bytesPerSession: 1000, bytesPerUser: 1000 })
    let book = limited.createSession(owner, fresh())
    expectError(() => limited.createSession(owner, fresh()), 'HISTORY_LIMIT')
    book = limited.appendUser(owner, book.id, { requestId: randomUUID(), expectedRevision: book.revision, body: '保留这条' }).session
    expectError(() => limited.appendUser(owner, book.id, { requestId: randomUUID(), expectedRevision: book.revision, body: '超过数量' }), 'HISTORY_LIMIT')
    for (const caps of [{ bytesPerSession: 120, bytesPerUser: 1000 }, { bytesPerSession: 1000, bytesPerUser: 120 }]) {
      const small = new AgentHistoryStore(db, { sessionsPerUser: 10, messagesPerSession: 10, ...caps })
      expectError(() => small.appendUser(owner, book.id, { requestId: randomUUID(), expectedRevision: book.revision, body: '长'.repeat(200) }), 'HISTORY_LIMIT')
    }
    assert.equal(limited.snapshot(owner, book.id).messages[0].body, '保留这条')
  })
  await check('清空保留会话、递增版本和消息序列；晚到旧请求不恢复已清空内容', async () => {
    const last = store.exportSession(alice, s.id).messages.at(-1)!.seq, oldRevision = s.revision
    const r = await request<{ session: HistorySession }>(`/sessions/${s.id}/clear`, { method: 'POST', payload: { expectedRevision: s.revision } }); s = r.body.session
    assert.equal(s.messageCount, 0); assert.equal(s.activeSummaryVersion, null); assert.equal(s.title, '改名后的私人手帐')
    assert.equal(s.revision, oldRevision + 1); assert.deepEqual(store.snapshot(alice, s.id).messages, [])
    assert.equal((await request(`/sessions/${s.id}/messages`, { method: 'POST', payload: { requestId: 'message-first', expectedRevision: 0, body: firstUser.body } })).response.status, 409)
    const added = store.appendUser(alice, s.id, { requestId: randomUUID(), expectedRevision: s.revision, body: '清空后的新消息' }); s = added.session
    assert(added.message.seq > last)
  })
  await check('删除级联移除内容，短期创建重试不让已删会话重新出现', async () => {
    assert.equal((await request(`/sessions/${s.id}`, { method: 'DELETE', payload: { expectedRevision: s.revision - 1 } })).response.status, 409)
    assert.equal((await request(`/sessions/${s.id}`, { method: 'DELETE', payload: { expectedRevision: s.revision } })).response.status, 200)
    assert.equal((await request(`/sessions/${s.id}`)).response.status, 404)
    assert.equal((await request(`/sessions/${s.id}/export`)).response.status, 404)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE session_id = ?').get(s.id) as { n: number }).n, 0)
    assert.equal((await request('/sessions', { method: 'POST', payload: initial })).body.code, 'REQUEST_RETIRED')
  })
  await check('登录版本撤销后旧 Cookie 失效，修改被挡在历史层之外', async () => {
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(alice)
    assert.equal((await request('/sessions')).response.status, 401)
    db.prepare('UPDATE users SET token_version = 0 WHERE id = ?').run(alice)
  })
  await check('写入限流 30 次/分钟，超限请求不会创建会话', async () => {
    const p = fresh('限流复用请求')
    for (let i = 0; i < 30; i++) assert.equal((await request('/sessions', { method: 'POST', payload: p })).response.status, 201)
    const r = await request('/sessions', { method: 'POST', payload: fresh() })
    assert.equal(r.response.status, 429); assert.equal(r.response.headers.get('retry-after'), '60')
  })
  await check('读取限流 120 次/分钟，与写入和导出预算独立', async () => {
    for (let i = 0; i < 120; i++) assert.equal((await request('/sessions')).response.status, 200)
    const r = await request('/sessions')
    assert.equal(r.response.status, 429); assert.equal(r.response.headers.get('retry-after'), '60')
    assert.equal((await request('/sessions', { method: 'POST', payload: fresh('独立写入预算') })).response.status, 201)
  })
  await check('公开大厅不包含会话，追番版本未变化；账号删除清理所属历史', async () => {
    const publicResponse = await originalFetch(origin + '/api/community')
    assert.equal(publicResponse.status, 200)
    assert.equal((await publicResponse.text()).includes('导出夹具'), false)
    assert.equal((db.prepare('SELECT tracks_rev AS rev FROM users WHERE id = ?').get(alice) as { rev: number }).rev, 0)
    const book = store.createSession(bob, fresh())
    store.appendUser(bob, book.id, { requestId: randomUUID(), expectedRevision: book.revision, body: '账号删除夹具' })
    db.prepare('DELETE FROM users WHERE id = ?').run(bob)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE user_id = ?').get(bob) as { n: number }).n, 0)
    assert.equal((await request('/sessions', { cookie: cookieB })).response.status, 401)
    assert.equal(externalRequests, 0)
  })
  console.log(JSON.stringify({ checks, failed: 0, httpRequests: requests, transport: 'loopback-http', persistence: 'file-sqlite-and-new-process-readback', externalRequests, realAiCalls: 0, productionDataTouched: false }))
} finally {
  await cleanup?.()
  await cleanupNetwork?.()
  globalThis.fetch = originalFetch
  process.chdir(originalCwd)
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  rmSync(fixture, { recursive: true, force: true })
}
