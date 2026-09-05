import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import type { ContractSchema } from '../../shared/agent-contracts'
import {
  AgentHistoryError, HISTORY_LIMITS, HISTORY_ID_SCHEMA, CREATE_SESSION_SCHEMA, PATCH_SESSION_SCHEMA,
  REVISION_SCHEMA, USER_MESSAGE_SCHEMA, ASSISTANT_APPEND_SCHEMA, ASSISTANT_UPDATE_SCHEMA,
  SESSION_LIST_SCHEMA, MESSAGE_PAGE_SCHEMA, ACTION_UPDATE_SCHEMA,
  type CreateHistorySession, type PatchHistorySession, type AppendUserMessage,
  type AppendAssistantMessage, type UpdateAssistantMessage, type AssistantMessageContent,
  type HistorySession, type HistoryMessage, type HistorySnapshot, type SessionListQuery, type MessagePageQuery, type UpdateHistoryAction,
} from '../../shared/agent-history'
import { DEFAULT_AGENT_MODEL } from './policy'
import { matchesContract } from './validation'

export function initializeAgentHistorySchema(db: Database.Database): void {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
      create_request_id TEXT NOT NULL, create_hash TEXT NOT NULL,
      title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      archived_at INTEGER, revision INTEGER NOT NULL DEFAULT 0,
      last_event_seq INTEGER NOT NULL DEFAULT 0, last_message_seq INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0, stored_bytes INTEGER NOT NULL DEFAULT 0,
      active_summary_version INTEGER,
      context_tier TEXT NOT NULL DEFAULT '128k' CHECK(context_tier IN ('64k','128k','256k','1m')),
      current_bgm_id INTEGER CHECK(current_bgm_id IS NULL OR current_bgm_id != 0),
      provider TEXT NOT NULL DEFAULT 'server' CHECK(provider IN ('server','byok')), model TEXT NOT NULL,
      UNIQUE(user_id, id), UNIQUE(user_id, create_request_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS agent_sessions_owner_updated ON agent_sessions(user_id, updated_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS agent_deleted_sessions (
      user_id INTEGER NOT NULL, create_request_id TEXT NOT NULL, deleted_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, create_request_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
      request_id TEXT NOT NULL, initial_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')), body TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('streaming','completed','failed','cancelled')),
      sources_json TEXT NOT NULL, tools_json TEXT NOT NULL, actions_json TEXT NOT NULL, usage_json TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
      pending_actions INTEGER NOT NULL DEFAULT 0 CHECK(pending_actions IN (0,1)),
      stored_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(user_id, session_id, request_id), UNIQUE(session_id, seq),
      FOREIGN KEY(user_id, session_id) REFERENCES agent_sessions(user_id, id) ON DELETE CASCADE
    );
  `)).immediate()
}

interface SessionRow {
  id: string; user_id: number; create_request_id: string; create_hash: string; title: string
  created_at: number; updated_at: number; archived_at: number | null; revision: number
  last_event_seq: number; last_message_seq: number; message_count: number; stored_bytes: number
  active_summary_version: number | null; context_tier: HistorySession['contextTier']
  current_bgm_id: number | null; provider: HistorySession['provider']; model: string
}
interface MessageRow {
  id: string; user_id: number; session_id: string; seq: number; request_id: string; initial_hash: string
  role: HistoryMessage['role']; body: string; status: HistoryMessage['status']
  sources_json: string; tools_json: string; actions_json: string; usage_json: string
  pinned: number; pending_actions: number; stored_bytes: number; created_at: number; updated_at: number
}

function parse<T>(schema: ContractSchema, value: unknown): T {
  if (!matchesContract(schema, value)) throw new AgentHistoryError('INVALID_ARGUMENT', 400, '这页手帐的参数不太对，请检查后再试。')
  return structuredClone(value) as T
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const emptyContent = (body: string): AssistantMessageContent => ({ body, status: 'completed', sources: [], toolSummaries: [], actions: [], usage: [] })
const sessionView = (r: SessionRow): HistorySession => ({
  id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at,
  revision: r.revision, activeSummaryVersion: r.active_summary_version, contextTier: r.context_tier,
  currentBgmId: r.current_bgm_id, provider: r.provider, model: r.model, lastEventSeq: r.last_event_seq,
  messageCount: r.message_count,
})
function messageView(r: MessageRow): HistoryMessage {
  const sources = JSON.parse(r.sources_json) as HistoryMessage['sources']
  const actions = JSON.parse(r.actions_json) as HistoryMessage['actions']
  return {
    id: r.id, sessionId: r.session_id, seq: r.seq, role: r.role, body: r.body, status: r.status,
    sources, sourceIds: sources.map(s => s.sourceId), actions, actionIds: actions.map(a => a.actionId),
    toolSummaries: JSON.parse(r.tools_json) as HistoryMessage['toolSummaries'],
    usage: JSON.parse(r.usage_json) as HistoryMessage['usage'],
    createdAt: r.created_at, updatedAt: r.updated_at, pinned: r.pinned === 1,
  }
}

function encodeContent(content: AssistantMessageContent) {
  if (new Set(content.sources.map(s => s.sourceId)).size !== content.sources.length
    || new Set(content.actions.map(a => a.actionId)).size !== content.actions.length) {
    throw new AgentHistoryError('INVALID_ARGUMENT', 400, '来源或动作编号重复了，请重新整理。')
  }
  for (const u of content.usage) {
    if (u.cachedInputTokens !== null && (u.inputTokens === null || u.cachedInputTokens > u.inputTokens)) {
      throw new AgentHistoryError('INVALID_ARGUMENT', 400, '用量记录不一致，请检查输入与缓存数量。')
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify({ body: content.body, status: content.status, sources: content.sources,
    toolSummaries: content.toolSummaries, actions: content.actions, usage: content.usage }), 'utf8')
  if (bytes > HISTORY_LIMITS.requestBytes) throw new AgentHistoryError('MESSAGE_TOO_LARGE', 413, '这条消息太长啦，请分几次保存。')
  return {
    body: content.body, status: content.status, sources: JSON.stringify(content.sources),
    tools: JSON.stringify(content.toolSummaries), actions: JSON.stringify(content.actions), usage: JSON.stringify(content.usage),
    bytes, pending: content.actions.some(a => !['completed', 'failed', 'cancelled', 'unknown'].includes(a.state)) ? 1 : 0,
  }
}

export class AgentHistoryStore {
  constructor(private readonly db: Database.Database, private readonly limits: {
    sessionsPerUser: number; messagesPerSession: number; bytesPerSession: number; bytesPerUser: number
  } = HISTORY_LIMITS) {}

  private session(uid: number, id: string): SessionRow {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new AgentHistoryError('NOT_FOUND', 404, '这本手帐没有找到。')
    parse(HISTORY_ID_SCHEMA, id)
    const row = this.db.prepare('SELECT * FROM agent_sessions WHERE user_id = ? AND id = ?').get(uid, id) as SessionRow | undefined
    if (!row) throw new AgentHistoryError('NOT_FOUND', 404, '这本手帐没有找到。')
    return row
  }

  private expectRevision(s: SessionRow, revision: number): void {
    if (s.revision !== revision) throw new AgentHistoryError('REVISION_CONFLICT', 409, '另一端已经更新这本手帐，请先刷新再试。')
  }

  private expectWritable(s: SessionRow): void {
    if (s.archived_at !== null) throw new AgentHistoryError('SESSION_ARCHIVED', 409, '这本手帐已归档，先恢复再继续写吧。')
  }

  private expectIdle(s: SessionRow): void {
    const busy = this.db.prepare("SELECT 1 FROM agent_messages WHERE user_id = ? AND session_id = ? AND (status = 'streaming' OR pending_actions = 1) LIMIT 1").get(s.user_id, s.id)
    if (busy) throw new AgentHistoryError('SESSION_BUSY', 409, '这本手帐还有进行中的回复或动作，先取消或等它结束吧。')
  }

  private touch(s: SessionRow, bytesDelta = 0, messageDelta = 0, advanceMessageSeq = false): void {
    this.db.prepare(`UPDATE agent_sessions SET updated_at = ?, revision = revision + 1, last_event_seq = last_event_seq + 1,
      stored_bytes = stored_bytes + ?, message_count = message_count + ?, last_message_seq = last_message_seq + ?
      WHERE user_id = ? AND id = ?`).run(Math.max(Date.now(), s.updated_at + 1), bytesDelta, messageDelta, advanceMessageSeq ? 1 : 0, s.user_id, s.id)
  }

  private expectSpace(s: SessionRow, delta: number, adding: boolean): void {
    const { bytes } = this.db.prepare('SELECT COALESCE(SUM(stored_bytes), 0) AS bytes FROM agent_sessions WHERE user_id = ?').get(s.user_id) as { bytes: number }
    if ((adding && s.message_count >= this.limits.messagesPerSession) || s.stored_bytes + delta > this.limits.bytesPerSession || bytes + delta > this.limits.bytesPerUser) {
      throw new AgentHistoryError('HISTORY_LIMIT', 409, '手帐空间已到上限，请先导出并清理旧会话。')
    }
  }

  createSession(uid: number, input: unknown): HistorySession {
    const p = parse<CreateHistorySession>(CREATE_SESSION_SCHEMA, input)
    if (p.title !== undefined && !p.title.trim()) throw new AgentHistoryError('INVALID_ARGUMENT', 400, '给这本手帐起个名字吧。')
    const title = p.title?.trim() ?? '新会话'
    const fingerprint = hash({ title, currentBgmId: p.currentBgmId ?? null })
    return this.db.transaction(() => {
      if (!Number.isSafeInteger(uid) || uid <= 0 || !this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) throw new AgentHistoryError('NOT_FOUND', 404, '账号已失效，请重新登录。')
      this.db.prepare('DELETE FROM agent_deleted_sessions WHERE user_id = ? AND deleted_at < ?').run(uid, Date.now() - HISTORY_LIMITS.deletedRequestRetentionMs)
      if (this.db.prepare('SELECT 1 FROM agent_deleted_sessions WHERE user_id = ? AND create_request_id = ?').get(uid, p.requestId)) {
        throw new AgentHistoryError('REQUEST_RETIRED', 409, '这次创建请求对应的手帐已删除，请新建一次会话。')
      }
      const existing = this.db.prepare('SELECT * FROM agent_sessions WHERE user_id = ? AND create_request_id = ?').get(uid, p.requestId) as SessionRow | undefined
      if (existing) {
        if (existing.create_hash !== fingerprint) throw new AgentHistoryError('IDEMPOTENCY_CONFLICT', 409, '这次请求的内容变了，请使用新的请求编号。')
        return sessionView(existing)
      }
      const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM agent_sessions WHERE user_id = ?').get(uid) as { count: number }
      if (count >= this.limits.sessionsPerUser) throw new AgentHistoryError('HISTORY_LIMIT', 409, '手帐数量已到上限，请先导出并清理旧会话。')
      const id = randomUUID(), now = Date.now()
      this.db.prepare(`INSERT INTO agent_sessions (id, user_id, create_request_id, create_hash, title, created_at, updated_at, current_bgm_id, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, uid, p.requestId, fingerprint, title, now, now, p.currentBgmId ?? null, DEFAULT_AGENT_MODEL)
      return sessionView(this.session(uid, id))
    }).immediate()
  }

  listSessions(uid: number, input: unknown = {}) {
    const p = parse<SessionListQuery>(SESSION_LIST_SCHEMA, input)
    if ((p.beforeUpdatedAt === undefined) !== (p.beforeId === undefined)) throw new AgentHistoryError('INVALID_ARGUMENT', 400, '列表游标不完整，请刷新列表。')
    const limit = p.limit ?? HISTORY_LIMITS.pageSize
    const archived = p.archived ?? 'active'
    const rows = this.db.prepare(`SELECT * FROM agent_sessions WHERE user_id = ?
      AND (? = 'all' OR (? = 'active' AND archived_at IS NULL) OR (? = 'archived' AND archived_at IS NOT NULL))
      AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?))
      ORDER BY updated_at DESC, id DESC LIMIT ?`).all(uid, archived, archived, archived, p.beforeUpdatedAt ?? null, p.beforeUpdatedAt ?? null, p.beforeUpdatedAt ?? null, p.beforeId ?? '', limit + 1) as SessionRow[]
    const items = rows.slice(0, limit), last = items.at(-1)
    return { sessions: items.map(sessionView), nextCursor: rows.length > limit && last ? { beforeUpdatedAt: last.updated_at, beforeId: last.id } : null }
  }

  snapshot(uid: number, id: string, input: unknown = {}): HistorySnapshot {
    const p = parse<MessagePageQuery>(MESSAGE_PAGE_SCHEMA, input)
    if (p.beforeSeq !== undefined && p.afterSeq !== undefined) throw new AgentHistoryError('INVALID_ARGUMENT', 400, '一次只选一个翻页方向吧。')
    return this.db.transaction(() => {
      const s = this.session(uid, id)
      const rows = this.db.prepare(`SELECT * FROM agent_messages WHERE user_id = ? AND session_id = ?
        AND (? IS NULL OR seq < ?) AND (? IS NULL OR seq > ?) ORDER BY seq ${p.afterSeq === undefined ? 'DESC' : 'ASC'} LIMIT ?`)
        .all(uid, id, p.beforeSeq ?? null, p.beforeSeq ?? null, p.afterSeq ?? null, p.afterSeq ?? null, p.limit ?? HISTORY_LIMITS.pageSize) as MessageRow[]
      if (p.afterSeq === undefined) rows.reverse()
      const bounds = this.db.prepare('SELECT MIN(seq) AS first, MAX(seq) AS last FROM agent_messages WHERE user_id = ? AND session_id = ?').get(uid, id) as { first: number | null; last: number | null }
      const first = rows.at(0)?.seq, last = rows.at(-1)?.seq
      return { session: sessionView(s), messages: rows.map(messageView),
        nextBeforeSeq: first !== undefined && bounds.first !== null && first > bounds.first ? first : null,
        nextAfterSeq: last !== undefined && bounds.last !== null && last < bounds.last ? last : null }
    })()
  }

  patchSession(uid: number, id: string, input: unknown): HistorySession {
    const p = parse<PatchHistorySession>(PATCH_SESSION_SCHEMA, input)
    if (Object.keys(p).length < 2 || (p.title !== undefined && !p.title.trim())) throw new AgentHistoryError('INVALID_ARGUMENT', 400, '请填写要修改的手帐内容。')
    return this.db.transaction(() => {
      const s = this.session(uid, id); this.expectRevision(s, p.expectedRevision)
      if (p.archived === true || p.currentBgmId !== undefined) this.expectIdle(s)
      this.db.prepare('UPDATE agent_sessions SET title = ?, archived_at = ?, current_bgm_id = ? WHERE user_id = ? AND id = ?')
        .run(p.title?.trim() ?? s.title, p.archived === undefined ? s.archived_at : p.archived ? s.archived_at ?? Date.now() : null,
          p.currentBgmId === undefined ? s.current_bgm_id : p.currentBgmId, uid, id)
      this.touch(s)
      return sessionView(this.session(uid, id))
    }).immediate()
  }

  appendUser(uid: number, id: string, input: unknown) {
    const p = parse<AppendUserMessage>(USER_MESSAGE_SCHEMA, input)
    if (!p.body.trim()) throw new AgentHistoryError('INVALID_ARGUMENT', 400, '先写一点想聊的内容吧。')
    return this.append(uid, id, p.requestId, p.expectedRevision, 'user', emptyContent(p.body))
  }

  // 助手记录只供未来的服务端循环写入；HTTP 只开放用户消息，浏览器不拥有回执/来源的签发权。
  appendAssistant(uid: number, id: string, input: unknown) {
    const p = parse<AppendAssistantMessage>(ASSISTANT_APPEND_SCHEMA, input)
    return this.append(uid, id, p.requestId, p.expectedRevision, 'assistant', p)
  }

  private append(uid: number, id: string, requestId: string, expectedRevision: number, role: HistoryMessage['role'], content: AssistantMessageContent) {
    const encoded = encodeContent(content)
    const fingerprint = hash({ role, body: encoded.body, status: encoded.status, sources: encoded.sources, tools: encoded.tools, actions: encoded.actions, usage: encoded.usage })
    return this.db.transaction(() => {
      const s = this.session(uid, id)
      const existing = this.db.prepare('SELECT * FROM agent_messages WHERE user_id = ? AND session_id = ? AND request_id = ?').get(uid, id, requestId) as MessageRow | undefined
      if (existing) {
        if (existing.initial_hash !== fingerprint) throw new AgentHistoryError('IDEMPOTENCY_CONFLICT', 409, '这次消息内容变了，请使用新的请求编号。')
        return { session: sessionView(s), message: messageView(existing) }
      }
      this.expectRevision(s, expectedRevision); this.expectWritable(s); this.expectIdle(s); this.expectSpace(s, encoded.bytes, true)
      const messageId = randomUUID(), now = Date.now()
      this.db.prepare(`INSERT INTO agent_messages
        (id, user_id, session_id, seq, request_id, initial_hash, role, body, status, sources_json, tools_json, actions_json, usage_json, stored_bytes, pending_actions, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(messageId, uid, id, s.last_message_seq + 1,
          requestId, fingerprint, role, encoded.body, encoded.status, encoded.sources, encoded.tools, encoded.actions, encoded.usage, encoded.bytes, encoded.pending, now, now)
      this.touch(s, encoded.bytes, 1, true)
      const row = this.db.prepare('SELECT * FROM agent_messages WHERE user_id = ? AND session_id = ? AND id = ?').get(uid, id, messageId) as MessageRow
      return { session: sessionView(this.session(uid, id)), message: messageView(row) }
    }).immediate()
  }

  updateAssistant(uid: number, id: string, messageId: string, input: unknown) {
    parse(HISTORY_ID_SCHEMA, messageId)
    const p = parse<UpdateAssistantMessage>(ASSISTANT_UPDATE_SCHEMA, input), encoded = encodeContent(p)
    return this.db.transaction(() => {
      const s = this.session(uid, id); this.expectRevision(s, p.expectedRevision); this.expectWritable(s)
      const row = this.db.prepare('SELECT * FROM agent_messages WHERE user_id = ? AND session_id = ? AND id = ?').get(uid, id, messageId) as MessageRow | undefined
      if (!row) throw new AgentHistoryError('NOT_FOUND', 404, '这条回复没有找到。')
      if (row.role !== 'assistant' || row.status !== 'streaming') throw new AgentHistoryError('MESSAGE_FINALIZED', 409, '这条回复已收好，晚到的更新没有覆盖它。')
      this.expectSpace(s, encoded.bytes - row.stored_bytes, false)
      this.db.prepare(`UPDATE agent_messages SET body = ?, status = ?, sources_json = ?, tools_json = ?, actions_json = ?, usage_json = ?,
        stored_bytes = ?, pending_actions = ?, updated_at = ? WHERE user_id = ? AND session_id = ? AND id = ?`)
        .run(encoded.body, encoded.status, encoded.sources, encoded.tools, encoded.actions, encoded.usage, encoded.bytes, encoded.pending, Date.now(), uid, id, messageId)
      this.touch(s, encoded.bytes - row.stored_bytes)
      return { session: sessionView(this.session(uid, id)), message: messageView(this.db.prepare('SELECT * FROM agent_messages WHERE user_id = ? AND session_id = ? AND id = ?').get(uid, id, messageId) as MessageRow) }
    }).immediate()
  }

  updateActionSummary(uid: number, id: string, messageId: string, input: unknown) {
    parse(HISTORY_ID_SCHEMA, messageId)
    const p = parse<UpdateHistoryAction>(ACTION_UPDATE_SCHEMA, input)
    return this.db.transaction(() => {
      const s = this.session(uid, id)
      const row = this.db.prepare('SELECT * FROM agent_messages WHERE user_id = ? AND session_id = ? AND id = ?').get(uid, id, messageId) as MessageRow | undefined
      if (!row || row.role !== 'assistant') throw new AgentHistoryError('NOT_FOUND', 404, '动作所属的回复没有找到。')
      const message = messageView(row)
      const index = message.actions.findIndex(a => a.actionId === p.action.actionId)
      const previous = message.actions[index]
      if (!previous) throw new AgentHistoryError('NOT_FOUND', 404, '这条动作记录没有找到。')
      if (hash(previous) === hash(p.action)) return { session: sessionView(s), message }
      this.expectRevision(s, p.expectedRevision)
      if (previous.kind !== p.action.kind || p.action.eventSeq <= previous.eventSeq || ['completed', 'failed', 'cancelled', 'unknown'].includes(previous.state)) {
        throw new AgentHistoryError('ACTION_RECEIPT_CONFLICT', 409, '动作回执已更新，旧状态没有覆盖它。')
      }
      message.actions[index] = p.action
      const encoded = encodeContent(message)
      this.expectSpace(s, encoded.bytes - row.stored_bytes, false)
      this.db.prepare('UPDATE agent_messages SET actions_json = ?, pending_actions = ?, stored_bytes = ?, updated_at = ? WHERE user_id = ? AND session_id = ? AND id = ?')
        .run(encoded.actions, encoded.pending, encoded.bytes, Date.now(), uid, id, messageId)
      this.touch(s, encoded.bytes - row.stored_bytes)
      return { session: sessionView(this.session(uid, id)), message: messageView(this.db.prepare('SELECT * FROM agent_messages WHERE user_id = ? AND session_id = ? AND id = ?').get(uid, id, messageId) as MessageRow) }
    }).immediate()
  }

  clearSession(uid: number, id: string, input: unknown): HistorySession {
    const p = parse<{ expectedRevision: number }>(REVISION_SCHEMA, input)
    return this.db.transaction(() => {
      const s = this.session(uid, id); this.expectRevision(s, p.expectedRevision); this.expectIdle(s)
      this.db.prepare('DELETE FROM agent_messages WHERE user_id = ? AND session_id = ?').run(uid, id)
      this.db.prepare('UPDATE agent_sessions SET active_summary_version = NULL WHERE user_id = ? AND id = ?').run(uid, id)
      // seq 不归零，另一端旧游标和晚到的请求仍然是旧状态，不会指向新的同号消息。
      this.touch(s, -s.stored_bytes, -s.message_count)
      return sessionView(this.session(uid, id))
    }).immediate()
  }

  deleteSession(uid: number, id: string, input: unknown) {
    const p = parse<{ expectedRevision: number }>(REVISION_SCHEMA, input)
    return this.db.transaction(() => {
      const s = this.session(uid, id); this.expectRevision(s, p.expectedRevision); this.expectIdle(s)
      // 只保留短期请求号，不保留标题/正文；防止删除后晚到的创建重试让会话重新出现。
      this.db.prepare('INSERT INTO agent_deleted_sessions (user_id, create_request_id, deleted_at) VALUES (?, ?, ?)')
        .run(uid, s.create_request_id, Date.now())
      this.db.prepare('DELETE FROM agent_sessions WHERE user_id = ? AND id = ?').run(uid, id)
      return { deleted: true as const }
    }).immediate()
  }

  exportSession(uid: number, id: string) {
    return this.db.transaction(() => {
      const s = this.session(uid, id)
      const rows = this.db.prepare('SELECT * FROM agent_messages WHERE user_id = ? AND session_id = ? ORDER BY seq').all(uid, id) as MessageRow[]
      return { format: 'mapletools-agent-history' as const, version: 1 as const, exportedAt: Date.now(), session: sessionView(s), messages: rows.map(messageView) }
    })()
  }
}
