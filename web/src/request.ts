export async function readApi<T>(
  url: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const controller = new AbortController()
  const abort = (): void => controller.abort(init.signal?.reason)
  if (init.signal?.aborted) abort()
  else init.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs)
  const started = performance.now()
  const startedAt = Date.now()
  let headersMs: number | null = null
  let requestId = ''
  let reason = ''
  let status = 0
  let outcome = 'ok'
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    status = response.status
    headersMs = Math.round(performance.now() - started)
    requestId = response.headers.get('X-Request-ID') ?? ''
    return await consume(response)
  } catch (error) {
    reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    outcome = init.signal?.aborted ? 'cancelled' : controller.signal.aborted ? 'timeout' : 'failed'
    if (outcome === 'cancelled') throw error
    if (outcome === 'timeout') throw new Error('请求超时，请检查网络后重试')
    if (headersMs !== null) throw error
    throw new Error(navigator.onLine === false ? '网络已断开，请联网后重试' : '无法连接服务器，请检查网络后重试', { cause: error })
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', abort)
    const ms = Math.round(performance.now() - started)
    if (outcome !== 'cancelled' && (url.split('?')[0] === '/api/search' || outcome !== 'ok' || ms >= 3000)) {
      try {
        const timing = performance.getEntriesByName(new URL(url, window.location.href).href).filter(entry => entry.startTime >= started).at(-1) as PerformanceResourceTiming | undefined
        const body = JSON.stringify({
          path: url.split('?')[0], outcome, status, ms, startedAt, requestId, headersMs, reason: reason.slice(0, 240),
          bodyMs: headersMs === null ? null : ms - headersMs,
          visibility: document.visibilityState, online: navigator.onLine,
          timing: timing ? {
            dnsMs: timing.domainLookupEnd - timing.domainLookupStart,
            connectMs: timing.connectEnd - timing.connectStart,
            waitMs: timing.responseStart - timing.requestStart,
            receiveMs: timing.responseEnd - timing.responseStart,
            transferBytes: timing.transferSize, protocol: timing.nextHopProtocol,
          } : undefined,
        })
        navigator.sendBeacon('/api/request-log', new Blob([body], { type: 'application/json' }))
      } catch { /* 日志上报不可阻塞原请求收口。 */ }
    }
  }
}

export function fetchApi(url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  // JSON 接口仍缓冲完整响应；追番流式快照用 readApi 在同一截止时间内逐批解析。
  return readApi(url, init, async response => {
    const body = await response.text()
    return new Response(body || null, { status: response.status, statusText: response.statusText, headers: response.headers })
  }, timeoutMs)
}
