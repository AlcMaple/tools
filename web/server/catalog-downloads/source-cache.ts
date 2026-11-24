import { proxyReady } from '../http'

export class SourceError extends Error {}
interface Cached<T> { value: T; at: number }
interface Failure { until: number; error: SourceError }
const paused = new Map<string, Failure>()
const MINUTE = 60_000

function retryDelay(header: string | null, fallback: number): number {
  if (!header) return fallback
  const ms = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()
  return Number.isFinite(ms) ? Math.max(ms, fallback) : fallback
}

async function limitedText(response: Response, limit: number): Promise<string | null> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { reader.releaseLock() }
}

export function sourceReason(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const body = data as Record<string, unknown>
  const error = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : body
  return [...new Set([error.code, error.message, body.error].filter((s): s is string => typeof s === 'string' && !!s.trim()))].join(' · ').replace(/\s+/g, ' ').slice(0, 200)
}

async function readText(url: string, source: string): Promise<string> {
  await proxyReady
  const response = await fetch(url, { signal: AbortSignal.timeout(7000), headers: {
    'User-Agent': 'MapleTools-Web/0.1 (https://github.com/AlcMaple/tools)',
    Accept: source === 'ANi' ? 'application/rss+xml, application/xml' : 'application/json',
  } })
  if (!response.ok) {
    const status = response.status
    const reason = status === 429 ? '限制了查询频率' : status >= 500 ? '服务暂时不可用' : status === 403 ? '拒绝了查询' : '未能返回资源'
    const error = new SourceError(`${source} ${reason}（HTTP ${status}）`)
    if (status === 429 || status === 403 || status >= 500) {
      paused.set(source, { until: Date.now() + retryDelay(response.headers.get('Retry-After'), status === 429 ? 5 * MINUTE : MINUTE), error })
    }
    if (response.headers.get('content-type')?.includes('json')) {
      try {
        const detail = sourceReason(JSON.parse(await limitedText(response, 8192) || 'null'))
        if (detail) error.message += `：${detail}`
      } catch (cause) { error.cause = cause }
    } else await response.body?.cancel()
    throw error
  }
  const text = await limitedText(response, 3 * 1024 * 1024)
  if (text === null) throw new SourceError(`${source} 返回的资源列表过大`)
  return text
}

// 每个源共享冷却，每个 URL 合并并发。只有用户再次查找才访问上游，失败时仍可返回上次成功的列表
export function cachedSource<T>(source: string, parse: (text: string) => T, capacity: number) {
  const cache = new Map<string, Cached<T>>()
  const pending = new Map<string, Promise<T>>()
  const failed = new Map<string, Failure>()
  return async (url: string, notices: Set<string>): Promise<T> => {
    const now = Date.now()
    const old = cache.get(url)
    if (old && now - old.at < 20 * MINUTE) return old.value
    try {
      const stop = [paused.get(source), failed.get(url)].find(f => f && f.until > now)
      if (stop) throw stop.error
      if (notices.size) throw new SourceError([...notices][0])
      let task = pending.get(url)
      if (!task) {
        if (pending.size >= 8) throw new SourceError(`${source} 的查询名额已满，请稍后再查`)
        task = readText(url, source).then(parse).then(value => {
          if (!cache.has(url) && cache.size >= capacity) cache.delete(cache.keys().next().value!)
          cache.set(url, { value, at: Date.now() })
          failed.delete(url)
          return value
        }).catch((cause: unknown) => {
          console.warn(`[catalog-downloads] ${source} ${new URL(url).pathname}`, cause instanceof SourceError && !cause.cause ? cause.message : cause)
          const message = cause instanceof Error && cause.name === 'TimeoutError' ? '查询超时' : cause instanceof SyntaxError ? '返回的数据格式不正确' : '连接中断'
          const error = cause instanceof SourceError ? cause : new SourceError(`${source} ${message}`, { cause })
          if (failed.size >= capacity) failed.delete(failed.keys().next().value!)
          failed.set(url, { error, until: Date.now() + MINUTE })
          throw error
        }).finally(() => pending.delete(url))
        pending.set(url, task)
      }
      return await task
    } catch (error) {
      if (!(error instanceof SourceError)) throw error
      if (!old || now - old.at > 24 * 60 * MINUTE) throw error
      notices.add(error.message)
      notices.add('沿用上次查询结果')
      return old.value
    }
  }
}
