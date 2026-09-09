// 阶段 8：播放打开预览 → 用户点击 → 播放页事件回执。覆盖越权、乱序/重放事件、
// 跨域套娃只能到 unknown、模型不能自称成功、片源未认时的导航意图；不触碰生产数据，不请求任何源站。
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { checkPlan } from './agent-fixtures'

const dir = mkdtempSync(join(tmpdir(), 'maple-agent-playback-')), cwd = process.cwd()
mkdirSync(join(dir, 'data'))
process.chdir(dir)
for (const key of Object.keys(process.env)) if (/^(AI_|AGENT_|SENTRY_|VITE_SENTRY_|SMTP_|GOOGLE_|MAPLETOOLS_ENV_FILE$|VERCEL$)/.test(key)) delete process.env[key]
process.env.NODE_ENV = 'production'
process.env.DATA_DIR = join(dir, 'data')
process.env.AUTH_SECRET = randomBytes(48).toString('hex')
process.env.EMAIL_MODE = 'disabled'
process.env.AGENT_AI_ENABLED = '0'

let checks = 0
const settlePlan = checkPlan('P', 28, () => checks)
const check = async (name: string, fn: () => unknown) => { await fn(); console.log(`PASS P${++checks} ${name}`) }
let cleanup: (() => Promise<void>) | undefined
const throws = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof Error && (e as { code?: string }).code === code, code)
const rejects = (fn: () => Promise<unknown>, code: string) => assert.rejects(fn, (e: unknown) => e instanceof Error && (e as { code?: string }).code === code, code)

