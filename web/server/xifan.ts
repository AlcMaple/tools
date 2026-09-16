// 稀饭：账号 / 验证码 / 搜索 / 定位 / 绑定 / 「跳去源站」。
// 在线观看已迁到 server/player（2026-09-17 删掉旧播放页、流代理路由、预转 HLS、慢源名额）；
// 解析层仍在 xifan/resolve.ts，流代理核心仍在 xifan/stream.ts，由 /api/player 调用。
//
//   GET  /api/xifan/source-page?animeId=&ep=       → 按快源策略选线路后 302 到稀饭站内页
//   POST /api/xifan/locate                         → bgmId + 标题 → 稀饭候选（周表免验证码匹配，见 locate.ts）
//   GET  /api/xifan/auth/status                    → 稀饭账号状态（远端校验）
//   POST /api/xifan/auth/login|logout              → 稀饭账号登录 / 退出
//   GET  /api/xifan/captcha                        → 登录 / 全站搜索共用验证码
//   POST /api/xifan/captcha/verify                 → 校验全站搜索验证码
//   POST /api/xifan/search                         → 搜索非周历稀饭资源（需要先过验证码）
//   POST /api/xifan/bind                           → 用户点候选确认，落库绑定（要登录）
//   GET  /api/xifan/bindings                       → 当前用户追番已建的绑定，页面加载时一次拿齐（要登录）
import { Hono } from 'hono'
import type { Context } from 'hono'
import { BASE_URL, clearXifanResolveCache, getPlaylist, XifanBusyError } from './xifan/resolve'
import { locate } from './xifan/locate'
import { getBinding, putBinding, bindingsFor } from './xifan/bindings'
import { getXifanCaptcha, searchXifan, verifyXifanCaptcha, XIFAN_SEARCH_MAX_LENGTH } from './xifan/search'
import { getXifanAuthStatus, loginXifan, logoutXifan } from './xifan/account'
import { XifanLocalRateLimitError, XifanUpstreamError } from './xifan/session'
import { clearRateLimit, clientIp, getSession, rateLimited } from './auth'
import { db } from './db'

const xifan = new Hono()
const XIFAN_LOGIN_WINDOW_MS = 15 * 60 * 1000
const XIFAN_LOGIN_MAX_PER_ACCOUNT = 10
const XIFAN_LOGIN_MAX_PER_IP = 20

// 这组响应含外站登录状态或登录结果，包含早退的 400 / 401 也一律禁止缓存。
xifan.use('/auth/*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})

function upstreamFailure(c: Context, error: unknown, fallback: string): Response {
  const message = error instanceof Error ? error.message : fallback
  // undici 的 "fetch failed" 是外壳，真实原因（ENOTFOUND / ECONNREFUSED / 证书握手失败……）
  // 挂在 error.cause 上；只吐外壳到终端等于没日志，这里把 cause 一起打出来。
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    console.error('[xifan] ' + fallback + ': ' + message + (cause ? ' | cause=' + String(cause) : ''))
  }
  if (error instanceof XifanLocalRateLimitError) {
    c.header('Retry-After', String(error.retryAfterSec))
    return c.json({ error: message }, 429)
  }
  if (error instanceof XifanBusyError) {
    c.header('Retry-After', String(error.retryAfterSec))
    return c.json({ error: message }, 429)
  }
  if (error instanceof XifanUpstreamError) {
    c.header('X-Upstream-Status', String(error.status))
    if (error.status === 429) {
      if (error.retryAfterSec !== null) c.header('Retry-After', String(error.retryAfterSec))
      return c.json({ error: message, upstreamStatus: error.status }, 429)
    }
    return c.json({ error: message, upstreamStatus: error.status }, 502)
  }
  return c.json({ error: message }, 502)
}

// 用户明确选择「跳去源站」时才走这里：复用 getPlaylist 的快源判定，避免让用户进站后
// 再手动试线路。先打开的是本站地址，策略请求完成后由 302 落到具体的稀饭线路页，
// 这样前端仍在原始点击手势里 window.open，不会被浏览器当成异步弹窗拦截。
xifan.get('/source-page', async (c) => {
  const animeId = c.req.query('animeId') ?? ''
  const ep = Number(c.req.query('ep') ?? '1')
  if (!/^\d+$/.test(animeId)) return c.json({ error: 'animeId 不合法（要纯数字，如 3543）' }, 400)
  if (!Number.isInteger(ep) || ep < 1) return c.json({ error: 'ep 不合法' }, 400)

  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  c.header('Cache-Control', 'no-store')
  try {
    const playlist = await getPlaylist(animeId, ep, session.uid)
    const source = playlist.first?.source
    const selected = typeof source === 'number' && Number.isInteger(source) && source > 0 ? source : 1
    return c.redirect(`${BASE_URL}/watch/${animeId}/${selected}/${ep}.html`, 302)
  } catch (error) {
    // 定位失败不让「跳去源站」变成空白页；线路 1 是源站原生默认回落。
    // 真实原因仍落终端，不能把限流 / 验证 / 源站错误伪装成成功定位。
    console.warn('[xifan] 快源定位失败，回落线路 1：', error)
    return c.redirect(`${BASE_URL}/watch/${animeId}/1/${ep}.html`, 302)
  }
})

