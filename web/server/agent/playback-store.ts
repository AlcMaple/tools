// 阶段 8：播放打开「预览 → 用户点击 → 进入现有播放流程 → 事件回执」。
//
// Agent 的本分是替人按下他自己能按的那几个按钮，所以这里复用的全是网页上现成的入口：
// 改状态改进度走 PUT /api/tracks/:bgmId（阶段 7 已包成 proposeTrackChange），认片源走
// POST /api/xifan/locate + /bind，打开播放页走 GET /api/xifan/play-page。一次确认按序做完。
//
// 只解析、不擅自写：locate 打的是稀饭周表（免验证码、只读、不落库），拿到候选写进预览让用户看清；
// 真正落库的 bind 要等确认那一下——xifan_binding 是**全局表**，认错了全站用户都跟着错。
// 本文件做四件事：
//   1. prepare —— 读本地 track 与片源绑定，补齐追番变更与认源候选，落一条 prepared 回执
//   2. open / dispatch —— 用户点击那一下：认源 → 写追番 → 签发播放页地址
//   3. report —— 播放页把浏览器 / 播放器事件回报回来，逐级推进到 playing / completed
//
// 状态推进一律过 permitsActionTransition：事件名 → (state, origin) 的映射写死在服务端，
// 页面只能说「发生了什么」，不能自称「已完成」。跨域套娃 iframe 只能到 unknown，截图不算证据。
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { AgentRunError } from '../../shared/agent-run'
import { AGENT_TOOLS, type JsonValue, type ActionState, type PlaybackEvent } from '../../shared/agent-contracts'
import { permitsActionTransition } from './policy'
import { matchesContract } from './validation'
import { AgentHistoryStore } from './history-store'
import type { AgentActionStore } from './actions-store'
import type { ReadTool } from './run-service'

// 播放预览比追番变更更「此刻」：换集、换源后旧预览没有意义，6 小时足够跨过一次犹豫。
const ACTION_TTL_MS = 6 * 60 * 60_000
const MAX_OPEN_ACTIONS = 50
// 周表匹配低于这个分就不当成认源候选：宁可退回「去找片源」让用户自己挑，也不要把全局绑定写歪。
const BIND_MIN_SCORE = 0.75
const SOURCE_LABEL = { xifan: '稀饭', girigiri: 'Girigiri' } as const
export type PlaybackSource = keyof typeof SOURCE_LABEL
/** 稀饭周表匹配出来的一个候选。score 由 locate 打分，1 表示已绑定。 */
export interface SourceCandidate { xifanId: number; xifanName: string; score: number }
/** 站内搜索命中的一条片源。note 是给用户认人用的辅助信息（更新到第几集 / 年份 / 地区）。 */
export interface SourceHit { xifanId: number; xifanName: string; note: string }

// 事件 → 状态与证据来源。origin 由服务端决定，绝不取客户端传来的值。
// page_ready 是浏览器确实打开了我们的播放页；player_* 起是同源 <video> 的真实事件；
// cross_origin 表示已退到源站自己的 iframe，那之后我们读不到播放状态，只能标 unknown。
const EVENT_MAP: Record<PlaybackEvent, { state: ActionState; origin: 'browser' | 'player'; evidence: string }> = {
  page_ready: { state: 'navigation_committed', origin: 'browser', evidence: 'navigation' },
  player_ready: { state: 'player_ready', origin: 'player', evidence: 'player_event' },
  source_selected: { state: 'source_selected', origin: 'player', evidence: 'player_event' },
  media_canplay: { state: 'media_canplay', origin: 'player', evidence: 'player_event' },
  playing: { state: 'playing', origin: 'player', evidence: 'player_event' },
  watched: { state: 'completed', origin: 'player', evidence: 'player_event' },
  cross_origin: { state: 'unknown', origin: 'browser', evidence: 'navigation' },
  failed: { state: 'failed', origin: 'player', evidence: 'error' },
}

