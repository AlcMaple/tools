import { Hono, type Context } from 'hono'
import { getCalendar } from './bgm/calendar'
import { searchAnime, indexStatus } from './bgm/anime-index'
import { searchAdditions } from './bgm/search-additions'
import { searchOnline } from './bgm/search-online'
import auth from './auth'
import oauth from './oauth'
import tracks from './tracks'
import girigiri from './girigiri'
import xifan from './xifan'
import { sameOriginGuard, securityHeaders } from './security'

// 本地开发通常没有 5.6MB 的 bgm_index.db（生成它要下载 400MB+ 官方离线档）。
// 仅 localhost 且本地索引未就绪时，借线上公开搜索 API 返回同形数据；追番写入、
// 登录和稀饭会话仍全部留在本地。生产有自己的索引，不会走这里。
const DEV_SEARCH_ORIGIN = process.env.DEV_SEARCH_ORIGIN || 'https://anime.alcmaple.cn'

async function searchFromDeployedWeb(q: string): Promise<Record<string, unknown> | null> {
  try {
    const url = new URL('/api/search', DEV_SEARCH_ORIGIN)
    url.searchParams.set('q', q)
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) })
    if (!response.ok) return null
    const data = (await response.json()) as Record<string, unknown>
    return data.ready === true && Array.isArray(data.data) ? data : null
  } catch {
    return null
  }
}

// 单一 Hono 应用 = API 的唯一真相源。本地开发经 vite.config 的 dev-server 插件跑，
// 生产经 web/api/[[...route]].ts 在 Vercel serverless 跑，将来迁 VPS 用 @hono/node-server
// 直接跑 —— 三处都是这一个 app，路由只写一遍。
const app = new Hono()

// 先挂在所有路由上：VPS 的静态 dist、API 和 Vercel serverless 都走同一套响应头。
app.use('*', securityHeaders())
// 所有写请求都先过来源校验；SameSite=Strict 仍是 Cookie 层的第二道防线。
app.use('/api/*', sameOriginGuard())

app.get('/api/health', (c) => c.json({ ok: true }))

// 账号体系：注册 / 登录 / 登出 / me。
app.route('/api/auth', auth)

// 第三方 OIDC 登录（Google，凭据未配时入口自动隐藏）。回调路径与 Google 控制台登记的
// https://anime.alcmaple.cn/api/auth/oauth/google/callback 一致，本地联调需另登记 localhost URI。
app.route('/api/auth/oauth', oauth)

// 追番：列表 / 增改（字段级 patch）/ 删。要登录。
app.route('/api/tracks', tracks)

// 稀饭在线观看「浏览器直连」可行性原型:probe 诊断 + 自包含试播页,
// 不登录、不碰 SPA。验证过就会长成①定位那一档的解析后端，或被判定要走服务器代理。
app.route('/api/xifan', xifan)

// Girigiri 在线观看：同样是服务端解析页面元数据、浏览器直连源 CDN，不中转视频。
app.route('/api/girigiri', girigiri)

// 追番「搜索加番」—— 打**本地** BGM 动漫索引（bgm_index.db），见 bgm/anime-index.ts。
// 索引没生成时 ready=false，前端据此提示「先跑同步脚本」。
//
// 只有本地**一条都没搜到**时，才查「用户实际加过」的持久补充表；它也没有才退回一次
// BGM 在线搜（离线档每周三才更新，本周新建的条目本地必然没有）。本地或补充表有结果就
// 绝不联网 —— 单机单 IP 被 BGM 限流会把周历和封面代理一起带走。在线那条路仍保留原有
// 缓存 / 限速 / 冷却，且失败不重试（bgm/search-online.ts）。
app.get('/api/search', async (c) => {
  const q = c.req.query('q') ?? ''
  const st = indexStatus()
  c.header('Cache-Control', 'no-store')
  if (!st.ready) {
    const hostname = new URL(c.req.url).hostname
    const localRequest = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    if (process.env.NODE_ENV !== 'production' && localRequest) {
      const deployed = await searchFromDeployedWeb(q)
      if (deployed) return c.json(deployed)
    }
    return c.json({ ready: false, data: [] })
  }
  // builtAt/total 是给运维看的：q 传空就只回这两个数，等于一个「索引同步到哪天了」的健康检查
  const base = { ready: true, total: st.count, builtAt: st.builtAt }
  const local = searchAnime(q, 30)
  if (local.length || !q.trim()) return c.json({ ...base, source: 'local', data: local })
  const learned = searchAdditions(q, 30)
  if (learned.length) return c.json({ ...base, source: 'learned', data: learned })
  const online = await searchOnline(q)
  return c.json({ ...base, source: 'online', data: online.hits, onlineError: online.error })
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

// 封面代理 —— BGM 图床 lain.bgm.tv 在国内被墙，国内免魔法用户浏览器直连拿不到（实测大陆机 curl
// BGM 超时）。由海外服务器代取再回传。**路径式**：前端把 `https://lain.bgm.tv/pic/...` 重写成
// `/api/cover/pic/...`，URL 里**不出现 bgm.tv** —— 否则 HTTP 明文下 GFW 看到 `bgm.tv` 会把请求
// RST（实测：手机端 /api/cover?u=…bgm.tv 全 499、随后整个 IP:80 被临时封）。host 写死 lain.bgm.tv、
// 路径按白名单放行，杜绝 SSRF。封面 URL 自带内容 hash、不变 → 长缓存。
//
// 两种形态都要过：`/pic/...`（原图）和 `/r/<宽>/pic/...`（图床按宽度实时缩放，周历在用，
// 见 bgm/calendar.ts 的 COVER_WIDTH）。仍然只认 `pic/` 那一段，不放行图床上的任意路径。
const COVER_PATH_RE = /^\/(r\/\d{2,4}\/)?pic\//
app.get('/api/cover/*', async (c) => {
  const path = c.req.path.replace(/^\/api\/cover/, '')
  if (!COVER_PATH_RE.test(path)) return c.text('forbidden', 403)
  try {
    const upstream = await fetch(`https://lain.bgm.tv${path}`, {
      headers: { 'User-Agent': 'MapleTools-Web/0.1 (https://github.com/AlcMaple/tools)' },
      signal: AbortSignal.timeout(15000),
    })
    if (!upstream.ok || !upstream.body) return c.text('upstream error', 502)
    const contentType = upstream.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase() ?? ''
    // 代理只允许图片。上游异常返回 HTML 时不能把它原样挂在本站路径下，避免被浏览器当
    // 成可执行文档或被未来的页面导航误用。
    if (!/^image\/(?:png|jpe?g|gif|webp)$/i.test(contentType)) return c.text('upstream image type rejected', 502)
    c.header('Content-Type', contentType)
    c.header('Cache-Control', 'public, max-age=2592000, immutable')
    return c.body(upstream.body)
  } catch {
    return c.text('fetch failed', 502)
  }
})

// `/api` 是封闭的系统命名空间：未知接口始终返回 JSON 404，不能继续落进 node.ts 的
// SPA index.html 兜底。这样客户端不会把一张页面误认成接口成功，也不会让未来的页面路由
// 或用户标识参与 API 路径匹配。
const apiNotFound = (c: Context) => c.json({ error: '接口不存在' }, 404)
app.all('/api', apiNotFound)
app.all('/api/*', apiNotFound)

export default app
