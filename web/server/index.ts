import { Hono } from 'hono'
import { getCalendar } from './bgm/calendar'

// 单一 Hono 应用 = API 的唯一真相源。本地开发经 vite.config 的 dev-server 插件跑，
// 生产经 web/api/[[...route]].ts 在 Vercel serverless 跑，将来迁 VPS 用 @hono/node-server
// 直接跑 —— 三处都是这一个 app，路由只写一遍。
const app = new Hono()

app.get('/api/health', (c) => c.json({ ok: true }))

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

// 封面代理 —— BGM（含图床 lain.bgm.tv）在国内被墙，国内免魔法用户的浏览器直连拿不到封面
// （实测阿里云大陆机 curl BGM 超时）。由海外服务器代取再回传。**只允许 BGM 图床**，避免变成
// 开放代理 / SSRF。封面 URL 自带内容 hash、不变 → 长缓存，浏览器只回源一次。
const COVER_HOST_RE = /(^|\.)bgm\.tv$/

app.get('/api/cover', async (c) => {
  const u = c.req.query('u')
  if (!u) return c.text('missing u', 400)
  let url: URL
  try {
    url = new URL(u)
  } catch {
    return c.text('bad url', 400)
  }
  if (url.protocol !== 'https:' || !COVER_HOST_RE.test(url.hostname)) {
    return c.text('forbidden host', 403)
  }
  try {
    const upstream = await fetch(url.toString(), {
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
