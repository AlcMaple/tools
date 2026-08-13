/**
 * 各站客户端共用的底层 HTTP 工具:
 *   1. 可中止的 `sleep` —— 重试和限速器用
 *   2. `decodeBody` —— gzip / brotli / deflate 解压
 *   3. `parseRetryAfter` —— Retry-After 头解析(秒数或 HTTP 日期两种形态)
 *   4. `withTransientRetry` —— 只重试一次的瞬时网络错误恢复
 *
 * 站点相关的东西(cookie、UA 池、加密协议)不放这里。
 */
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

// ── Abortable sleep ───────────────────────────────────────────────────────────

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ── Response body decoding ────────────────────────────────────────────────────

/** 按 `content-encoding` 解压。坏帧直接抛错,让调用方能报出结构性失败,而不是拿到一堆乱码字节。 */
export function decodeBody(headers: NodeJS.Dict<string | string[]>, body: Buffer): Buffer {
  const enc = String(headers['content-encoding'] || '').toLowerCase()
  if (enc === 'gzip') return gunzipSync(body)
  if (enc === 'br') return brotliDecompressSync(body)
  if (enc === 'deflate') return inflateSync(body)
  return body
}

// ── Retry-After parser ────────────────────────────────────────────────────────

/** 解析 Retry-After,返回距现在多少秒(≥0);缺失或解析不了返回 null。两种形态都支持。 */
export function parseRetryAfter(v: string | string[] | undefined): number | null {
  if (!v) return null
  const s = Array.isArray(v) ? v[0] : v
  const n = parseInt(s, 10)
  if (!Number.isNaN(n) && n >= 0) return n // delta-seconds
  const t = Date.parse(s)
  if (!Number.isNaN(t)) return Math.max(0, Math.round((t - Date.now()) / 1000))
  return null
}

// ── 瞬时网络错误重试 ──────────────────────────────────────────────────────────
// Wi-Fi 抖一下、DNS 短暂卡顿、偶发的 RST 是家用网络的正常噪音,快速重试一次就能恢复,用户无感。
// 其他情况(真的断网、主动中止、服务端错误)

const TRANSIENT_ERRNOS = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  'EAI_AGAIN', 'ENETRESET', 'ENETUNREACH', 'ENOTFOUND',
])

export function isTransientError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  if (e.message === 'aborted') return false
  const code = (e as NodeJS.ErrnoException).code
  return typeof code === 'string' && TRANSIENT_ERRNOS.has(code)
}

/**
 * 跑 `fn`。遇到瞬时错误(ECONNRESET / ENOTFOUND 等)睡 200~500ms 后**只重试一次**;
 * 非瞬时错误和中止信号立即冒泡出去。
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (signal?.aborted) throw e
    if (!isTransientError(e)) throw e
    await sleep(200 + Math.floor(Math.random() * 300), signal)
    return await fn()
  }
}
