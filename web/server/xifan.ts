// 稀饭在线观看 —— 懒加载播放器（用户 2026-07-21 定：不并行、不自动选最优）。
//
//   GET  /api/xifan/playlist?animeId=&ep=          → 一次抓取：线路 1 地址 + 全部线路名单
//   GET  /api/xifan/resolve?animeId=&ep=&source=N  → 用户手动点线路 N 时才解析那一条
//   GET  /api/xifan/play-page?animeId=&ep=         → 播放器页（默认播线路 1，直连失败套娃兜底）
//   GET  /api/xifan/hls.js                         → 自托管 hls.js（不走可能被墙的 jsdelivr）
//   POST /api/xifan/locate                         → bgmId + 标题 → 稀饭候选（周表免验证码匹配，见 locate.ts）
//   GET  /api/xifan/auth/status                    → 稀饭账号状态（远端校验）
//   POST /api/xifan/auth/login|logout              → 稀饭账号登录 / 退出
//   GET  /api/xifan/captcha                        → 登录 / 全站搜索共用验证码
//   POST /api/xifan/captcha/verify                 → 校验全站搜索验证码
//   POST /api/xifan/search                         → 搜索非周历稀饭资源（需要先过验证码）
//   POST /api/xifan/bind                           → 用户点候选确认，落库绑定（要登录）
//   GET  /api/xifan/bindings                       → 当前用户追番已建的绑定，页面加载时一次拿齐（要登录）
//
// 播放器页是「服务端返回的一张裸 HTML」，跟生产 SPA 同源，<video> 加载源 CDN 就是跨源＝真实场景。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  clearXifanResolveCache,
  getPlaylist,
  resolveLine,
  XifanBusyError,
  XifanResolveError,
} from './xifan/resolve'
import { INTERNAL_TOKEN, serveStream, slotInfo, ViewerLimitReached } from './xifan/stream'
import { needsProxy, PROXY_HOSTS } from './xifan/proxy-hosts'
import {
  dropPrepared, listPrepared, PrepareRejected, resolveAsset, startPrepare, statusOf, touch,
} from './xifan/prepare'
import { locate } from './xifan/locate'
import { getBinding, putBinding, bindingsFor } from './xifan/bindings'
import { getXifanCaptcha, searchXifan, verifyXifanCaptcha, XIFAN_SEARCH_MAX_LENGTH } from './xifan/search'
import { getXifanAuthStatus, loginXifan, logoutXifan } from './xifan/account'
import { XifanLocalRateLimitError, XifanUpstreamError } from './xifan/session'
import { clearRateLimit, clientIp, getSession, rateLimited } from './auth'
import { db } from './db'
import { playerPageSecurity, renderNonce } from './security'
import { parsePlayerBgmId, playerSourceOptions, serializePlayerSources } from './player-sources'

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

// 自托管 hls.js —— 不走 jsdelivr（国内无魔法可能加载不到）。首次请求读一次、进程内缓存。
let hlsJsCache: string | null = null
xifan.get('/hls.js', (c) => {
  if (!hlsJsCache) hlsJsCache = readFileSync(join(process.cwd(), 'node_modules/hls.js/dist/hls.min.js'), 'utf8')
  c.header('Content-Type', 'application/javascript; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=86400')
  return c.body(hlsJsCache)
})

// 播放页调试日志出口——用户只看终端，不看网页 devtools；<video> 的 error/回退套娃这些
// 只在浏览器里发生的事件，改用 sendBeacon 把摘要丢过来，落进这个 Node 进程的 stdout。
const XIFAN_CLIENT_LOG_MAX = 300
xifan.post('/client-log', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.body(null, 204)
  }
  const msg = body && typeof body === 'object' && 'msg' in body ? String((body as { msg: unknown }).msg) : ''
  if (msg) console.log('[xifan:client] ' + msg.slice(0, XIFAN_CLIENT_LOG_MAX))
  return c.body(null, 204)
})

// 打开播放页：一次抓 source 1 → 线路 1 地址 + 全部线路名单（不碰线路 2/3）
xifan.get('/playlist', async (c) => {
  const animeId = c.req.query('animeId') ?? ''
  const ep = Number(c.req.query('ep') ?? '1')
  if (!/^\d+$/.test(animeId)) return c.json({ error: 'animeId 不合法（要纯数字，如 3543）' }, 400)
  if (!Number.isInteger(ep) || ep < 1) return c.json({ error: 'ep 不合法' }, 400)
  const session = await getSession(c)
  c.header('Cache-Control', 'no-store')
  try {
    return c.json(await getPlaylist(animeId, ep, session?.uid ?? null))
  } catch (error) {
    if (error instanceof XifanResolveError) {
      const body = { error: error.message, code: error.code }
      return error.code === 'XIFAN_AUTH_REQUIRED' ? c.json(body, 401) : c.json(body, 403)
    }
    return upstreamFailure(c, error, '稀饭播放页解析失败')
  }
})

// 用户手动点线路 N：只抓那一条
xifan.get('/resolve', async (c) => {
  const animeId = c.req.query('animeId') ?? ''
  const ep = Number(c.req.query('ep') ?? '1')
  const source = Number(c.req.query('source') ?? '0')
  if (!/^\d+$/.test(animeId)) return c.json({ error: 'animeId 不合法' }, 400)
  if (!Number.isInteger(ep) || ep < 1) return c.json({ error: 'ep 不合法' }, 400)
  if (!Number.isInteger(source) || source < 1) return c.json({ error: 'source 不合法' }, 400)
  const session = await getSession(c)
  c.header('Cache-Control', 'no-store')
  try {
    const line = await resolveLine(animeId, ep, source, session?.uid ?? null)
    return line ? c.json(line) : c.json({ error: '此线路解析不到（可能此线路没有这一集）' }, 404)
  } catch (error) {
    if (error instanceof XifanResolveError) {
      const body = { error: error.message, code: error.code }
      return error.code === 'XIFAN_AUTH_REQUIRED' ? c.json(body, 401) : c.json(body, 403)
    }
    return upstreamFailure(c, error, '稀饭线路解析失败')
  }
})

// mp4 并发分片流代理 —— 为什么必须在服务端、为什么要多路，见 xifan/stream.ts 顶部注释。
xifan.get('/stream', async (c) => {
  const raw = c.req.query('u') ?? ''
  if (!raw) return c.json({ error: '缺少 u' }, 400)
  try {
    // 带对令牌的才是预转自己拉的流，不计入「观众」（令牌只存在于本进程内存，外部伪造不了）。
    const r = await serveStream(
      raw,
      c.req.header('range'),
      c.req.query('t') === INTERNAL_TOKEN,
      clientIp(c),
    )
    return new Response(r.body, { status: r.status, headers: r.headers })
  } catch (error) {
    if (error instanceof ViewerLimitReached) {
      // 503 + 结构化 code：播放页据此显示排队提示，而不是当成播放失败去回退 iframe。
      return c.json({ error: error.message, code: 'VIEWER_LIMIT', current: error.current, limit: error.limit }, 503)
    }
    return upstreamFailure(c, error, '稀饭流代理失败')
  }
})

