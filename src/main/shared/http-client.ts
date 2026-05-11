/**
 * Lower-level HTTP utilities shared across site clients (aowu / bgm / future).
 *
 * Three things live here:
 *   1. Abortable `sleep` — used by retries and rate limiters.
 *   2. `decodeBody` — gunzip / brotli / inflate for Accept-Encoding-aware sites.
 *   3. `parseRetryAfter` — RFC 7231 Retry-After header parser (delta-seconds or HTTP-date).
 *   4. `withTransientRetry` — single-shot retry for flaky-wifi / DNS / RST errors.
 *
 * Anything site-specific (cookies, UA pool, encryption protocol) lives elsewhere.
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

/**
 * Decode a response body per the `content-encoding` header. Throws on bad frames
 * so the caller can surface the structural failure rather than handing back
 * garbled bytes.
 */
export function decodeBody(headers: NodeJS.Dict<string | string[]>, body: Buffer): Buffer {
  const enc = String(headers['content-encoding'] || '').toLowerCase()
  if (enc === 'gzip') return gunzipSync(body)
  if (enc === 'br') return brotliDecompressSync(body)
  if (enc === 'deflate') return inflateSync(body)
  return body
}

// ── Retry-After parser ────────────────────────────────────────────────────────

/**
 * Parse a Retry-After header. Returns seconds-from-now (>= 0) or null if absent
 * / unparseable. Accepts both delta-seconds and HTTP-date forms.
 */
export function parseRetryAfter(v: string | string[] | undefined): number | null {
  if (!v) return null
  const s = Array.isArray(v) ? v[0] : v
  const n = parseInt(s, 10)
  if (!Number.isNaN(n) && n >= 0) return n // delta-seconds
  const t = Date.parse(s)
  if (!Number.isNaN(t)) return Math.max(0, Math.round((t - Date.now()) / 1000))
  return null
}

// ── Transient-network retry ───────────────────────────────────────────────────
// Wi-Fi blips, brief DNS hiccups, and stray RST packets are normal background
// noise on consumer networks. One quick retry recovers from the vast majority
// without the user noticing. Anything else (true outages, aborts, server errors)
// is surfaced so the caller can decide.

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
 * Run `fn`. On transient error (ECONNRESET / ENOTFOUND / etc.) sleep 200-500ms
 * then retry exactly once. Non-transient errors and abort signals bubble out
 * immediately.
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
