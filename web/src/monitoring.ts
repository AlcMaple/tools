import * as Sentry from '@sentry/react'

const DEFAULT_TRACES_SAMPLE_RATE = 0.05

function sampleRate(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_TRACES_SAMPLE_RATE
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_TRACES_SAMPLE_RATE
}

function cleanUrl(raw: string | undefined): string | undefined {
  if (!raw) return raw
  try {
    const url = new URL(raw, window.location.origin)
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
  // headers 里只留 User-Agent —— Sentry 服务端据此解析 browser / os / device 上下文；
  // Referer 会带 URL、Cookie / Authorization 是凭据，全部丢弃。
  const headers = redacted.headers
  const ua =
    headers && typeof headers === 'object'
      ? (headers['User-Agent'] ?? headers['user-agent'])
      : undefined
  redacted.headers = typeof ua === 'string' ? { 'User-Agent': ua } : undefined
  redacted.cookies = undefined
  redacted.data = undefined
  redacted.query_string = undefined
  redacted.env = undefined
}

function redactSpanUrls(spans: unknown): void {
  if (!Array.isArray(spans)) return
  for (const rawSpan of spans) {
    if (!rawSpan || typeof rawSpan !== 'object') continue
    const span = rawSpan as { description?: string; data?: Record<string, unknown> }
    if (span.description) {
      const match = /^([A-Z]+)\s+(.+)$/.exec(span.description)
      if (match) span.description = `${match[1]} ${cleanUrl(match[2]) ?? match[2]}`
    }
    if (!span.data) continue
    for (const [key, value] of Object.entries(span.data)) {
      if (/query|cookie|authorization|request\.body|response\.body/i.test(key)) {
        delete span.data[key]
      } else if (/url/i.test(key) && typeof value === 'string') {
        span.data[key] = cleanUrl(value)
      }
    }
  }
}

export function initBrowserMonitoring(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim()
  if (!dsn) return

  Sentry.init({
    dsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE || undefined,
    sendDefaultPii: false,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: sampleRate(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE),
    // 只给本站 API 传播 trace；播放源、图床等第三方请求不附加监控头。
    // 相对与绝对两种写法都列出：部分 Sentry 代码路径会先把相对 URL 解析成绝对再匹配。
    tracePropagationTargets: [/^\/api(?:\/|$)/, /^https:\/\/[^/]*\balcmaple\.cn\/api(?:\/|$)/],
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.data?.url && typeof breadcrumb.data.url === 'string') {
        breadcrumb.data.url = cleanUrl(breadcrumb.data.url)
      }
      // fetch/xhr breadcrumb 不保留任何请求或响应正文，避免账号表单内容进入监控。
      if (breadcrumb.category === 'fetch' || breadcrumb.category === 'xhr') {
        delete breadcrumb.data?.request_body
        delete breadcrumb.data?.response_body
      }
      return breadcrumb
    },
    beforeSend(event) {
      event.user = undefined
      redactRequest(event.request)
      return event
    },
    beforeSendTransaction(event) {
      event.user = undefined
      redactRequest(event.request)
      redactSpanUrls(event.spans)
      if (event.transaction) event.transaction = event.transaction.split(/[?#]/, 1)[0]
      return event
    },
  })

  // 供 public/white-screen-probe.js 使用：那个探针是独立静态脚本、拿不到本模块的 Sentry 实例，
  // 只暴露一个窄接口，不把整个 Sentry 挂到 window 上。
  window.__mapleMonitoring = {
    captureMessage: (message: string) => Sentry.captureMessage(message, 'fatal'),
  }
}

export function captureRecoverableReactError(error: unknown, componentStack?: string): void {
  Sentry.withScope((scope) => {
    if (componentStack) scope.setContext('react', { componentStack })
    Sentry.captureException(error)
  })
}
