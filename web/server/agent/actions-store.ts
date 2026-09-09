// 阶段 7：追番变更「预览 → 用户点击确认 → 执行 → 权威回读」。
//
// 预览由模型通过 `proposeTrackChange` 工具触发，但确认凭证（confirmToken）永不进入模型：
// 它只随权威回执存库，前端用 owner 身份的 REST 接口取回。执行链路完全独立于模型循环，
// 服务端重新绑定账号、字段白名单、前置 revision、期限、幂等与事务回读，任何一步不符即拒。
import type Database from 'better-sqlite3'
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import { isRecentAir } from '../../shared/anime-age'
import { epsOf, openOfflineIndex } from '../bgm/anime-index'
import { AgentRunError } from '../../shared/agent-run'
import { AGENT_TOOLS, TRACK_STATUSES, type JsonValue } from '../../shared/agent-contracts'
import { permitsActionTransition } from './policy'
import { matchesContract } from './validation'
import { AgentHistoryStore } from './history-store'
import type { ReadTool } from './run-service'

// 预览等用户点确认，切走标签页、去核对番剧再回来都算正常，别 10 分钟就废。
// 真正的防串改是 apply 时的 revision 校验：期间追番被改过，apply 报 REVISION_CONFLICT 重新预览。
const ACTION_TTL_MS = 24 * 60 * 60_000
const MAX_OPEN_ACTIONS = 50
const USER_TAG_MAX_LEN = 20
const USER_TAG_MAX_COUNT = 12
const STATUS_LABEL: Record<(typeof TRACK_STATUSES)[number], string> = { watching: '在看', plan: '想看', considering: '观望', done: '看完' }

export function initializeAgentActionSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_actions (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, session_id TEXT NOT NULL, run_id TEXT, message_id TEXT,
    bgm_id INTEGER NOT NULL, change_kind TEXT NOT NULL CHECK(change_kind IN ('add','update')),
    before_json TEXT, after_json TEXT NOT NULL, impact TEXT NOT NULL,
    expected_revision INTEGER NOT NULL, actual_revision INTEGER,
    confirm_token TEXT NOT NULL, token_version INTEGER NOT NULL, knowledge_version TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'prepared', evidence TEXT NOT NULL DEFAULT 'preview', error_code TEXT,
    event_seq INTEGER NOT NULL DEFAULT 0, apply_request_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    FOREIGN KEY(user_id, session_id) REFERENCES agent_sessions(user_id, id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS agent_actions_owner ON agent_actions(user_id, session_id);`)
}

interface ActionRow {
  id: string; user_id: number; session_id: string; run_id: string | null; message_id: string | null
  bgm_id: number; change_kind: 'add' | 'update'; before_json: string | null; after_json: string; impact: string
  expected_revision: number; actual_revision: number | null; confirm_token: string; token_version: number; knowledge_version: string
  state: string; evidence: string; error_code: string | null; event_seq: number; apply_request_id: string | null
  created_at: number; updated_at: number; expires_at: number
}
export interface TrackView { bgmId: number; title: string; status: string; episode: number; userTags: string[] }
export interface TrackPreview {
  actionId: string; bgmId: number; kind: 'track_change'; expiresAt: number; impact: string
  expectedRevision: number; before: TrackView | null; after: TrackView
}
export interface ActionReceiptView {
  actionId: string; kind: 'track_change'; state: string; evidence: string; errorCode: string | null
  eventSeq: number; updatedAt: number; expiresAt: number; expectedRevision: number; actualRevision: number | null
}

const parseList = (s: string | null): string[] => {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] } catch { return [] }
}
const trackView = (r: Record<string, unknown>): TrackView => ({
  bgmId: Number(r.bgm_id), title: String(r.title_cn || r.title || `条目 #${r.bgm_id}`).slice(0, 200),
  status: String(r.status), episode: Number(r.episode) || 0, userTags: parseList(r.user_tags as string),
})
const receiptView = (r: ActionRow): ActionReceiptView => ({
  actionId: r.id, kind: 'track_change', state: r.state, evidence: r.evidence, errorCode: r.error_code,
  eventSeq: r.event_seq, updatedAt: r.updated_at, expiresAt: r.expires_at, expectedRevision: r.expected_revision, actualRevision: r.actual_revision,
})
const terminal = (state: string) => ['completed', 'failed', 'cancelled', 'unknown'].includes(state)

