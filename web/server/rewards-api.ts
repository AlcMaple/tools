import { Hono } from 'hono'
import { getSession, rateLimited } from './auth'
import {
  draw,
  existingDrawResult,
  lotteryEnabled,
  redeem,
  RewardError,
  rewardSummary,
  rewardsEnabled,
} from './rewards'

const rewards = new Hono()

rewards.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})

rewards.get('/me', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  return c.json({
    enabled: rewardsEnabled(session.uid),
    lotteryEnabled: lotteryEnabled(session.uid),
    ...rewardSummary(session.uid),
  })
})

rewards.post('/redeem', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const body = await c.req.json().catch(() => null) as { requestId?: unknown; item?: unknown } | null
  try {
    return c.json(redeem(
      session.uid,
      typeof body?.requestId === 'string' ? body.requestId : '',
      typeof body?.item === 'string' ? body.item : '',
    ))
  } catch (error) {
    if (error instanceof RewardError) return c.json({ error: error.message }, error.status)
    throw error
  }
})

rewards.post('/draw', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const body = await c.req.json().catch(() => null) as { requestId?: unknown } | null
  const requestId = typeof body?.requestId === 'string' ? body.requestId : ''
  const existing = existingDrawResult(session.uid, requestId)
  if (existing) return c.json(existing)
  if (rateLimited(`reward-draw:${session.uid}`, 10, 10_000)) {
    return c.json({ error: '抽取太快，请稍后再试' }, 429)
  }
  try {
    return c.json(draw(session.uid, requestId))
  } catch (error) {
    if (error instanceof RewardError) return c.json({ error: error.message }, error.status)
    throw error
  }
})

export default rewards
