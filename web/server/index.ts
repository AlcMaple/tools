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

export default app
