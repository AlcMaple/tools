import { Hono, type Context } from 'hono'
import bootLog from './boot-log'
// 监控要最先加载：Sentry.init 是这个模块的导入副作用，必须早于它可能包裹的业务模块，
// 否则将来任何一个自动 integration 被重新打开都会因为加载顺序而静默失效。
import { monitoringErrorHandler, monitoringMiddleware } from './monitoring'
import { getCalendar } from './bgm/calendar'
import { bgmHealth, noteBgmRequest } from './bgm/bgm-health'
import { deriveSeason, getSeason, isBackfillable, isSeasonKey, listSeasons, seasonKeyOf } from './bgm/calendar-history'
import { CoverError, getBgmCover } from './bgm/cover-proxy'
import { searchAnime, indexStatus } from './bgm/anime-index'
import { searchAdditions } from './bgm/search-additions'
import { searchOnline } from './bgm/search-online'
import auth from './auth'
import announcements from './announcement'
import feedback from './feedback'
import oauth from './oauth'
import tracks from './tracks'
import girigiri from './girigiri'
import player from './player'
import xifan from './xifan'
import rewards from './rewards-api'
import community from './community'
import reviews from './reviews'
import backup from './backup'
import agentHistory from './agent/history-api'
import agentGuest from './agent/guest-api'
import { maintenanceMode } from './maintenance'
import { sameOriginGuard, securityHeaders } from './security'

// 本地开发通常没有 5.6MB 的 bgm_index.db（生成它要下载 400MB+ 官方离线档）。
// 仅 localhost 且本地索引未就绪时，借线上公开的**离线结果**返回同形数据；追番写入、
// 登录和稀饭会话仍全部留在本地。生产有自己的索引，不会走这里。
const DEV_SEARCH_ORIGIN = process.env.DEV_SEARCH_ORIGIN || 'https://anime.alcmaple.cn'

// 本地开发没有索引时每次搜索都要翻山越岭问线上：不去重、不缓存、超时 12 秒，回填弹窗一开
// 还会先发一次空查询，用户看到的就是「纱雾正在翻目录」转很久。同一个词 60 秒内共用一份结果 /
// 一个在途请求；失败也短暂记住，避免在代理黑洞时每次输入都再等满超时。
const DEPLOYED_TIMEOUT_MS = 6000
const DEPLOYED_TTL_MS = 60_000
const deployedCache = new Map<string, { at: number; value: Promise<Record<string, unknown> | null> }>()

