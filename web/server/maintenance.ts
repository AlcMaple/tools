// 维护开关：数据目录里存在 MAINTENANCE 文件就进入维护模式，删掉即恢复，不用重启进程。
// 文件放 DATA_DIR 而不是部署目录：部署会重建代码目录，开关必须跨部署保持；
// 也不用环境变量——pm2 改环境变量要重读配置并重启，和「发布期间先关门」的目的冲突。
// 是否开启完全由人决定，平时不存在这个文件，代码对用户零影响。
import type { MiddlewareHandler } from 'hono'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './data-dir'

const flagFile = join(dataDir, 'MAINTENANCE')

// 维护页上纱雾头像要用的那张图，必须放行；整张图集在 public/assets，裁切由 CSS 完成。
const FACE_PATH = '/assets/sagiri-face.webp'

const API_MESSAGE = '纱雾正在整理小站，请稍后再来'

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>维护中</title>
<style>
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;background-color:#fbf6ec;
background-image:radial-gradient(#e6dcc4 1.2px,transparent 1.2px);background-size:22px 22px;color:#3e4350;
font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}
.note{position:relative;box-sizing:border-box;width:min(340px,calc(100vw - 48px));padding:62px 28px 34px;
background:#fffdf7;border:2px solid #3e4350;border-radius:18px 22px 16px 24px / 22px 16px 24px 18px;
box-shadow:5px 6px 0 #ecd8d6;text-align:center;transform:rotate(-1.2deg)}
.tape{position:absolute;top:-10px;right:-18px;width:76px;height:24px;background:rgba(214,79,122,.28);
transform:rotate(38deg);border-left:2px dashed rgba(214,79,122,.45);border-right:2px dashed rgba(214,79,122,.45)}
.face{position:absolute;top:-46px;left:50%;width:92px;height:92px;margin-left:-46px;border-radius:50%;
border:2px solid #3e4350;background:#f4eddc url(/assets/sagiri-face.webp) no-repeat;
background-size:266px 242px;background-position:-87px 0;animation:bob 3.2s ease-in-out infinite}
h1{margin:0 0 10px;font-size:21px;letter-spacing:1px;color:#1f7680}
p{margin:0;font-size:14.5px;line-height:1.8;color:#6f7279}
.dots{display:inline-block;margin-left:2px;letter-spacing:2px;color:#d64f7a}
.dots i{font-style:normal;animation:blink 1.4s infinite}
.dots i:nth-child(2){animation-delay:.2s}
.dots i:nth-child(3){animation-delay:.4s}
@keyframes bob{50%{transform:translateY(-4px)}}
@keyframes blink{0%,60%,100%{opacity:.2}30%{opacity:1}}
@media (prefers-reduced-motion:reduce){.face,.dots i{animation:none}}
</style></head>
<body><main class="note">
<div class="tape"></div><div class="face"></div>
<h1>纱雾正在整理小站</h1>
<p>稍等一会儿再来看看吧<span class="dots"><i>.</i><i>.</i><i>.</i></span></p>
</main></body></html>`

/** `/api/health*` 放行，外部监控仍能看到进程是否存活。 */
export function maintenanceMode(): MiddlewareHandler {
  return async (c, next) => {
    if (!existsSync(flagFile) || c.req.path.startsWith('/api/health') || c.req.path === FACE_PATH) return next()
    c.header('Retry-After', '120')
    c.header('Cache-Control', 'no-store')
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: API_MESSAGE, code: 'MAINTENANCE' }, 503)
    }
    // 维护页是自带内联样式的单文件，默认 CSP 的 style-src 'self' 会把它挡成白底裸文本。
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'")
    if (c.req.method === 'GET' && (c.req.header('accept') ?? '').includes('text/html')) {
      return c.html(PAGE, 503)
    }
    return c.text(API_MESSAGE, 503)
  }
}
