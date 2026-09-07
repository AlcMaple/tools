import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { AgentHistoryStore } from './history-store'
import { knowledgeHash, type KnowledgeSnapshot } from './knowledge'
import { AGENT_LIMITS } from './policy'
import { AgentRunError, RUN_LIMITS, type RunCheckpoint, type RunEvent, type RunEventKind, type RunState, type RunView, type StartRun, type ResumeRun } from '../../shared/agent-run'
import { HISTORY_LIMITS, type AssistantMessageContent } from '../../shared/agent-history'
import type { JsonValue } from '../../shared/agent-contracts'

export function initializeAgentRunSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
    user_message_id TEXT NOT NULL, message_id TEXT, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, rounds INTEGER NOT NULL DEFAULT 0,
    active_ms INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    lease_until INTEGER NOT NULL, last_event_seq INTEGER NOT NULL DEFAULT 0, code TEXT, auth_version INTEGER NOT NULL,
    knowledge_json TEXT NOT NULL, client_version TEXT, checkpoint_json TEXT NOT NULL, stored_bytes INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id,session_id,request_id), UNIQUE(user_id,id),
    FOREIGN KEY(user_id,session_id) REFERENCES agent_sessions(user_id,id) ON DELETE CASCADE);
    CREATE UNIQUE INDEX IF NOT EXISTS agent_run_active_user ON agent_runs(user_id) WHERE state='running';
    CREATE TABLE IF NOT EXISTS agent_run_events (
      user_id INTEGER NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(run_id,seq), FOREIGN KEY(user_id,run_id) REFERENCES agent_runs(user_id,id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS agent_run_resumes (
      user_id INTEGER NOT NULL, run_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      PRIMARY KEY(run_id,request_id), FOREIGN KEY(user_id,run_id) REFERENCES agent_runs(user_id,id) ON DELETE CASCADE);
    CREATE TRIGGER IF NOT EXISTS agent_run_clear AFTER UPDATE OF context_generation ON agent_sessions
      WHEN NEW.context_generation != OLD.context_generation BEGIN
      DELETE FROM agent_runs WHERE user_id=NEW.user_id AND session_id=NEW.id;
      UPDATE agent_sessions SET run_id=NULL,run_bytes=0 WHERE id=NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS agent_run_remove AFTER DELETE ON agent_runs BEGIN
      UPDATE agent_sessions SET run_bytes=MAX(0,run_bytes-OLD.stored_bytes),run_id=CASE WHEN run_id=OLD.id THEN NULL ELSE run_id END
      WHERE id=OLD.session_id AND user_id=OLD.user_id; END;`)
}
export interface RunRow {
  id: string; user_id: number; session_id: string; request_id: string; request_hash: string; user_message_id: string; message_id: string | null
  state: RunState; attempt: number; rounds: number; active_ms: number; started_at: number; created_at: number; updated_at: number
  lease_until: number; last_event_seq: number; code: string | null; auth_version: number; knowledge_json: string
  client_version: string | null; checkpoint_json: string; stored_bytes: number
}
const emptyCheckpoint = (): RunCheckpoint => ({ results: [], inFlight: null, pendingCalls: [], usage: [] })
export class AgentRunStore {
  private readonly listeners = new Map<string,Set<()=>void>>()
  subscribe(id:string,listener:()=>void) {
    const listeners=this.listeners.get(id)??new Set<()=>void>();listeners.add(listener);this.listeners.set(id,listeners)
    return ()=>{listeners.delete(listener);if(!listeners.size)this.listeners.delete(id)}
  }
  constructor(readonly db: Database.Database, readonly now: () => number = Date.now) {}
  history(runId?: string) { return new AgentHistoryStore(this.db, HISTORY_LIMITS, runId) }
  row(uid: number, id: string): RunRow {
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE user_id=? AND id=?').get(uid,id) as RunRow | undefined
    if (!row) throw new AgentRunError('NOT_FOUND', 404)
    return row
  }
  view(row: RunRow): RunView {
    return { id: row.id, sessionId: row.session_id, state: row.state, messageId: row.message_id, userMessageId: row.user_message_id,
      attempt: row.attempt, rounds: row.rounds, activeMs: row.active_ms + (row.state === 'running' ? Math.max(0,this.now()-row.started_at) : 0),
      createdAt: row.created_at, updatedAt: row.updated_at, lastEventSeq: row.last_event_seq, code: row.code,
      knowledgeVersion: (JSON.parse(row.knowledge_json) as KnowledgeSnapshot).version,
      canResume: row.state === 'paused' && row.active_ms < AGENT_LIMITS.cumulativeTaskMs }
  }
  list(uid:number,sessionId:string,input:{limit?:number;beforeCreatedAt?:number;beforeId?:string}={}) {
    this.recover();this.history().snapshot(uid,sessionId,{limit:1})
    const limit=input.limit??30
    if(!Number.isSafeInteger(limit)||limit<1||limit>50||(input.beforeCreatedAt===undefined)!==(input.beforeId===undefined)
      ||(input.beforeCreatedAt!==undefined&&(!Number.isSafeInteger(input.beforeCreatedAt)||input.beforeCreatedAt<0))
      ||(input.beforeId!==undefined&&!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(input.beforeId)))throw new AgentRunError('INVALID_CURSOR',400)
    const rows=this.db.prepare(`SELECT * FROM agent_runs WHERE user_id=? AND session_id=? AND
      (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(uid,sessionId,input.beforeCreatedAt??null,input.beforeCreatedAt??null,input.beforeCreatedAt??null,input.beforeId??'',limit+1) as RunRow[]
    const page=rows.slice(0,limit),last=page.at(-1)
    return{runs:page.map(row=>this.view(row)),nextCursor:rows.length>limit&&last?{beforeCreatedAt:last.created_at,beforeId:last.id}:null}
  }
  checkpoint(row: RunRow): RunCheckpoint { return JSON.parse(row.checkpoint_json) as RunCheckpoint }
  knowledge(row: RunRow): KnowledgeSnapshot { return JSON.parse(row.knowledge_json) as KnowledgeSnapshot }
  assertActive(row: RunRow, attempt?: number) {
    if (row.state !== 'running' || (attempt !== undefined && row.attempt !== attempt)) throw new AgentRunError('CANCELLED')
    const session = this.db.prepare('SELECT run_id FROM agent_sessions WHERE user_id=? AND id=?').get(row.user_id,row.session_id) as {run_id:string|null}|undefined
    if (session?.run_id !== row.id) throw new AgentRunError('CANCELLED')
  }
  assertIdentity(uid:number,tv:number) {
    const row=this.db.prepare('SELECT token_version FROM users WHERE id=?').get(uid) as {token_version:number}|undefined
    if(!row||row.token_version!==tv)throw new AgentRunError('AUTH_REQUIRED',401)
  }
  private space(row: RunRow, delta: number, terminal = false) {
    const reserve = terminal ? 0 : 2048
    const total = this.db.prepare('SELECT COALESCE(SUM(run_bytes),0) AS runs,COALESCE(SUM(stored_bytes+context_bytes+run_bytes),0) AS allBytes FROM agent_sessions WHERE user_id=?').get(row.user_id) as {runs:number;allBytes:number}
    if (row.stored_bytes + delta > RUN_LIMITS.bytesPerRun-reserve || total.runs + delta > RUN_LIMITS.bytesPerUser-reserve || total.allBytes + delta > HISTORY_LIMITS.bytesPerUser-reserve) throw new AgentRunError('RUN_STORAGE_LIMIT')
    this.db.prepare('UPDATE agent_runs SET stored_bytes=stored_bytes+? WHERE user_id=? AND id=?').run(delta,row.user_id,row.id)
    this.db.prepare('UPDATE agent_sessions SET run_bytes=run_bytes+? WHERE user_id=? AND id=?').run(delta,row.user_id,row.session_id)
  }
  event(uid: number, id: string, type: RunEventKind, data: JsonValue, terminal = false): RunEvent {
    const event = this.db.transaction(() => {
      const row = this.row(uid,id), encoded = JSON.stringify(data), bytes = Buffer.byteLength(encoded)
      if (bytes > RUN_LIMITS.eventBytes || row.last_event_seq >= RUN_LIMITS.eventsPerRun-(terminal?0:4)) throw new AgentRunError('RUN_STORAGE_LIMIT')
      this.space(row,bytes+64,terminal)
      const seq = row.last_event_seq+1, now = this.now()
      this.db.prepare('INSERT INTO agent_run_events VALUES(?,?,?,?,?,?)').run(uid,id,seq,type,encoded,now)
      this.db.prepare('UPDATE agent_runs SET last_event_seq=?,updated_at=? WHERE user_id=? AND id=?').run(seq,now,uid,id)
      return {runId:id,seq,type,data,createdAt:now}
    }).immediate()
    for(const listener of this.listeners.get(id)??[])listener()
    return event
  }
  events(uid: number, id: string, after: number): RunEvent[] {
    const row = this.row(uid,id)
    if (!Number.isSafeInteger(after) || after < 0 || after > row.last_event_seq) throw new AgentRunError('INVALID_CURSOR',400)
    return (this.db.prepare('SELECT seq,type,data_json,created_at FROM agent_run_events WHERE user_id=? AND run_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(uid,id,after,RUN_LIMITS.eventPage) as {seq:number;type:RunEventKind;data_json:string;created_at:number}[])
      .map(e=>({runId:id,seq:e.seq,type:e.type,data:JSON.parse(e.data_json) as JsonValue,createdAt:e.created_at}))
  }
  begin(uid: number, sessionId: string, p: StartRun, knowledge: KnowledgeSnapshot, authVersion: number) {
    return this.db.transaction(() => {
      this.assertIdentity(uid,authVersion)
      const requestHash = knowledgeHash({body:p.body,clientVersion:p.clientVersion??null})
      const existing = this.db.prepare('SELECT * FROM agent_runs WHERE user_id=? AND session_id=? AND request_id=?').get(uid,sessionId,p.requestId) as RunRow|undefined
      if (existing) { if(existing.request_hash!==requestHash) throw new AgentRunError('IDEMPOTENCY_CONFLICT'); return {row:existing,fresh:false} }
      if (this.db.prepare("SELECT 1 FROM agent_runs WHERE user_id=? AND state='running'").get(uid)) throw new AgentRunError('RUN_BUSY')
      if (this.db.prepare('SELECT 1 FROM agent_sessions WHERE user_id=? AND context_job_id IS NOT NULL').get(uid)) throw new AgentRunError('SESSION_BUSY')
      const session = this.history().snapshot(uid,sessionId,{limit:1}).session
      if (session.revision!==p.expectedRevision) throw new AgentRunError('REVISION_CONFLICT')
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE user_id=? AND session_id=?').get(uid,sessionId) as {n:number}
      if (count.n >= RUN_LIMITS.runsPerSession) throw new AgentRunError('RUN_STORAGE_LIMIT')
      const id=randomUUID(), now=this.now(), history=this.history(id)
      const user=history.appendUser(uid,sessionId,{requestId:randomUUID(),expectedRevision:p.expectedRevision,body:p.body})
      this.db.prepare(`INSERT INTO agent_runs(id,user_id,session_id,request_id,request_hash,user_message_id,state,started_at,created_at,updated_at,lease_until,auth_version,knowledge_json,client_version,checkpoint_json)
        VALUES(?,?,?,?,?,?,'running',?,?,?,?,?,?,?,?)`).run(id,uid,sessionId,p.requestId,requestHash,user.message.id,now,now,now,now+RUN_LIMITS.leaseMs,authVersion,JSON.stringify(knowledge),p.clientVersion??null,JSON.stringify(emptyCheckpoint()))
      this.db.prepare('UPDATE agent_sessions SET run_id=? WHERE user_id=? AND id=?').run(id,uid,sessionId)
      this.space(this.row(uid,id),Buffer.byteLength(JSON.stringify(knowledge))+512)
      this.event(uid,id,'started',{attempt:1})
      return {row:this.row(uid,id),fresh:true}
    }).immediate()
  }
  resume(uid: number, id: string, p: ResumeRun, knowledge: KnowledgeSnapshot, authVersion: number) {
    return this.db.transaction(() => {
      this.assertIdentity(uid,authVersion)
      const row=this.row(uid,id), hash=knowledgeHash({clientVersion:p.clientVersion??null})
      const prior=this.db.prepare('SELECT request_hash FROM agent_run_resumes WHERE user_id=? AND run_id=? AND request_id=?').get(uid,id,p.requestId) as {request_hash:string}|undefined
      if(prior){if(prior.request_hash!==hash)throw new AgentRunError('IDEMPOTENCY_CONFLICT');return{row,fresh:false}}
      if(!this.view(row).canResume)throw new AgentRunError('CONTINUE_REQUIRED')
      if(row.auth_version!==authVersion)throw new AgentRunError('AUTH_REQUIRED',401)
      const session=this.history().snapshot(uid,row.session_id,{limit:1}).session
      if(session.revision!==p.expectedRevision)throw new AgentRunError('REVISION_CONFLICT')
      if(session.archivedAt!==null)throw new AgentRunError('SESSION_ARCHIVED')
      if(this.db.prepare("SELECT 1 FROM agent_runs WHERE user_id=? AND state='running'").get(uid)
        ||this.db.prepare('SELECT 1 FROM agent_sessions WHERE user_id=? AND context_job_id IS NOT NULL').get(uid))throw new AgentRunError('RUN_BUSY')
      if(this.db.prepare("SELECT 1 FROM agent_messages WHERE user_id=? AND session_id=? AND (status='streaming' OR pending_actions=1)").get(uid,row.session_id))throw new AgentRunError('SESSION_BUSY')
      const newest=this.db.prepare("SELECT id FROM agent_messages WHERE user_id=? AND session_id=? AND role='user' ORDER BY seq DESC LIMIT 1").get(uid,row.session_id) as {id:string}
      if(newest.id!==row.user_message_id)throw new AgentRunError('STALE_TURN')
      const now=this.now(), checkpoint=this.checkpoint(row)
      checkpoint.inFlight=null;checkpoint.pendingCalls=[];checkpoint.usage=[]
      if(knowledge.version!==this.knowledge(row).version)checkpoint.results=[]
      const encoded=JSON.stringify(checkpoint)
      this.space(row,Buffer.byteLength(encoded)-Buffer.byteLength(row.checkpoint_json)+Buffer.byteLength(JSON.stringify(knowledge))-Buffer.byteLength(row.knowledge_json)+256)
      this.db.prepare("UPDATE agent_runs SET state='running',attempt=attempt+1,rounds=0,message_id=NULL,code=NULL,started_at=?,lease_until=?,updated_at=?,knowledge_json=?,client_version=?,checkpoint_json=? WHERE user_id=? AND id=?")
        .run(now,now+RUN_LIMITS.leaseMs,now,JSON.stringify(knowledge),p.clientVersion??null,encoded,uid,id)
      this.db.prepare('INSERT INTO agent_run_resumes VALUES(?,?,?,?)').run(uid,id,p.requestId,hash)
      this.db.prepare('UPDATE agent_sessions SET run_id=? WHERE user_id=? AND id=?').run(id,uid,row.session_id)
      this.event(uid,id,'resumed',{attempt:row.attempt+1})
      return{row:this.row(uid,id),fresh:true}
    }).immediate()
  }
  save(uid:number,id:string,attempt:number,checkpoint:RunCheckpoint,rounds?:number){
    this.db.transaction(()=>{
      const row=this.row(uid,id);this.assertActive(row,attempt)
      const encoded=JSON.stringify(checkpoint)
      if(Buffer.byteLength(encoded)>RUN_LIMITS.checkpointBytes)throw new AgentRunError('RUN_STORAGE_LIMIT')
      this.space(row,Buffer.byteLength(encoded)-Buffer.byteLength(row.checkpoint_json))
      this.db.prepare('UPDATE agent_runs SET checkpoint_json=?,rounds=?,updated_at=? WHERE user_id=? AND id=?').run(encoded,rounds??row.rounds,this.now(),uid,id)
    }).immediate()
  }
  writeMessage(uid:number,id:string,attempt:number,content:AssistantMessageContent){
    return this.db.transaction(()=>{
      const row=this.row(uid,id);this.assertActive(row,attempt)
      const history=this.history(id),session=history.snapshot(uid,row.session_id,{limit:1}).session
      const result=row.message_id ? history.updateAssistant(uid,row.session_id,row.message_id,{...content,expectedRevision:session.revision})
        :history.appendAssistant(uid,row.session_id,{...content,requestId:randomUUID(),expectedRevision:session.revision})
      this.db.prepare('UPDATE agent_runs SET message_id=? WHERE user_id=? AND id=?').run(result.message.id,uid,id)
      return result.message
    }).immediate()
  }
  finish(uid:number,id:string,state:Exclude<RunState,'running'>,code:string|null){
    return this.db.transaction(()=>{
      const row=this.row(uid,id)
      if(row.state!=='running')return this.view(row)
      if(row.message_id){
        const transcript=this.history(id).exportSession(uid,row.session_id), message=transcript.messages.find(m=>m.id===row.message_id)
        if(message?.status==='streaming')this.history(id).updateAssistant(uid,row.session_id,row.message_id,{body:message.body,sources:message.sources,toolSummaries:message.toolSummaries,actions:message.actions,usage:message.usage,
          expectedRevision:transcript.session.revision,status:state==='completed'?'completed':state==='cancelled'?'cancelled':'failed'})
      }
      this.db.prepare('UPDATE agent_runs SET state=?,code=?,active_ms=active_ms+?,updated_at=?,lease_until=0 WHERE user_id=? AND id=?')
        .run(state,code,Math.max(0,this.now()-row.started_at),this.now(),uid,id)
      this.db.prepare('UPDATE agent_sessions SET run_id=NULL WHERE user_id=? AND id=? AND run_id=?').run(uid,row.session_id,id)
      this.event(uid,id,state,{code,attempt:row.attempt},true)
      return this.view(this.row(uid,id))
    }).immediate()
  }
  renew(uid:number,id:string,attempt:number){const row=this.row(uid,id);this.assertActive(row,attempt);this.db.prepare('UPDATE agent_runs SET lease_until=? WHERE user_id=? AND id=?').run(this.now()+RUN_LIMITS.leaseMs,uid,id)}
  recover(){
    const stale=this.db.prepare("SELECT * FROM agent_runs WHERE state='running' AND lease_until<=?").all(this.now()) as RunRow[]
    for(const row of stale)this.finish(row.user_id,row.id,'paused','INTERRUPTED')
  }
}