async function fetchDeployedSearch(q: string): Promise<Record<string, unknown> | null> {
  try {
    const url = new URL('/api/search', DEV_SEARCH_ORIGIN)
    url.searchParams.set('q', q)
    url.searchParams.set('mode', 'local')
    const response = await fetch(url, { signal: AbortSignal.timeout(DEPLOYED_TIMEOUT_MS) })
    if (!response.ok) return null
    const data = (await response.json()) as Record<string, unknown>
    // 只接受离线来源（source=local/learned）。当前 /api/search 在 mode=local 下不会在线兜底，
    // 这一层是防御：万一对端跑着某个会自动回退到 BGM 的旧版本，也不采用它的 online 结果。
    return data.ready === true
      && (data.source === 'local' || data.source === 'learned')
      && Array.isArray(data.data)
      ? data
      : null
  } catch (error) {
    console.warn(`[search] 借线上离线索引失败 q="${q}": ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function searchFromDeployedWeb(q: string): Promise<Record<string, unknown> | null> {
  const now = Date.now()
  const hit = deployedCache.get(q)
  if (hit && now - hit.at < DEPLOYED_TTL_MS) return hit.value
  if (deployedCache.size > 200) deployedCache.clear()
  const value = fetchDeployedSearch(q)
  deployedCache.set(q, { at: now, value })
  return value
}

// 单一 Hono 应用 = API 的唯一真相源。本地开发经 vite.config 的 dev-server 插件跑，
// 生产经 web/api/[[...route]].ts 在 Vercel serverless 跑，将来迁 VPS 用 @hono/node-server
// 直接跑 —— 三处都是这一个 app，路由只写一遍。
const app = new Hono()

// 最外层先给每个请求 request id，并在配置 SENTRY_DSN 时采集未处理异常与低采样性能 trace。
app.use('*', monitoringMiddleware())
app.onError(monitoringErrorHandler())
// 先挂在所有路由上：VPS 的静态 dist、API 和 Vercel serverless 都走同一套响应头。
app.use('*', securityHeaders())
// 服务器上建 DATA_DIR/MAINTENANCE 文件即进入维护页，删掉恢复；必须排在所有路由和静态文件之前。
app.use('*', maintenanceMode())
// 所有写请求都先过来源校验；SameSite=Strict 仍是 Cookie 层的第二道防线。
app.use('/api/*', sameOriginGuard())

app.route('/api/boot-log', bootLog)

app.get('/api/health', (c) => c.json({ ok: true }))
// BGM 连通状态（被动记账，不会去请求 BGM）。ok / idle 返回 200；被限流 / 大面积失败返回 503，
// 方便外部监控直接按状态码判断，具体原因看 body。
app.get('/api/health/bgm', (c) => {
  const health = bgmHealth()
  c.header('Cache-Control', 'no-store')
  return c.json(health, health.state === 'ok' || health.state === 'idle' ? 200 : 503)
})

// 账号体系：注册 / 登录 / 登出 / me。
app.route('/api/auth', auth)

// 第三方 OIDC 登录（Google，凭据未配时入口自动隐藏）。回调路径与 Google 控制台登记的
// https://anime.alcmaple.cn/api/auth/oauth/google/callback 一致，本地联调需另登记 localhost URI。
app.route('/api/auth/oauth', oauth)

// 积分、邀请、权益兑换与幸运扭蛋。页面视觉另行设计，服务端合同先保持独立。
app.route('/api/rewards', rewards)


// 公开追番大厅：只读、无需登录；具体用户是否可见由 users.tracks_public 控制。
app.route('/api/community', community)

// 首页开屏后的站内公告：登录账号可为当前公告版本保存“暂不再显示”偏好。
app.route('/api/announcements', announcements)
app.route('/api/feedback', feedback)

// 追番：列表 / 增改（字段级 patch）/ 删。要登录。
app.route('/api/tracks', tracks)

// 推荐与点评助手：草稿 / 当前内容 / 发布 / 撤回 + 服务器 AI 问答与初稿生成。要登录。
app.route('/api/reviews', reviews)
// 备份导入导出：追番 + 点评/推荐，用户自己留底或跨账号拿追番清单
app.route('/api/backup', backup)

app.route('/api/agent', agentGuest)
app.route('/api/agent', agentHistory)

// 稀饭在线观看「浏览器直连」可行性原型:probe 诊断 + 自包含试播页,
// 不登录、不碰 SPA。验证过就会长成①定位那一档的解析后端，或被判定要走服务器代理。
app.route('/api/xifan', xifan)

// Girigiri 在线观看：同样是服务端解析页面元数据、浏览器直连源 CDN，不中转视频。
app.route('/api/girigiri', girigiri)

// 新播放页（docs/design/播放页重写方案.md）：稀饭 / Girigiri 共用，全部经服务器代理；含阶段 0 测速页。先与旧播放页并存。
app.route('/api/player', player)

// 追番「搜索加番」默认只打**本地** BGM 动漫索引（bgm_index.db）和成功加番积累的补充表，
// 见 bgm/anime-index.ts / bgm/search-additions.ts。离线档每周更新，命中并不代表 BGM
// 刚刚新增的条目也在里面，所以前端把在线搜索做成用户可见的明确动作，而不是隐式兜底。
// `mode=online` 才会访问 BGM 在线搜索；这条路仍保留缓存 / 限速 / 冷却，且失败不重试
//（bgm/search-online.ts）。
app.get('/api/search', async (c) => {
  const started = Date.now()
  const q = c.req.query('q') ?? ''
  // 只记有词的搜索；本地搜索正常是几十毫秒，日志里出现大数字就是服务端这一段慢
  const done = (source: string, hits: number): void => {
    if (q.trim()) console.log(`[search] q="${q.trim().slice(0, 40)}" source=${source} hits=${hits} server=${Date.now() - started}ms`)
  }
  const onlineRequested = c.req.query('mode') === 'online' || c.req.query('online') === '1'
  const st = indexStatus()
  c.header('Cache-Control', 'no-store')

  // 在线搜索是独立入口：索引缺失、过期或已有本地结果都不影响用户主动去 BGM 查最新条目。
  if (onlineRequested) {
    const base = { ready: st.ready, total: st.count, builtAt: st.builtAt }
    if (!q.trim()) return c.json({ ...base, source: 'online', data: [] })
    const online = await searchOnline(q)
    done('online', online.hits.length)
    return c.json({ ...base, source: 'online', data: online.hits, onlineError: online.error })
  }

  if (!st.ready) {
    const hostname = new URL(c.req.url).hostname
    const localRequest = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    if (process.env.NODE_ENV !== 'production' && localRequest) {
      const deployed = await searchFromDeployedWeb(q)
      if (deployed) {
        done('dev-deployed', Array.isArray(deployed.data) ? deployed.data.length : 0)
        return c.json(deployed)
      }
    }
    done('not-ready', 0)
    return c.json({ ready: false, data: [] })
  }
  // builtAt/total 是给运维看的：q 传空就只回这两个数，等于一个「索引同步到哪天了」的健康检查
  const base = { ready: true, total: st.count, builtAt: st.builtAt }
  const local = searchAnime(q, 30)
  if (local.length || !q.trim()) {
    done('local', local.length)
    return c.json({ ...base, source: 'local', data: local })
  }
  const learned = searchAdditions(q, 30)
  if (learned.length) {
    done('learned', learned.length)
    return c.json({ ...base, source: 'learned', data: learned })
  }
  done('local', 0)
  return c.json({ ...base, source: 'local', data: [] })
})

// 快慢搜索都记录 DOM 提交耗时；浏览器时钟只和同端日志关联，不能直接减服务端时间。
app.post('/api/search-log', async (c) => {
  const raw = (await c.req.text().catch(() => '')).slice(0, 1000)
  try {
    const b = JSON.parse(raw) as Record<string, unknown>
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : -1)
    const t = (v: unknown, max: number): string => String(v ?? '').replace(/[\r\n]/g, ' ').slice(0, max)
    console.log(`[search:client] q="${t(b.q, 40)}" mode=${t(b.mode, 10)} outcome=${t(b.outcome, 10)} client=${n(b.ms)}ms`)
    if (b.outcome === 'committed') console.log('[search:display]', JSON.stringify({
      q: t(b.q, 40), mode: t(b.mode, 10), startedAt: n(b.startedAt),
      inputWaitMs: n(b.inputWaitMs), readyMs: n(b.readyMs), sortMs: n(b.sortMs), commitMs: n(b.ms), count: n(b.count),
    }))
  } catch {
    /* 上报格式不对就丢，日志接口不该产生新错误 */
  }
  return c.body(null, 204)
})

app.post('/api/request-log', async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (body && typeof body.path === 'string' && /^\/api\/[a-z/-]{1,80}$/.test(body.path)) {
    const outcome = ['ok', 'timeout', 'failed'].includes(String(body.outcome)) ? body.outcome : 'unknown'
    const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
    const timing = body.timing && typeof body.timing === 'object' ? body.timing as Record<string, unknown> : {}
    console.warn('[request:client]', JSON.stringify({
      path: body.path, outcome, status: number(body.status), ms: number(body.ms), startedAt: number(body.startedAt),
      reason: typeof body.reason === 'string' ? body.reason.replace(/[\r\n]/g, ' ').slice(0, 240) : '',
      requestId: /^[a-f0-9-]{36}$/.test(String(body.requestId)) ? body.requestId : null,
      headersMs: number(body.headersMs), bodyMs: number(body.bodyMs),
      visibility: body.visibility === 'hidden' ? 'hidden' : 'visible', online: body.online === true,
      dnsMs: number(timing.dnsMs), connectMs: number(timing.connectMs), waitMs: number(timing.waitMs), receiveMs: number(timing.receiveMs),
      transferBytes: number(timing.transferBytes), protocol: ['h2', 'h3', 'http/1.1'].includes(String(timing.protocol)) ? timing.protocol : '',
    }))
  }
  return c.body(null, 204)
})

app.get('/api/calendar', async (c) => {
  const force = c.req.query('force') === '1'
  try {
    const result = await getCalendar(force)
    // 边缘缓存 1 天、过期后 7 天内后台再验 —— 周期表一季度才变，对缓存极友好，
    // 也进一步减轻对 BGM 的请求压力。
    c.header('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800')
    return c.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误'
    return c.json({ error: message }, 502)
  }
})

// 往期周历：每个季度一份 BGM 周历快照，从接入起往后存。本季还在随周历更新，其余季度已冻结。
app.get('/api/calendar/seasons', (c) => {
  // 目录随快照增长，不让浏览器 / 边缘缓存把「还没有」固定住
  c.header('Cache-Control', 'no-cache')
  return c.json({ seasons: listSeasons() })
})

app.get('/api/calendar/seasons/:key', async (c) => {
  const key = c.req.param('key')
  if (!isSeasonKey(key)) return c.json({ error: '季度不合法' }, 400)
  const current = key === seasonKeyOf(Date.now())
  let snapshot = getSeason(key)
  if (!snapshot && isBackfillable(key)) {
    try {
      snapshot = await deriveSeason(key)
    } catch (error) {
      console.warn(`[calendar-history] 补 ${key} 失败:`, error instanceof Error ? error.message : error)
      c.header('Cache-Control', 'no-store')
      return c.json({ error: error instanceof Error ? error.message : '补这一季时出了问题' }, 502)
    }
  }
  if (!snapshot) return c.json({ error: '这个季度还没有周历记录' }, 404)
  c.header('Cache-Control', current ? 'public, max-age=300' : 'public, max-age=86400')
  return c.json({ key, data: snapshot.data, updatedAt: snapshot.updatedAt, current, derived: snapshot.derived })
})

// 封面代理 —— BGM 图床 lain.bgm.tv 在国内被墙，国内免魔法用户浏览器直连拿不到（实测大陆机 curl
// BGM 超时）。由海外服务器代取再回传。**路径式**：前端把 `https://lain.bgm.tv/pic/...` 重写成
// `/api/cover/pic/...`，URL 里**不出现 bgm.tv** —— 否则 HTTP 明文下 GFW 看到 `bgm.tv` 会把请求
// RST（实测：手机端 /api/cover?u=…bgm.tv 全 499、随后整个 IP:80 被临时封）。host 写死 lain.bgm.tv、
// 路径按白名单放行，杜绝 SSRF。封面 URL 自带内容 hash、不变 → 长缓存。
//
// 两种形态都要过：`/pic/...`（原图）和 `/r/<宽>/pic/...`（图床按宽度实时缩放，周历在用，
// 见 bgm/calendar.ts 的 COVER_WIDTH）。仍然只认 `pic/` 那一段，不放行图床上的任意路径。
const COVER_PATH_RE = /^\/(r\/\d{2,4}\/)?pic\//
const subjectCovers = new Map<number, { path: string; at: number }>()
const subjectCoverRequests = new Map<number, Promise<string>>()

// 旧同步记录可能带已失效的百科图床；只为这些 BGM 条目取官方封面，不改用户保存的数据。
app.get('/api/subject-cover/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isSafeInteger(id) || id <= 0) return c.text('invalid subject', 400)
  c.header('Cache-Control', 'no-store')
  const cached = subjectCovers.get(id)
  if (cached && Date.now() - cached.at < 3600_000) return c.redirect(cached.path)
  let request = subjectCoverRequests.get(id)
  if (!request) {
    if (subjectCoverRequests.size >= 4) return c.text('cover busy', 503)
    request = (async () => {
      const subjectUrl = `https://api.bgm.tv/v0/subjects/${id}`
      let response: Response
      try {
        response = await fetch(subjectUrl, {
          headers: { 'User-Agent': 'MapleTools-Web/0.1 (https://github.com/AlcMaple/tools)' },
          signal: AbortSignal.timeout(10_000),
        })
      } catch (error) {
        noteBgmRequest(subjectUrl, null)
        throw error
      }
      noteBgmRequest(subjectUrl, response.status)
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`BGM HTTP ${response.status}`)
      }
      const data = await response.json() as { images?: { common?: string; large?: string } }
      const url = new URL(data.images?.common || data.images?.large || '')
      if (url.hostname !== 'lain.bgm.tv' || !COVER_PATH_RE.test(url.pathname)) throw new Error('BGM cover missing')
      const path = `/api/cover${url.pathname}`
      if (subjectCovers.size >= 128) subjectCovers.delete(subjectCovers.keys().next().value!)
      subjectCovers.set(id, { path, at: Date.now() })
      return path
    })()
    subjectCoverRequests.set(id, request)
  }
  try {
    return c.redirect(await request)
  } catch (error) {
    console.warn(`[cover] subject=${id}`, error)
    return c.text('subject cover unavailable', 502)
  } finally {
    if (subjectCoverRequests.get(id) === request) subjectCoverRequests.delete(id)
  }
})

app.get('/api/cover/*', async (c) => {
  const path = c.req.path.replace(/^\/api\/cover/, '')
  if (!COVER_PATH_RE.test(path)) return c.text('forbidden', 403)
  try {
    const image = await getBgmCover(path)
    c.header('Content-Type', image.contentType)
    c.header('Cache-Control', 'public, max-age=2592000, immutable')
    return c.body(image.body)
  } catch (error) {
    console.warn(`[cover] 代取失败 ${path}:`, error instanceof Error ? error.message : error)
    c.header('Cache-Control', 'no-store')
    const status = error instanceof CoverError ? error.status : 502
    return c.text(error instanceof CoverError ? error.message : 'fetch failed', status as 502 | 503)
  }
})

// `/api` 是封闭的系统命名空间：未知接口始终返回 JSON 404，不能继续落进 node.ts 的
// SPA index.html 兜底。这样客户端不会把一张页面误认成接口成功，也不会让未来的页面路由
// 或用户标识参与 API 路径匹配。
const apiNotFound = (c: Context) => c.json({ error: '接口不存在' }, 404)
app.all('/api', apiNotFound)
app.all('/api/*', apiNotFound)

export default app
