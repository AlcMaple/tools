import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import type { AgentUsage, ContextTier, SummaryState } from '../../shared/agent-contracts'
import { HISTORY_LIMITS, HISTORY_ID_SCHEMA, AgentHistoryError, type HistoryMessage } from '../../shared/agent-history'
import { CONTEXT_LIMITS, type CompactJob, type CompactStage, type ContextSummary, type NativeWindow, type PreferenceCard, type SummaryQuality } from '../../shared/agent-context'
import { AgentHistoryStore } from './history-store'
import { matchesContract } from './validation'

export const contextHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function contextError(code: string, message: string, status: 400 | 404 | 409 | 413 | 429 = 409): never { throw new AgentHistoryError(code, status, message) }
const activeStages = "'queued','budgeting','extracting','checking','merging','native'"
export const isCompactActive = (stage: CompactStage): boolean => !['completed', 'failed', 'cancelled', 'skipped'].includes(stage)

export function initializeAgentContextSchema(db: Database.Database): void {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS agent_preferences (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, category TEXT NOT NULL, value TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('proposed','confirmed')), revision INTEGER NOT NULL,
      source_message_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, confirmed_at INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS agent_preferences_owner ON agent_preferences(user_id, status, id);
    CREATE TABLE IF NOT EXISTS agent_context_versions (
      user_id INTEGER NOT NULL, session_id TEXT NOT NULL, version INTEGER NOT NULL, parent_version INTEGER,
      created_at INTEGER NOT NULL, from_seq INTEGER NOT NULL, through_seq INTEGER NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, origin TEXT NOT NULL,
      state_json TEXT NOT NULL, quality_json TEXT NOT NULL, usage_json TEXT NOT NULL, native_json TEXT,
      profile_hash TEXT NOT NULL, preferences_hash TEXT NOT NULL, bytes INTEGER NOT NULL, restored_from INTEGER,
      PRIMARY KEY(user_id, session_id, version),
      FOREIGN KEY(user_id, session_id) REFERENCES agent_sessions(user_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS agent_context_jobs (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL,
      trigger TEXT NOT NULL, stage TEXT NOT NULL, base_revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      error_code TEXT, summary_version INTEGER, usage_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE(user_id, session_id, request_id),
      FOREIGN KEY(user_id, session_id) REFERENCES agent_sessions(user_id, id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS agent_context_one_job ON agent_context_jobs(user_id) WHERE stage IN (${activeStages});
    CREATE TRIGGER IF NOT EXISTS agent_context_clear AFTER UPDATE OF context_generation ON agent_sessions
    WHEN NEW.context_generation != OLD.context_generation BEGIN
      DELETE FROM agent_context_versions WHERE user_id = NEW.user_id AND session_id = NEW.id;
      DELETE FROM agent_context_jobs WHERE user_id = NEW.user_id AND session_id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS agent_context_clear_pointer AFTER UPDATE OF active_summary_version ON agent_sessions
    WHEN NEW.active_summary_version IS NULL BEGIN
      DELETE FROM agent_context_versions WHERE user_id = NEW.user_id AND session_id = NEW.id;
      DELETE FROM agent_context_jobs WHERE user_id = NEW.user_id AND session_id = NEW.id;
      UPDATE agent_sessions SET context_bytes = 0, context_job_id = NULL WHERE user_id = NEW.user_id AND id = NEW.id;
    END;
  `)).immediate()
  const versionColumns=db.prepare('PRAGMA table_info(agent_context_versions)').all() as {name:string}[]
  if(!versionColumns.some(c=>c.name==='restored_from'))db.exec('ALTER TABLE agent_context_versions ADD COLUMN restored_from INTEGER')
  const exists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'agent_transcript_fts'").get())
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS agent_transcript_fts USING fts5(body, content='agent_messages', content_rowid='rowid', tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS agent_transcript_insert AFTER INSERT ON agent_messages BEGIN
      INSERT INTO agent_transcript_fts(rowid, body) VALUES (NEW.rowid, NEW.body); END;
    CREATE TRIGGER IF NOT EXISTS agent_transcript_delete AFTER DELETE ON agent_messages BEGIN
      INSERT INTO agent_transcript_fts(agent_transcript_fts,rowid,body) VALUES ('delete',OLD.rowid,OLD.body); END;
    CREATE TRIGGER IF NOT EXISTS agent_transcript_update AFTER UPDATE OF body ON agent_messages BEGIN
      INSERT INTO agent_transcript_fts(agent_transcript_fts,rowid,body) VALUES ('delete',OLD.rowid,OLD.body);
      INSERT INTO agent_transcript_fts(rowid,body) VALUES (NEW.rowid,NEW.body); END;`)
  if (!exists) db.exec("INSERT INTO agent_transcript_fts(agent_transcript_fts) VALUES ('rebuild')")
}

interface VersionRow {
  user_id: number; session_id: string; version: number; parent_version: number | null; created_at: number
  from_seq: number; through_seq: number; provider: 'server' | 'byok'; model: string; method: ContextSummary['method']
  origin: ContextSummary['origin']; state_json: string; quality_json: string; usage_json: string; native_json: string | null
  profile_hash: string; preferences_hash: string; bytes: number
  restored_from:number|null
}
interface JobRow {
  id: string; user_id: number; session_id: string; request_id: string; trigger: CompactJob['trigger']; stage: CompactStage
  base_revision: number; created_at: number; updated_at: number; expires_at: number; error_code: string | null
  summary_version: number | null; usage_json: string
}
interface PrefRow { id: string; category: PreferenceCard['category']; value: string; status: PreferenceCard['status']; revision: number; source_message_id: string | null; created_at: number; updated_at: number; confirmed_at: number | null }
const prefView = (r: PrefRow): PreferenceCard => ({ id: r.id, category: r.category, value: r.value, status: r.status, revision: r.revision, sourceMessageId: r.source_message_id, createdAt: r.created_at, updatedAt: r.updated_at, confirmedAt: r.confirmed_at })
const jobView = (r: JobRow): CompactJob => ({ id: r.id, sessionId: r.session_id, requestId: r.request_id, trigger: r.trigger, stage: r.stage, createdAt: r.created_at, updatedAt: r.updated_at, expiresAt: r.expires_at, errorCode: r.error_code, summaryVersion: r.summary_version, usage: JSON.parse(r.usage_json) as AgentUsage[] })
const versionView = (r: VersionRow, active: number | null): ContextSummary => ({
  sessionId: r.session_id, summary_version: r.version, parentVersion: r.parent_version, createdAt: r.created_at,
  transcriptRange: { fromSeq: r.from_seq, throughSeq: r.through_seq }, provider: r.provider, model: r.model,
  method: r.method, origin: r.origin, state: JSON.parse(r.state_json) as SummaryState, quality: JSON.parse(r.quality_json) as SummaryQuality,
  usage: JSON.parse(r.usage_json) as AgentUsage[], hasNativeState: r.native_json !== null, status: active === r.version ? 'active' : 'superseded',restoredFromVersion:r.restored_from,
})

export class AgentContextStore {
  readonly history: AgentHistoryStore
  constructor(readonly db: Database.Database) { this.history = new AgentHistoryStore(db) }
  session(uid: number, id: string) { return this.history.snapshot(uid, id, { limit: 1 }).session }
  transcript(uid: number, id: string) { return this.history.exportSession(uid, id) }
  preferences(uid: number, confirmedOnly = false): PreferenceCard[] {
    return (this.db.prepare("SELECT * FROM agent_preferences WHERE user_id = ? AND (? = 0 OR status = 'confirmed') ORDER BY updated_at, id").all(uid, confirmedOnly ? 1 : 0) as PrefRow[]).map(prefView)
  }
  preferenceHash(uid: number): string { return contextHash(this.preferences(uid, true)) }
  private preference(uid: number, id: string): PrefRow {
    const row = this.db.prepare('SELECT * FROM agent_preferences WHERE user_id = ? AND id = ?').get(uid, id) as PrefRow | undefined
    return row ?? contextError('NOT_FOUND', '这张偏好卡没有找到。', 404)
  }
  proposePreference(uid: number, p: { category: PreferenceCard['category']; value: string; sourceMessageId?: string }): PreferenceCard {
    return this.db.transaction(() => {
      if (this.preferences(uid).length >= CONTEXT_LIMITS.preferences) contextError('PREFERENCE_LIMIT', '偏好卡已到上限，先整理一下旧卡片吧。')
      if (p.sourceMessageId && !this.db.prepare('SELECT 1 FROM agent_messages WHERE user_id = ? AND id = ?').get(uid, p.sourceMessageId)) contextError('NOT_FOUND', '偏好来源消息没有找到。', 404)
      const id = randomUUID(), now = Date.now()
      this.db.prepare("INSERT INTO agent_preferences VALUES (?, ?, ?, ?, 'proposed', 1, ?, ?, ?, NULL)").run(id, uid, p.category, p.value.trim(), p.sourceMessageId ?? null, now, now)
      return prefView(this.preference(uid, id))
    }).immediate()
  }
  changePreference(uid: number, id: string, revision: number, operation: 'confirm' | 'edit' | 'delete', value?: string): PreferenceCard | null {
    return this.db.transaction(() => {
      const row = this.preference(uid, id)
      if (row.revision !== revision) contextError('REVISION_CONFLICT', '偏好卡已更新，请刷新后再确认。')
      if(operation==='confirm'&&row.status!=='confirmed'&&this.preferences(uid,true).length>=CONTEXT_LIMITS.confirmedPreferences) contextError('PREFERENCE_LIMIT','已确认偏好达到上限，请先整理旧卡片。')
      if (operation === 'delete') { this.db.prepare('DELETE FROM agent_preferences WHERE user_id = ? AND id = ?').run(uid, id); return null }
      const now = Date.now()
      this.db.prepare(`UPDATE agent_preferences SET value = ?, status = ?, revision = revision + 1, updated_at = ?, confirmed_at = ? WHERE user_id = ? AND id = ?`)
        .run(value?.trim() ?? row.value, operation === 'confirm' ? 'confirmed' : row.status, now, operation === 'confirm' || row.status === 'confirmed' ? now : row.confirmed_at, uid, id)
      return prefView(this.preference(uid, id))
    }).immediate()
  }
  settings(uid:number,id:string) { this.session(uid,id); return this.db.prepare('SELECT context_adaptive AS adaptive FROM agent_sessions WHERE user_id = ? AND id = ?').get(uid,id) as {adaptive:number} }
  assertRun(uid: number, id: string, runId?: string) {
    const row = this.db.prepare('SELECT run_id FROM agent_sessions WHERE user_id = ? AND id = ?').get(uid,id) as {run_id:string|null}|undefined
    if (runId && row?.run_id !== runId) contextError('CANCELLED', '这轮回复已结束，晚到的整理任务没有启动。')
    if (row?.run_id && row.run_id !== runId) contextError('SESSION_BUSY', '回复正在准备或执行，请先等它结束。')
  }
  setContext(uid: number, id: string, expectedRevision: number, change: { contextTier?: ContextTier; adaptive?:boolean; messageId?: string; pinned?: boolean }, runId?: string) {
    this.assertRun(uid,id,runId)
    return this.db.transaction(() => {
      const s = this.session(uid, id)
      if (s.revision !== expectedRevision) contextError('REVISION_CONFLICT', '手帐已更新，请刷新后再试。')
      if (this.activeJob(uid)) contextError('SESSION_BUSY', '上下文正在整理，先取消或等它完成吧。')
      if (change.contextTier) this.db.prepare('UPDATE agent_sessions SET context_tier = ?, context_adaptive = ? WHERE user_id = ? AND id = ?').run(change.contextTier, change.adaptive ? 1 : 0, uid, id)
      if (change.messageId) {
        if (!this.db.prepare('SELECT 1 FROM agent_messages WHERE user_id = ? AND session_id = ? AND id = ?').get(uid, id, change.messageId)) contextError('NOT_FOUND', '要固定的消息没有找到。', 404)
        this.db.prepare('UPDATE agent_messages SET pinned = ? WHERE user_id = ? AND session_id = ? AND id = ?').run(change.pinned ? 1 : 0, uid, id, change.messageId)
      }
      this.touch(uid, id)
      return this.session(uid, id)
    }).immediate()
  }
  private touch(uid: number, id: string) { this.db.prepare('UPDATE agent_sessions SET revision = revision + 1, last_event_seq = last_event_seq + 1, updated_at = MAX(updated_at + 1, ?) WHERE user_id = ? AND id = ?').run(Date.now(), uid, id) }
  versions(uid: number, id: string): ContextSummary[] {
    const s = this.session(uid, id)
    return (this.db.prepare('SELECT * FROM agent_context_versions WHERE user_id = ? AND session_id = ? ORDER BY version DESC').all(uid, id) as VersionRow[]).map(r => versionView(r, s.activeSummaryVersion))
  }
  version(uid: number, id: string, version: number) {
    const s = this.session(uid, id)
    const row = this.db.prepare('SELECT * FROM agent_context_versions WHERE user_id = ? AND session_id = ? AND version = ?').get(uid, id, version) as VersionRow | undefined
    if (!row) return contextError('NOT_FOUND', '这版摘要没有找到。', 404)
    return { view: versionView(row, s.activeSummaryVersion), native: row.native_json ? JSON.parse(row.native_json) as NativeWindow : null, profileHash: row.profile_hash, preferencesHash: row.preferences_hash }
  }
  active(uid: number, id: string) { const s = this.session(uid, id); return s.activeSummaryVersion === null ? null : this.version(uid, id, s.activeSummaryVersion) }
  retrieve(uid: number, id: string, question: string): HistoryMessage[] {
    this.session(uid, id)
    const searchText=question.length>480?question.slice(0,240)+' '+question.slice(-240):question
    const words = [...new Set((searchText.match(/[\p{L}\p{N}]{2,}/gu) ?? []).map(w=>Array.from(w).slice(0,64).join('')))].slice(0, 8)
    if (!words.length) return []
    const terms = words.flatMap(w => w.length <= 6 ? [w] : Array.from({ length: Math.min(w.length - 2, 8) }, (_, i) => w.slice(i, i + 3))).filter(w => w.length >= 3).slice(0, 16)
    const ids:{id:string}[]=[]
    for(const key of [...new Set(searchText.match(/[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}/g)??[])].slice(0,6)) {
      ids.push(...this.db.prepare(`SELECT m.id FROM agent_messages m WHERE user_id = ? AND session_id = ? AND
        (m.id = ? OR EXISTS (SELECT 1 FROM json_each(m.sources_json) WHERE json_extract(value,'$.sourceId') = ? OR CAST(json_extract(value,'$.bgmId') AS TEXT) = ?)
          OR EXISTS (SELECT 1 FROM json_each(m.actions_json) WHERE json_extract(value,'$.actionId') = ?)) ORDER BY seq DESC LIMIT ?`)
        .all(uid,id,key,key,key,key,CONTEXT_LIMITS.retrievalMessages) as {id:string}[])
      if(ids.length>=CONTEXT_LIMITS.retrievalMessages)break
    }
    if(terms.length&&ids.length<CONTEXT_LIMITS.retrievalMessages)ids.push(...this.db.prepare(`SELECT m.id FROM agent_transcript_fts f JOIN agent_messages m ON m.rowid = f.rowid
      WHERE agent_transcript_fts MATCH ? AND m.user_id = ? AND m.session_id = ? ORDER BY rank LIMIT ?`)
      .all(terms.map(t => '"' + t.replaceAll('"', '""') + '"').join(' OR '), uid, id, CONTEXT_LIMITS.retrievalMessages) as { id: string }[])
    if (!ids.length) {
      const word = words[0].replace(/[\\%_]/g, c => '\\' + c)
      ids.push(...this.db.prepare("SELECT id FROM agent_messages WHERE user_id = ? AND session_id = ? AND body LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT ?").all(uid, id, '%' + word + '%', CONTEXT_LIMITS.retrievalMessages) as { id: string }[])
    }
    const wanted = new Set(ids.map(r => r.id).slice(0,CONTEXT_LIMITS.retrievalMessages))
    return this.transcript(uid, id).messages.filter(m => wanted.has(m.id))
  }
  expireJobs() {
    this.db.transaction(() => {
      const stale = this.db.prepare(`SELECT * FROM agent_context_jobs WHERE stage IN (${activeStages}) AND expires_at <= ?`).all(Date.now()) as JobRow[]
      for (const r of stale) this.finishJob(r.user_id, r.id, 'failed', [], 'TIMEOUT')
    }).immediate()
  }
  activeJob(uid: number): CompactJob | null {
    this.expireJobs()
    const row = this.db.prepare(`SELECT * FROM agent_context_jobs WHERE user_id = ? AND stage IN (${activeStages})`).get(uid) as JobRow | undefined
    return row ? jobView(row) : null
  }
  job(uid: number, jobId: string): CompactJob {
    const row = this.db.prepare('SELECT * FROM agent_context_jobs WHERE user_id = ? AND id = ?').get(uid, jobId) as JobRow | undefined
    return row ? jobView(row) : contextError('NOT_FOUND', '这次压缩记录没有找到。', 404)
  }
  beginJob(uid: number, id: string, requestId: string, revision: number, trigger: CompactJob['trigger'], runId?: string) {
    this.assertRun(uid,id,runId)
    if (!matchesContract(HISTORY_ID_SCHEMA, requestId)) contextError('INVALID_ARGUMENT', '请求编号格式不正确。', 400)
    return this.db.transaction(() => {
      const s = this.session(uid, id)
      const existing = this.db.prepare('SELECT * FROM agent_context_jobs WHERE user_id = ? AND session_id = ? AND request_id = ?').get(uid, id, requestId) as JobRow | undefined
      if (existing) return { job: jobView(existing), fresh: false }
      if (s.revision !== revision) contextError('REVISION_CONFLICT', '手帐已更新，请刷新后再整理。')
      if (s.archivedAt !== null) contextError('SESSION_ARCHIVED', '先恢复这本手帐，再整理上下文吧。')
      if (this.activeJob(uid)) contextError('SESSION_BUSY', '还有一次压缩在进行中，请先等它完成。')
      if (this.db.prepare("SELECT 1 FROM agent_messages WHERE user_id = ? AND session_id = ? AND status = 'streaming'").get(uid, id)) contextError('SESSION_BUSY', '回复还在生成，结束后再整理吧。')
      const jobId = randomUUID(), now = Date.now()
      this.db.prepare(`INSERT INTO agent_context_jobs (id,user_id,session_id,request_id,trigger,stage,base_revision,created_at,updated_at,expires_at)
        VALUES (?,?,?,?,?,'queued',?,?,?,?)`).run(jobId, uid, id, requestId, trigger, s.revision + 1, now, now, now + CONTEXT_LIMITS.jobMs)
      this.db.prepare('UPDATE agent_sessions SET context_job_id = ? WHERE user_id = ? AND id = ?').run(jobId, uid, id); this.touch(uid, id)
      return { job: this.job(uid, jobId), fresh: true }
    }).immediate()
  }
  progress(uid: number, jobId: string, stage: CompactStage, usage: AgentUsage[]) {
    const j = this.job(uid, jobId)
    if (!isCompactActive(j.stage) || j.expiresAt <= Date.now()) contextError('CANCELLED', '这次压缩已结束，原有上下文仍然保留。')
    this.db.prepare('UPDATE agent_context_jobs SET stage = ?, usage_json = ?, updated_at = ? WHERE user_id = ? AND id = ?').run(stage, JSON.stringify(usage), Date.now(), uid, jobId)
  }
  finishJob(uid: number, jobId: string, stage: CompactStage, usage: AgentUsage[], error: string | null = null, version: number | null = null) {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM agent_context_jobs WHERE user_id = ? AND id = ?').get(uid, jobId) as JobRow | undefined
      if (!row || !isCompactActive(row.stage)) return
      this.db.prepare('UPDATE agent_context_jobs SET stage = ?, error_code = ?, summary_version = ?, usage_json = ?, updated_at = ? WHERE user_id = ? AND id = ?')
        .run(stage, error, version, JSON.stringify(usage), Date.now(), uid, jobId)
      this.db.prepare('UPDATE agent_sessions SET context_job_id = NULL WHERE user_id = ? AND id = ? AND context_job_id = ?').run(uid, row.session_id, jobId)
      this.touch(uid, row.session_id)
      this.db.prepare(`DELETE FROM agent_context_jobs WHERE user_id = ? AND session_id = ? AND id NOT IN
        (SELECT id FROM agent_context_jobs WHERE user_id = ? AND session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`)
        .run(uid, row.session_id, uid, row.session_id, CONTEXT_LIMITS.jobsPerSession)
    }).immediate()
  }
  saveVersion(uid: number, id: string, data: { revision: number; preferencesHash: string; state: SummaryState; quality: SummaryQuality; usage: AgentUsage[]; profileHash: string; provider: 'server' | 'byok'; model: string; method: ContextSummary['method']; native: NativeWindow | null; throughSeq: number; fromSeq: number; origin: ContextSummary['origin']; jobId?: string; restoredFromVersion?:number; validateSource?:()=>void }) {
    return this.db.transaction(() => {
      data.validateSource?.()
      const s = this.session(uid, id)
      if (s.revision !== data.revision || this.preferenceHash(uid) !== data.preferencesHash) contextError('STALE_CONTEXT', '资料或偏好已更新，这次整理没有覆盖原有上下文。')
      if (data.jobId && !isCompactActive(this.job(uid, data.jobId).stage)) contextError('CANCELLED', '这次压缩已取消。')
      const state = JSON.stringify(data.state), native = data.native ? JSON.stringify(data.native) : null
      const bytes = Buffer.byteLength(state + (native ?? '') + JSON.stringify(data.usage) + JSON.stringify(data.quality))
      if (Buffer.byteLength(state) > CONTEXT_LIMITS.summaryBytes || (native && Buffer.byteLength(native) > CONTEXT_LIMITS.nativeBytes)) contextError('CONTEXT_TOO_LARGE', '摘要仍然太大，原有上下文保持不变。')
      const usage = this.db.prepare('SELECT COALESCE(SUM(context_bytes),0) AS n,COALESCE(SUM(stored_bytes+context_bytes+run_bytes),0) AS total,MAX(run_id IS NOT NULL) AS active FROM agent_sessions WHERE user_id = ?').get(uid) as { n: number; total: number; active: number }
      if (usage.n + bytes > CONTEXT_LIMITS.contextBytesPerUser || usage.total + bytes + (usage.active ? 2048 : 0) > HISTORY_LIMITS.bytesPerUser) contextError('CONTEXT_LIMIT', '摘要存储已到上限，原有历史仍然保留。')
      const serial = this.db.prepare('SELECT context_version_seq AS n FROM agent_sessions WHERE user_id = ? AND id = ?').get(uid, id) as { n: number }
      const version = serial.n + 1
      this.db.prepare(`INSERT INTO agent_context_versions (user_id,session_id,version,parent_version,created_at,from_seq,through_seq,provider,model,method,origin,
        state_json,quality_json,usage_json,native_json,profile_hash,preferences_hash,bytes,restored_from) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(uid,id,version,s.activeSummaryVersion,Date.now(),data.fromSeq,data.throughSeq,data.provider,data.model,data.method,data.origin,state,JSON.stringify(data.quality),JSON.stringify(data.usage),native,data.profileHash,data.preferencesHash,bytes,data.restoredFromVersion??null)
      this.db.prepare('UPDATE agent_sessions SET active_summary_version = ?, context_version_seq = ?, context_bytes = context_bytes + ? WHERE user_id = ? AND id = ?').run(version,version,bytes,uid,id)
      if(data.origin!=='restore') this.db.prepare('UPDATE agent_sessions SET provider = ?, model = ? WHERE user_id = ? AND id = ?').run(data.provider,data.model,uid,id)
      this.touch(uid,id)
      const old = this.db.prepare('SELECT version, bytes FROM agent_context_versions WHERE user_id = ? AND session_id = ? ORDER BY version DESC LIMIT -1 OFFSET ?').all(uid,id,CONTEXT_LIMITS.versionsPerSession) as {version:number;bytes:number}[]
      for(const r of old) { this.db.prepare('DELETE FROM agent_context_versions WHERE user_id = ? AND session_id = ? AND version = ?').run(uid,id,r.version); this.db.prepare('UPDATE agent_sessions SET context_bytes = context_bytes - ? WHERE user_id = ? AND id = ?').run(r.bytes,uid,id) }
      return this.version(uid,id,version).view
    }).immediate()
  }
  exportContext(uid: number,id: string) {
    return { summaries: this.versions(uid,id), compactions: (this.db.prepare('SELECT * FROM agent_context_jobs WHERE user_id = ? AND session_id = ? ORDER BY created_at').all(uid,id) as JobRow[]).map(jobView) }
  }
}