export function initializeAgentPlaybackSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_playback_actions (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, session_id TEXT NOT NULL, run_id TEXT, message_id TEXT,
    bgm_id INTEGER NOT NULL, source TEXT NOT NULL CHECK(source IN ('xifan','girigiri')),
    episode INTEGER NOT NULL, title TEXT NOT NULL, target TEXT NOT NULL CHECK(target IN ('web_player','source_search')),
    bound_id TEXT, impact TEXT NOT NULL, token_version INTEGER NOT NULL, knowledge_version TEXT NOT NULL,
    track_action_id TEXT, bind_source_id TEXT, bind_source_name TEXT, source_candidates TEXT,
    state TEXT NOT NULL DEFAULT 'prepared', evidence TEXT NOT NULL DEFAULT 'preview', error_code TEXT,
    event_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    FOREIGN KEY(user_id, session_id) REFERENCES agent_sessions(user_id, id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS agent_playback_owner ON agent_playback_actions(user_id, session_id);`)
  // 阶段 8 首版建过这张表的库里没有 track_action_id，CREATE TABLE IF NOT EXISTS 不会补列。
  const columns = (db.prepare('PRAGMA table_info(agent_playback_actions)').all() as { name: string }[]).map(c => c.name)
  for (const [name, type] of [['track_action_id', 'TEXT'], ['bind_source_id', 'TEXT'], ['bind_source_name', 'TEXT'], ['source_candidates', 'TEXT']]) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE agent_playback_actions ADD COLUMN ${name} ${type}`)
  }
}

interface PlaybackRow {
  id: string; user_id: number; session_id: string; run_id: string | null; message_id: string | null
  bgm_id: number; source: PlaybackSource; episode: number; title: string; target: 'web_player' | 'source_search'
  bound_id: string | null; impact: string; token_version: number; knowledge_version: string; track_action_id: string | null
  bind_source_id: string | null; bind_source_name: string | null; source_candidates: string | null
  state: string; evidence: string; error_code: string | null; event_seq: number
  created_at: number; updated_at: number; expires_at: number
}
export interface PlaybackPreview {
  actionId: string; bgmId: number; kind: 'playback_open'; expiresAt: number; impact: string
  title: string; source: PlaybackSource; episode: number; target: 'web_player' | 'source_search'; addsToTracks: boolean
  // 认源那一步：番剧还没绑过片源时，预览里带上周表匹配到的候选，让用户在同一张卡上看清要绑哪个。
  bindsSource: { id: string; name: string } | null
  // 周表没匹配上时，用户可以就地发起站内搜索。搜到的候选留在服务端，卡片按下标挑选 ——
  // 让客户端直接把 id 传回来就等于让任何人往全局绑定表里写任意值。
  sourceCandidates: { name: string; note: string }[] | null
}
export interface PlaybackReceiptView {
  actionId: string; kind: 'playback_open'; state: string; evidence: string; errorCode: string | null
  eventSeq: number; updatedAt: number; expiresAt: number
}

const previewView = (r: PlaybackRow): PlaybackPreview => ({
  actionId: r.id, bgmId: r.bgm_id, kind: 'playback_open', expiresAt: r.expires_at, impact: r.impact,
  title: r.title, source: r.source, episode: r.episode, target: r.target, addsToTracks: r.track_action_id !== null,
  bindsSource: r.bind_source_id ? { id: r.bind_source_id, name: r.bind_source_name ?? '' } : null,
  sourceCandidates: r.source_candidates === null ? null : parseCandidates(r.source_candidates).map(h => ({ name: h.xifanName, note: h.note })),
})
const receiptView = (r: PlaybackRow): PlaybackReceiptView => ({
  actionId: r.id, kind: 'playback_open', state: r.state, evidence: r.evidence, errorCode: r.error_code,
  eventSeq: r.event_seq, updatedAt: r.updated_at, expiresAt: r.expires_at,
})
const parseCandidates = (raw: string | null): SourceHit[] => {
  if (!raw) return []
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v as SourceHit[] : [] } catch { return [] }
}
const parseAliases = (raw: string | undefined): string[] => {
  if (!raw) return []
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [] } catch { return [] }
}
const terminal = (state: string) => ['completed', 'failed', 'cancelled', 'unknown'].includes(state)

