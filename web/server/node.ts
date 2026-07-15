import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import app from './index'

// 生产 / 自有 VPS 运行入口：同一个 Hono 应用（/api/* 已在 index.ts 里定义、优先匹配）
// + 服务 `npm run build` 打包出的前端 dist/。
// 本地开发不走这里（走 vite dev + dev-server 插件）；Vercel 备选走 api/[[...route]].ts。
// VPS 上：`npm run build` 出 dist/，再 `npm start` 跑本文件。
app.use('/*', serveStatic({ root: './dist' }))
// SPA 兜底：没命中静态文件的路由回 index.html（当前单页；将来加前端路由也不裂）。
app.get('*', serveStatic({ path: './dist/index.html' }))

const port = Number(process.env.PORT) || 3000
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[web] listening on http://0.0.0.0:${info.port}`)
})
