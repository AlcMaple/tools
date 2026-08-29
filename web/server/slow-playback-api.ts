import { Hono } from 'hono'
import { getSession } from './auth'
import {
  admissionStatus,
  heartbeatAdmission,
  releaseAdmission,
  requestAdmission,
  SlowQueueClosed,
} from './slow-playback'

const slowPlayback = new Hono()

slowPlayback.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})

slowPlayback.post('/request', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  try {
    return c.json(requestAdmission(session.uid, {
      poolId: typeof body?.poolId === 'string' ? body.poolId : '',
      source: typeof body?.source === 'string' ? body.source : '',
      resourceKey: typeof body?.resourceKey === 'string' ? body.resourceKey : '',
      returnTo: typeof body?.returnTo === 'string' ? body.returnTo : '/',
      clientId: typeof body?.clientId === 'string' ? body.clientId : '',
    }))
  } catch (error) {
    if (error instanceof SlowQueueClosed) return c.json({ error: error.message }, 503)
    return c.json({ error: error instanceof Error ? error.message : '候补失败' }, 400)
  }
})

slowPlayback.get('/status', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const poolId = c.req.query('poolId') ?? ''
  const clientId = c.req.query('clientId') ?? ''
  if (!/^[a-z0-9-]{3,64}$/.test(poolId)) return c.json({ error: '容量池不合法' }, 400)
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(clientId)) return c.json({ error: '播放器会话不合法' }, 400)
  return c.json({ admission: admissionStatus(session.uid, poolId, clientId) })
})

slowPlayback.post('/heartbeat', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const body = await c.req.json().catch(() => null) as { poolId?: unknown; clientId?: unknown; paused?: unknown } | null
  const poolId = typeof body?.poolId === 'string' ? body.poolId : ''
  const clientId = typeof body?.clientId === 'string' ? body.clientId : ''
  if (!/^[a-z0-9-]{3,64}$/.test(poolId)) return c.json({ error: '容量池不合法' }, 400)
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(clientId)) return c.json({ error: '播放器会话不合法' }, 400)
  return c.json({ admission: heartbeatAdmission(session.uid, poolId, clientId, body?.paused === true) })
})

slowPlayback.post('/release', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const body = await c.req.json().catch(() => null) as { poolId?: unknown; clientId?: unknown } | null
  const poolId = typeof body?.poolId === 'string' ? body.poolId : ''
  const clientId = typeof body?.clientId === 'string' ? body.clientId : ''
  if (!/^[a-z0-9-]{3,64}$/.test(poolId)) return c.json({ error: '容量池不合法' }, 400)
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(clientId)) return c.json({ error: '播放器会话不合法' }, 400)
  releaseAdmission(session.uid, poolId, clientId)
  return c.json({ ok: true })
})

export default slowPlayback