export class AgentPlaybackStore {
  private readonly history: AgentHistoryStore
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now,
    private readonly knowledgeVersion: (uid: number) => string,
    // 组合动作用它生成并执行「先加入追番」那一步；追番的字段白名单、revision、回读全部照阶段 7 原样走。
    private readonly actions?: AgentActionStore,
    // 认源用的两个既有能力，由 run-runtime 注入而不在本文件里 import：store 保持可离线单测，
    // 「哪些外站请求允许发生」也就只在组装根一处可查。
    private readonly sources?: {
      locate(bgmId: number, titles: string[]): Promise<{ bound?: SourceCandidate; candidates: SourceCandidate[] }>
      bind(bgmId: number, id: string, name: string): void
      // 站内搜索走用户自己的源站会话，可能要先过验证码；三个方法都只透传，不在这里解码或识别图片。
      search(uid: number, keyword: string): Promise<{ needsCaptcha: true } | { needsCaptcha: false; data: SourceHit[] }>
      captcha(uid: number): Promise<{ imageB64: string; mime: string }>
      verifyCaptcha(uid: number, code: string): Promise<{ success: boolean }>
    }) {
    this.history = new AgentHistoryStore(db)
  }
  private account(uid: number) {
    const row = this.db.prepare('SELECT token_version FROM users WHERE id = ?').get(uid) as { token_version: number } | undefined
    if (!row) throw new AgentRunError('AUTH_REQUIRED', 401)
    return row
  }
  // 片源绑定是全局事实（见 server/db.ts 建表注释），不按用户分；没绑过就是没绑过，不联网去认。
  private binding(source: PlaybackSource, bgmId: number): string | null {
    const row = source === 'xifan'
      ? this.db.prepare('SELECT xifan_id AS id FROM xifan_binding WHERE bgm_id = ?').get(bgmId) as { id: number } | undefined
      : this.db.prepare('SELECT girigiri_id AS id FROM girigiri_binding WHERE bgm_id = ?').get(bgmId) as { id: string } | undefined
    return row ? String(row.id) : null
  }
  private sessionRevision(uid: number, sessionId: string): number {
    const row = this.db.prepare('SELECT revision FROM agent_sessions WHERE user_id = ? AND id = ?').get(uid, sessionId) as { revision: number } | undefined
    if (!row) throw new AgentRunError('NOT_FOUND', 404)
    return row.revision
  }

  /**
   * 模型工具入口：只读本地库，不发任何外站请求，也不打开任何页面。
   * 这一层必须快 —— 它跑在模型的工具预算里（proposePlaybackOpen: 1s）。
   */
  prepare(uid: number, ctx: { sessionId: string; runId: string; messageId: string | null }, args: Record<string, JsonValue>): { preview: PlaybackPreview } {
    if (!matchesContract(AGENT_TOOLS.proposePlaybackOpen.parameters, args)) throw new AgentRunError('INVALID_ARGUMENT', 400)
    if (!this.db.prepare('SELECT 1 FROM agent_sessions WHERE user_id = ? AND id = ?').get(uid, ctx.sessionId)) throw new AgentRunError('AUTH_REQUIRED', 401)
    const account = this.account(uid)
    const bgmId = Number(args.bgmId), source = String(args.source) as PlaybackSource
    // 「继续看」只长在追番卡片上。番剧还不在追番里时**不报错**：把「先加入追番」挂进同一张预览，
    // 用户点一次按顺序执行。以前这里直接 NOT_FOUND，模型会改调 proposeTrackChange 再回头重试，
    // 一轮里反复试探，最后并排甩出两张一模一样的待确认卡。
    const track = this.db.prepare('SELECT bgm_id, title, title_cn, status, episode, total_episodes, aliases FROM tracks WHERE user_id = ? AND bgm_id = ?')
      .get(uid, bgmId) as { title: string; title_cn: string; status: string; episode: number; total_episodes: number | null; aliases: string } | undefined
    const open = (this.db.prepare("SELECT COUNT(*) AS n FROM agent_playback_actions WHERE user_id = ? AND session_id = ? AND state = 'prepared'").get(uid, ctx.sessionId) as { n: number }).n
    if (open >= MAX_OPEN_ACTIONS) throw new AgentRunError('QUOTA_EXCEEDED', 429)

    const total = track && track.total_episodes !== null ? Number(track.total_episodes) : null
    // 模型没给集数就沿用页面「继续看」的算法：当前进度那一集，封顶总集数，至少第 1 集。
    const wanted = args.episode !== undefined ? Number(args.episode) : Number(track?.episode) || 1
    const episode = Math.max(1, total !== null && total > 0 ? Math.min(total, wanted) : wanted)
    const boundId = this.binding(source, bgmId)
    const label = SOURCE_LABEL[source]

    // 与追番变更同理：同一会话里同番、同源、同集且仍在等确认的预览直接复用，不重复发卡。
    const twin = this.db.prepare(`SELECT id FROM agent_playback_actions WHERE user_id = ? AND session_id = ? AND state = 'prepared'
      AND expires_at > ? AND bgm_id = ? AND source = ? AND episode = ? ORDER BY created_at DESC LIMIT 1`)
      .get(uid, ctx.sessionId, this.now(), bgmId, source, episode) as { id: string } | undefined
    if (twin) return { preview: previewView(this.row(uid, twin.id)) }

    // 追番那一步照阶段 7 原样生成（离线元数据、字段白名单、revision、确认凭证都不另起一套）。
    // 番剧不在追番里就加；已经在但状态或进度落后于用户这次要看的集数，就一并改到位 ——
    // 「我要看最新一集」在人的操作里本来就等于「点在看、把进度拖到那一集、再点继续看」。
    let trackActionId: string | null = null
    let title = track ? String(track.title_cn || track.title || `条目 #${bgmId}`).slice(0, 200) : ''
    let trackStep = ''
    // 这一步**不挂在消息上**（messageId 传 null）：组合动作只发播放这一张卡，追番那条从不登记进
    // 消息的 actions_json。带上 messageId 的话，apply() 会去回写一条根本不在列表里的记录，
    // 直接抛「这条动作记录没有找到」——它的回执改走 open() 的响应，由客户端就地更新。
    const linkedCtx = { ...ctx, messageId: null }
    if (!track) {
      if (!this.actions) throw new AgentRunError('NOT_FOUND', 404)
      const added = this.actions.prepare(uid, linkedCtx, { bgmId, change: { kind: 'add', fields: { status: 'watching', episode } } }).preview
      trackActionId = added.actionId
      title = added.after.title
      trackStep = `先把《${title}》加入追番（在看 · 进度 ${episode}），再`
    } else if (this.actions && (track.status !== 'watching' || Number(track.episode) < episode)) {
      const updated = this.actions.prepare(uid, linkedCtx, { bgmId, change: { kind: 'update', fields: { status: 'watching', episode } } }).preview
      trackActionId = updated.actionId
      trackStep = `先把《${title}》改成在看、进度记到第 ${episode} 集，再`
    }

    // 认源**不在这里做**。周表定位实测要 7 秒上下，而 proposePlaybackOpen 的工具预算是 1 秒：
    // 放在模型这一轮里必然 TIMEOUT，整条提案连预览都生成不出来。没绑过片源就照旧给
    // 「去找片源」，由卡片上的认源面板在用户点击时去打周表（见 searchSource）——
    // 慢的那一步移到用户手势里，有明确的等待反馈，也不占模型的轮次预算。
    const impact = boundId !== null
      ? `${trackStep}打开${label}的《${title}》第 ${episode} 集播放页`
      : `${trackStep}去${label}找《${title}》的片源，认好后打开第 ${episode} 集`

    const id = 'pb-' + randomUUID(), created = this.now()
    this.db.prepare(`INSERT INTO agent_playback_actions
      (id, user_id, session_id, run_id, message_id, bgm_id, source, episode, title, target, bound_id, impact, token_version, knowledge_version, track_action_id, bind_source_id, bind_source_name, created_at, updated_at, expires_at)
      VALUES (@id, @user_id, @session_id, @run_id, @message_id, @bgm_id, @source, @episode, @title, @target, @bound_id, @impact, @token_version, @knowledge_version, @track_action_id, @bind_source_id, @bind_source_name, @created_at, @updated_at, @expires_at)`).run({
      id, user_id: uid, session_id: ctx.sessionId, run_id: ctx.runId, message_id: ctx.messageId, bgm_id: bgmId,
      source, episode, title, target: boundId !== null ? 'web_player' : 'source_search', bound_id: boundId, impact,
      token_version: account.token_version,
      knowledge_version: this.knowledgeVersion(uid), track_action_id: trackActionId,
      bind_source_id: null, bind_source_name: null,
      created_at: created, updated_at: created, expires_at: created + ACTION_TTL_MS,
    })
    return { preview: previewView(this.row(uid, id)) }
  }

  private row(uid: number, actionId: string): PlaybackRow {
    const row = this.db.prepare('SELECT * FROM agent_playback_actions WHERE user_id = ? AND id = ?').get(uid, actionId) as PlaybackRow | undefined
    if (!row) throw new AgentRunError('NOT_FOUND', 404)
    return row
  }
  /** owner 身份取回预览。播放不需要写入凭证：真正的执行在用户自己的浏览器里。 */
  detail(uid: number, actionId: string) {
    const r = this.row(uid, actionId)
    return { action: receiptView(r), preview: previewView(r), openable: r.state === 'prepared' && r.expires_at > this.now() }
  }

  private syncMessage(uid: number, r: PlaybackRow, state: string, evidence: string, errorCode: string | null): number {
    const seq = r.event_seq + 1
    if (r.message_id) {
      try {
        this.history.updateActionSummary(uid, r.session_id, r.message_id, {
          expectedRevision: this.sessionRevision(uid, r.session_id),
          action: { actionId: r.id, kind: 'playback_open', state: state as never, eventSeq: seq, updatedAt: this.now(),
            evidence: evidence as never, errorCode: errorCode as never, userReportedSuccess: false, summary: r.impact },
        })
      } catch (error) {
        // 权威回执以 agent_playback_actions 为准；聊天卡片同步失败不影响用户已经在看的那一集。
        if (!(error instanceof Error) || !/REVISION_CONFLICT|ACTION_RECEIPT_CONFLICT|NOT_FOUND|MESSAGE/.test(error.message)) throw error
      }
    }
    return seq
  }
  private advance(uid: number, r: PlaybackRow, to: ActionState, origin: 'server' | 'user_click' | 'browser' | 'player',
    evidence: string, errorCode: string | null, sync: boolean): PlaybackRow {
    if (!permitsActionTransition('playback_open', r.state as ActionState, to, { origin, crossOrigin: false })) throw new AgentRunError('INTERNAL_ERROR', 409)
    // 中间态（player_ready / source_selected / media_canplay）只更权威回执，不逐条改写聊天卡片：
    // 每次改写都会顶一次 session revision，一集播放能顶出五六次，前端反而看不清。
    const seq = sync ? this.syncMessage(uid, r, to, evidence, errorCode) : r.event_seq + 1
    this.db.prepare('UPDATE agent_playback_actions SET state = ?, evidence = ?, error_code = ?, event_seq = ?, updated_at = ? WHERE user_id = ? AND id = ?')
      .run(to, evidence, errorCode, seq, this.now(), uid, r.id)
    return this.row(uid, r.id)
  }
  private assertOpenable(uid: number, r: PlaybackRow): void {
    if (r.state !== 'prepared') throw new AgentRunError('ACTION_EXPIRED', 409)
    if (this.now() > r.expires_at) { this.expire(uid, r); throw new AgentRunError('ACTION_EXPIRED', 409) }
    if (this.account(uid).token_version !== r.token_version) throw new AgentRunError('AUTH_REQUIRED', 401)
    if (this.knowledgeVersion(uid) !== r.knowledge_version) throw new AgentRunError('CAPABILITY_CHANGED', 409)
  }

  /**
   * 用户点了确认那一下。两种目标各自的下一步：
   * - web_player：已认过片源，返回同源播放页地址，由调用方在用户手势内打开新标签
   * - source_search：还没认片源，返回导航意图，前端把用户送进既有的「继续看 → 选片源」弹窗
   */
  open(uid: number, actionId: string) {
    const pre = this.row(uid, actionId)
    this.assertOpenable(uid, pre)
    // 第一步：认源。全局表写在追番之前 —— 它是后面两步的前提（没有 xifan_id 就签不出播放页地址），
    // 而且失败时还没有任何用户数据被改动。这里不再匹配一次：绑的就是预览上给用户看过的那个候选。
    if (pre.bind_source_id && !this.binding(pre.source, pre.bgm_id)) {
      if (!this.sources) throw new AgentRunError('CAPABILITY_CHANGED', 409)
      this.sources.bind(pre.bgm_id, pre.bind_source_id, pre.bind_source_name ?? '')
    }
    // 第二步：组合动作里的「加入追番 / 改状态改进度」。走阶段 7 原来那条执行路径（事务、前置 revision、
    // 权威回读一个不少），凭证只在服务端之间传递，从不进模型也不进 URL。
    // 写失败就整个停在这里：宁可没打开播放页，也不要写了一半还宣布成功。
    let track: ReturnType<AgentActionStore['apply']> | null = null
    if (pre.track_action_id && this.actions) {
      const linked = this.actions.detail(uid, pre.track_action_id)
      if (linked.action.state === 'prepared') {
        if (!linked.confirmationToken) throw new AgentRunError('ACTION_EXPIRED', 409)
        track = this.actions.apply(uid, pre.track_action_id, { requestId: `playback:${pre.id}`,
          expectedRevision: linked.preview.expectedRevision, confirmationToken: linked.confirmationToken })
      } else if (linked.action.state !== 'completed') throw new AgentRunError('ACTION_EXPIRED', 409)
    }
    const confirmed = this.advance(uid, pre, 'user_confirmed', 'user_click', 'user_click', null, true)
    // dispatch_started 的证据来源按目标区分：同源播放页是服务端签发地址，找片源是浏览器自己跳转。
    const started = this.advance(uid, confirmed, 'dispatch_started', pre.target === 'web_player' ? 'server' : 'browser',
      pre.target === 'web_player' ? 'user_click' : 'navigation', null, false)
    // 播放页地址按刚认下的绑定重算：预览生成时 bound_id 还是空的。
    const bound = pre.target === 'web_player' ? { ...pre, bound_id: pre.bound_id ?? pre.bind_source_id } : pre
    return {
      action: receiptView(started), preview: previewView(started),
      url: pre.target === 'web_player' ? playPageUrl(bound) : null,
      navigate: pre.target === 'source_search' ? { view: 'source_search' as const, bgmId: pre.bgm_id, source: pre.source } : null,
      // 追番那一步的权威回执一并返回：客户端据此就地更新那张卡与 revision，不必再拉快照。
      track: track ? { action: track.action, track: track.track } : null,
      session: this.session(uid, pre.session_id),
    }
  }

  // ── 就地认源：周表没匹配上时，用户在卡片里搜、过验证码、挑一个 ─────────────────────
  //
  // 验证码本来就是「证明此刻有个人在」，所以这段全程绕开模型：图片直接进聊天卡片，
  // 用户输入的数字由浏览器发到我们服务端、再转给源站会话（xifanSessionFor(uid) 的 cookie 罐）。
  // 模型既看不到图也拿不到数字，它只知道「这一步用户自己做完了」。
  private editable(uid: number, actionId: string): PlaybackRow {
    const r = this.row(uid, actionId)
    this.assertOpenable(uid, r)
    if (!this.sources) throw new AgentRunError('CAPABILITY_CHANGED', 409)
    return r
  }

  /**
   * 用户点「在这里找片源」那一下。两级：
   *   1. 周表定位 —— 精确、免验证码，当季新番一步到位（慢，7 秒上下，所以只在这里做）
   *   2. 站内搜索 —— 周表里没有的老番才走，可能要过验证码
   */
  async searchSource(uid: number, actionId: string) {
    const r = this.editable(uid, actionId)
    if (r.source === 'xifan') {
      const t = this.db.prepare('SELECT title, title_cn, aliases FROM tracks WHERE user_id = ? AND bgm_id = ?')
        .get(uid, r.bgm_id) as { title: string; title_cn: string; aliases: string } | undefined
      const titles = [r.title, t?.title_cn ?? '', t?.title ?? ''].concat(parseAliases(t?.aliases)).map(x => x.trim()).filter(Boolean)
      try {
        const located = await this.sources!.locate(r.bgm_id, [...new Set(titles)])
        const pick = located.bound ?? located.candidates[0]
        // 分数够高就直接认下来，用户不必再从一堆同名里挑
        if (pick && pick.score >= BIND_MIN_SCORE) {
          return { needsCaptcha: false as const, preview: this.setBind(uid, r, String(pick.xifanId), String(pick.xifanName || '')) }
        }
      } catch { /* 周表不通就退到站内搜索，别把整条认源堵死 */ }
    }
    const found = await this.sources!.search(uid, r.title)
    if (found.needsCaptcha) return { needsCaptcha: true as const, preview: previewView(r) }
    return { needsCaptcha: false as const, preview: this.rememberCandidates(uid, r, found.data) }
  }

  /** 取一张新验证码图。每取一张源站会把旧的作废，所以取图这件事本身是有副作用的写操作。 */
  async captcha(uid: number, actionId: string) {
    this.editable(uid, actionId)
    return this.sources!.captcha(uid)
  }

  /** 校验用户输入的验证码；过了就顺手把搜索结果一并带回，省掉用户再点一次。 */
  async verifyCaptcha(uid: number, actionId: string, code: string) {
    const r = this.editable(uid, actionId)
    if (!code.trim() || code.length > 32) throw new AgentRunError('INVALID_ARGUMENT', 400)
    const { success } = await this.sources!.verifyCaptcha(uid, code.trim())
    if (!success) return { success: false as const, preview: previewView(r) }
    const found = await this.sources!.search(uid, r.title)
    // 刚过完验证码又被要求验证码：源站没认账，别把它说成搜不到。
    if (found.needsCaptcha) throw new AgentRunError('INTERNAL_ERROR', 503)
    return { success: true as const, preview: this.rememberCandidates(uid, r, found.data) }
  }

  /**
   * 用户在候选里挑了一个。**按下标挑**，不接受客户端传回 id 或名字 ——
   * xifan_binding 是全局表，让调用方指定值就等于开放任意写入。
   * 这里仍然只是改预览：真正落库还是在 open() 那一下。
   */
  pickSource(uid: number, actionId: string, index: number) {
    const r = this.editable(uid, actionId)
    const list = parseCandidates(r.source_candidates)
    if (!Number.isSafeInteger(index) || index < 0 || index >= list.length) throw new AgentRunError('INVALID_ARGUMENT', 400)
    const pick = list[index]
    return { preview: this.setBind(uid, r, String(pick.xifanId), pick.xifanName) }
  }

  /** 认源候选落到动作上：只改预览与文案，绑定表要等 open() 那一下才写。 */
  private setBind(uid: number, r: PlaybackRow, id: string, name: string): PlaybackPreview {
    const impact = r.impact.replace(/去.+?找.+?的片源，认好后打开/, `认源到${SOURCE_LABEL[r.source]}的「${name}」，打开`)
    this.db.prepare(`UPDATE agent_playback_actions SET bind_source_id = ?, bind_source_name = ?, target = 'web_player',
      impact = ?, updated_at = ? WHERE user_id = ? AND id = ?`)
      .run(id, name.slice(0, 200), impact, this.now(), uid, r.id)
    return previewView(this.row(uid, r.id))
  }

  private rememberCandidates(uid: number, r: PlaybackRow, hits: SourceHit[]): PlaybackPreview {
    const list = hits.slice(0, 12).map(h => ({ xifanId: Number(h.xifanId), xifanName: String(h.xifanName).slice(0, 200), note: String(h.note ?? '').slice(0, 60) }))
      .filter(h => Number.isSafeInteger(h.xifanId) && h.xifanId > 0 && h.xifanName)
    this.db.prepare('UPDATE agent_playback_actions SET source_candidates = ?, updated_at = ? WHERE user_id = ? AND id = ?')
      .run(JSON.stringify(list), this.now(), uid, r.id)
    return previewView(this.row(uid, r.id))
  }

  /** 播放页回报。事件不合当前状态（重放、乱序、已终结）不算错误：原样返回权威回执。 */
  report(uid: number, actionId: string, event: PlaybackEvent, detail: string) {
    const pre = this.row(uid, actionId)
    const mapped = EVENT_MAP[event]
    if (!mapped || terminal(pre.state)) return { action: receiptView(pre), applied: false }
    if (!permitsActionTransition('playback_open', pre.state as ActionState, mapped.state, { origin: mapped.origin, crossOrigin: false })) {
      return { action: receiptView(pre), applied: false }
    }
    // 只有「真的看起来了 / 出了问题 / 退到跨域套娃」值得回到聊天卡片上。
    const sync = ['navigation_committed', 'playing', 'completed', 'failed', 'unknown'].includes(mapped.state)
    const errorCode = mapped.state === 'failed' ? 'INTERNAL_ERROR' : null
    const next = this.advance(uid, pre, mapped.state, mapped.origin, mapped.evidence, errorCode, sync)
    if (detail) console.log(`[agent] 播放回执 ${actionId} ${event} → ${mapped.state}：${detail.slice(0, 200)}`)
    return { action: receiptView(next), applied: true }
  }

  cancel(uid: number, actionId: string) {
    const r = this.row(uid, actionId)
    if (r.state === 'cancelled') return { action: receiptView(r), session: this.session(uid, r.session_id) }
    if (r.state !== 'prepared') throw new AgentRunError('ACTION_EXPIRED', 409)
    // 取消组合动作时把「先加入追番」那一步一并作废，别在手帐里留一张没人认领的待确认卡。
    if (r.track_action_id && this.actions) {
      try { this.actions.cancel(uid, r.track_action_id, {}) } catch { /* 已终结或已被单独取消：忽略 */ }
    }
    const next = this.advance(uid, r, 'cancelled', 'user_click', 'user_click', null, true)
    return { action: receiptView(next), session: this.session(uid, r.session_id) }
  }
  private session(uid: number, sessionId: string) { return this.history.snapshot(uid, sessionId, { limit: 1 }).session }
  private expire(uid: number, r: PlaybackRow) {
    if (r.state !== 'prepared') return
    const seq = this.syncMessage(uid, r, 'cancelled', 'error', 'ACTION_EXPIRED')
    this.db.prepare("UPDATE agent_playback_actions SET state = 'cancelled', evidence = 'error', error_code = 'ACTION_EXPIRED', event_seq = ?, updated_at = ? WHERE user_id = ? AND id = ?")
      .run(seq, this.now(), uid, r.id)
  }
}