try {
  const { db } = await import('../server/db')
  const { AgentPlaybackStore, initializeAgentPlaybackSchema, proposePlaybackOpenTool } = await import('../server/agent/playback-store')
  type SourceCandidate = { xifanId: number; xifanName: string; score: number }
  const { AgentActionStore, initializeAgentActionSchema } = await import('../server/agent/actions-store')
  const { AgentHistoryStore } = await import('../server/agent/history-store')
  const { initializeAgentRunSchema, AgentRunStore } = await import('../server/agent/run-store')
  const { AgentRunService } = await import('../server/agent/run-service')
  const { createAgentRunApi } = await import('../server/agent/run-api')
  const { AgentKnowledgeRegistry, AGENT_FEATURES, AGENT_FEATURE_REGISTRATIONS } = await import('../server/agent/knowledge')
  const { PLAYBACK_EVENTS } = await import('../shared/agent-contracts')
  const { Hono } = await import('hono')
  const { serve } = await import('@hono/node-server')
  const { issueSession } = await import('../server/auth')
  const { sameOriginGuard, securityHeaders } = await import('../server/security')

  initializeAgentRunSchema(db); initializeAgentActionSchema(db); initializeAgentPlaybackSchema(db)
  const history = new AgentHistoryStore(db)
  const addUser = (name: string) => Number(db.prepare('INSERT INTO users(username,pass_hash,created_at) VALUES(?,?,?)').run(name, randomBytes(16).toString('hex'), new Date().toISOString()).lastInsertRowid)
  const alice = addUser('play_alice'), bob = addUser('play_bob')
  const seedTrack = (uid: number, bgmId: number, over: Record<string, unknown> = {}) =>
    db.prepare(`INSERT OR REPLACE INTO tracks (user_id,bgm_id,status,episode,total_episodes,title,title_cn,cover,air_weekday,air_date,score,bgm_tags,user_tags,aliases,extra,observe_count,updated_at)
      VALUES (@user_id,@bgm_id,@status,@episode,@total_episodes,'Ojou-sama','大小姐才不会格斗游戏','',0,'',0,'[]','[]','[]','{}',0,@now)`).run({
      user_id: uid, bgm_id: bgmId, status: 'watching', episode: 3, total_episodes: null, now: Date.now(), ...over })
  const bindXifan = (bgmId: number, id: number) => db.prepare('INSERT OR REPLACE INTO xifan_binding (bgm_id,xifan_id,xifan_name,updated_at) VALUES (?,?,?,?)').run(bgmId, id, 'x', Date.now())
  const session = (uid: number) => history.createSession(uid, { requestId: randomUUID(), title: '播放手帐' })
  const rowState = (id: string) => (db.prepare('SELECT state, event_seq FROM agent_playback_actions WHERE id=?').get(id) as { state: string; event_seq: number })

  let version = 'v1'
  let clock = Date.now()
  const trackStore = new AgentActionStore(db, () => clock, () => version)
  // 认源依赖是注入的：测试里用可编排的假周表，一次源站请求都不真发。
  let locateResult: { bound?: SourceCandidate; candidates: SourceCandidate[] } | Error = { candidates: [] }
  const locateCalls: { bgmId: number; titles: string[] }[] = []
  const bindCalls: { bgmId: number; id: string; name: string }[] = []
  // 站内搜索 / 验证码也全是编排出来的：测试一次真实源站请求都不发。
  let searchResult: { needsCaptcha: true } | { needsCaptcha: false; data: { xifanId: number; xifanName: string; note: string }[] } = { needsCaptcha: false, data: [] }
  let captchaOk = true
  const captchaCalls: number[] = []
  const store = new AgentPlaybackStore(db, () => clock, () => version, trackStore, {
    locate: async (bgmId, titles) => {
      locateCalls.push({ bgmId, titles })
      if (locateResult instanceof Error) throw locateResult
      return locateResult
    },
    search: async () => searchResult,
    captcha: async uid => { captchaCalls.push(uid); return { imageB64: 'aGk=', mime: 'image/png' } },
    verifyCaptcha: async () => ({ success: captchaOk }),
    bind: (bgmId, id, name) => {
      bindCalls.push({ bgmId, id, name })
      db.prepare('INSERT OR REPLACE INTO xifan_binding (bgm_id,xifan_id,xifan_name,updated_at) VALUES (?,?,?,?)').run(bgmId, Number(id), name, clock)
    },
  })
  // 组合动作里的「先加入追番」要能查到离线元数据；本地补充表就够，不必造索引文件。
  const offline = (bgmId: number, name: string) =>
    db.prepare("INSERT OR REPLACE INTO bgm_search_additions(bgm_id,name,name_cn,aliases,date,score,added_at) VALUES(?,?,?,'[]','2026-08-12',0,?)").run(bgmId, name, name, clock)
  const trackRow = (uid: number, bgmId: number) => db.prepare('SELECT status,episode FROM tracks WHERE user_id=? AND bgm_id=?').get(uid, bgmId) as { status: string; episode: number } | undefined
  const ctx = (sessionId: string) => ({ sessionId, runId: 'run-x', messageId: null })

  await check('预览只读：不写库、不带任何源站请求，集数沿用追番进度', async () => {
    const s = session(alice); seedTrack(alice, 401, { episode: 3 }); bindXifan(401, 9001)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 401, source: 'xifan' })
    assert.equal(preview.kind, 'playback_open')
    assert.equal(preview.episode, 3)
    assert.equal(preview.source, 'xifan')
    assert.equal(preview.target, 'web_player')
    assert.equal(preview.title, '大小姐才不会格斗游戏')
    assert.equal(rowState(preview.actionId).state, 'prepared')
    // 预览里没有任何可直接执行的凭证或源站地址
    assert(!JSON.stringify(preview).includes('http'))
  })

  await check('集数封顶总集数；离线资料也查不到的条目无从生成预览', async () => {
    const s = session(alice); seedTrack(alice, 402, { episode: 3, total_episodes: 12 })
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 402, source: 'xifan', episode: 99 })
    assert.equal(preview.episode, 12)
    // 离线资料里都查不到的条目，仍然无从生成预览
    throws(() => store.prepare(alice, ctx(s.id), { bgmId: 999_001, source: 'xifan' }), 'NOT_FOUND')
  })

  await check('没认过片源：目标是选片源弹窗，不是播放页', async () => {
    const s = session(alice); seedTrack(alice, 403, { episode: 1 })
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 403, source: 'girigiri' })
    assert.equal(preview.target, 'source_search')
    assert.match(preview.impact, /去Girigiri找《大小姐才不会格斗游戏》的片源，认好后打开第 1 集/)
    const opened = store.open(alice, preview.actionId)
    assert.equal(opened.url, null)
    assert.deepEqual(opened.navigate, { view: 'source_search', bgmId: 403, source: 'girigiri' })
    assert.equal(opened.action.state, 'dispatch_started')
  })

  await check('已认片源：点击后推进到 dispatch_started 并给出同源播放页地址（带 actionId）', async () => {
    const s = session(alice); seedTrack(alice, 404, { episode: 5 }); bindXifan(404, 9002)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 404, source: 'xifan' })
    const opened = store.open(alice, preview.actionId)
    assert.equal(opened.action.state, 'dispatch_started')
    assert.equal(opened.url, `/api/xifan/play-page?animeId=9002&ep=5&bgmId=404&agentAction=${preview.actionId}`)
    // 同一份预览不能重复打开
    throws(() => store.open(alice, preview.actionId), 'ACTION_EXPIRED')
  })

  await check('同一会话里同番同源同集的重复提案复用同一张卡', async () => {
    const s = session(alice); seedTrack(alice, 415, { episode: 2 }); bindXifan(415, 9012)
    const first = (store.prepare(alice, ctx(s.id), { bgmId: 415, source: 'xifan' })).preview
    const again = (store.prepare(alice, ctx(s.id), { bgmId: 415, source: 'xifan' })).preview
    assert.equal(again.actionId, first.actionId)
    // 换集数或换源仍然是另一个提案
    assert.notEqual((store.prepare(alice, ctx(s.id), { bgmId: 415, source: 'xifan', episode: 7 })).preview.actionId, first.actionId)
    assert.notEqual((store.prepare(alice, ctx(s.id), { bgmId: 415, source: 'girigiri' })).preview.actionId, first.actionId)
  })

  await check('事件链：页面 → 播放器 → 线路 → canplay → playing → 累计观看才算完成', async () => {
    const s = session(alice); seedTrack(alice, 405, { episode: 1 }); bindXifan(405, 9003)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 405, source: 'xifan' })
    store.open(alice, preview.actionId)
    const path: [string, string][] = [
      ['page_ready', 'navigation_committed'], ['player_ready', 'player_ready'], ['source_selected', 'source_selected'],
      ['media_canplay', 'media_canplay'], ['playing', 'playing'], ['watched', 'completed'],
    ]
    for (const [event, state] of path) {
      const r = store.report(alice, preview.actionId, event as never, '')
      assert.equal(r.applied, true, event)
      assert.equal(r.action.state, state, event)
    }
    // 终态之后任何事件都不再改动权威回执
    const after = store.report(alice, preview.actionId, 'failed', '')
    assert.equal(after.applied, false); assert.equal(after.action.state, 'completed')
  })

  await check('乱序与重放事件被忽略：不报错，也不推进状态', async () => {
    const s = session(alice); seedTrack(alice, 406, { episode: 1 }); bindXifan(406, 9004)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 406, source: 'xifan' })
    store.open(alice, preview.actionId)
    // 直接自称 playing —— 中间步骤没发生过，不认
    const jump = store.report(alice, preview.actionId, 'playing', '')
    assert.equal(jump.applied, false); assert.equal(jump.action.state, 'dispatch_started')
    assert.equal(store.report(alice, preview.actionId, 'page_ready', '').action.state, 'navigation_committed')
    // 重放同一条事件：状态与 eventSeq 都不动
    const seq = rowState(preview.actionId).event_seq
    const replay = store.report(alice, preview.actionId, 'page_ready', '')
    assert.equal(replay.applied, false)
    assert.equal(rowState(preview.actionId).event_seq, seq)
  })

  await check('退到源站自己的播放器：只能到 unknown，之后不再推进', async () => {
    const s = session(alice); seedTrack(alice, 407, { episode: 1 }); bindXifan(407, 9005)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 407, source: 'xifan' })
    store.open(alice, preview.actionId)
    store.report(alice, preview.actionId, 'page_ready', '')
    const fallback = store.report(alice, preview.actionId, 'cross_origin', '')
    assert.equal(fallback.action.state, 'unknown')
    assert.equal(store.report(alice, preview.actionId, 'playing', '').applied, false)
    assert.equal(rowState(preview.actionId).state, 'unknown')
  })

  await check('预览过期与取消都不打开任何页面', async () => {
    const s = session(alice); seedTrack(alice, 408, { episode: 1 }); bindXifan(408, 9006)
    const cancelled = (store.prepare(alice, ctx(s.id), { bgmId: 408, source: 'xifan' })).preview
    assert.equal(store.cancel(alice, cancelled.actionId).action.state, 'cancelled')
    throws(() => store.open(alice, cancelled.actionId), 'ACTION_EXPIRED')
    const stale = (store.prepare(alice, ctx(s.id), { bgmId: 408, source: 'xifan' })).preview
    clock += 7 * 60 * 60_000
    throws(() => store.open(alice, stale.actionId), 'ACTION_EXPIRED')
    assert.equal(rowState(stale.actionId).state, 'cancelled')
    clock -= 7 * 60 * 60_000
  })

  await check('功能版本或登录状态变化后，旧预览不再可用', async () => {
    const s = session(alice); seedTrack(alice, 409, { episode: 1 }); bindXifan(409, 9007)
    const a = (store.prepare(alice, ctx(s.id), { bgmId: 409, source: 'xifan' })).preview
    version = 'v2'
    throws(() => store.open(alice, a.actionId), 'CAPABILITY_CHANGED')
    version = 'v1'
    const b = (store.prepare(alice, ctx(s.id), { bgmId: 409, source: 'xifan' })).preview
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id=?').run(alice)
    throws(() => store.open(alice, b.actionId), 'AUTH_REQUIRED')
    db.prepare('UPDATE users SET token_version = token_version - 1 WHERE id=?').run(alice)
  })

  await check('工具入口：账号绑定服务端会话，参数非法与越权都不生成预览', async () => {
    const s = session(alice); seedTrack(alice, 410, { episode: 1 })
    const tool = proposePlaybackOpenTool(store, alice, s.id)
    const signal = new AbortController().signal
    const mismatch = await tool.execute({ bgmId: 410, source: 'xifan' } as never, { uid: bob, knowledgeVersion: 'v1', signal }) as { ok: boolean; code?: string }
    assert.equal(mismatch.ok, false); assert.equal(mismatch.code, 'AUTH_REQUIRED')
    const bad = await tool.execute({ bgmId: 410, source: 'bilibili' } as never, { uid: alice, knowledgeVersion: 'v1', signal }) as { ok: boolean; code?: string }
    assert.equal(bad.ok, false); assert.equal(bad.code, 'INVALID_ARGUMENT')
    const missing = await tool.execute({ bgmId: 999_002, source: 'xifan' } as never, { uid: alice, knowledgeVersion: 'v1', signal }) as { ok: boolean; code?: string; message?: string }
    assert.equal(missing.code, 'NOT_FOUND'); assert.match(missing.message!, /还不在追番里/)
    const ok = await tool.execute({ bgmId: 410, source: 'xifan' } as never, { uid: alice, knowledgeVersion: 'v1', signal }) as { ok: boolean; data: { actionId: string } }
    assert.equal(ok.ok, true)
    // 工具结果里没有任何可直接执行的地址或凭证
    assert(!JSON.stringify(ok).includes('play-page'))
  })

  await check('不在追番里：同一张预览带上「先加入追番」，不再另发一张追番卡', async () => {
    const s = session(alice); offline(420, '夺还篇'); bindXifan(420, 9020)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 420, source: 'xifan', episode: 5 })
    assert.equal(preview.addsToTracks, true)
    assert.equal(preview.episode, 5)
    assert.match(preview.impact, /先把《夺还篇》加入追番（在看 · 进度 5），再打开稀饭/)
    // 追番那一步只是预览，此刻绝不能已经写进去
    assert.equal(trackRow(alice, 420), undefined)
    const linked = db.prepare('SELECT track_action_id FROM agent_playback_actions WHERE id=?').get(preview.actionId) as { track_action_id: string }
    assert.match(linked.track_action_id, /^act-/)
    assert.equal(trackStore.detail(alice, linked.track_action_id).action.state, 'prepared')
  })

  await check('确认一次按顺序执行：先写追番并回读，再给出播放页地址', async () => {
    const s = session(alice); offline(421, '组合番'); bindXifan(421, 9021)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 421, source: 'xifan', episode: 3 })
    const opened = store.open(alice, preview.actionId)
    // 第一步真的落库并回读
    assert.equal(opened.track?.track?.status, 'watching')
    assert.equal(opened.track?.track?.episode, 3)
    assert.equal(trackRow(alice, 421)?.episode, 3)
    // 第二步给出同源播放页地址
    assert.equal(opened.url, `/api/xifan/play-page?animeId=9021&ep=3&bgmId=421&agentAction=${preview.actionId}`)
    assert.equal(opened.action.state, 'dispatch_started')
    throws(() => store.open(alice, preview.actionId), 'ACTION_EXPIRED')
  })

  await check('取消组合动作把「先加入追番」一并作废，不写任何追番', async () => {
    const s = session(alice); offline(422, '取消番')
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 422, source: 'xifan' })
    const linked = (db.prepare('SELECT track_action_id FROM agent_playback_actions WHERE id=?').get(preview.actionId) as { track_action_id: string }).track_action_id
    assert.equal(store.cancel(alice, preview.actionId).action.state, 'cancelled')
    assert.equal(trackStore.detail(alice, linked).action.state, 'cancelled')
    assert.equal(trackRow(alice, 422), undefined)
  })

  // ── HTTP ────────────────────────────────────────────────────────────────────
  const runService = new AgentRunService(new AgentRunStore(db), () => { throw new Error('NO_RUN_IN_THIS_TEST') })
  const knowledge = () => new AgentKnowledgeRegistry('rel', AGENT_FEATURE_REGISTRATIONS, AGENT_FEATURES, ['proposePlaybackOpen']).snapshot(alice, { enabled: true, permissionVersion: 'p', features: [], tools: [] })
  const app = new Hono()
  app.use('*', securityHeaders()); app.use('/api/*', sameOriginGuard())
  app.route('/api/agent', createAgentRunApi(runService, knowledge as never, trackStore, store))
  const server = serve({ fetch: app.fetch, hostname: 'localhost', port: 0 }); await once(server, 'listening')
  const addr = server.address(); assert(addr && typeof addr !== 'string')
  const origin = `http://localhost:${addr.port}`
  const cookie = async (uid: number, username: string) => {
    const tv = (db.prepare('SELECT token_version FROM users WHERE id=?').get(uid) as { token_version: number }).token_version
    const issuer = new Hono().get('/', async c => { await issueSession(c, { uid, username, tv }); return c.text('ok') })
    return (await issuer.request(origin)).headers.get('set-cookie')!.split(';')[0]
  }
  const aliceCookie = await cookie(alice, 'play_alice'), bobCookie = await cookie(bob, 'play_bob')
  const call = (path: string, method: string, body: unknown, ck?: string, extra: Record<string, string> = {}) =>
    fetch(origin + '/api/agent' + path, { method, redirect: 'manual', headers: { Origin: origin, 'Content-Type': 'application/json', ...extra, ...(ck ? { Cookie: ck } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  cleanup = async () => { const done = new Promise<void>((r, j) => server.close(e => e ? j(e) : r())); (server as Server).closeAllConnections(); await done; db.close(); process.chdir(cwd) }

  await check('HTTP：未登录、跨账号、跨站都拿不到预览，也开不了播放页', async () => {
    const s = session(alice); seedTrack(alice, 411, { episode: 2 }); bindXifan(411, 9008)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 411, source: 'xifan' })
    assert.equal((await call(`/actions/${preview.actionId}`, 'GET', undefined)).status, 401)
    assert.equal((await call(`/actions/${preview.actionId}`, 'GET', undefined, bobCookie)).status, 404)
    // 跨站顶层导航不能替用户点这一下
    assert.equal((await call(`/actions/${preview.actionId}/open`, 'GET', undefined, aliceCookie, { 'Sec-Fetch-Site': 'cross-site' })).status, 401)
    assert.equal((await fetch(origin + `/api/agent/actions/${preview.actionId}/playback-event`, { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json', Cookie: aliceCookie }, body: '{}' })).status, 403)
    assert.equal(rowState(preview.actionId).state, 'prepared')
  })

  await check('HTTP：owner 点击后 302 到同源播放页，播放页事件推进权威回执', async () => {
    const s = session(alice); seedTrack(alice, 412, { episode: 7 }); bindXifan(412, 9009)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 412, source: 'xifan' })
    const detail = await (await call(`/actions/${preview.actionId}`, 'GET', undefined, aliceCookie)).json() as { openable: boolean; preview: { target: string } }
    assert.equal(detail.openable, true); assert.equal(detail.preview.target, 'web_player')
    const redirect = await call(`/actions/${preview.actionId}/open`, 'GET', undefined, aliceCookie, { 'Sec-Fetch-Site': 'same-origin' })
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.get('location'), `/api/xifan/play-page?animeId=9009&ep=7&bgmId=412&agentAction=${preview.actionId}`)
    for (const event of ['page_ready', 'player_ready', 'source_selected', 'media_canplay', 'playing']) {
      const r = await call(`/actions/${preview.actionId}/playback-event`, 'POST', { actionId: preview.actionId, event }, aliceCookie)
      assert.equal(r.status, 200, event)
    }
    assert.equal(rowState(preview.actionId).state, 'playing')
  })

  await check('HTTP：带写入的组合动作不许走 GET，只接受同源守卫覆盖的 POST', async () => {
    const s = session(alice); offline(423, 'GET 拒绝番'); bindXifan(423, 9023)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 423, source: 'xifan', episode: 2 })
    // GET 不在 sameOriginGuard 覆盖范围内，不能承载「加入追番」这一步
    assert.equal((await call(`/actions/${preview.actionId}/open`, 'GET', undefined, aliceCookie, { 'Sec-Fetch-Site': 'same-origin' })).status, 400)
    assert.equal(trackRow(alice, 423), undefined)
    assert.equal(rowState(preview.actionId).state, 'prepared')
    // 同一张预览走 POST 则正常执行两步
    const posted = await call(`/actions/${preview.actionId}/open`, 'POST', {}, aliceCookie)
    assert.equal(posted.status, 200)
    const body = await posted.json() as { url: string; track: { track: { episode: number } } }
    assert.equal(body.track.track.episode, 2)
    assert.equal(trackRow(alice, 423)?.episode, 2)
    assert.match(body.url, /^\/api\/xifan\/play-page\?animeId=9023/)
  })

  await check('HTTP：事件名白名单之外一律 400；页面不能自己指定状态', async () => {
    const s = session(alice); seedTrack(alice, 413, { episode: 1 }); bindXifan(413, 9010)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 413, source: 'xifan' })
    for (const body of [{ actionId: preview.actionId, event: 'completed' }, { actionId: preview.actionId, state: 'playing' },
      { actionId: 'pb-other', event: 'playing' }, { actionId: preview.actionId, event: 'playing', origin: 'server' }]) {
      assert.equal((await call(`/actions/${preview.actionId}/playback-event`, 'POST', body, aliceCookie)).status, 400, JSON.stringify(body))
    }
    // 事件名里没有任何「已完成 / 已成功」这类由页面自称的词：终态只能由服务端映射得出
    assert(!(PLAYBACK_EVENTS as readonly string[]).some(e => /complete|success|done/.test(e)))
    assert.equal(rowState(preview.actionId).state, 'prepared')
  })

  await check('HTTP：追番与播放两套回执不互相顶替', async () => {
    const s = session(alice); seedTrack(alice, 414, { episode: 1 }); bindXifan(414, 9011)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 414, source: 'xifan' })
    // 播放动作没有写入执行接口
    assert.equal((await call(`/actions/${preview.actionId}/apply`, 'POST', { actionId: preview.actionId, requestId: 'r', expectedRevision: 0, confirmationToken: 'x'.repeat(40) }, aliceCookie)).status, 404)
    // 追番动作也没有播放事件接口
    assert.equal((await call(`/actions/act-fake/playback-event`, 'POST', { actionId: 'act-fake', event: 'playing' }, aliceCookie)).status, 404)
    assert.equal((await call(`/actions/${preview.actionId}/cancel`, 'POST', {}, aliceCookie)).status, 200)
    assert.equal(rowState(preview.actionId).state, 'cancelled')
  })

  await check('已在追番但状态或进度落后：同一张预览带上「改成在看 + 进度记到那一集」', async () => {
    const s = session(alice); seedTrack(alice, 430, { episode: 2, status: 'plan', total_episodes: 12 }); bindXifan(430, 9030)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 430, source: 'xifan', episode: 5 })
    assert.equal(preview.addsToTracks, true)
    assert.match(preview.impact, /改成在看、进度记到第 5 集/)
    const done = store.open(alice, preview.actionId)
    // 权威回读来自 tracks 本身，不是预览的复述
    assert.deepEqual(trackRow(alice, 430), { status: 'watching', episode: 5 })
    assert(done.url?.includes('ep=5'))
  })

  await check('进度已经领先时不改追番：只打开播放页', async () => {
    const s = session(alice); seedTrack(alice, 431, { episode: 9, status: 'watching', total_episodes: 12 }); bindXifan(431, 9031)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 431, source: 'xifan', episode: 5 })
    assert.equal(preview.addsToTracks, false)
    store.open(alice, preview.actionId)
    assert.deepEqual(trackRow(alice, 431), { status: 'watching', episode: 9 })
  })

  await check('预览这一层不打外站：周表定位挪到用户点击时，模型的 1 秒工具预算才够用', async () => {
    const s = session(alice); seedTrack(alice, 432, { episode: 4, total_episodes: 12 })
    locateResult = { candidates: [{ xifanId: 7788, xifanName: '夺还篇', score: 0.9 }] }
    const before = locateCalls.length
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 432, source: 'xifan', episode: 5 })
    // 生成预览期间一次周表请求都没发
    assert.equal(locateCalls.length, before)
    assert.equal(preview.target, 'source_search')
    assert.equal(preview.bindsSource, null)

    // 点「在这里找片源」才去打周表；分数够高就直接认下来，不用再挑
    const searched = await store.searchSource(alice, preview.actionId)
    assert.equal(locateCalls.length, before + 1)
    assert.deepEqual(searched.preview.bindsSource, { id: '7788', name: '夺还篇' })
    assert.equal(searched.preview.target, 'web_player')
    // 认下来了但还没落库：绑定表这时仍是空的
    assert.equal(db.prepare('SELECT COUNT(*) n FROM xifan_binding WHERE bgm_id=?').get(432).n, 0)

    const done = store.open(alice, preview.actionId)
    assert.deepEqual(bindCalls.at(-1), { bgmId: 432, id: '7788', name: '夺还篇' })
    assert(done.url?.includes('animeId=7788'))
    // 追番那一步照做
    assert.deepEqual(trackRow(alice, 432), { status: 'watching', episode: 5 })
  })

  await check('周表不通或匹配分不够：退到站内搜索，绝不写歪全局绑定', async () => {
    const s = session(alice); seedTrack(alice, 433, { episode: 1 })
    locateResult = new Error('周表 502')
    searchResult = { needsCaptcha: false, data: [{ xifanId: 61, xifanName: '搜出来的', note: '' }] }
    const a = store.prepare(alice, ctx(s.id), { bgmId: 433, source: 'xifan' }).preview
    const fell = await store.searchSource(alice, a.actionId)
    assert.equal(fell.preview.bindsSource, null)
    assert.deepEqual(fell.preview.sourceCandidates, [{ name: '搜出来的', note: '' }])

    seedTrack(alice, 434, { episode: 1 })
    locateResult = { candidates: [{ xifanId: 6, xifanName: '名字不像', score: 0.4 }] }
    const b = store.prepare(alice, ctx(s.id), { bgmId: 434, source: 'xifan' }).preview
    const weak = await store.searchSource(alice, b.actionId)
    assert.equal(weak.preview.bindsSource, null)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM xifan_binding WHERE bgm_id IN (433,434)').get().n, 0)
    locateResult = { candidates: [] }; searchResult = { needsCaptcha: false, data: [] }
  })

  await check('HTTP：要写全局绑定的动作同样不许走 GET', async () => {
    const s = session(alice); seedTrack(alice, 435, { episode: 1 })
    locateResult = { candidates: [{ xifanId: 7799, xifanName: '某番', score: 0.95 }] }
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 435, source: 'xifan' })
    assert.deepEqual((await store.searchSource(alice, preview.actionId)).preview.bindsSource, { id: '7799', name: '某番' })
    assert.equal((await call(`/actions/${preview.actionId}/open`, 'GET', undefined, aliceCookie)).status, 400)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM xifan_binding WHERE bgm_id=?').get(435).n, 0)
    locateResult = { candidates: [] }
  })

  await check('周表没匹配上：就地搜索 → 验证码 → 挑一个候选 → 确认打开', async () => {
    const s = session(alice); seedTrack(alice, 440, { episode: 1 })
    locateResult = { candidates: [] }
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 440, source: 'xifan', episode: 2 })
    assert.equal(preview.target, 'source_search')
    // 还没搜过：候选是 null（「没搜」），不是空数组（「搜过，没有」）
    assert.equal(preview.sourceCandidates, null)

    searchResult = { needsCaptcha: true }
    assert.equal((await store.searchSource(alice, preview.actionId)).needsCaptcha, true)
    const image = await store.captcha(alice, preview.actionId)
    assert.equal(image.mime, 'image/png')

    captchaOk = false
    assert.equal((await store.verifyCaptcha(alice, preview.actionId, '1234')).success, false)
    captchaOk = true
    searchResult = { needsCaptcha: false, data: [
      { xifanId: 5501, xifanName: '夺还篇', note: '05|周三' },
      { xifanId: 5502, xifanName: '夺还篇 合集', note: '2026' },
    ] }
    const verified = await store.verifyCaptcha(alice, preview.actionId, '8642')
    assert.equal(verified.success, true)
    // 候选只回名字与辅助信息，不回 xifanId：让客户端指定 id 就等于开放任意写全局绑定表
    assert.deepEqual(verified.preview.sourceCandidates, [
      { name: '夺还篇', note: '05|周三' }, { name: '夺还篇 合集', note: '2026' }])
    assert.equal(JSON.stringify(verified.preview).includes('5501'), false)

    const picked = store.pickSource(alice, preview.actionId, 0)
    assert.deepEqual(picked.preview.bindsSource, { id: '5501', name: '夺还篇' })
    assert.equal(picked.preview.target, 'web_player')
    const done = store.open(alice, preview.actionId)
    assert.deepEqual(bindCalls.at(-1), { bgmId: 440, id: '5501', name: '夺还篇' })
    assert(done.url?.includes('animeId=5501'))
    searchResult = { needsCaptcha: false, data: [] }
  })

  await check('挑选只认下标：越界、非整数与已终结的动作都拒绝', async () => {
    const s = session(alice); seedTrack(alice, 441, { episode: 1 })
    locateResult = { candidates: [] }
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 441, source: 'xifan' })
    searchResult = { needsCaptcha: false, data: [{ xifanId: 5601, xifanName: '某番', note: '' }] }
    await store.searchSource(alice, preview.actionId)
    for (const bad of [-1, 1, 1.5, Number.NaN]) throws(() => store.pickSource(alice, preview.actionId, bad), 'INVALID_ARGUMENT')
    store.cancel(alice, preview.actionId)
    // 已取消的动作不能再改认源，也不能再搜
    throws(() => store.pickSource(alice, preview.actionId, 0), 'ACTION_EXPIRED')
    await rejects(() => store.searchSource(alice, preview.actionId), 'ACTION_EXPIRED')
    searchResult = { needsCaptcha: false, data: [] }
  })

  await check('HTTP：认源四条接口只接受 POST，且跨账号一律拿不到', async () => {
    const s = session(alice); seedTrack(alice, 442, { episode: 1 })
    locateResult = { candidates: [] }
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 442, source: 'xifan' })
    searchResult = { needsCaptcha: false, data: [{ xifanId: 5701, xifanName: '某番', note: '' }] }
    const path = `/actions/${preview.actionId}`
    assert.equal((await call(`${path}/source-search`, 'GET', undefined, aliceCookie)).status, 404)
    assert.equal((await call(`${path}/source-search`, 'POST', {}, aliceCookie)).status, 200)
    assert.equal((await call(`${path}/captcha`, 'POST', {}, bobCookie)).status, 404)
    assert.equal((await call(`${path}/pick-source`, 'POST', { index: '0' }, aliceCookie)).status, 400)
    assert.equal((await call(`${path}/captcha/verify`, 'POST', { code: '' }, aliceCookie)).status, 400)
    assert.equal((await call(`${path}/pick-source`, 'POST', { index: 0 }, aliceCookie)).status, 200)
    // 认源写的是全局表，所以这条动作现在也不许走 GET open
    assert.equal((await call(`${path}/open`, 'GET', undefined, aliceCookie)).status, 400)
    searchResult = { needsCaptcha: false, data: [] }
  })

  await check('预览挂在真实消息上时，组合动作的追番那一步不去回写它没有的记录', async () => {
    const s = session(alice); seedTrack(alice, 450, { episode: 1, status: 'plan', total_episodes: 12 }); bindXifan(450, 9050)
    const { preview } = store.prepare(alice, ctx(s.id), { bgmId: 450, source: 'xifan', episode: 6 })
    assert.equal(preview.addsToTracks, true)
    const linked = (db.prepare('SELECT track_action_id FROM agent_playback_actions WHERE id=?').get(preview.actionId) as { track_action_id: string }).track_action_id

    // 复现真实形态：运行结束时助手消息带着**播放这一张卡**落库，播放动作挂上 messageId。
    // 组合动作只发一张卡，追番那条 act- 从不进这个列表 —— 所以它也绝不能带 messageId，
    // 否则 apply() 会去回写一条不在列表里的记录，抛「这条动作记录没有找到」。
    const revision = (history.snapshot(alice, s.id, { limit: 1 }).session as { revision: number }).revision
    const m = history.appendAssistant(alice, s.id, { requestId: randomUUID(), expectedRevision: revision,
      body: '预览', status: 'completed', sources: [], toolSummaries: [], usage: [],
      actions: [{ actionId: preview.actionId, kind: 'playback_open', state: 'prepared', evidence: 'preview',
        errorCode: null, eventSeq: 0, summary: preview.impact, updatedAt: clock, userReportedSuccess: false }] })
    const messageId = (m.message as { id: string }).id
    db.prepare('UPDATE agent_playback_actions SET message_id = ? WHERE id = ?').run(messageId, preview.actionId)
    assert.equal((db.prepare('SELECT message_id FROM agent_actions WHERE id=?').get(linked) as { message_id: string | null }).message_id, null)

    const done = store.open(alice, preview.actionId)
    assert.deepEqual(trackRow(alice, 450), { status: 'watching', episode: 6 })
    assert(done.url?.includes('ep=6'))
    // 播放这一条的回执确实回写进了消息（dispatch_started 按设计不回写，卡片走响应里的回执）
    const listed = JSON.parse((db.prepare('SELECT actions_json FROM agent_messages WHERE id=?').get(messageId) as { actions_json: string }).actions_json) as { actionId: string; state: string }[]
    assert.deepEqual(listed.map(a => [a.actionId, a.state]), [[preview.actionId, 'user_confirmed']])
    assert.equal(rowState(preview.actionId).state, 'dispatch_started')
  })

  settlePlan()

  console.log(JSON.stringify({ checks, failed: 0, realAiCalls: 0, sourceSiteRequests: 0, transport: 'direct-store-and-loopback-http', database: 'temporary-sqlite', productionDataTouched: false }))
} finally {
  await cleanup?.()
  process.chdir(cwd)
}
