// Girigiri：追番定位 / 搜索 / 绑定 / 「跳去源站」。
// 在线观看已迁到 server/player（2026-09-17 删掉旧播放页）；解析层仍在 girigiri/resolve.ts，由 /api/player 调用。
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getSession } from './auth'
import { db } from './db'
import { bindingsFor, getBinding, putBinding } from './girigiri/bindings'
import { locate } from './girigiri/locate'
import {
  getGirigiriCaptcha,
  GIRIGIRI_SEARCH_MAX_LENGTH,
  searchGirigiri,
  verifyGirigiriCaptcha,
} from './girigiri/search'
import { getSourcePageUrl, isGirigiriId } from './girigiri/resolve'
import { GirigiriError } from './girigiri/api'

const girigiri = new Hono()

function failure(c: Context, error: unknown): Response {
  console.error('[girigiri] 请求失败：', error)
  const status = error instanceof GirigiriError && error.code === 'GIRIGIRI_EPISODE_NOT_FOUND' ? 404
    : error instanceof GirigiriError && error.upstreamStatus === 429 ? 429 : 502
  return c.json({ error: error instanceof Error ? error.message : 'Girigiri 请求失败',
    ...(error instanceof GirigiriError ? { code: error.code, upstreamStatus: error.upstreamStatus } : {}),
  }, status)
}

// 源站使用零基线路/选集索引，必须从真实列表查集号；缺集时不跳回第 1 集。
girigiri.get('/source-page', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const id = (c.req.query('animeId') ?? '').trim().toUpperCase()
  const ep = Number(c.req.query('ep') ?? '1')
  if (!isGirigiriId(id)) return c.json({ error: 'girigiriId 不合法（应为 GV 开头的编号）' }, 400)
  if (!Number.isInteger(ep) || ep < 1) return c.json({ error: 'ep 不合法' }, 400)

  c.header('Cache-Control', 'no-store')
  try {
    return c.redirect(await getSourcePageUrl(id, ep), 302)
  } catch (error) {
    return failure(c, error)
  }
})

// 搜索仍需本站登录；源站新版 API 不需要旧验证码会话。
girigiri.get('/captcha', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  try {
    c.header('Cache-Control', 'no-store')
    return c.json(await getGirigiriCaptcha(session.uid))
  } catch (error) {
    return failure(c, error)
  }
})

girigiri.post('/captcha/verify', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as { code?: unknown }
  const code = typeof body.code === 'string' ? body.code.trim() : ''
  if (!code || code.length > 32) return c.json({ error: '验证码格式不合法' }, 400)
  try {
    return c.json(await verifyGirigiriCaptcha(session.uid, code))
  } catch (error) {
    return failure(c, error)
  }
})

girigiri.post('/search', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as { keyword?: unknown }
  const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : ''
  if (!keyword) return c.json({ error: '请输入搜索词' }, 400)
  if (keyword.length > GIRIGIRI_SEARCH_MAX_LENGTH) {
    return c.json({ error: `搜索词不能超过 ${GIRIGIRI_SEARCH_MAX_LENGTH} 个字符` }, 400)
  }
  try {
    c.header('Cache-Control', 'no-store')
    return c.json(await searchGirigiri(session.uid, keyword))
  } catch (error) {
    return failure(c, error)
  }
})

girigiri.post('/locate', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { bgmId?: number; titles?: unknown; rebind?: unknown }
  const bgmId = Number(body.bgmId)
  if (!Number.isInteger(bgmId) || bgmId <= 0) return c.json({ error: 'bgmId 不合法' }, 400)
  const titles = Array.isArray(body.titles) ? body.titles.filter((title): title is string => typeof title === 'string') : []
  try {
    c.header('Cache-Control', 'no-store')
    return c.json(await locate(bgmId, titles, { rebind: body.rebind === true }))
  } catch (error) {
    return failure(c, error)
  }
})

girigiri.post('/bind', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as { bgmId?: number; girigiriId?: unknown; girigiriName?: unknown }
  const bgmId = Number(body.bgmId)
  const id = typeof body.girigiriId === 'string' ? body.girigiriId.trim().toUpperCase() : ''
  if (!Number.isInteger(bgmId) || bgmId <= 0) return c.json({ error: 'bgmId 不合法' }, 400)
  if (!isGirigiriId(id)) return c.json({ error: 'girigiriId 不合法' }, 400)
  putBinding(bgmId, id, String(body.girigiriName ?? '').slice(0, 200))
  return c.json({ ok: true, binding: getBinding(bgmId) })
})

girigiri.get('/bindings', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ data: {} })
  const rows = db.prepare('SELECT bgm_id FROM tracks WHERE user_id = ?').all(session.uid) as { bgm_id: number }[]
  return c.json({ data: bindingsFor(rows.map((row) => row.bgm_id)) })
})

export default girigiri