/** 同源播放页地址；与 src/api.ts 的 playPageUrl / girigiriPlayPageUrl 保持同一份拼法。 */
function playPageUrl(r: PlaybackRow): string {
  const query = new URLSearchParams({ animeId: r.bound_id ?? '', ep: String(r.episode), bgmId: String(r.bgm_id), agentAction: r.id })
  return `/api/${r.source}/play-page?${query.toString()}`
}

/** run-runtime 注册的 proposal 工具。身份固定绑定服务端会话，不接受模型账号参数。 */
export function proposePlaybackOpenTool(store: AgentPlaybackStore, uid: number, sessionId: string): ReadTool {
  return {
    name: 'proposePlaybackOpen',
    async execute(args, actor) {
      if (actor.signal.aborted) return { ok: false, code: 'CANCELLED', message: '已取消。', retryable: false }
      if (actor.uid !== uid) return { ok: false, code: 'AUTH_REQUIRED', message: '账号状态已变化。', retryable: false }
      try {
        const { preview } = await store.prepare(uid, { sessionId, runId: actor.runId ?? '', messageId: actor.messageId ?? null }, args)
        return { ok: true, data: preview, sources: [], resultCount: 1, truncated: false }
      } catch (error) {
        const code = error instanceof AgentRunError ? error.code : 'INTERNAL_ERROR'
        return {
          ok: false,
          code: ['INVALID_ARGUMENT', 'AUTH_REQUIRED', 'NOT_FOUND', 'QUOTA_EXCEEDED'].includes(code) ? code : 'INTERNAL_ERROR',
          message: code === 'NOT_FOUND' ? '这部番还不在追番里，没有继续看的入口。' : '这次预览没有生成。',
          retryable: false,
        }
      }
    },
  }
}