// 稀饭账号状态 / 登录 / 退出都绑定当前 MapleTools uid；密码只转发，不落库。
xifan.get('/auth/status', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  try {
    const status = await getXifanAuthStatus(session.uid)
    if (!status.loggedIn) clearXifanResolveCache(session.uid)
    return c.json(status)
  } catch (error) {
    return upstreamFailure(c, error, '稀饭登录状态校验失败')
  }
})

xifan.post('/auth/login', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as {
    username?: unknown
    password?: unknown
    verify?: unknown
  }
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const verify = typeof body.verify === 'string' ? body.verify.trim() : ''
  if (!username || username.length > 100) return c.json({ error: '账号格式不合法' }, 400)
  if (!password || password.length > 200) return c.json({ error: '密码格式不合法' }, 400)
  if (!verify || verify.length > 32) return c.json({ error: '验证码格式不合法' }, 400)

  const ipKey = `xifan-login-ip:${clientIp(c)}`
  const accountKey = `xifan-login-account:${username.toLowerCase()}`
  if (
    rateLimited(ipKey, XIFAN_LOGIN_MAX_PER_IP, XIFAN_LOGIN_WINDOW_MS)
    || rateLimited(accountKey, XIFAN_LOGIN_MAX_PER_ACCOUNT, XIFAN_LOGIN_WINDOW_MS)
  ) {
    return c.json({ error: '尝试次数过多，请 15 分钟后再试' }, 429)
  }

  try {
    const result = await loginXifan(session.uid, username, password, verify)
    if (result.success) {
      clearRateLimit(ipKey)
      clearRateLimit(accountKey)
      clearXifanResolveCache(session.uid)
    }
    return c.json(result)
  } catch (error) {
    return upstreamFailure(c, error, '稀饭登录失败')
  }
})

xifan.post('/auth/logout', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const status = await logoutXifan(session.uid)
  clearXifanResolveCache(session.uid)
  return c.json(status)
})

// 登录与全站搜索复用同一个验证码 / cookie 会话；不登录就不能把服务器当成匿名代理。
xifan.get('/captcha', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  try {
    c.header('Cache-Control', 'no-store')
    return c.json(await getXifanCaptcha(session.uid))
  } catch (e) {
    return upstreamFailure(c, e, '验证码请求失败')
  }
})

xifan.post('/captcha/verify', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as { code?: unknown }
  const code = typeof body.code === 'string' ? body.code.trim() : ''
  if (!code || code.length > 32) return c.json({ error: '验证码格式不合法' }, 400)
  try {
    return c.json(await verifyXifanCaptcha(session.uid, code))
  } catch (e) {
    return upstreamFailure(c, e, '验证码校验失败')
  }
})

xifan.post('/search', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as { keyword?: unknown }
  const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : ''
  if (!keyword) return c.json({ error: '请输入搜索词' }, 400)
  if (keyword.length > XIFAN_SEARCH_MAX_LENGTH) {
    return c.json({ error: `搜索词不能超过 ${XIFAN_SEARCH_MAX_LENGTH} 个字符` }, 400)
  }
  try {
    c.header('Cache-Control', 'no-store')
    return c.json(await searchXifan(session.uid, keyword))
  } catch (e) {
    return upstreamFailure(c, e, '稀饭搜索失败')
  }
})

// 定位：bgmId + 追番标题 → 周表候选（或已绑定则直接给 bound）。不写库、不要登录（纯解析）。
xifan.post('/locate', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { bgmId?: number; titles?: unknown; rebind?: unknown }
  const bgmId = Number(body.bgmId)
  if (!Number.isInteger(bgmId) || bgmId <= 0) return c.json({ error: 'bgmId 不合法' }, 400)
  const titles = Array.isArray(body.titles) ? body.titles.filter((t): t is string => typeof t === 'string') : []
  try {
    c.header('Cache-Control', 'no-store')
    return c.json(await locate(bgmId, titles, { rebind: body.rebind === true }))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : '周表请求失败' }, 502)
  }
})

// 建绑定：用户点候选确认才走这条，落库（全局表）。要登录 —— 防匿名乱写别人也会命中的全局绑定。
xifan.post('/bind', async (c) => {
  const s = await getSession(c)
  if (!s) return c.json({ error: '未登录' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as { bgmId?: number; xifanId?: number; xifanName?: string }
  const bgmId = Number(body.bgmId)
  const xifanId = Number(body.xifanId)
  if (!Number.isInteger(bgmId) || bgmId <= 0) return c.json({ error: 'bgmId 不合法' }, 400)
  if (!Number.isInteger(xifanId) || xifanId <= 0) return c.json({ error: 'xifanId 不合法' }, 400)
  putBinding(bgmId, xifanId, String(body.xifanName ?? '').slice(0, 200))
  return c.json({ ok: true, binding: getBinding(bgmId) })
})

// 当前用户追番里已建的绑定，一次拿齐（前端据此把绑过的「继续看」直接渲染成链接）。
xifan.get('/bindings', async (c) => {
  const s = await getSession(c)
  if (!s) return c.json({ data: {} }) // 未登录没有追番，空即可，不当错误
  const rows = db.prepare('SELECT bgm_id FROM tracks WHERE user_id = ?').all(s.uid) as { bgm_id: number }[]
  return c.json({ data: bindingsFor(rows.map((r) => r.bgm_id)) })
})

export default xifan
