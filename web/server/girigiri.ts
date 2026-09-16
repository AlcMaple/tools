// Girigiri：追番定位 / 搜索 / 绑定 / 「跳去源站」。
// 在线观看已迁到 server/player（2026-09-17 删掉旧播放页）；解析层仍在 girigiri/resolve.ts，由 /api/player 调用。
import { Hono } from 'hono'
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
import { BASE_URL, getPlaylist, isGirigiriId } from './girigiri/resolve'

const girigiri = new Hono()

// 与稀饭的 source-page 保持同一点击链路：前端先打开本站地址，服务端确定默认线路后
// 302 到 Girigiri 源站。当前 Girigiri 播放页的默认线路仍是线路 1，失败时也明确回落。
girigiri.get('/source-page', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const id = (c.req.query('animeId') ?? '').trim().toUpperCase()
  const ep = Number(c.req.query('ep') ?? '1')
  if (!isGirigiriId(id)) return c.json({ error: 'girigiriId 不合法（应为 GV 开头的编号）' }, 400)
  if (!Number.isInteger(ep) || ep < 1) return c.json({ error: 'ep 不合法' }, 400)

  c.header('Cache-Control', 'no-store')
  try {
    const playlist = await getPlaylist(id, ep)
    const source = playlist.first?.source
    const selected = typeof source === 'number' && Number.isInteger(source) && source > 0 ? source : 1
    return c.redirect(`${BASE_URL}/play${id}-${selected}-${ep}/`, 302)
  } catch (error) {
    console.warn('[girigiri] 默认线路定位失败，回落线路 1：', error)
    return c.redirect(`${BASE_URL}/play${id}-1-${ep}/`, 302)
  }
})

// 搜索验证码会话按 MapleTools 用户隔离；不登录不开放站点搜索代理。
girigiri.get('/captcha', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  try {
    c.header('Cache-Control', 'no-store')
    return c.json(await getGirigiriCaptcha(session.uid))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Girigiri 验证码请求失败' }, 502)
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
    return c.json({ error: error instanceof Error ? error.message : 'Girigiri 验证码校验失败' }, 502)
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
    return c.json({ error: error instanceof Error ? error.message : 'Girigiri 搜索失败' }, 502)
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
    return c.json({ error: error instanceof Error ? error.message : 'Girigiri 周表请求失败' }, 502)
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