// 代理观看名额 —— 播放页在真去播之前先问一句。<video> 收到 503 只会触发一个没有响应体的
// error 事件，分不清是「名额满」还是「真播不了」，所以名额必须能单独查。这个查询无副作用。
xifan.get('/slots', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json(slotInfo(clientIp(c)))
})

// 预转 HLS —— 为什么需要它、为什么不能边下边切，见 xifan/prepare.ts 顶部注释。
xifan.get('/prepared', (c) => {
  const raw = c.req.query('u') ?? ''
  if (!raw) return c.json({ error: '缺少 u' }, 400)
  c.header('Cache-Control', 'no-store')
  try {
    const st = statusOf(raw)
    // 播放页一轮询就顺手开工。**触发点必须放在这里而不是 /stream**：慢源的代理直连
    // 会占满入口，预转就被让位逻辑冻住，形成「越想转越转不动」的死锁（实测日志：
    // 开始预转 → 有人在看，暂停 → 永远转不出来）。轮询不占入口，所以能一直跑。
    if (st.state === 'none' && needsProxy(raw)) {
      try { startPrepare(raw, internalOrigin(c)) } catch { /* 配额/并发满，下次轮询再说 */ }
    }
    return c.json(st)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '查询失败' }, 400)
  }
})

// ffmpeg 的输入指回**本进程自己**的流代理（不是源站直连——源站单路只有 1.4Mbps
// 会把 remux 饿死），所以要拿到自己的内网地址。
// 生产 node 绑 127.0.0.1:3000；但 vite dev 只监听 [::1]，写死 IPv4 会 Connection refused，
// 所以留一个 env 口子给 dev 覆盖。
function internalOrigin(c: Context): string {
  const url = new URL(c.req.url)
  return process.env.XIFAN_INTERNAL_ORIGIN
    ?? `http://127.0.0.1:${url.port || process.env.PORT || '3000'}`
}

xifan.post('/prepare', async (c) => {
  // 手动触发口子（调试用）。要登录：它会写几百 MB、长时间占入口带宽，不设防就是
  // 一个「任何人都能让你的服务器免费下片」的按钮。正常路径是下面 /stream 里自动触发。
  const session = await getSession(c)
  if (!session) return c.json({ error: '请先登录再用预转' }, 401)
  const body = await c.req.json().catch(() => null) as { u?: string } | null
  const raw = body?.u ?? ''
  if (!raw) return c.json({ error: '缺少 u' }, 400)
  const origin = internalOrigin(c)
  try {
    return c.json(startPrepare(raw, origin))
  } catch (error) {
    if (error instanceof PrepareRejected) return c.json({ error: error.message }, 429)
    return c.json({ error: error instanceof Error ? error.message : '预转失败' }, 400)
  }
})

xifan.get('/hls/:key/:file', async (c) => {
  const p = resolveAsset(c.req.param('key'), c.req.param('file'))
  if (!p) return c.json({ error: '没有这个分片' }, 404)
  const file = c.req.param('file')
  touch(c.req.param('key')) // LRU 按「最后真的被看过」排序，不是按转好的时间
  const { createReadStream } = await import('node:fs')
  const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/iso.segment'
  return new Response(createReadStream(p) as unknown as ReadableStream, {
    headers: { 'Content-Type': type, 'Cache-Control': file.endsWith('.m3u8') ? 'no-store' : 'public, max-age=86400' },
  })
})

xifan.get('/prepared/list', (c) => c.json({ items: listPrepared() }))

xifan.delete('/prepared/:key', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '请先登录' }, 401)
  return dropPrepared(c.req.param('key')) ? c.json({ ok: true }) : c.json({ error: '没有这一份' }, 404)
})

