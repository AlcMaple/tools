import * as Sentry from '@sentry/node'
import { randomUUID } from 'node:crypto'
import type { Context, ErrorHandler, MiddlewareHandler } from 'hono'

const DEFAULT_TRACES_SAMPLE_RATE = 0.05
const dsn = process.env.SENTRY_DSN?.trim()
const enabled = Boolean(dsn)
const requestIds = new WeakMap<Request, string>()

function sampleRate(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_TRACES_SAMPLE_RATE
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_TRACES_SAMPLE_RATE
}

function cleanUrl(raw: string | undefined): string | undefined {
  if (!raw) return raw
  try {
    const url = new URL(raw)
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return raw.split(/[?#]/, 1)[0]
  }
}

function redactRequest<T extends object>(request: T | undefined): void {
  if (!request) return
  const redacted = request as {
    url?: string
    headers?: Record<string, unknown>
    cookies?: unknown
    data?: unknown
    query_string?: unknown
    env?: unknown
  }
  redacted.url = cleanUrl(redacted.url)
  // 只留 User-Agent（Sentry 服务端据此解析 browser / os / device）；
  // Cookie / Authorization / X-Forwarded-For 等一律丢弃。
  const headers = redacted.headers
  const ua =
    headers && typeof headers === 'object'
      ? (headers['user-agent'] ?? headers['User-Agent'])
      : undefined
  redacted.headers = typeof ua === 'string' ? { 'User-Agent': ua } : undefined
  redacted.cookies = undefined
  redacted.data = undefined
  redacted.query_string = undefined
  redacted.env = undefined
}

function stablePath(path: string): string {
  return path
    .replace(/\/[0-9]+(?=\/|$)/g, '/:id')
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, '/:id')
    .replace(/\/[A-Za-z0-9_-]{32,}(?=\/|$)/g, '/:token')
}

if (enabled) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE || undefined,
    sendDefaultPii: false,
    includeLocalVariables: false,
    // 本项目自己给 Hono 建请求 span；不依赖 Node ESM loader 的自动补丁，VPS / Vercel 行为一致。
    registerEsmLoaderHooks: false,
    integrations: (defaults) => defaults.filter((integration) => integration.name !== 'Http'),
    tracesSampleRate: sampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
    beforeSend(event) {
      event.user = undefined
      redactRequest(event.request)
      return event
    },
    beforeSendTransaction(event) {
      event.user = undefined
      redactRequest(event.request)
      if (event.transaction) event.transaction = cleanUrl(event.transaction) ?? event.transaction
      return event
    },
  })
}

/**
 * 所有响应都带 request id；启用 Sentry 后再为每个请求建立隔离 scope 和低采样性能 span。
 * scope 隔离是硬边界：并发用户的 tag / context 不能串到彼此事件里。
 */
export function monitoringMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const requestId = randomUUID()
    requestIds.set(c.req.raw, requestId)
    c.header('X-Request-ID', requestId)
    const method = c.req.method
    const path = stablePath(c.req.path)
    const traceable = /^\/api(?:\/|$)/.test(path) && path !== '/api/health'
    if (!enabled || !traceable) {
      await next()
      return
    }

    await Sentry.withIsolationScope(async (scope) => {
      scope.setTag('request_id', requestId)
      scope.setTag('http.method', method)
      scope.setContext('request', { id: requestId, method, path })

      await Sentry.continueTrace(
        {
          sentryTrace: c.req.header('sentry-trace'),
          baggage: c.req.header('baggage'),
        },
        () =>
          Sentry.startSpan(
            {
              name: `${method} ${path}`,
              op: 'http.server',
              attributes: {
                'http.request.method': method,
                'url.path': path,
                'maple.request_id': requestId,
              },
            },
            async (span) => {
              await next()
              const status = c.res?.status ?? 500
              span.setAttribute('http.response.status_code', status)
              span.setStatus(Sentry.getSpanStatusFromHttpCode(status))
            },
          ),
      )
    })
  }
}

async function captureUnhandledError(error: Error, c: Context): Promise<Response> {
  const requestId = requestIds.get(c.req.raw) ?? randomUUID()
  const method = c.req.method
  const path = stablePath(c.req.path)
  c.header('X-Request-ID', requestId)
  console.error(`[web] request failed id=${requestId} ${method} ${path}`, error)

  if (enabled) {
    Sentry.withScope((scope) => {
      scope.setTag('request_id', requestId)
      scope.setTag('http.method', method)
      scope.setContext('request', { id: requestId, method, path })
      Sentry.captureException(error)
    })
    // 常驻 VPS 通常会自行发送；serverless 可能在响应后冻结，异常路径短暂 flush 一次。
    await Sentry.flush(1500)
  }

  return c.json({ error: '服务器内部错误', requestId }, 500)
}

/** Hono 会在下游异常回到外层 middleware 前先调用 onError；异常捕获必须挂在这里。 */
export function monitoringErrorHandler(): ErrorHandler {
  return captureUnhandledError
}
