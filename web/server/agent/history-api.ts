import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { db } from '../db'
import { getSession, rateLimited } from '../auth'
import { AgentHistoryError, HISTORY_LIMITS } from '../../shared/agent-history'
import { AgentHistoryStore } from './history-store'

const history = new Hono<{ Variables: { agentUid: number } }>()
export const agentHistoryStore = new AgentHistoryStore(db)

history.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  const session = await getSession(c)
  if (!session) return c.json({ code: 'AUTH_REQUIRED', error: '先登录，再来翻这本手帐吧。' }, 401)
  c.set('agentUid', session.uid)
  const operation = c.req.method === 'GET' ? 'read' : 'write'
  if (rateLimited(`agent-history:${operation}:${session.uid}`, operation === 'read' ? 120 : 30, 60_000)) {
    c.header('Retry-After', '60')
    return c.json({ code: 'RATE_LIMITED', error: '翻写得有点快，稍等一下再来吧。' }, 429)
  }
  await next()
})

history.use('*', bodyLimit({ maxSize: HISTORY_LIMITS.requestBytes, onError: c => c.json({ code: 'MESSAGE_TOO_LARGE', error: '这条消息太长啦，请分几次保存。' }, 413) }))
history.onError((error, c) => {
  if (error instanceof AgentHistoryError) return c.json({ code: error.code, error: error.message }, error.status)
  throw error
})

async function body(c: Context): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(c.req.header('content-type') ?? '')) {
    throw new AgentHistoryError('INVALID_ARGUMENT', 400, '请使用 JSON 格式保存这页手帐。')
  }
  try { return await c.req.json() } catch { throw new AgentHistoryError('INVALID_ARGUMENT', 400, '消息格式没有读懂，请检查后再试。') }
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
history.get('/sessions/:sessionId', c => c.json(agentHistoryStore.snapshot(c.get('agentUid'), c.req.param('sessionId'), query(c, ['limit', 'beforeSeq', 'afterSeq']))))
history.patch('/sessions/:sessionId', async c => c.json({ session: agentHistoryStore.patchSession(c.get('agentUid'), c.req.param('sessionId'), await body(c)) }))
history.post('/sessions/:sessionId/messages', async c => c.json(agentHistoryStore.appendUser(c.get('agentUid'), c.req.param('sessionId'), await body(c)), 201))
history.post('/sessions/:sessionId/clear', async c => c.json({ session: agentHistoryStore.clearSession(c.get('agentUid'), c.req.param('sessionId'), await body(c)) }))
history.delete('/sessions/:sessionId', async c => c.json(agentHistoryStore.deleteSession(c.get('agentUid'), c.req.param('sessionId'), await body(c))))
history.get('/sessions/:sessionId/export', c => {
  if (Object.keys(c.req.query()).length) throw new AgentHistoryError('INVALID_ARGUMENT', 400, '导出整本手帐时不用填写筛选条件。')
  const uid = c.get('agentUid')
  if (rateLimited(`agent-history:export:${uid}`, 2, 60_000)) {
    c.header('Retry-After', '60')
    return c.json({ code: 'RATE_LIMITED', error: '刚刚已导出过，稍等一下再试吧。' }, 429)
  }
  const exported = agentHistoryStore.exportSession(uid, c.req.param('sessionId'))
  c.header('Content-Disposition', `attachment; filename="agent-history-${exported.session.id}.json"`)
  return c.json(exported)
})

export default history
