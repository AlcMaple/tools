// 网页版的安全边界集中在这里：响应头挡住浏览器危险能力，来源校验挡住跨站写入。
// XSS 的根本修复仍然是每个输出点做上下文编码；这里是即使未来漏了一个点，也不让脚本
// 随意执行、页面被嵌套点击劫持的纵深防线。
import type { Context, MiddlewareHandler } from 'hono'
import { randomBytes } from 'node:crypto'

const DEFAULT_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https: data:",
  "font-src 'self'",
  "connect-src 'self' https:",
  "media-src 'self' https: blob:",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  'upgrade-insecure-requests',
].join('; ')

const PLAYER_FRAME_ORIGINS = [
  'https://player.moedot.net',
  'https://ani.girigirilove.com',
]

function firstHeaderValue(value: string | undefined): string {
  return value?.split(',')[0]?.trim().toLowerCase() ?? ''
}

function requestOrigin(c: Context): string {
  const requestUrl = new URL(c.req.url)
  const proto = firstHeaderValue(c.req.header('x-forwarded-proto')) || requestUrl.protocol.slice(0, -1)
  const host = c.req.header('host') || requestUrl.host
  try {
    // 用 URL.origin 归一化默认端口（`:443` / `:80`），避免反代显式带端口时误杀
    // 正常浏览器的同源请求。
    return new URL(`${proto}://${host}`).origin
  } catch {
    return ''
  }
}

function isSecureRequest(c: Context): boolean {
  return firstHeaderValue(c.req.header('x-forwarded-proto')) === 'https' || new URL(c.req.url).protocol === 'https:'
}

/** 统一给 API、播放器页和 VPS 静态文件补浏览器安全响应头。 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    setCommonHeaders(c)
    c.header('Content-Security-Policy', DEFAULT_CSP)
    const path = c.req.path
    if (path.startsWith('/api/auth') || path.startsWith('/api/tracks') || path.endsWith('/bindings')) {
      c.header('Cache-Control', 'no-store')
    }
    await next()
  }
}

/**
 * Cookie 会话的状态变更只接受同源请求。
 *
 * 浏览器的同源 fetch 会带 Origin；没有 Origin 的 CLI / 同源旧客户端仍允许，避免把
 * 正常的服务端调用误杀。若带了 Referer，则同样校验其 origin。SameSite=Strict 是第二道门。
 */
export function sameOriginGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
      const expected = requestOrigin(c)
      const origin = c.req.header('origin')
      if (origin && origin !== expected) return c.json({ error: '跨站请求被拒绝' }, 403)

      const referer = c.req.header('referer')
      if (!origin && referer) {
        try {
          if (new URL(referer).origin !== expected) return c.json({ error: '跨站请求被拒绝' }, 403)
        } catch {
          return c.json({ error: '请求来源不合法' }, 403)
        }
      }
    }
    await next()
  }
}

/** 播放器页必须保留内联控制脚本，但只允许本次响应生成的随机 nonce。 */
export function playerPageSecurity(c: Context, nonce: string): void {
  setCommonHeaders(c)
  c.header('Content-Security-Policy', [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' https:",
    "media-src 'self' https: blob:",
    `frame-src ${PLAYER_FRAME_ORIGINS.join(' ')}`,
    "worker-src 'self' blob:",
    'upgrade-insecure-requests',
  ].join('; '))
}

export function renderNonce(template: string): { html: string; nonce: string } {
  const nonce = randomBytes(18).toString('base64url')
  return { html: template.replaceAll('__CSP_NONCE__', nonce), nonce }
}

function setCommonHeaders(c: Context): void {
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self "https://player.moedot.net" "https://ani.girigirilove.com"), autoplay=(self "https://player.moedot.net" "https://ani.girigirilove.com")',
  )
  c.header('Cross-Origin-Opener-Policy', 'same-origin')
  c.header('Cross-Origin-Resource-Policy', 'same-origin')
  c.header('X-Permitted-Cross-Domain-Policies', 'none')
  // 旧版 XSS Auditor 已废弃，显式关闭避免老浏览器的错误过滤造成旁路。
  c.header('X-XSS-Protection', '0')
  if (isSecureRequest(c)) c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
}