xifan.get('/play-page', (c) => {
  const animeId = c.req.query('animeId') ?? ''
  const ep = Number(c.req.query('ep') ?? '1')
  const bgmIdRaw = c.req.query('bgmId')
  const bgmId = parsePlayerBgmId(bgmIdRaw)
  if (!/^\d+$/.test(animeId)) return c.json({ error: 'animeId 不合法' }, 400)
  if (!Number.isInteger(ep) || ep < 1) return c.json({ error: 'ep 不合法' }, 400)
  if (bgmIdRaw && bgmId == null) return c.json({ error: 'bgmId 不合法' }, 400)
  c.header('Cache-Control', 'no-store')
  const sources = serializePlayerSources(playerSourceOptions('xifan', Number(animeId), ep, bgmId))
  const page = renderNonce(
    PLAY_PAGE
      .replace('__PLAYER_SOURCES__', sources)
      .replace('__PROXY_HOSTS__', JSON.stringify(PROXY_HOSTS)),
  )
  playerPageSecurity(c, page.nonce)
  // pan.wo 的下载响应带 attachment；保持来源信息时 Chromium 会把它判成不可播放媒体。
  // 稀饭自己的 player.moedot 页面同样用 no-referrer，复测后可让 <video> 正常直连。
  c.header('Referrer-Policy', 'no-referrer')
  return c.html(page.html)
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
  const body = (await c.req.json().catch(() => ({}))) as { bgmId?: number; titles?: unknown }
  const bgmId = Number(body.bgmId)
  if (!Number.isInteger(bgmId) || bgmId <= 0) return c.json({ error: 'bgmId 不合法' }, 400)
  const titles = Array.isArray(body.titles) ? body.titles.filter((t): t is string => typeof t === 'string') : []
  try {
    c.header('Cache-Control', 'no-store')
    return c.json(await locate(bgmId, titles))
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

// 播放器页 —— 客户端 JS 只用字符串拼接（不用模板串），避开外层模板串的 ${}。<video> 不加 crossorigin。
// 视觉照「纱雾画稿 Sagiri Sketchfolio」设计系统（docs/design-mockups/web/anime-sketchfolio/player.html）：
// tokens/组件 CSS 引用同一份静态副本（web/public/styles/，见该目录文件头注释），不是另起一套配色。
const PLAY_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>继续看 · 稀饭</title>
<script src="/api/xifan/hls.js"></script>
<link rel="stylesheet" href="/styles/sketch-tokens.css">
<link rel="stylesheet" href="/styles/sketch-ui.css">
<style nonce="__CSP_NONCE__">
  /* 播放页专属：真实 <video>/<iframe> 填满播放框（原型里那块是演示占位，这里要放真内容），
     其余外观（选集格 / 线路卡 / 分段器 / 手写标题）全部复用 sketch-ui.css 组件，不重新定义。 */
  .sheet-wrap { max-width: 1080px; margin: 0 auto; padding: 24px 20px 60px; position: relative; z-index: 1 }
  .player-frame { position: relative; aspect-ratio: 16/9; background: #000; border: 1.5px solid var(--line-strong); border-radius: var(--r-card); overflow: hidden; box-shadow: var(--shadow-1) }
  video, iframe.player { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #000; display: none }
  /* 浏览器原生的黑色缓冲转圈（Chrome/Safari 在 <video controls> 卡顿时自己画的那个）藏在
     UA shadow DOM 里，靠伪元素关不干净——版本一多就失效。唯一稳的办法是拿一块不透明的
     「画纸」把整个播放框盖住，原生转圈画在下面也露不出来；控制条（播放/进度条）不受影响。 */
  video::-webkit-media-controls-loading-panel { display: none !important }
  .ep-badge-pill { display: inline-flex; align-items: center; font-family: var(--font-hand); font-size: 14px; color: var(--teal); background: var(--teal-wash); border: 1.5px solid var(--teal-line); border-radius: var(--r-pill); padding: 2px 12px; font-variant-numeric: tabular-nums }
  #buffering { position: absolute; inset: 0; z-index: 3; display: none; align-items: center; justify-content: center; background: var(--paper); pointer-events: none }
  #buffering.show { display: flex }
  #buffering.retryable { pointer-events: auto; cursor: pointer }
  .buf-card { display: inline-flex; flex-direction: column; align-items: center; gap: 8px; padding: 18px 26px; border-radius: var(--r-card); background: var(--card); border: 1.5px dashed var(--teal-line); box-shadow: var(--shadow-stick); transform: rotate(-1.3deg); animation: buffer-wobble 2.6s ease-in-out infinite }
  .buf-ring { width: 32px; height: 32px; fill: none; stroke: var(--teal-mid); stroke-width: 2; stroke-linecap: round; stroke-dasharray: 34 22; transform-origin: center; animation: buf-draw 1.4s linear infinite }
  #bufferText { font-family: var(--font-hand); font-size: 14px; color: var(--ink); font-variant-numeric: tabular-nums }
  @keyframes buf-draw { to { transform: rotate(360deg) } }
  @keyframes buffer-wobble { 0%, 100% { transform: rotate(-1.3deg) translateY(0) } 50% { transform: rotate(1deg) translateY(-3px) } }
  /* 只在真出错时才现（加载失败 / 这集没更新 / 线路解析不到）—— 平时不显示任何提示文字。
     用 classList 切换而不是 JS 里直接写 el.style.display —— 后者是内联样式，同样受
     style-src 这条 CSP 约束，没有 nonce/hash 会被浏览器悄悄吞掉，表现成「怎么切都不生效」。 */
  #err { display: none; align-items: center; gap: 12px; margin: 16px 0; padding: 10px 14px; border-radius: var(--r-card); font-size: 13px; font-weight: 600; background: var(--sakura-wash); border: 1.5px solid var(--sakura); color: #923d49 }
  #err.show { display: flex }
  #err-text { min-width: 0; flex: 1 }
  #auth-link { display: none }
  #auth-link.show { display: inline-flex }
  video.on, iframe.player.on { display: block }
  /* 预转状态条：跟播放框同宽，贴在下面。不抢戏，但失败/进行中要看得见。 */
  .prep { margin-top: 10px; font-size: 13px; color: #6b6558; display: flex; align-items: center; gap: 8px; flex-wrap: wrap }
  .prep:empty { display: none }
  .prep.ok { color: #2f7d5e }
  .prep.busy { color: #8a6d2f }
  .prep.bad { color: #b4483c }
  /* 浮层里的出口按钮（等起稿时给个「不想等就换快源」的去处）。 */
  #bufferActions:empty { display: none }
  #bufferActions { margin-top: 10px; display: flex; gap: 8px; justify-content: center }
  /* 播放源分段器：未关联的源需要一种「虚线、可点」的第三态，seg 组件本身没有 */
  .src-seg > button.unbound { color: var(--ink-faint); border: 1.5px dashed var(--line); border-radius: var(--r-pill) }
  .lines-list { display: flex; flex-direction: column; gap: 10px; margin-top: 14px }
  /* CSP style-src 不放行内联 style 属性（nonce 只保护 <style>/<script> 标签本身），
     所以原型稿里随手写的内联字号/对齐这里都得落成类。 */
  .hd-row { align-items: flex-end }
  .player-title { font-size: 24px }
  .section-title { font-size: 18px }
  .icon-sprite { display: none }
  /* 好看集提示条：这集是不是我标过的，不用 hover——手机上根本没有 hover。
     文字可能比较长（备注），不截断、正常换行，卡片跟着撑高。 */
  .ep-good-note { display: none; align-items: flex-start; gap: 8px; margin-top: 14px; padding: 10px 14px; border-radius: var(--r-card); background: var(--gold-hl); border: 1.5px solid var(--gold); color: #6b5416; font-size: 13px; line-height: 1.6; }
  .ep-good-note.show { display: flex }
  .ep-good-note::before { content: '★'; flex: none; margin-top: 1px; color: var(--gold); }
</style>
</head>
<body data-page="player">
<div class="sheet-wrap">
  <a class="btn btn-sm btn-ghost" href="/#/tracks">
    <svg class="ic ic-sm"><use href="#i-back"></use></svg>回到我的追番
  </a>
  <div class="spread hd-row mt16">
    <div>
      <h1 class="title-sketch player-title" id="ttl">继续看</h1>
      <p class="muted small mt8"><span class="ep-badge-pill font-hand" id="epbadge">EP</span></p>
    </div>
    <div class="seg src-seg" id="sources"></div>
  </div>
  <div class="ep-good-note" id="epgood"></div>
  <div class="player-frame mt16">
    <video id="v" controls playsinline preload="auto"></video>
    <iframe id="frame" class="player" allow="autoplay; fullscreen" allowfullscreen referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"></iframe>
    <div id="buffering" role="status" aria-live="polite">
      <div class="buf-card">
        <svg class="buf-ring" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle></svg>
        <span id="bufferText" class="font-hand">描线中…</span>
        <div id="bufferActions"></div>
      </div>
    </div>
  </div>
  <div id="prepareBox" class="prep"></div>
  <div id="err" role="alert" aria-live="polite"><span id="err-text"></span><a id="auth-link" class="btn btn-sm btn-ghost" href="/#/settings/xifan" target="_blank" rel="noopener">去登录</a></div>
  <div class="spread mt24">
    <h2 class="title-sketch section-title">选集</h2>
  </div>
  <div class="ep-grid mt16" id="eps"></div>
  <h2 class="title-sketch section-title mt24">线路</h2>
  <div class="lines-list" id="lines"></div>
</div>
<svg class="icon-sprite" aria-hidden="true"><symbol id="i-back" viewBox="0 0 24 24"><path d="M14.5 5.5L8 12l6.5 6.5"/></symbol></svg>
<script nonce="__CSP_NONCE__">
(function(){
  var $ = function(id){ return document.getElementById(id) }
  // 排查用日志一律走这里 → 落 Node 终端的 stdout，不进浏览器 devtools（那边看不到）。
  var slog = function(msg){
    try {
      var body = JSON.stringify({ msg: msg })
      if (navigator.sendBeacon) navigator.sendBeacon('/api/xifan/client-log', new Blob([body], { type: 'application/json' }))
      else fetch('/api/xifan/client-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true })
    } catch (e) {}
  }
  var q = new URLSearchParams(location.search)
  var animeId = q.get('animeId') || ''
  var ep = q.get('ep') || '1'
  var bgmId = q.get('bgmId') || ''
  var sourceOptions = __PLAYER_SOURCES__
  // 只有这些域名的 mp4 要走服务端并发代理；其余（如线路二 play.xfvod.pro）浏览器直连——
  // 直连实测 30Mbps 且不占服务器那 6Mbps 的出口，让它走代理纯属浪费还挤占名额。
  var PROXY_HOSTS = __PROXY_HOSTS__
  function needsProxy(u){
    try { return PROXY_HOSTS.indexOf(new URL(u).hostname) >= 0 } catch (e) { return false }
  }
  var v = $('v'), frame = $('frame')
  var lines = [], eps = [], curPl = null, resolvedMap = {}, resolvingMap = {}, hls = null
  var goodEps = {}, goodNotes = {}
  var waitingForAuth = false
  var BUFFER_TARGET = 10, BUFFER_RATE = .0625, BUFFER_STALL_MS = 10000, BUFFER_MAX_MS = 30000
  // 冷启动（跨源 TCP 慢启动 + moov 定位）前 10 秒不做速率裁决，之后每 6 秒滚动采样一次；
  // 门槛 1.0 = 只要下载不比实时播放慢就继续等，不再因为「不够快 15%」就退套娃。
  var BUFFER_WARMUP_MS = 10000, BUFFER_SAMPLE_MS = 6000, BUFFER_MIN_MEDIA_RATE = 1
  var bufferSampled = false, bufferTimer = null, bufferToken = 0
  var resumeAfterBuffer = false, bufferAnchor = 0, savedRate = 1, savedMuted = false, internalSeek = false
  var bufferStartedAt = 0, bufferLastProgressAt = 0, bufferLastAhead = 0, bufferSampleAt = 0, bufferSampleAhead = 0
  var internalSeekTimer = null, gateOnPlay = false, lineRequest = 0, playGeneration = 0
  var networkInterrupted = false, networkCheck = null, networkRetry = null, failureGeneration = -1
  var preparedKey = null, preparedFor = null, prepareTimer = null, prepareFailed = null
  var resumeTime = 0, resumeWasPlaying = false, resumePending = false, resumeKey = '', recoverTimer = null

  window.addEventListener('storage', function(e){
    if (waitingForAuth && e.key === 'mapletools-xifan-auth-changed' && e.newValue) location.reload()
  })
  window.addEventListener('pagehide', function(){ stopAll() })
  window.addEventListener('pageshow', function(e){ if (e.persisted) location.reload() })
  window.addEventListener('offline', function(){ rememberNetworkPosition(); networkInterrupted = true })
  window.addEventListener('online', function(){
    if (!networkInterrupted){ resumePending = false; resumeWasPlaying = false; return }
    if (recoverTimer !== null) clearTimeout(recoverTimer)
    var attempt = async function(second){
      recoverTimer = null
      if (!networkInterrupted) return
      if (await checkNetwork()){ recoverCurrentLine(); return }
      if (!second) recoverTimer = setTimeout(function(){ attempt(true) }, 3000)
    }
    recoverTimer = setTimeout(function(){ attempt(false) }, 600)
  })

  function fail(txt, code){
    waitingForAuth = code === 'XIFAN_AUTH_REQUIRED'
    $('err-text').textContent = txt
    $('auth-link').classList.toggle('show', waitingForAuth)
    $('err').classList.add('show')
  }
  function clearFail(){ waitingForAuth = false; $('err').classList.remove('show'); $('auth-link').classList.remove('show') }
  function inFrame(){ return frame.classList.contains('on') }

  function rememberNetworkPosition(){
    if (Number.isFinite(v.currentTime)) resumeTime = v.currentTime
    resumeWasPlaying = resumeWasPlaying || !v.paused || resumeAfterBuffer
    resumePending = true
    resumeKey = (curPl ? curPl.source : 'none') + ':' + ep
  }

  function checkNetwork(){
    if (!navigator.onLine) return Promise.resolve(false)
    if (networkCheck) return networkCheck
    var controller = new AbortController()
    var timeout = setTimeout(function(){ controller.abort() }, 3000)
    networkCheck = fetch('/api/health?playback=1', { cache: 'no-store', signal: controller.signal })
      .then(function(r){ return r.ok })
      .catch(function(){ return false })
      .finally(function(){ clearTimeout(timeout); networkCheck = null })
    return networkCheck
  }

  function holdForNetwork(retry){
    rememberNetworkPosition()
    networkInterrupted = true
    if (retry) networkRetry = retry
    cancelBufferGate(false)
    try { v.pause() } catch (e) {}
    $('bufferText').textContent = '网络已断开 · 恢复后继续当前线路'
    var overlay = $('buffering')
    overlay.classList.add('show', 'retryable')
    overlay.onclick = function(){ checkNetwork().then(function(online){ if (online) recoverCurrentLine() }) }
  }

  function classifyMediaFailure(fallback, retry){
    var generation = playGeneration
    if (failureGeneration === generation) return
    if (!navigator.onLine){ holdForNetwork(retry); return }
    failureGeneration = generation
    checkNetwork().then(function(online){
      if (generation !== playGeneration) return
      if (online) fallback()
      else holdForNetwork(retry)
    }).finally(function(){ if (failureGeneration === generation) failureGeneration = -1 })
  }

  function recoverCurrentLine(){
    if (!networkInterrupted) return
    var retry = networkRetry
    var pl = curPl
    networkInterrupted = false; networkRetry = null; clearFail(); hideBuffer()
    $('buffering').onclick = null; $('buffering').classList.remove('retryable')
    if (retry) retry()
    else if (pl) playLine(pl)
  }

  v.addEventListener('loadedmetadata', function(){
    if (!resumePending) return
    if (resumeKey !== (curPl ? curPl.source : 'none') + ':' + ep){ resumePending = false; resumeWasPlaying = false; return }
    try { v.currentTime = Math.min(resumeTime, Number.isFinite(v.duration) ? Math.max(0, v.duration - .25) : resumeTime) } catch (e) {}
    if (resumeWasPlaying){ var rp = v.play(); if (rp && rp.catch) rp.catch(function(){}) }
  })
  v.addEventListener('playing', function(){ resumePending = false; resumeWasPlaying = false; networkInterrupted = false })
  // 首次真正可播（不是 bufferGate 那种「已经在播中途卡了」）就收起初始浮层；
  // 中途 waiting/seeking 触发的 bufferGate 有自己的一套 show/hide，不受这里影响。
  // 这里曾经加过「canplay 后低速静音静默预缓冲」，实测**有害，已移除**：0.0625 倍速会让
  // 浏览器判定「缓冲远超消费速度」而主动限流，10.9 秒只攒到 2.7 秒缓冲；同一时刻用
  // fetch 直接读同一个代理地址能跑 772KB/s(6.3Mbps)。起播慢的真正原因是带宽不是时机，
  // 已由 /api/xifan/stream 的并发代理解决，不需要再抢跑。
  v.addEventListener('canplay', function(){ if (!resumeAfterBuffer) hideBuffer() })

  function bufferedAhead(){
    for (var i = 0; i < v.buffered.length; i++){
      if (v.buffered.start(i) <= v.currentTime + .05 && v.buffered.end(i) >= v.currentTime) return Math.max(0, v.buffered.end(i) - v.currentTime)
    }
    return 0
  }

  function bufferGoal(){
    if (!Number.isFinite(v.duration)) return BUFFER_TARGET
    return Math.max(0, Math.min(BUFFER_TARGET, v.duration - v.currentTime - .25))
  }

  function hideBuffer(){
    var b = $('buffering'); b.classList.remove('show', 'retryable'); b.onclick = null
    $('bufferActions').textContent = ''
  }

  /**
   * 在**已经解析过**的线路里找一条不需要代理的（快源）。
   * 只看已知的：没解析过的线路不知道快慢，凭线路号猜会猜错（实测 3498 的线路一就是快源），
   * 猜错就成了「让用户换到另一条同样慢的线路」——那比不提示更糟。
   */
  function findFastLine(){
    for (var k in resolvedMap){
      var pl = resolvedMap[k]
      if (pl && pl.url && !needsProxy(pl.url)) return pl
    }
    return null
  }

  function clearInternalSeek(){
    if (internalSeekTimer !== null) clearTimeout(internalSeekTimer)
    internalSeekTimer = null; internalSeek = false
  }

  function markInternalSeek(){
    clearInternalSeek(); internalSeek = true
    internalSeekTimer = setTimeout(function(){ internalSeek = false; internalSeekTimer = null }, 800)
  }

  function resetBufferWatch(ahead){
    var now = performance.now()
    bufferStartedAt = now; bufferLastProgressAt = now; bufferLastAhead = ahead
    bufferSampleAt = now; bufferSampleAhead = ahead; bufferSampled = false
  }

  function restorePlaybackState(){
    try { v.playbackRate = savedRate } catch (e) {}
    v.muted = savedMuted
  }

  function cancelBufferGate(resetPosition){
    if (resetPosition === undefined) resetPosition = false
    var wasBuffering = resumeAfterBuffer
    bufferToken++
    if (bufferTimer !== null) clearInterval(bufferTimer)
    bufferTimer = null; resumeAfterBuffer = false; hideBuffer()
    if (wasBuffering){
      restorePlaybackState()
      if (resetPosition && Number.isFinite(bufferAnchor)){
        markInternalSeek()
        try { v.currentTime = bufferAnchor } catch (e) { clearInternalSeek() }
      }
    }
  }

  function finishBufferGate(token){
    if (token !== bufferToken || !resumeAfterBuffer) return
    if (bufferTimer !== null) clearInterval(bufferTimer)
    bufferTimer = null; resumeAfterBuffer = false; hideBuffer()
    // 缓冲期间用极低速静音播放来保持浏览器继续拉流；达标后回到用户 seek 的原位置，
    // 再恢复原速与静音状态。锚点已经落在 buffered 内，不会重新走网络。
    markInternalSeek()
    try { v.currentTime = bufferAnchor } catch (e) { clearInternalSeek() }
    restorePlaybackState()
    gateOnPlay = false
  }

  // 直连本身没报错、只是攒不够缓冲被判出局。日志要写清判定快照，否则和 <video> error
  // 那条路径混在一起没法区分（那条会先打 direct play failed, code=N）。
  function fallbackBufferGate(token, why){
    if (token !== bufferToken || !resumeAfterBuffer || !curPl || inFrame()) return
    var pl = curPl
    slog('buffer gate gave up (' + (why || 'unknown') + ') after ' + Math.round(performance.now() - bufferStartedAt) + 'ms url=' + pl.url)
    cancelBufferGate(false)
    embed(pl)
  }

  function checkBufferGate(token){
    if (token !== bufferToken || !resumeAfterBuffer || !curPl || curPl.kind !== 'mp4' || inFrame()) return
    // 切 src / loadedmetadata 时 Chromium 可能把 playbackRate 重置成 1；缓冲期间持续钉回
    // 极低速，确保下载在继续而播放位置几乎不动。
    v.muted = true
    if (v.playbackRate !== BUFFER_RATE){
      try { v.playbackRate = BUFFER_RATE } catch (e) { v.playbackRate = .25 }
    }
    var ahead = bufferedAhead(), goal = bufferGoal(), now = performance.now()
    if (ahead > bufferLastAhead + .05){ bufferLastAhead = ahead; bufferLastProgressAt = now }
    $('bufferText').textContent = '描线中 · 还差 ' + Math.max(0, Math.ceil(goal - ahead)) + ' 秒'
    if (ahead + .25 >= goal || v.ended){ finishBufferGate(token); return }
    if (now - bufferLastProgressAt >= BUFFER_STALL_MS || now - bufferStartedAt >= BUFFER_MAX_MS){
      var why = now - bufferLastProgressAt >= BUFFER_STALL_MS ? 'stall' : 'max wait'
      classifyMediaFailure(function(){ fallbackBufferGate(token, why + ' ahead=' + ahead.toFixed(1) + '/' + goal.toFixed(1)) }, function(){ if (curPl) playLine(curPl) })
      return
    }
    if (now - bufferSampleAt >= (bufferSampled ? BUFFER_SAMPLE_MS : BUFFER_WARMUP_MS)){
      var elapsed = Math.max(.001, (now - bufferSampleAt) / 1000)
      var mediaRate = (ahead - bufferSampleAhead) / elapsed + BUFFER_RATE
      if (mediaRate < BUFFER_MIN_MEDIA_RATE) {
        classifyMediaFailure(function(){ fallbackBufferGate(token, 'rate ' + mediaRate.toFixed(2) + 'x') }, function(){ if (curPl) playLine(curPl) })
        return
      }
      bufferSampled = true; bufferSampleAt = now; bufferSampleAhead = ahead
    }
  }

  function beginBufferGate(fromSeek){
    if (!curPl || curPl.kind !== 'mp4' || inFrame()) return
    var goal = bufferGoal()
    var ahead = bufferedAhead()
    gateOnPlay = false
    if (ahead + .25 >= goal) return
    if (bufferTimer !== null){
      if (fromSeek){ bufferAnchor = v.currentTime; resetBufferWatch(ahead) }
      return
    }
    resumeAfterBuffer = true
    bufferAnchor = v.currentTime
    savedRate = v.playbackRate
    savedMuted = v.muted
    v.muted = true
    try { v.playbackRate = BUFFER_RATE } catch (e) { v.playbackRate = .25 }
    var token = ++bufferToken
    resetBufferWatch(ahead)
    $('buffering').classList.add('show')
    checkBufferGate(token)
    bufferTimer = setInterval(function(){ checkBufferGate(token) }, 250)
  }

  // mp4 直连意外失败（少数编码问题）→ 静默切套娃。HLS 失败交给 hls.js 的 fatal。
  // 切套娃时会给 <video> removeAttribute+load，也会冒一个 error —— 用 inFrame()/有无 src 挡掉，别再回切。
  v.addEventListener('error', function(){
    if (!curPl || inFrame() || !v.getAttribute('src')) return
    // hls.js 自己处理错误；Safari / iOS 原生 HLS 没有 hls 实例，仍需回退官方播放器。
    if (curPl.kind === 'hls' && hls) return
    // 排查「总是回退官方 iframe」用：MediaError.code（1 abort/2 network/3 decode/4 src not supported）
    // 直接暴露在控制台，不用每次都翻源码猜是 CDN 拒了还是别的。
    if (v.error) slog('direct play failed, code=' + v.error.code + ' url=' + curPl.url)
    var failed = curPl
    classifyMediaFailure(function(){ cancelBufferGate(); embed(failed) }, function(){ playLine(failed) })
  })
  v.addEventListener('seeking', function(){
    if (internalSeek) return
    gateOnPlay = true
    if (!v.paused || resumeAfterBuffer) beginBufferGate(true)
  })
  v.addEventListener('seeked', function(){ if (internalSeek) clearInternalSeek() })
  v.addEventListener('playing', function(){ if (gateOnPlay && !internalSeek && !resumeAfterBuffer) beginBufferGate(false) })
  v.addEventListener('waiting', function(){
    if (internalSeek || v.paused) return
    if (!navigator.onLine){ holdForNetwork(function(){ if (curPl) playLine(curPl) }); return }
    gateOnPlay = true; beginBufferGate(false)
  })
  v.addEventListener('progress', function(){ if (bufferTimer !== null) checkBufferGate(bufferToken) })
  v.addEventListener('pause', function(){
    // 用户主动暂停时停止自动恢复，并把进度退回本次缓冲开始的位置。
    if (curPl && curPl.kind === 'mp4' && !internalSeek) gateOnPlay = true
    if (bufferTimer !== null && !internalSeek) cancelBufferGate(true)
  })
  v.addEventListener('ended', function(){ gateOnPlay = false; cancelBufferGate(false) })

  // ——— 预转 HLS（最小可用版：手动触发 + 轮询状态）———
  function prepareBox(){ return $('prepareBox') }

  function renderPrepare(st, url){
    var box = prepareBox()
    if (!box) return
    if (!url){ box.textContent = ''; box.className = 'prep'; return }
    var mb = st.bytes ? Math.round(st.bytes / 1048576) + 'MB' : ''
    if (st.state === 'ready'){
      box.className = 'prep ok'
      box.textContent = '这张已经上完色了 · ' + mb
    } else if (st.state === 'running' && st.playable){
      // 边转边播：已经攒够缓冲垫，可以一边看一边继续转。
      box.className = 'prep ok'
      box.textContent = '边描边看 · 已描好 ' + Math.round((st.segments || 0) * 6 / 60) + ' 分钟，后面的还在赶'
    } else if (st.state === 'running'){
      box.className = 'prep busy'
      box.textContent = '起稿中… 已描好 ' + Math.round((st.segments || 0) * 6) + ' 秒'
    } else if (st.state === 'failed'){
      // 转失败后代码会自动退回直连播放（卡但能看），所以文案要同时说清
      // 「出问题了」和「你现在能怎么办」——只说「没描成」看不出是报错。
      box.className = 'prep bad'
      box.textContent = '这张描废了，先将就着看 · '
      var fast = findFastLine()
      if (fast){
        var jump = document.createElement('button')
        jump.className = 'btn btn-sm'
        jump.textContent = '换线路 ' + fast.source + ' 会顺畅些'
        jump.onclick = function(){ selectLine(fast.source) }
        box.appendChild(jump)
      } else {
        box.appendChild(document.createTextNode('这条线路本来就慢，只能这样了'))
      }
    } else {
      // state=none：后台还没开始转。多半是**转码队列**在排（服务器同时只转一集，
      // 免得两集互相抢带宽），也可能是刚点开、轮询还没来得及触发。
      // 别用「排队」二字——那会和「观看名额满」撞车，用户分不清是哪种排队。
      box.className = 'prep'
      box.textContent = '前面还有一张在描 · 轮到这张就开始'
    }
  }

  function pollPrepare(url){
    if (prepareTimer){ clearTimeout(prepareTimer); prepareTimer = null }
    if (!url) return
    fetch('/api/xifan/prepared?u=' + encodeURIComponent(url), { cache: 'no-store' })
      .then(function(r){ return r.json() })
      .then(function(st){
        if (!st || st.error) return
        renderPrepare(st, url)
        if (st.state === 'failed' && curPl && curPl.url === url && prepareFailed !== url){
          prepareFailed = url
          playLine(curPl) // 转不出来只能退回代理直连，卡也比看不了强
          return
        }
        if (st.playable){
          var wasNew = preparedKey !== st.key
          preparedKey = st.key; preparedFor = url
          // 能播了就切（不必等整集转完）。两种情形：正等在起稿浮层里，或正播着直连版。
          if (wasNew && curPl && curPl.kind === 'mp4' && curPl.url === url){
            if (v.getAttribute('src')){
              resumeTime = v.currentTime; resumeWasPlaying = !v.paused
              resumePending = true; resumeKey = curPl.source + ':' + ep
            }
            hideBuffer()
            playLine(curPl)
          }
          // 还在转的话继续轮询，好让状态条跟着走；转完了就停。
          if (st.state === 'running') prepareTimer = setTimeout(function(){ pollPrepare(url) }, 10000)
          return
        }
        if (st.state === 'running') prepareTimer = setTimeout(function(){ pollPrepare(url) }, 5000)
      })
      .catch(function(){})
  }

  function destroyHls(){ if (hls){ try { hls.destroy() } catch (e) {} hls = null } }
  function stopAll(){ playGeneration++; cancelBufferGate(false); clearInternalSeek(); destroyHls(); try { v.pause() } catch (e) {} v.removeAttribute('src'); v.load(); frame.src = 'about:blank'; gateOnPlay = false }

  function renderSources(){
    var box = $('sources'); box.textContent = ''
    sourceOptions.forEach(function(source){
      var control = document.createElement('button')
      control.type = 'button'
      control.className = (source.active ? 'on' : '') + (!source.href ? ' unbound' : '')
      control.textContent = source.label + (!source.href ? ' · 未关联' : '')
      control.title = source.href ? source.label : source.label + ' 尚未关联，请先在“我的追番”选择片源'
      if (source.active) control.setAttribute('aria-current', 'true')
      else if (source.href) control.onclick = function(){ stopAll(); location.assign(source.href) }
      else control.onclick = function(){ fail(source.label + ' 尚未关联，请回“我的追番”选择片源') }
      box.appendChild(control)
    })
  }

  function renderChips(){
    var box = $('lines'); box.textContent = ''
    lines.forEach(function(l){
      var b = document.createElement('button')
      b.type = 'button'
      b.className = 'line-card' + (curPl && l.source === curPl.source ? ' on' : '')
      var dot = document.createElement('span'); dot.className = 'lc-dot'
      var name = document.createElement('span'); name.className = 'lc-name'
      name.textContent = '线路 ' + l.source + (l.name ? ' ' + l.name : '')
      b.appendChild(dot); b.appendChild(name)
      b.onclick = function(){ selectLine(l.source) }
      box.appendChild(b)
    })
  }

  function playLine(pl){
    // 只有走代理的慢源才谈得上预转；直连线路不需要，也别去占服务器空间。
    if (pl.kind === 'mp4' && needsProxy(pl.url)) pollPrepare(pl.url)
    else renderPrepare({ state: 'none' }, null)
    // 这一集若已经预转成 HLS，就改播分片版：<video> 直连服务器只开一条连接，跨境
    // 单连接只有 2.2Mbps（低于 2.67Mbps 码率），而 HLS 播放器会并发拉多片，
    // 同一条链路能跑到 5.22Mbps。细节见 xifan/prepare.ts。
    if (pl.kind === 'mp4' && preparedKey && preparedFor === pl.url){
      pl = { source: pl.source, kind: 'hls', url: '/api/xifan/hls/' + preparedKey + '/index.m3u8', viaPrepared: true }
    }
    // 慢源且还没转出可播部分时：**不要去播代理直连**。
    // 它注定不够快（<video> 单连接跨境 2.2Mbps < 2.67Mbps 码率），播了既卡、又会占满
    // 入口把预转冻住，形成「越想转越转不动」的死锁。老实等 1 分钟换全程流畅。
    if (pl.kind === 'mp4' && needsProxy(pl.url)){
      var pending = pl
      checkSlots(function(slots){
        if (slots && !slots.mine && slots.current >= slots.limit){ showQueue(slots); return }
        // 预转失败（配额满等）时才退回代理直连——聊胜于无，且有 iframe 兜底。
        if (prepareFailed === pending.url){ reallyPlay(pending); return }
        showDrafting(pending)
      })
      return
    }
    reallyPlay(pl)
  }

  // 等待预转攒够缓冲垫。这段时间不建代理连接，入口全留给 remux。
  function showDrafting(pl){
    curPl = pl
    stopAll()
    v.classList.remove('on'); frame.classList.remove('on')
    renderChips()
    $('buffering').classList.remove('retryable'); $('buffering').onclick = null
    $('bufferText').textContent = '这张底稿难描了点 · 大约 1 分钟就好'
    var acts = $('bufferActions')
    acts.textContent = ''
    // 只有**确实存在**已知快源时才给这个出口。没有还劝人家去换，那是把提示写成 bug。
    var fast = findFastLine()
    if (fast){
      var btn = document.createElement('button')
      btn.className = 'btn btn-sm'
      btn.textContent = '等不及？线路 ' + fast.source + ' 那边有现成的'
      btn.onclick = function(){ hideBuffer(); selectLine(fast.source) }
      acts.appendChild(btn)
    }
    $('buffering').classList.add('show')
    pollPrepare(pl.url)
  }

  function checkSlots(cb){
    fetch('/api/xifan/slots', { cache: 'no-store' })
      .then(function(r){ return r.json() })
      .then(cb)
      .catch(function(){ cb(null) }) // 问不到就别拦着，让它照常去播
  }

  // 名额满时不是「他自己卡」——出口带宽被三条连接平分，是**三个人一起卡**。
  // 所以宁可拦住新来的，也不能让正在看的两位跟着崩。
  function showQueue(slots){
    stopAll()
    v.classList.remove('on'); frame.classList.remove('on')
    var hasOther = lines.length > 1
    var box = $('buffering')
    box.classList.remove('retryable')
    $('bufferText').textContent = hasOther
      ? '画桌前坐满了 · 已经有 ' + slots.current + ' 位在描，换条线路，或者点一下再等等'
      : '画桌前坐满了 · 已经有 ' + slots.current + ' 位在描，点一下看看空出来没有'
    box.classList.add('show', 'retryable')
    box.onclick = function(){
      checkSlots(function(s){
        if (s && (s.mine || s.current < s.limit)){ hideBuffer(); if (curPl) playLine(curPl) }
        else if (s) showQueue(s)
      })
    }
  }

  function reallyPlay(pl){
    curPl = pl; clearFail(); stopAll(); renderChips()
    gateOnPlay = pl.kind === 'mp4'
    v.classList.add('on'); frame.classList.remove('on')
    // stopAll() 里的 cancelBufferGate 已经把上一条线路的浮层收掉；这里立刻重新盖上——
    // 从「设 src」到浏览器第一次 canplay 之间那段没有任何 waiting/playing 事件，
    // bufferGate 完全不知道，只能靠浏览器自己画黑色原生 loading，就是「点了播放还有 loading」
    // 那个体感的根：不是逻辑重复弹了两次，是这段空档我们的浮层压根没盖上过。
    $('bufferText').textContent = '描线中…'
    $('buffering').classList.remove('retryable'); $('buffering').onclick = null
    $('buffering').classList.add('show')
    if (pl.kind === 'hls'){
      if (window.Hls && Hls.isSupported()){
        // 90–120 秒足够覆盖网络抖动，同时避免旧配置一次抓 10–15 分钟、产生上百个分片请求。
        var noRetry = { maxNumRetry: 0, retryDelayMs: 0, maxRetryDelayMs: 0 }
        hls = new Hls({
          maxBufferLength: 90,
          maxMaxBufferLength: 120,
          maxBufferSize: 96 * 1000 * 1000,
          backBufferLength: 60,
          manifestLoadPolicy: { default: {
            maxTimeToFirstByteMs: 10000, maxLoadTimeMs: 30000,
            timeoutRetry: noRetry, errorRetry: noRetry
          } },
          playlistLoadPolicy: { default: {
            maxTimeToFirstByteMs: 10000, maxLoadTimeMs: 30000,
            timeoutRetry: noRetry, errorRetry: noRetry
          } },
          keyLoadPolicy: { default: {
            maxTimeToFirstByteMs: 10000, maxLoadTimeMs: 30000,
            timeoutRetry: noRetry, errorRetry: noRetry
          } },
          fragLoadPolicy: { default: {
            maxTimeToFirstByteMs: 10000,
            maxLoadTimeMs: 30000,
            timeoutRetry: noRetry,
            errorRetry: noRetry
          } }
        })
        hls.on(Hls.Events.ERROR, function(e, data){
          if (data && data.fatal) classifyMediaFailure(function(){ embed(pl) }, function(){ playLine(pl) })
        })
        hls.loadSource(pl.url); hls.attachMedia(v)
        var pp = v.play(); if (pp && pp.catch) pp.catch(function(){})
      } else if (v.canPlayType('application/vnd.apple.mpegurl')){
        v.src = pl.url; var p2 = v.play(); if (p2 && p2.catch) p2.catch(function(){}) // iOS 原生 HLS
      } else { embed(pl) }
    } else {
      // 慢源（线路一）走服务端 /stream 并发聚合；其余 mp4 保持裸直连——
      // 线路二直连 30Mbps 比走代理快得多，也不占服务器出口。
      v.src = needsProxy(pl.url) ? '/api/xifan/stream?u=' + encodeURIComponent(pl.url) : pl.url
      v.load(); var p = v.play(); if (p && p.catch) p.catch(function(){})
    }
  }

  // 套娃：直连播不了 → 嵌稀饭自己的真实播放器（跟你在稀饭看一样）
  function embed(pl){
    slog('fallback to official iframe, source=' + pl.source + ' kind=' + pl.kind + ' url=' + pl.url)
    curPl = pl
    cancelBufferGate(false); destroyHls(); try { v.pause() } catch (e) {} v.removeAttribute('src'); v.load()
    gateOnPlay = false; v.classList.remove('on'); frame.classList.add('on'); renderChips()
    frame.src = 'https://player.moedot.net/player/index.php?code=xfdm1&from=cf&url=' + encodeURIComponent(pl.url)
  }

  function resolveSource(source){
    if (resolvingMap[source]) return resolvingMap[source]
    var controller = new AbortController()
    var timeout = setTimeout(function(){ controller.abort() }, 16000)
    var url = '/api/xifan/resolve?animeId=' + encodeURIComponent(animeId) + '&ep=' + encodeURIComponent(ep) + '&source=' + source
    var job = fetch(url, { signal: controller.signal }).then(async function(r){
      var d = await r.json()
      if (!r.ok || !d || d.error || !d.url){
        var err = new Error(d && d.error ? d.error : '这条线路解析不到')
        err.code = d && d.code
        throw err
      }
      resolvedMap[source] = d
      return d
    }).catch(function(e){
      if (e && e.name === 'AbortError') throw new Error('线路解析等待超过 16 秒')
      throw e
    }).finally(function(){
      clearTimeout(timeout)
      if (resolvingMap[source] === job) delete resolvingMap[source]
    })
    resolvingMap[source] = job
    return job
  }

  async function selectLine(source){
    if (curPl && curPl.source === source && !inFrame() && !networkInterrupted) return
    var request = ++lineRequest
    clearFail()
    stopAll()
    var pl = resolvedMap[source]
    if (!pl){
      try {
        pl = await resolveSource(source)
      } catch (e){
        slog('resolveSource failed, source=' + source + ' msg=' + (e && e.message || e))
        if (request !== lineRequest) return
        classifyMediaFailure(
          function(){ if (request === lineRequest) fail('解析请求失败：' + (e && e.message || e), e && e.code) },
          function(){ if (request === lineRequest) selectLine(source) }
        )
        return
      }
    }
    if (request !== lineRequest) return
    playLine(pl)
  }

  // 换集 —— 直接改地址重载整页（裸页，全量重启最省事、也不残留上一集的 hls/buffer 状态）
  function goEp(n){
    if (n < 1) return
    var next = new URLSearchParams({ animeId: animeId, ep: String(n) })
    if (/^[0-9]+$/.test(bgmId)) next.set('bgmId', bgmId)
    stopAll(); location.search = '?' + next.toString()
  }
  // 集数网格（参考 app 播放页「集数」区）：当前集高亮，点其余集换过去；扒不到集数就退化成只显示当前集
  function renderEps(){
    var box = $('eps'); box.textContent = ''
    var cur = Number(ep) || 1
    if (!eps.length){
      var one = document.createElement('div'); one.className = 'ep-cell on'; one.textContent = cur; box.appendChild(one)
      return
    }
    eps.forEach(function(n){
      var b = document.createElement('button'); b.type = 'button'
      b.className = 'ep-cell' + (n === cur ? ' on' : '') + (goodEps[n] ? ' good' : '')
      b.textContent = n
      b.onclick = function(){ if (n !== cur) goEp(n) }
      box.appendChild(b)
    })
  }

  // 这集是不是我标过的好看集——不用 hover（手机没有 hover），直接常驻在播放框上方一条。
  // 没登录 / 没带 bgmId / 没追这部番时接口都只返回空，安安静静不显示，不算错误。
  function loadGoodEpisodes(){
    if (!/^[0-9]+$/.test(bgmId)) return Promise.resolve()
    return fetch('/api/tracks/' + bgmId + '/good-episodes', { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : null })
      .then(function(d){
        if (!d) return
        ;(d.goodEpisodes || []).forEach(function(n){ goodEps[n] = true })
        goodNotes = d.goodEpisodeNotes || {}
      })
      .catch(function(){})
  }
  function renderGoodNote(){
    var box = $('epgood')
    var cur = Number(ep) || 1
    if (!goodEps[cur]){ box.classList.remove('show'); box.textContent = ''; return }
    var note = goodNotes[cur]
    box.textContent = note ? ('这集我标过好看：' + note) : '这集我标过好看，就是没留下备注'
    box.classList.add('show')
  }

  async function boot(){
    if (!/^[0-9]+$/.test(animeId) || !/^[0-9]+$/.test(ep)){ fail('URL 参数不合法'); return }
    renderSources()
    $('epbadge').textContent = 'EP ' + ep
    renderEps() // 先按 URL 的 ep 画一版占位，拿到 playlist 的整季集数再重画
    var goodPromise = loadGoodEpisodes()
    try {
      var r = await fetch('/api/xifan/playlist?animeId=' + encodeURIComponent(animeId) + '&ep=' + encodeURIComponent(ep))
      var d = await r.json()
      if (d.error){ fail('加载失败：' + d.error, d.code); return }
      lines = d.lines || []
      eps = d.eps || []
      if (d.title){ $('ttl').textContent = d.title }
      await goodPromise
      renderEps(); renderChips(); renderGoodNote()
      // 按 first.source 存，**不能写死 1**：服务端返回的 first 是「最优线路」，
      // 未必是线路 1（它会跳过需要代理的慢源）。写死会让 resolvedMap[1] 装着别条线路的
      // 地址，点线路 1 拿到的却是那条——表现为「点了没反应」。
      if (d.first){ resolvedMap[d.first.source] = d.first; playLine(d.first) }
      else { fail('这一集解析不到 —— 可能还没更新，点上面别的集试试') }
    } catch (e){
      classifyMediaFailure(
        function(){ fail('请求失败：' + (e && e.message || e)) },
        function(){ boot() }
      )
    }
  }
  boot()
})();
</script>
</body>
</html>`
