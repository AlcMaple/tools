// 维护开关：数据目录里存在 MAINTENANCE 文件就进入维护模式，删掉即恢复，不用重启进程。
// 文件放 DATA_DIR 而不是部署目录：部署会重建代码目录，开关必须跨部署保持；
// 也不用环境变量——pm2 改环境变量要重读配置并重启，和「发布期间先关门」的目的冲突。
// 是否开启完全由人决定，平时不存在这个文件，代码对用户零影响。
//
// 维护期间放行两类人，方便在生产环境用管理员账号做发布后验证：
//   1. 已登录的管理员（会话 cookie 对得上就放行，不需要任何额外步骤）；
//   2. 持有「维护口令」的浏览器——口令就是 MAINTENANCE 文件的内容（空文件 = 没有口令，只放行第 1 类）。
//      管理员退出登录后维护页拦着登录接口，所以要靠口令先进门：访问 `/?maint-key=<口令>`，服务端校验后
//      种一个 httpOnly cookie 并跳转回干净地址，之后这个浏览器整站可用，正常登录管理员即可。
//      维护页本身不提供任何登录入口、也不提示口令存在；口令随每次开维护重新生成，旧口令和旧 cookie 自动作废。
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isAdminUid } from './admin'
import { SECURE, clientIp, getSession, rateLimited } from './auth'
import { dataDir } from './data-dir'
import { AUTH_SECRET } from './secrets'

const flagFile = join(dataDir, 'MAINTENANCE')

// 维护页上纱雾头像要用的那张图，必须放行；与 Toast、助手共用已裁好的单人头像。
const FACE_PATH = '/assets/sagiri-avatar.webp'

// 与会话 cookie 同一套前缀规则：生产用 __Host- 强制 Secure + Path=/。
const BYPASS_COOKIE = SECURE ? '__Host-mt_maint' : 'mt_maint'
const BYPASS_PARAM = 'maint-key'
const BYPASS_MAX_AGE = 12 * 60 * 60

/** null = 没开维护；'' = 开了但没设口令；其余 = 口令。 */
function readFlag(): string | null {
  try {
    return readFileSync(flagFile, 'utf8').trim()
  } catch {
    return null
  }
}

// cookie 里放口令的 HMAC 而不是口令本身；口令换了，旧 cookie 立刻对不上。
const bypassToken = (key: string): string => createHmac('sha256', AUTH_SECRET).update(`maintenance:${key}`).digest('hex')

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

async function allowed(c: Context, key: string): Promise<Response | boolean> {
  if (key) {
    const given = c.req.query(BYPASS_PARAM)
    if (given !== undefined && c.req.method === 'GET' && !rateLimited(`maint-key:${clientIp(c)}`, 10, 15 * 60 * 1000)) {
      if (safeEqual(given, key)) {
        setCookie(c, BYPASS_COOKIE, bypassToken(key), { httpOnly: true, secure: SECURE, sameSite: 'Lax', path: '/', maxAge: BYPASS_MAX_AGE })
        const clean = new URL(c.req.url)
        clean.searchParams.delete(BYPASS_PARAM)
        return c.redirect(`${clean.pathname}${clean.search}`, 302)
      }
    }
    const cookie = getCookie(c, BYPASS_COOKIE)
    if (cookie && safeEqual(cookie, bypassToken(key))) return true
  }
  const session = await getSession(c)
  return !!session && isAdminUid(session.uid)
}

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
border:2px solid #3e4350;background:#f4eddc url(/assets/sagiri-avatar.webp) no-repeat;
background-size:cover;background-position:center;animation:bob 3.2s ease-in-out infinite}
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
    const key = readFlag()
    if (key === null || c.req.path.startsWith('/api/health') || c.req.path === FACE_PATH) return next()
    const pass = await allowed(c, key)
    if (pass instanceof Response) return pass
    if (pass) return next()
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
