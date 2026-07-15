import { Hono } from 'hono'
import { getCalendar } from './bgm/calendar'
import auth from './auth'

// 单一 Hono 应用 = API 的唯一真相源。本地开发经 vite.config 的 dev-server 插件跑，
// 生产经 web/api/[[...route]].ts 在 Vercel serverless 跑，将来迁 VPS 用 @hono/node-server
// 直接跑 —— 三处都是这一个 app，路由只写一遍。
const app = new Hono()

app.get('/api/health', (c) => c.json({ ok: true }))

// 账号体系：注册 / 登录 / 登出 / me。
app.route('/api/auth', auth)

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
// 只放行 `/pic/` 前缀，杜绝 SSRF。封面 URL 自带内容 hash、不变 → 长缓存。
app.get('/api/cover/*', async (c) => {
  const path = c.req.path.replace(/^\/api\/cover/, '')
  if (!path.startsWith('/pic/')) return c.text('forbidden', 403)
  try {
    const upstream = await fetch(`https://lain.bgm.tv${path}`, {
      headers: { 'User-Agent': 'MapleTools-Web/0.1 (https://github.com/AlcMaple/tools)' },
      signal: AbortSignal.timeout(15000),
    })
    if (!upstream.ok || !upstream.body) return c.text('upstream error', 502)
    c.header('Content-Type', upstream.headers.get('content-type') ?? 'image/jpeg')
    c.header('Cache-Control', 'public, max-age=2592000, immutable')
    return c.body(upstream.body)
  } catch {
    return c.text('fetch failed', 502)
  }
})

export default app
