// 阶段 7：追番变更预览 → 确认 → 执行 → 回读。覆盖越权、篡改/重放、并发冲突、
// 取消/超时/响应丢失、回读一致性、功能版本变化与访客拒绝；不触碰生产数据。
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import Database from 'better-sqlite3'
import type { Server } from 'node:http'

const dir = mkdtempSync(join(tmpdir(), 'maple-agent-tracks-')), cwd = process.cwd(), env = { ...process.env }
mkdirSync(join(dir, 'data'))
process.chdir(dir)
for (const key of Object.keys(process.env)) if (/^(AI_|AGENT_|SENTRY_|VITE_SENTRY_|SMTP_|GOOGLE_|MAPLETOOLS_ENV_FILE$|VERCEL$)/.test(key)) delete process.env[key]
process.env.NODE_ENV = 'production'
process.env.DATA_DIR = join(dir, 'data')
process.env.AUTH_SECRET = randomBytes(48).toString('hex')
process.env.EMAIL_MODE = 'disabled'
process.env.AGENT_AI_ENABLED = '0'

// 离线索引夹具：add 预览只允许离线已收录的正数条目。
const index = new Database(join(dir, 'data', 'bgm_index.db'))
index.exec("CREATE TABLE anime (bgm_id INTEGER PRIMARY KEY, name TEXT, name_cn TEXT, aliases TEXT, date TEXT, score REAL)")
index.prepare('INSERT INTO anime VALUES (?,?,?,?,?,?)').run(555, 'Yuru Camp', '摇曳露营△', '[]', '2018-01-04', 8.5)
index.close()

let checks = 0
const check = async (name: string, fn: () => unknown) => { await fn(); console.log(`PASS T${++checks} ${name}`) }
let cleanup: (() => Promise<void>) | undefined
const throws = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof Error && (e as { code?: string }).code === code, code)

