import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import app from './index'

// 生产 / 自有 VPS 运行入口：同一个 Hono 应用（/api/* 已在 index.ts 里定义、优先匹配）
// + 服务 `npm run build` 打包出的前端 dist/。
// 本地开发不走这里（走 vite dev + dev-server 插件）；Vercel 备选走 api/[[...route]].ts。
// VPS 上：`npm run build` 出 dist/，再 `npm start` 跑本文件。
// 静态资源的缓存头。serveStatic 自己只发 Last-Modified，没有 Cache-Control —— 浏览器只能
// 靠启发式缓存瞎猜，实测线上每次进站都可能重新取那张 200KB 的开屏立绘。
//
// **两类资源必须分开对待**：
//   - vite 打包产物（`index-7uqcGf7t.js` 这种）文件名带内容 hash，内容一变文件名就变，
//     可以放心 immutable、存一年。
//   - `public/` 原样拷过去的（`/assets/sagiri-full.webp` 等角色立绘）**文件名不带 hash**，
//     真敢 immutable 一年，以后换图线上一年刷不掉。所以给一天 + must-revalidate：
//     常规访问走缓存，换了图第二天自然生效，急用就改文件名。
app.use('/assets/*', async (c, next) => {
  await next()
  if (c.res.status !== 200) return
  const hashed = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(new URL(c.req.url).pathname)
  c.res.headers.set(
    'Cache-Control',
    hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=86400, must-revalidate',
  )
})
app.use('/*', serveStatic({ root: './dist' }))
// SPA 兜底：没命中静态文件的路由回 index.html（当前单页；将来加前端路由也不裂）。
app.get('*', serveStatic({ path: './dist/index.html' }))

const port = Number(process.env.PORT) || 3000
// 默认只绑回环 —— 这台机上 nginx 才是唯一入口（负责 HTTPS / 证书 / 转发）。
// 曾经绑 0.0.0.0：公网直连 http://<ip>:3000 就绕开了 nginx，登录密码明文过网，
// 且 X-Forwarded-For 随便伪造（限流形同虚设）。要对外裸跑再显式给 HOST=0.0.0.0。
const hostname = process.env.HOST || '127.0.0.1'
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[web] listening on http://${hostname}:${info.port}`)
})