function normalizeTags(input: JsonValue | undefined): string[] {
  if (!Array.isArray(input)) throw new AgentRunError('INVALID_ARGUMENT', 400)
  const tags = [...new Set(input.filter((t): t is string => typeof t === 'string').map(t => t.trim()).filter(Boolean))]
  if (tags.length !== input.length || tags.length > USER_TAG_MAX_COUNT || tags.some(t => [...t].length > USER_TAG_MAX_LEN)) throw new AgentRunError('INVALID_ARGUMENT', 400)
  return tags
}

type OfflineMeta = { title: string; titleCn: string; airDate: string }

export class AgentActionStore {
  private readonly history: AgentHistoryStore
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now,
    private readonly knowledgeVersion: (uid: number) => string) {
    this.history = new AgentHistoryStore(db)
  }
  private account(uid: number) {
    const row = this.db.prepare('SELECT token_version, tracks_rev FROM users WHERE id = ?').get(uid) as { token_version: number; tracks_rev: number } | undefined
    if (!row) throw new AgentRunError('AUTH_REQUIRED', 401)
    return row
  }
  private track(uid: number, bgmId: number) {
    return this.db.prepare('SELECT bgm_id, title, title_cn, status, episode, total_episodes, user_tags, air_date FROM tracks WHERE user_id = ? AND bgm_id = ?').get(uid, bgmId) as Record<string, unknown> | undefined
  }
  // 离线元数据：只读离线索引 → 本地补充表（含 dev 借用与用户从在线搜索加过的条目）→
  // 当前会话由用户主动带入的页面资料。绝不联网。查不到返回 null。
  private resolveOffline(bgmId: number, uid: number, sessionId: string): OfflineMeta | null {
    const index = openOfflineIndex()
    if (index) {
      try {
        const cols = (index.prepare('PRAGMA table_info(anime)').all() as { name: string }[]).map(c => c.name)
        if (cols.includes('name')) {
          const row = index.prepare('SELECT name, name_cn, date FROM anime WHERE bgm_id = ?').get(bgmId) as { name?: string; name_cn?: string; date?: string } | undefined
          if (row?.name) return { title: row.name, titleCn: row.name_cn ?? '', airDate: row.date ?? '' }
        }
      } catch { /* 索引损坏时继续走后备来源 */ }
    }
    const add = this.db.prepare('SELECT name, name_cn, date FROM bgm_search_additions WHERE bgm_id = ?').get(bgmId) as { name?: string; name_cn?: string; date?: string } | undefined
    if (add && (add.name || add.name_cn)) return { title: add.name || '', titleCn: add.name_cn || '', airDate: add.date || '' }
    const session = this.db.prepare('SELECT current_bgm_id, page_context_json FROM agent_sessions WHERE user_id = ? AND id = ?').get(uid, sessionId) as { current_bgm_id: number | null; page_context_json: string | null } | undefined
    if (session?.current_bgm_id === bgmId && session.page_context_json) {
      try {
        const page = JSON.parse(session.page_context_json) as { bgmId?: number; title?: string; titleCn?: string }
        if (page.bgmId === bgmId && typeof page.title === 'string' && page.title.trim()) {
          return { title: page.title, titleCn: typeof page.titleCn === 'string' ? page.titleCn : '', airDate: '' }
        }
      } catch { /* 页面资料损坏时忽略 */ }
    }
    return null
  }
  private sessionRevision(uid: number, sessionId: string): number {
    const row = this.db.prepare('SELECT revision FROM agent_sessions WHERE user_id = ? AND id = ?').get(uid, sessionId) as { revision: number } | undefined
    if (!row) throw new AgentRunError('NOT_FOUND', 404)
    return row.revision
  }

  /** 模型工具入口：只生成预览与权威回执，不写任何追番数据。 */
  prepare(uid: number, ctx: { sessionId: string; runId: string; messageId: string | null }, args: Record<string, JsonValue>): { preview: TrackPreview } {
    if (!matchesContract(AGENT_TOOLS.proposeTrackChange.parameters, args)) throw new AgentRunError('INVALID_ARGUMENT', 400)
    if (!this.db.prepare('SELECT 1 FROM agent_sessions WHERE user_id = ? AND id = ?').get(uid, ctx.sessionId)) throw new AgentRunError('AUTH_REQUIRED', 401)
    const account = this.account(uid)
    const change = args.change as { kind: 'add' | 'update' | 'add_custom'; title?: string; fields?: Record<string, JsonValue> }
    const fields = change.fields ?? {}
    // 自己记一条：模型不给 bgmId，服务端分配一个负 ID（沿用页面自定义条目的约定）。
    const customTitle = change.kind === 'add_custom' ? String(change.title ?? '').trim().slice(0, 200) : ''
    if (change.kind === 'add_custom' && !customTitle) throw new AgentRunError('INVALID_ARGUMENT', 400)
    const bgmId = change.kind === 'add_custom' ? this.nextCustomBgmId(uid) : Number(args.bgmId)
    const open = (this.db.prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE user_id = ? AND session_id = ? AND state = 'prepared'").get(uid, ctx.sessionId) as { n: number }).n
    if (open >= MAX_OPEN_ACTIONS) throw new AgentRunError('QUOTA_EXCEEDED', 429)
    const status = fields.status !== undefined ? String(fields.status) : undefined
    if (status !== undefined && !TRACK_STATUSES.includes(status as (typeof TRACK_STATUSES)[number])) throw new AgentRunError('INVALID_ARGUMENT', 400)
    const episode = fields.episode !== undefined ? Number(fields.episode) : undefined
    if (episode !== undefined && (!Number.isInteger(episode) || episode < 0 || episode > 20_000)) throw new AgentRunError('INVALID_ARGUMENT', 400)
    const userTags = fields.userTags !== undefined ? normalizeTags(fields.userTags) : undefined

    const clamp = (value: number, total: number | null): number => total !== null && total > 0 && value > total ? total : value
    let before: TrackView | null
    let after: TrackView
    if (change.kind === 'add_custom') {
      before = null
      after = { bgmId, title: customTitle, status: status ?? 'watching', episode: episode ?? 0, userTags: userTags ?? [] }
    } else if (change.kind === 'update') {
      const row = this.track(uid, bgmId)
      if (!row) throw new AgentRunError('NOT_FOUND', 404)
      before = trackView(row)
      const total = row.total_episodes === null || row.total_episodes === undefined ? null : Number(row.total_episodes)
      after = {
        bgmId, title: before.title,
        status: status ?? before.status,
        episode: clamp(episode ?? before.episode, total),
        userTags: userTags ?? before.userTags,
      }
    } else {
      if (bgmId <= 0) throw new AgentRunError('INVALID_ARGUMENT', 400)
      if (this.track(uid, bgmId)) throw new AgentRunError('REVISION_CONFLICT', 409)
      const meta = this.resolveOffline(bgmId, uid, ctx.sessionId)
      if (!meta) throw new AgentRunError('NOT_FOUND', 404)
      before = null
      const total = isRecentAir(meta.airDate) ? null : (epsOf(bgmId) || null)
      after = {
        bgmId, title: (meta.titleCn || meta.title).slice(0, 200),
        status: status ?? 'watching', episode: clamp(episode ?? 0, total), userTags: userTags ?? [],
      }
    }

    const impact = this.impact(change.kind, before, after)
    const storedKind = change.kind === 'add_custom' ? 'add' : change.kind
    // 同一会话里内容完全相同、仍在等确认的预览直接复用，不再开一张新卡。
    // 模型会因为后续工具失败（例如播放打开要求先在追番里）而重试同一个提案，
    // 每次都发新 actionId 的话，用户面前会并排出现两张一模一样的「待确认」，不知道该点哪个。
    const twin = this.db.prepare(`SELECT * FROM agent_actions WHERE user_id = ? AND session_id = ? AND state = 'prepared'
      AND expires_at > ? AND bgm_id = ? AND change_kind = ? AND after_json = ? ORDER BY created_at DESC LIMIT 1`)
      .get(uid, ctx.sessionId, this.now(), bgmId, storedKind, JSON.stringify(after)) as ActionRow | undefined
    if (twin) {
      return { preview: { actionId: twin.id, bgmId: twin.bgm_id, kind: 'track_change', expiresAt: twin.expires_at, impact: twin.impact,
        expectedRevision: twin.expected_revision, before: twin.before_json ? JSON.parse(twin.before_json) as TrackView : null, after: JSON.parse(twin.after_json) as TrackView } }
    }
    const id = 'act-' + randomUUID(), created = this.now()
    this.db.prepare(`INSERT INTO agent_actions
      (id, user_id, session_id, run_id, message_id, bgm_id, change_kind, before_json, after_json, impact, expected_revision, confirm_token, token_version, knowledge_version, created_at, updated_at, expires_at)
      VALUES (@id, @user_id, @session_id, @run_id, @message_id, @bgm_id, @change_kind, @before_json, @after_json, @impact, @expected_revision, @confirm_token, @token_version, @knowledge_version, @created_at, @updated_at, @expires_at)`).run({
      id, user_id: uid, session_id: ctx.sessionId, run_id: ctx.runId, message_id: ctx.messageId, bgm_id: bgmId, change_kind: storedKind,
      before_json: before ? JSON.stringify(before) : null, after_json: JSON.stringify(after), impact,
      expected_revision: account.tracks_rev, confirm_token: randomBytes(32).toString('hex'), token_version: account.token_version,
      knowledge_version: this.knowledgeVersion(uid), created_at: created, updated_at: created, expires_at: created + ACTION_TTL_MS,
    })
    return { preview: { actionId: id, bgmId, kind: 'track_change', expiresAt: created + ACTION_TTL_MS, impact, expectedRevision: account.tracks_rev, before, after } }
  }

  private nextCustomBgmId(uid: number): number {
    const min = (this.db.prepare('SELECT MIN(bgm_id) AS m FROM tracks WHERE user_id = ?').get(uid) as { m: number | null }).m
    return Math.min(-1, (min ?? 0) - 1)
  }
  private impact(kind: 'add' | 'update' | 'add_custom', before: TrackView | null, after: TrackView): string {
    const name = `「${after.title}」`
    if (kind === 'add' || kind === 'add_custom') {
      const extra: string[] = []
      if (after.episode > 0) extra.push(`进度第 ${after.episode} 集`)
      if (after.userTags.length) extra.push(`标签 ${after.userTags.join('、')}`)
      return `把${name}${kind === 'add_custom' ? '以自己记一条的方式' : ''}加入追番（${STATUS_LABEL[after.status as keyof typeof STATUS_LABEL]}）${extra.length ? '，' + extra.join('，') : ''}`
    }
    const parts: string[] = []
    if (before && after.status !== before.status) parts.push(`状态从「${STATUS_LABEL[before.status as keyof typeof STATUS_LABEL] ?? before.status}」改为「${STATUS_LABEL[after.status as keyof typeof STATUS_LABEL]}」`)
    if (before && after.episode !== before.episode) parts.push(`进度记到第 ${after.episode} 集`)
    if (before && JSON.stringify(after.userTags) !== JSON.stringify(before.userTags)) parts.push(after.userTags.length ? `标签设为 ${after.userTags.join('、')}` : '清空标签')
    return `把${name}的${parts.join('，') || '资料保持不变'}`
  }

  private row(uid: number, actionId: string): ActionRow {
    const row = this.db.prepare('SELECT * FROM agent_actions WHERE user_id = ? AND id = ?').get(uid, actionId) as ActionRow | undefined
    if (!row) throw new AgentRunError('NOT_FOUND', 404)
    return row
  }
  /** owner 身份取回预览与确认凭证；模型没有这个入口。 */
  detail(uid: number, actionId: string) {
    const r = this.row(uid, actionId)
    return {
      action: receiptView(r),
      preview: { actionId: r.id, bgmId: r.bgm_id, kind: 'track_change' as const, expiresAt: r.expires_at, impact: r.impact,
        expectedRevision: r.expected_revision, before: r.before_json ? JSON.parse(r.before_json) as TrackView : null, after: JSON.parse(r.after_json) as TrackView },
      confirmationToken: r.state === 'prepared' && r.expires_at > this.now() ? r.confirm_token : null,
    }
  }

  private syncMessage(uid: number, r: ActionRow, state: string, evidence: string, errorCode: string | null): number {
    const seq = r.event_seq + 1
    if (r.message_id) {
      try {
        this.history.updateActionSummary(uid, r.session_id, r.message_id, {
          expectedRevision: this.sessionRevision(uid, r.session_id),
          action: { actionId: r.id, kind: 'track_change', state: state as never, eventSeq: seq, updatedAt: this.now(),
            evidence: evidence as never, errorCode: errorCode as never, userReportedSuccess: false, summary: r.impact },
        })
      } catch (error) {
        // 权威回执以 agent_actions 为准；消息卡片同步失败不回滚已完成的追番写入。
        if (!(error instanceof Error) || !/REVISION_CONFLICT|ACTION_RECEIPT_CONFLICT|NOT_FOUND|MESSAGE/.test(error.message)) throw error
      }
    }
    return seq
  }

  apply(uid: number, actionId: string, input: { requestId: string; expectedRevision: number; confirmationToken: string }) {
    const pre = this.row(uid, actionId)
    if (pre.apply_request_id !== null) {
      if (pre.apply_request_id !== input.requestId) throw new AgentRunError('CONFIRMATION_REQUIRED', 409)
      const done = this.row(uid, actionId)
      return { action: receiptView(done), track: done.state === 'completed' ? this.currentTrack(uid, done.bgm_id) : null,
        session: this.session(uid, done.session_id) }
    }
    const provided = Buffer.from(input.confirmationToken), expected = Buffer.from(pre.confirm_token)
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new AgentRunError('CONFIRMATION_REQUIRED', 409)
    if (pre.state !== 'prepared' || terminal(pre.state)) throw new AgentRunError('ACTION_EXPIRED', 409)
    if (this.now() > pre.expires_at) { this.expire(uid, pre); throw new AgentRunError('ACTION_EXPIRED', 409) }
    const account = this.account(uid)
    if (account.token_version !== pre.token_version) throw new AgentRunError('AUTH_REQUIRED', 401)
    if (this.knowledgeVersion(uid) !== pre.knowledge_version) throw new AgentRunError('CAPABILITY_CHANGED', 409)
    if (input.expectedRevision !== pre.expected_revision) throw new AgentRunError('REVISION_CONFLICT', 409)

    const after = JSON.parse(pre.after_json) as TrackView
    for (const [from, to, origin] of [['prepared', 'user_confirmed', 'user_click'], ['user_confirmed', 'dispatch_started', 'server']] as const) {
      if (!permitsActionTransition('track_change', from, to, { origin })) throw new AgentRunError('INTERNAL_ERROR', 409)
    }

    const result = this.db.transaction(() => {
      const current = (this.db.prepare('SELECT tracks_rev FROM users WHERE id = ?').get(uid) as { tracks_rev: number }).tracks_rev
      if (current !== pre.expected_revision) throw new AgentRunError('REVISION_CONFLICT', 409)
      const now = this.now()
      const custom = pre.bgm_id < 0
      let bgmId = pre.bgm_id
      if (pre.change_kind === 'add') {
        if (custom && this.track(uid, bgmId)) bgmId = this.nextCustomBgmId(uid) // 预览与执行之间又建了自定义条目
        if (this.track(uid, bgmId)) throw new AgentRunError('REVISION_CONFLICT', 409)
        const meta = custom ? null : this.resolveOffline(bgmId, uid, pre.session_id)
        const total = meta && !isRecentAir(meta.airDate) ? (epsOf(bgmId) || null) : null
        this.db.prepare(`INSERT INTO tracks (user_id, bgm_id, status, episode, total_episodes, title, title_cn, cover, air_weekday, air_date, score, bgm_tags, user_tags, aliases, extra, observe_count, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, ?, 0, '[]', ?, '[]', '{}', 0, ?)`).run(
          uid, bgmId, after.status, total !== null && total > 0 ? Math.min(after.episode, total) : after.episode, total,
          custom ? after.title : (meta?.title ?? after.title), custom ? '' : (meta?.titleCn ?? ''), meta?.airDate ?? '', JSON.stringify(after.userTags), now)
      } else {
        const existing = this.track(uid, bgmId)
        if (!existing) throw new AgentRunError('NOT_FOUND', 404)
        const total = existing.total_episodes === null ? null : Number(existing.total_episodes)
        this.db.prepare('UPDATE tracks SET status = ?, episode = ?, user_tags = ?, updated_at = ? WHERE user_id = ? AND bgm_id = ?').run(
          after.status, total !== null && total > 0 ? Math.min(after.episode, total) : after.episode, JSON.stringify(after.userTags), now, uid, bgmId)
      }
      this.db.prepare('UPDATE users SET tracks_rev = tracks_rev + 1 WHERE id = ?').run(uid)
      const written = this.track(uid, bgmId)
      if (!written) throw new AgentRunError('INTERNAL_ERROR')
      const readback = trackView(written)
      const nextRev = (this.db.prepare('SELECT tracks_rev FROM users WHERE id = ?').get(uid) as { tracks_rev: number }).tracks_rev
      const matches = readback.status === after.status && readback.episode === after.episode && JSON.stringify(readback.userTags) === JSON.stringify(after.userTags)
      if (!permitsActionTransition('track_change', 'dispatch_started', 'completed', { origin: 'server', matchingReadback: matches, expectedRevision: pre.expected_revision, actualRevision: nextRev })) {
        throw new AgentRunError('REVISION_CONFLICT', 409)
      }
      const seq = this.syncMessage(uid, pre, 'completed', 'server_readback', null)
      this.db.prepare("UPDATE agent_actions SET state = 'completed', evidence = 'server_readback', actual_revision = ?, event_seq = ?, apply_request_id = ?, updated_at = ? WHERE user_id = ? AND id = ?")
        .run(nextRev, seq, input.requestId, now, uid, actionId)
      return { action: receiptView(this.row(uid, actionId)), track: readback, session: this.session(uid, pre.session_id) }
    }).immediate()
    return result
  }

  cancel(uid: number, actionId: string, input: { expectedRevision?: number }) {
    const r = this.row(uid, actionId)
    if (r.state === 'cancelled') return { action: receiptView(r), session: this.session(uid, r.session_id) }
    if (r.state !== 'prepared') throw new AgentRunError('ACTION_EXPIRED', 409)
    if (input.expectedRevision !== undefined && input.expectedRevision !== r.expected_revision) throw new AgentRunError('REVISION_CONFLICT', 409)
    if (!permitsActionTransition('track_change', 'prepared', 'cancelled', { origin: 'user_click' })) throw new AgentRunError('INTERNAL_ERROR', 409)
    const seq = this.syncMessage(uid, r, 'cancelled', 'user_click', null)
    this.db.prepare("UPDATE agent_actions SET state = 'cancelled', evidence = 'user_click', event_seq = ?, updated_at = ? WHERE user_id = ? AND id = ?").run(seq, this.now(), uid, actionId)
    return { action: receiptView(this.row(uid, actionId)), session: this.session(uid, r.session_id) }
  }
  // 确认/取消后把最新会话一并返回:客户端据此更新 revision 并就地改写卡片状态,
  // 不必为了一个已知的状态变化再拉一整套快照(见 controller.confirmAction)。
  private session(uid: number, sessionId: string) { return this.history.snapshot(uid, sessionId, { limit: 1 }).session }
  private expire(uid: number, r: ActionRow) {
    if (r.state !== 'prepared') return
    const seq = this.syncMessage(uid, r, 'cancelled', 'server_readback', 'ACTION_EXPIRED')
    this.db.prepare("UPDATE agent_actions SET state = 'cancelled', evidence = 'error', error_code = 'ACTION_EXPIRED', event_seq = ?, updated_at = ? WHERE user_id = ? AND id = ?").run(seq, this.now(), uid, r.id)
  }
  private currentTrack(uid: number, bgmId: number): TrackView | null {
    const row = this.track(uid, bgmId)
    return row ? trackView(row) : null
  }
}

/** run-runtime 注册的 proposal 工具。身份固定绑定服务端会话，不接受模型账号参数。 */
export function proposeTrackChangeTool(store: AgentActionStore, uid: number, sessionId: string): ReadTool {
  return {
    name: 'proposeTrackChange',
    async execute(args, actor) {
      if (actor.signal.aborted) return { ok: false, code: 'CANCELLED', message: '已取消。', retryable: false }
      if (actor.uid !== uid) return { ok: false, code: 'AUTH_REQUIRED', message: '账号状态已变化。', retryable: false }
      try {
        const { preview } = store.prepare(uid, { sessionId, runId: actor.runId ?? '', messageId: actor.messageId ?? null }, args)
        return { ok: true, data: preview, sources: [], resultCount: 1, truncated: false }
      } catch (error) {
        const code = error instanceof AgentRunError ? error.code : 'INTERNAL_ERROR'
        return { ok: false, code: ['INVALID_ARGUMENT', 'AUTH_REQUIRED', 'NOT_FOUND', 'REVISION_CONFLICT', 'QUOTA_EXCEEDED'].includes(code) ? code : 'INTERNAL_ERROR', message: '这次预览没有生成。', retryable: false }
      }
    },
  }
}