try {
  const { db } = await import('../server/db')
  const { AgentActionStore, proposeTrackChangeTool } = await import('../server/agent/actions-store')
  const { AgentHistoryStore } = await import('../server/agent/history-store')
  const { initializeAgentRunSchema, AgentRunStore } = await import('../server/agent/run-store')
  const { AgentRunService } = await import('../server/agent/run-service')
  const { createAgentRunApi } = await import('../server/agent/run-api')
  const { AgentKnowledgeRegistry, AGENT_FEATURES, AGENT_FEATURE_REGISTRATIONS } = await import('../server/agent/knowledge')
  const { Hono } = await import('hono')
  const { serve } = await import('@hono/node-server')
  const { issueSession } = await import('../server/auth')
  const { sameOriginGuard, securityHeaders } = await import('../server/security')

  initializeAgentRunSchema(db)
  const history = new AgentHistoryStore(db)
  const addUser = (name: string) => Number(db.prepare('INSERT INTO users(username,pass_hash,created_at) VALUES(?,?,?)').run(name, randomBytes(16).toString('hex'), new Date().toISOString()).lastInsertRowid)
  const alice = addUser('tracks_alice'), bob = addUser('tracks_bob')
  const rev = (uid: number) => (db.prepare('SELECT tracks_rev FROM users WHERE id=?').get(uid) as { tracks_rev: number }).tracks_rev
  const bumpTracks = (uid: number) => db.prepare('UPDATE users SET tracks_rev = tracks_rev + 1 WHERE id=?').run(uid)
  const seedTrack = (uid: number, bgmId: number, over: Record<string, unknown> = {}) => {
    db.prepare(`INSERT OR REPLACE INTO tracks (user_id,bgm_id,status,episode,total_episodes,title,title_cn,cover,air_weekday,air_date,score,bgm_tags,user_tags,aliases,extra,observe_count,updated_at)
      VALUES (@user_id,@bgm_id,@status,@episode,@total_episodes,@title,@title_cn,'',0,'',0,'[]',@user_tags,'[]','{}',0,@now)`).run({
      user_id: uid, bgm_id: bgmId, status: 'watching', episode: 2, total_episodes: null, title: 'Seed', title_cn: '种子番', user_tags: '[]', now: Date.now(), ...over,
    })
    bumpTracks(uid)
  }
  const session = (uid: number) => history.createSession(uid, { requestId: randomUUID(), title: '追番变更手帐' })
  const trackRow = (uid: number, bgmId: number) => db.prepare('SELECT status,episode,user_tags FROM tracks WHERE user_id=? AND bgm_id=?').get(uid, bgmId) as { status: string; episode: number; user_tags: string } | undefined

  let version = 'v1'
  const store = new AgentActionStore(db, Date.now, () => version)
  const ctx = (sessionId: string) => ({ sessionId, runId: 'run-x', messageId: null })

  await check('预览只读：返回新旧值与 revision，不写追番，凭证不进模型结果', () => {
    const s = session(alice); seedTrack(alice, 101, { status: 'watching', episode: 2 })
    const before = rev(alice)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 101, change: { kind: 'update', fields: { status: 'done', episode: 5 } } })
    assert.equal(preview.kind, 'track_change')
    assert.equal(preview.before?.status, 'watching'); assert.equal(preview.after.status, 'done'); assert.equal(preview.after.episode, 5)
    assert.equal(preview.expectedRevision, before)
    assert(!('confirmationToken' in preview) && !JSON.stringify(preview).includes('confirm'))
    assert.equal(rev(alice), before)
    assert.equal(trackRow(alice, 101)!.status, 'watching')
    const row = db.prepare('SELECT state FROM agent_actions WHERE id=?').get(preview.actionId) as { state: string }
    assert.equal(row.state, 'prepared')
  })

  await check('确认执行按字段级 patch 写入并回读一致，revision 恰好 +1', () => {
    const s = session(alice); seedTrack(alice, 102, { status: 'watching', episode: 1, user_tags: '["旧"]' })
    const baseRev = rev(alice)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 102, change: { kind: 'update', fields: { status: 'done', userTags: ['补完'] } } })
    const detail = store.detail(alice, preview.actionId)
    assert(typeof detail.confirmationToken === 'string' && detail.confirmationToken.length >= 32)
    const result = store.apply(alice, preview.actionId, { requestId: `apply:${preview.actionId}`, expectedRevision: baseRev, confirmationToken: detail.confirmationToken })
    assert.equal(result.action.state, 'completed')
    assert.equal(result.action.actualRevision, baseRev + 1)
    assert.equal(result.track!.status, 'done'); assert.deepEqual(result.track!.userTags, ['补完'])
    const written = trackRow(alice, 102)!
    assert.equal(written.status, 'done'); assert.equal(written.episode, 1); assert.equal(written.user_tags, '["补完"]')
    assert.equal(rev(alice), baseRev + 1)
  })

  await check('添加：只用离线已收录的正数条目，目标已存在则拒绝', () => {
    const s = session(alice)
    throws(() => store.prepare(alice, ctx(s.id), { bgmId: 999999, change: { kind: 'add', fields: { status: 'plan' } } }), 'NOT_FOUND')
    const baseRev = rev(alice)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 555, change: { kind: 'add', fields: { status: 'plan', userTags: ['周末看'] } } })
    assert.equal(preview.before, null); assert.equal(preview.after.title, '摇曳露营△'); assert.equal(preview.after.status, 'plan')
    const token = store.detail(alice, preview.actionId).confirmationToken!
    const result = store.apply(alice, preview.actionId, { requestId: `apply:${preview.actionId}`, expectedRevision: baseRev, confirmationToken: token })
    assert.equal(result.action.state, 'completed'); assert.equal(result.track!.status, 'plan')
    throws(() => store.prepare(alice, ctx(s.id), { bgmId: 555, change: { kind: 'add', fields: { status: 'done' } } }), 'REVISION_CONFLICT')
  })

  await check('添加：离线索引查不到时可用本地补充表或当前页面资料的标题', () => {
    const s = session(alice)
    db.prepare("INSERT OR REPLACE INTO bgm_search_additions (bgm_id,name,name_cn,aliases,date,score,added_at) VALUES (?,?,?,'[]',?,?,?)").run(778, 'Learned Title', '本地补充番', '2020-04-01', 7, Date.now())
    const p1 = store.prepare(alice, ctx(s.id), { bgmId: 778, change: { kind: 'add', fields: { status: 'plan' } } })
    assert.equal(p1.preview.after.title, '本地补充番')
    // 页面带入的番剧：会话 current_bgm_id + page_context_json 匹配时用其标题
    const s2 = history.createSession(alice, { requestId: randomUUID(), title: '带资料', currentBgmId: 889, pageContext: { bgmId: 889, title: '页面带入番', titleCn: '页面带入番', year: 2021, episodes: 12, tags: [], completed: null, summary: '', loadedAt: Date.now() } })
    const p2 = store.prepare(alice, { sessionId: s2.id, runId: 'r', messageId: null }, { bgmId: 889, change: { kind: 'add', fields: { status: 'watching', episode: 3 } } })
    assert.equal(p2.preview.after.title, '页面带入番'); assert.equal(p2.preview.after.episode, 3)
    // 三个来源都没有 → 仍拒绝
    throws(() => store.prepare(alice, ctx(s.id), { bgmId: 4242, change: { kind: 'add', fields: { status: 'plan' } } }), 'NOT_FOUND')
  })

  await check('自己记一条：离线库没有也能加，服务端分配负 bgmId，确认后落库', () => {
    const s = session(alice)
    const { preview } = store.prepare(alice, ctx(s.id), { change: { kind: 'add_custom', title: '感谢对战。～大小姐才不玩格斗游戏～', fields: { status: 'plan', episode: 3 } } })
    assert.equal(preview.before, null)
    assert(preview.after.bgmId < 0)
    assert.equal(preview.after.title, '感谢对战。～大小姐才不玩格斗游戏～')
    assert.equal(preview.after.status, 'plan'); assert.equal(preview.after.episode, 3)
    assert(!('confirmationToken' in preview))
    const baseRev = rev(alice)
    const token = store.detail(alice, preview.actionId).confirmationToken!
    const res = store.apply(alice, preview.actionId, { requestId: `apply:${preview.actionId}`, expectedRevision: baseRev, confirmationToken: token })
    assert.equal(res.action.state, 'completed')
    assert(res.track!.bgmId < 0)
    const written = db.prepare('SELECT bgm_id, title, status, episode FROM tracks WHERE user_id = ? AND bgm_id < 0').get(alice) as { bgm_id: number; title: string; status: string; episode: number }
    assert.equal(written.title, '感谢对战。～大小姐才不玩格斗游戏～'); assert.equal(written.status, 'plan'); assert.equal(written.episode, 3)
    assert.equal(rev(alice), baseRev + 1)
    // 标题必填
    throws(() => store.prepare(alice, ctx(s.id), { change: { kind: 'add_custom', title: '   ', fields: {} } }), 'INVALID_ARGUMENT')
  })

  await check('篡改凭证被拒；正确凭证重放同一请求号只执行一次', () => {
    const s = session(alice); seedTrack(alice, 103, { status: 'watching', episode: 3 })
    const baseRev = rev(alice)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 103, change: { kind: 'update', fields: { episode: 8 } } })
    const token = store.detail(alice, preview.actionId).confirmationToken!
    const reqId = `apply:${preview.actionId}`
    throws(() => store.apply(alice, preview.actionId, { requestId: reqId, expectedRevision: baseRev, confirmationToken: 'x'.repeat(token.length) }), 'CONFIRMATION_REQUIRED')
    assert.equal(rev(alice), baseRev)
    const first = store.apply(alice, preview.actionId, { requestId: reqId, expectedRevision: baseRev, confirmationToken: token })
    const afterRev = rev(alice)
    const replay = store.apply(alice, preview.actionId, { requestId: reqId, expectedRevision: baseRev, confirmationToken: token })
    assert.equal(first.action.actualRevision, replay.action.actualRevision)
    assert.equal(rev(alice), afterRev)
    throws(() => store.apply(alice, preview.actionId, { requestId: 'apply:other', expectedRevision: baseRev, confirmationToken: token }), 'CONFIRMATION_REQUIRED')
  })

  await check('并发修改：预览后追番被改动，确认报 REVISION_CONFLICT 且不写', () => {
    const s = session(alice); seedTrack(alice, 104, { status: 'watching' })
    const baseRev = rev(alice)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 104, change: { kind: 'update', fields: { status: 'done' } } })
    const token = store.detail(alice, preview.actionId).confirmationToken!
    bumpTracks(alice) // 另一端改动
    throws(() => store.apply(alice, preview.actionId, { requestId: `apply:${preview.actionId}`, expectedRevision: baseRev, confirmationToken: token }), 'REVISION_CONFLICT')
    assert.equal(trackRow(alice, 104)!.status, 'watching')
    // 客户端发的 expectedRevision 与回执不一致也拒绝
    seedTrack(alice, 105, {})
    const p2 = store.prepare(alice, ctx(s.id), { bgmId: 105, change: { kind: 'update', fields: { status: 'plan' } } })
    const t2 = store.detail(alice, p2.preview.actionId).confirmationToken!
    throws(() => store.apply(alice, p2.preview.actionId, { requestId: `apply:${p2.preview.actionId}`, expectedRevision: p2.preview.expectedRevision + 99, confirmationToken: t2 }), 'REVISION_CONFLICT')
  })

  await check('取消不写；过期预览再确认报 ACTION_EXPIRED 并记为取消', () => {
    const s = session(alice); seedTrack(alice, 106, { status: 'watching' })
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 106, change: { kind: 'update', fields: { status: 'done' } } })
    const realToken = (db.prepare('SELECT confirm_token FROM agent_actions WHERE id=?').get(preview.actionId) as { confirm_token: string }).confirm_token
    store.cancel(alice, preview.actionId, { expectedRevision: preview.expectedRevision })
    assert.equal(trackRow(alice, 106)!.status, 'watching')
    assert.equal(store.detail(alice, preview.actionId).action.state, 'cancelled')
    throws(() => store.apply(alice, preview.actionId, { requestId: `apply:${preview.actionId}`, expectedRevision: preview.expectedRevision, confirmationToken: realToken }), 'ACTION_EXPIRED')

    const expiring = new AgentActionStore(db, () => Date.now() - 25 * 60 * 60_000, () => version)
    const s2 = session(alice); seedTrack(alice, 107, {})
    const old = expiring.prepare(alice, ctx(s2.id), { bgmId: 107, change: { kind: 'update', fields: { status: 'plan' } } })
    const oldToken = db.prepare('SELECT confirm_token FROM agent_actions WHERE id=?').get(old.preview.actionId) as { confirm_token: string }
    throws(() => store.apply(alice, old.preview.actionId, { requestId: `apply:${old.preview.actionId}`, expectedRevision: old.preview.expectedRevision, confirmationToken: oldToken.confirm_token }), 'ACTION_EXPIRED')
    assert.equal(store.detail(alice, old.preview.actionId).action.state, 'cancelled')
    assert.equal(trackRow(alice, 107)!.status, 'watching')
  })

  await check('身份或功能版本变化不沿用旧确认', () => {
    const s = session(alice); seedTrack(alice, 108, {})
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 108, change: { kind: 'update', fields: { status: 'done' } } })
    const token = store.detail(alice, preview.actionId).confirmationToken!
    version = 'v2'
    throws(() => store.apply(alice, preview.actionId, { requestId: `apply:${preview.actionId}`, expectedRevision: preview.expectedRevision, confirmationToken: token }), 'CAPABILITY_CHANGED')
    version = 'v1'
    const s2 = session(alice); seedTrack(alice, 109, {})
    const p2 = store.prepare(alice, ctx(s2.id), { bgmId: 109, change: { kind: 'update', fields: { status: 'done' } } })
    const t2 = store.detail(alice, p2.preview.actionId).confirmationToken!
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id=?').run(alice)
    throws(() => store.apply(alice, p2.preview.actionId, { requestId: `apply:${p2.preview.actionId}`, expectedRevision: p2.preview.expectedRevision, confirmationToken: t2 }), 'AUTH_REQUIRED')
    db.prepare('UPDATE users SET token_version = token_version - 1 WHERE id=?').run(alice)
  })

  await check('消息卡片：prepared 动作在确认后转 completed 并清除 pending', () => {
    const s = session(alice); seedTrack(alice, 130, { status: 'watching' })
    let cur = history.snapshot(alice, s.id).session
    const msg = history.appendAssistant(alice, s.id, { requestId: randomUUID(), expectedRevision: cur.revision, body: '点确认后才写入。', status: 'streaming', sources: [], toolSummaries: [], usage: [], actions: [] })
    const { preview } = store.prepare(alice, { sessionId: s.id, runId: 'r1', messageId: msg.message.id }, { bgmId: 130, change: { kind: 'update', fields: { status: 'done' } } })
    cur = history.snapshot(alice, s.id).session
    const withAction = history.updateAssistant(alice, s.id, msg.message.id, {
      body: msg.message.body, status: 'streaming', sources: [], toolSummaries: [], usage: [],
      actions: [{ actionId: preview.actionId, kind: 'track_change', state: 'prepared', eventSeq: 0, updatedAt: Date.now(), evidence: 'preview', errorCode: null, userReportedSuccess: false, summary: preview.impact }],
      expectedRevision: cur.revision,
    })
    history.updateAssistant(alice, s.id, msg.message.id, { body: withAction.message.body, status: 'completed', sources: [], toolSummaries: [], usage: [], actions: withAction.message.actions, expectedRevision: history.snapshot(alice, s.id).session.revision })
    const finalized = history.snapshot(alice, s.id).messages.find(m => m.id === msg.message.id)!
    assert.equal(finalized.actions[0].state, 'prepared')
    const token = store.detail(alice, preview.actionId).confirmationToken!
    store.apply(alice, preview.actionId, { requestId: `apply:${preview.actionId}`, expectedRevision: preview.expectedRevision, confirmationToken: token })
    const after = history.snapshot(alice, s.id).messages.find(m => m.id === msg.message.id)!
    assert.equal(after.actions[0].state, 'completed')
    assert.equal((db.prepare('SELECT pending_actions FROM agent_messages WHERE id=?').get(msg.message.id) as { pending_actions: number }).pending_actions, 0)
  })

  await check('越权：别的账号或伪造 actionId 都读不到也执行不了', () => {
    const s = session(alice); seedTrack(alice, 110, {})
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 110, change: { kind: 'update', fields: { status: 'done' } } })
    const token = store.detail(alice, preview.actionId).confirmationToken!
    throws(() => store.detail(bob, preview.actionId), 'NOT_FOUND')
    throws(() => store.apply(bob, preview.actionId, { requestId: `apply:${preview.actionId}`, expectedRevision: preview.expectedRevision, confirmationToken: token }), 'NOT_FOUND')
    throws(() => store.cancel(bob, preview.actionId, {}), 'NOT_FOUND')
    assert.equal(trackRow(alice, 110)!.status, 'watching')
  })

  await check('proposal 工具固定绑定账号，模型给的身份不生效；非法字段被拒', async () => {
    const s = session(alice); seedTrack(alice, 111, {})
    const tool = proposeTrackChangeTool(store, alice, s.id)
    const mismatch = await tool.execute({ bgmId: 111, change: { kind: 'update', fields: { status: 'done' } } } as never, { uid: bob, knowledgeVersion: 'v1', signal: new AbortController().signal }) as { ok: boolean; code?: string }
    assert.equal(mismatch.ok, false); assert.equal(mismatch.code, 'AUTH_REQUIRED')
    const bad = await tool.execute({ bgmId: 111, change: { kind: 'update', fields: { status: 'not-a-status' } } } as never, { uid: alice, knowledgeVersion: 'v1', signal: new AbortController().signal }) as { ok: boolean; code?: string }
    assert.equal(bad.ok, false); assert.equal(bad.code, 'INVALID_ARGUMENT')
    const empty = await tool.execute({ bgmId: 111, change: { kind: 'update', fields: {} } } as never, { uid: alice, knowledgeVersion: 'v1', signal: new AbortController().signal }) as { ok: boolean }
    assert.equal(empty.ok, false)
  })

  // ── HTTP：会话鉴权、跨账号、访客拒绝 ──────────────────────────────────────────
  const runService = new AgentRunService(new AgentRunStore(db), () => { throw new Error('NO_RUN_IN_THIS_TEST') })
  const knowledge = () => ({ ...new AgentKnowledgeRegistry('rel', AGENT_FEATURE_REGISTRATIONS, AGENT_FEATURES, ['proposeTrackChange']).snapshot(alice, { enabled: true, permissionVersion: 'p', features: [], tools: [] }) })
  const app = new Hono()
  app.use('*', securityHeaders()); app.use('/api/*', sameOriginGuard())
  app.route('/api/agent', createAgentRunApi(runService, knowledge as never, store))
  const server = serve({ fetch: app.fetch, hostname: 'localhost', port: 0 }); await once(server, 'listening')
  const addr = server.address(); assert(addr && typeof addr !== 'string')
  const origin = `http://localhost:${addr.port}`
  const cookie = async (uid: number, username: string) => {
    const issuer = new Hono().get('/', async c => { await issueSession(c, { uid, username, tv: db.prepare('SELECT token_version FROM users WHERE id=?').get(uid) ? (db.prepare('SELECT token_version FROM users WHERE id=?').get(uid) as { token_version: number }).token_version : 0 }); return c.text('ok') })
    return (await issuer.request(origin)).headers.get('set-cookie')!.split(';')[0]
  }
  const aliceCookie = await cookie(alice, 'tracks_alice'), bobCookie = await cookie(bob, 'tracks_bob')
  const call = (path: string, method: string, body: unknown, ck?: string) => fetch(origin + '/api/agent' + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(ck ? { Cookie: ck } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  cleanup = async () => { const done = new Promise<void>((r, j) => server.close(e => e ? j(e) : r())); (server as Server).closeAllConnections(); await done; db.close(); index; }

  await check('HTTP：未登录、跨账号、跨站请求全部拒绝', async () => {
    const s = session(alice); seedTrack(alice, 120, {})
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 120, change: { kind: 'update', fields: { status: 'done' } } })
    const token = store.detail(alice, preview.actionId).confirmationToken!
    assert.equal((await call(`/actions/${preview.actionId}`, 'GET', undefined)).status, 401)
    assert.equal((await call(`/actions/${preview.actionId}`, 'GET', undefined, bobCookie)).status, 404)
    assert.equal((await fetch(origin + `/api/agent/actions/${preview.actionId}/apply`, { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json', Cookie: aliceCookie }, body: '{}' })).status, 403)
    const body = { actionId: preview.actionId, requestId: `apply:${preview.actionId}`, expectedRevision: preview.expectedRevision, confirmationToken: token }
    assert.equal((await call(`/actions/${preview.actionId}/apply`, 'POST', body, bobCookie)).status, 404)
    assert.equal(trackRow(alice, 120)!.status, 'watching')
  })

  await check('HTTP：owner 取回预览与凭证后确认成功并回读', async () => {
    const s = session(alice); seedTrack(alice, 121, { status: 'watching', episode: 4 })
    const baseRev = rev(alice)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 121, change: { kind: 'update', fields: { episode: 9 } } })
    const detail = await (await call(`/actions/${preview.actionId}`, 'GET', undefined, aliceCookie)).json() as { confirmationToken: string; preview: { expectedRevision: number } }
    assert.equal(typeof detail.confirmationToken, 'string')
    const res = await call(`/actions/${preview.actionId}/apply`, 'POST', { actionId: preview.actionId, requestId: `apply:${preview.actionId}`, expectedRevision: detail.preview.expectedRevision, confirmationToken: detail.confirmationToken }, aliceCookie)
    assert.equal(res.status, 200)
    const json = await res.json() as { action: { state: string }; track: { episode: number } }
    assert.equal(json.action.state, 'completed'); assert.equal(json.track.episode, 9)
    assert.equal(rev(alice), baseRev + 1)
    // 消息卡片同步：会话下这条 prepared 动作已转 completed（若绑定了 message 则清 pending）
  })

  await check('HTTP：畸形 body、actionId 不一致、非法游标被入口拦截', async () => {
    const s = session(alice); seedTrack(alice, 122, {})
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 122, change: { kind: 'update', fields: { status: 'done' } } })
    assert.equal((await call(`/actions/${preview.actionId}/apply`, 'POST', { confirmed: true }, aliceCookie)).status, 400)
    assert.equal((await call(`/actions/${preview.actionId}/apply`, 'POST', { actionId: 'act-other', requestId: 'apply:x', expectedRevision: 0, confirmationToken: 'x'.repeat(40) }, aliceCookie)).status, 400)
    assert.equal((await call(`/actions/not-an-id`, 'GET', undefined, aliceCookie)).status, 404)
    assert.equal((await call(`/actions/${preview.actionId}/cancel`, 'POST', { extra: 1 }, aliceCookie)).status, 400)
    assert.equal(trackRow(alice, 122)!.status, 'watching')
  })

  console.log(JSON.stringify({ checks, failed: 0, realAiCalls: 0, transport: 'direct-store-and-loopback-http', database: 'temporary-sqlite', productionDataTouched: false }))
} finally {
  await cleanup?.()
  process.chdir(cwd); process.env = env
  rmSync(dir, { recursive: true, force: true })
}
