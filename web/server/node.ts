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
// HTML 入口不在这份长期缓存里：发布后手机可能从挂起标签恢复旧的 index.html；它若引用
// 已换名的入口脚本，脚本请求会被 SPA 兜底成 HTML，浏览器随后整页空白。入口每次回源校验，
// 资源路径也单独返回 404，脚本加载器收到的始终是明确的资源响应。
app.use('/*', async (c, next) => {
  await next()
  if (c.res.status !== 200) return
  const contentType = c.res.headers.get('Content-Type')?.split(';', 1)[0].toLowerCase()
  if (contentType === 'text/html') c.res.headers.set('Cache-Control', 'no-cache, must-revalidate')
})
app.use('/white-screen-probe.js', async (c, next) => {
  await next()
  if (c.res.status === 200) c.res.headers.set('Cache-Control', 'no-cache, must-revalidate')
})
app.use('/assets/*', async (c, next) => {
  await next()
  if (c.res.status !== 200) return
  // 自愈响应（见下面的 STALE_ENTRY_RECOVERY）自己带 no-store，绝不能被这里改成 immutable：
  // 那等于把"重新加载"这段脚本按旧 hash 缓存一年。
  if (c.res.headers.has('Cache-Control')) return
  const hashed = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(new URL(c.req.url).pathname)
  c.res.headers.set(
    'Cache-Control',
    hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=86400, must-revalidate',
  )
})
app.use('/*', serveStatic({ root: './dist' }))

// 陈旧标签页自愈。
//
// 实测（nginx access log，Chrome iOS 恢复被杀掉的标签页）：浏览器**根本不重新请求 HTML**，
// 而是还原它自己存的旧 DOM 快照，再按快照里的 URL 去取子资源。快照可能是好几次部署之前的，
// 里面的 `index-<hash>.js` 早已不存在 —— 于是入口脚本 404、整页空白、地址栏一直转，
// 而且页面里一行 JS 都没执行，Sentry 和白屏探针都收不到任何信号。
//
// 光靠"部署时保留旧 hash"救不了这种情况：快照可能比任何保留窗口都旧。所以反过来做 ——
// 未知的入口脚本不返回 404，而是返回一段合法的、会把页面重新载入的脚本。浏览器执行它，
// 拿到当前的 index.html，白屏自己就消失了。
//
// 只对入口脚本 `index-*.js` 这么做：它是快照里唯一必然被重新执行的入口。其余资源保持 404，
// 免得任何拼错的路径都变成一次重载。
const STALE_ENTRY_RECOVERY = `// 这份资源属于一个已经下线的构建版本：当前页面是浏览器还原的旧快照。
(function () {
  var GUARD = 'mt_stale'
  try {
    var url = new URL(location.href)
    if (url.searchParams.has(GUARD)) {
      console.error('[stale-entry] 重新加载后仍然是旧入口，停止重试')
      return
    }
    url.searchParams.set(GUARD, Date.now().toString(36))
    location.replace(url.pathname + url.search + url.hash)
  } catch (_) {
    location.reload()
  }
})()
`
app.get('/assets/*', (c) => {
  if (/^\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(new URL(c.req.url).pathname)) {
    return c.body(STALE_ENTRY_RECOVERY, 200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    })
  }
  return c.notFound()
})
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
