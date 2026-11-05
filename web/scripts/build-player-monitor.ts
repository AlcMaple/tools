// 裸播放页不用 SPA bundle，监控和续看辅助脚本都单独打成自托管 IIFE
//
// 为什么要单独一步：播放页是裸 HTML，用不上 SPA 的 bundle；而 @sentry/browser 的 npm 包里
// **没有**现成的 CDN bundle（只有 ESM/CJS），直接 <script src> 是引不动的。
// 产物放 dist/，播放页通过同源依赖入口读取，不借用 SPA 的动态 chunk
// 因此这一步必须**排在 vite build 之后** —— vite 会先清空 dist。
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const result = await build({
  entryPoints: [join(webRoot, 'src/player-monitoring.ts')],
  outfile: join(webRoot, 'dist/player-monitor.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2018'], // 跟播放页其余脚本一样保守：老一点的手机浏览器也要能跑
  legalComments: 'none',
  // source map 不生成也不上传：真正会出错的是播放页那段**内联脚本**（在 HTML 里，本来就没压缩，
  // 栈里是原样行号）；SDK 内部的帧压不压缩都不用读。省一次上传、也不用管产物泄露。
  sourcemap: false,
  metafile: true,
})

const output = result.metafile.outputs['dist/player-monitor.js']
console.log(`[player-monitor] dist/player-monitor.js  ${(output?.bytes ?? 0) / 1024 | 0} KB`)

await build({
  entryPoints: [join(webRoot, 'src/watch-history-browser.ts')],
  outfile: join(webRoot, 'dist/watch-history.js'),
  globalName: 'MapleWatchHistory',
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2018'],
  legalComments: 'none',
})
console.log('[player-history] dist/watch-history.js built')
