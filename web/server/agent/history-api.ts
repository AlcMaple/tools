import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { db } from '../db'
import { getSession, rateLimited } from '../auth'
import { AgentHistoryError, HISTORY_LIMITS, USER_MESSAGE_SCHEMA, type AppendUserMessage } from '../../shared/agent-history'
import { AgentHistoryStore } from './history-store'
import { createAgentContextApi } from './context-api'
import { agentContextService, agentContextStore } from './context-runtime'
import { AgentRunError } from '../../shared/agent-run'
import { externalError,createExternalApi } from './external-api'
import { matchesContract } from './validation'
import { createAgentRunApi } from './run-api'
import { agentActionStore, agentPlaybackStore, agentRunService, currentAgentKnowledge } from './run-runtime'

const history = new Hono<{ Variables: { agentUid: number } }>()
export const agentHistoryStore = new AgentHistoryStore(db)

history.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  const session = await getSession(c)
  if (!session) return c.json({ code: 'AUTH_REQUIRED', error: '先登录，再来翻这本手帐吧。' }, 401)
  c.set('agentUid', session.uid)
  c.header('X-Agent-Owner',String(session.uid))
  const operation = c.req.method === 'GET' ? 'read' : 'write'
  if (rateLimited(`agent-history:${operation}:${session.uid}`, operation === 'read' ? 120 : 30, 60_000)) {
    c.header('Retry-After', '60')
    return c.json({ code: 'RATE_LIMITED', error: '翻写得有点快，稍等一下再来吧。' }, 429)
  }
  await next()
})

history.use('*', bodyLimit({ maxSize: HISTORY_LIMITS.requestBytes, onError: c => c.json({ code: 'MESSAGE_TOO_LARGE', error: '这条消息太长啦，请分几次保存。' }, 413) }))
history.onError((error, c) => {
  if (error instanceof AgentRunError) return c.json(externalError(error),error.status)
  if (error instanceof AgentHistoryError) return c.json({ code: error.code, error: error.message }, error.status)
  throw error
})

async function body(c: Context): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(c.req.header('content-type') ?? '')) {
    throw new AgentHistoryError('INVALID_ARGUMENT', 400, '请使用 JSON 格式保存这页手帐。')
  }
  try { return await c.req.json() } catch { throw new AgentHistoryError('INVALID_ARGUMENT', 400, '消息格式没有读懂，请检查后再试。') }
}

// ?include=a,b —— 返回 include 列表和一份**不含 include** 的查询(下游 schema 是 additionalProperties:false)。
// query() 用 defineProperty 建的属性不可配置,删不掉,所以这里重建一份而不是 delete。
function extras(q: Record<string, unknown>, allowed: readonly string[]): { include: string[]; rest: Record<string, unknown> } {
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(q)) if (key !== 'include') Object.defineProperty(rest, key, { value, enumerable: true })
  if (q.include === undefined) return { include: [], rest }
  const include = String(q.include).split(',').filter(Boolean)
  if (!include.length || include.some(name => !allowed.includes(name))) throw new AgentHistoryError('INVALID_ARGUMENT', 400, '这个附加内容读不出来。')
  return { include, rest }
}
// 与 GET /sessions/:id/context 返回同一份视图(见 context-api),合并读取时复用。
function contextView(uid: number, id: string) {
  agentContextService.expire()
  return { session: agentContextStore.session(uid, id), adaptive: Boolean(agentContextStore.settings(uid, id).adaptive),
    active: agentContextStore.active(uid, id)?.view ?? null,
    versions: agentContextStore.versions(uid, id).map(({ state, ...meta }) => meta), job: agentContextStore.activeJob(uid) }
}
function query(c: Context, numeric: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, values] of Object.entries(c.req.queries())) {
    if (values.length !== 1) throw new AgentHistoryError('INVALID_ARGUMENT', 400, '同一个筛选条件只填写一次吧。')
    const value = values[0]
    if (numeric.includes(key)) {
      if (!/^(0|[1-9]\d*)$/.test(value)) throw new AgentHistoryError('INVALID_ARGUMENT', 400, '页码和数量请填写完整的非负整数。')
      result[key] = Number(value)
    } else {
      Object.defineProperty(result, key, { value, enumerable: true })
    }
  }
  return result
}

history.get('/sessions', c => c.json(agentHistoryStore.listSessions(c.get('agentUid'), query(c, ['limit', 'beforeUpdatedAt']))))
history.post('/sessions', async c => c.json({ session: agentHistoryStore.createSession(c.get('agentUid'), await body(c)) }, 201))
// 打开一个会话 = 一次请求。正文、上下文、最近回合是同一屏的三块,合并读取。
history.get('/sessions/:sessionId', c => {
  const uid = c.get('agentUid'), id = c.req.param('sessionId')
  const { include, rest } = extras(query(c, ['limit', 'beforeSeq', 'afterSeq']), ['context', 'runs'])
  const snapshot = agentHistoryStore.snapshot(uid, id, rest)
  if (!include.length) return c.json(snapshot)
  return c.json({ ...snapshot,
    ...include.includes('context') ? { context: contextView(uid, id) } : {},
    ...include.includes('runs') ? { runs: agentRunService.store.list(uid, id, { limit: 1 }).runs } : {} })
})
history.patch('/sessions/:sessionId', async c => c.json({ session: agentHistoryStore.patchSession(c.get('agentUid'), c.req.param('sessionId'), await body(c)) }))
history.post('/sessions/:sessionId/messages', async c => {
  const value=await body(c)
  if(matchesContract(USER_MESSAGE_SCHEMA,value)&&(value as AppendUserMessage).body.trim()==='/compact'){
    const p=value as AppendUserMessage,job=agentContextService.start(c.get('agentUid'),c.req.param('sessionId'),p)
    try{c.executionCtx.waitUntil(agentContextService.wait(job.id))}catch{}
    return c.json({command:'/compact',job},202)
  }
  return c.json(agentHistoryStore.appendUser(c.get('agentUid'),c.req.param('sessionId'),value),201)
})
history.post('/sessions/:sessionId/clear', async c => c.json({ session: agentHistoryStore.clearSession(c.get('agentUid'), c.req.param('sessionId'), await body(c)) }))
history.post('/sessions/:sessionId/truncate', async c => c.json({ session: agentHistoryStore.truncateSession(c.get('agentUid'), c.req.param('sessionId'), await body(c)) }))
history.delete('/sessions/:sessionId', async c => c.json(agentHistoryStore.deleteSession(c.get('agentUid'), c.req.param('sessionId'), await body(c))))
history.get('/sessions/:sessionId/export', c => {
  if (Object.keys(c.req.query()).length) throw new AgentHistoryError('INVALID_ARGUMENT', 400, '导出整本手帐时不用填写筛选条件。')
  const uid = c.get('agentUid')
  if (rateLimited(`agent-history:export:${uid}`, 2, 60_000)) {
    c.header('Retry-After', '60')
    return c.json({ code: 'RATE_LIMITED', error: '刚刚已导出过，稍等一下再试吧。' }, 429)
  }
  const exported = db.transaction(()=>({...agentHistoryStore.exportSession(uid,c.req.param('sessionId')),context:agentContextStore.exportContext(uid,c.req.param('sessionId'))}))()
  c.header('Content-Disposition', `attachment; filename="agent-history-${exported.session.id}.json"`)
  return c.json(exported)
})

history.route('/provider',createExternalApi())
history.route('/',createAgentRunApi(agentRunService,currentAgentKnowledge,agentActionStore,agentPlaybackStore))
history.route('/',createAgentContextApi(agentContextService))

export default history
