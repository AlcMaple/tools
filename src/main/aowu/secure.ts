/**
 * Aowu (FantasyKon) /api/site/secure protocol.
 *
 * Reverse-engineered against the live site (2026-05). Replaces the previous
 * BrowserWindow-driven scraping with plain HTTPS — ~30× faster.
 *
 *   Envelope:  { n: <12-byte IV b64>, d: <ciphertext + 16-byte GCM tag b64> }
 *   Cipher:    AES-256-GCM
 *   Key:       32 bytes — atob() of 5 page-baked fragments concatenated:
 *                meta[name="fk-p"].content
 *              + html[data-fk-s]
 *              + window.__FKM[0]
 *              + getComputedStyle(html, "--fk-c")  (CSS string, strip quotes)
 *              + window.__FKM[1]
 *              Each fragment is trim()'d and stripped of wrapping quotes.
 *
 * Anti-detection posture (single-user desktop client):
 *   - Browser-y headers via shared BrowserSession (UA pool + Accept-Language +
 *     Sec-Fetch-* + Sec-Ch-Ua-* + cookie jar). Cookies persist __mxa* analytics
 *     so subsequent secure POSTs look continuous with the SPA.
 *   - Global throttle via shared RateLimiter: random 500-2000ms gap between any
 *     two secure POSTs. Search pagination uses the same throttle, so 6 pages ≈
 *     6-9s — close to a real user clicking through pages.
 *   - 429/503 are NOT retried — those are limit signals; we surface them as
 *     a distinct ERR_RATE_LIMITED so the renderer can show "等几分钟再试".
 *   - 401/403/decrypt-fail still get one retry with a fresh key (deploy-time
 *     key rotation is the legitimate cause).
 *
 * Error taxonomy (preserves "is it me or is it the protocol" distinction):
 *   ERR_UNREACHABLE       network-level failure or 5xx (transient)
 *   ERR_RATE_LIMITED      HTTP 429 (we got noticed; back off)
 *   ERR_STRUCTURE_CHANGED key extraction / decrypt / response shape failure —
 *                         likely server-side protocol change, code needs update
 */
import https from 'node:https'
import { URL } from 'node:url'
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'
import { BrowserSession } from '../shared/browser-session'
import { RateLimiter } from '../shared/rate-limit'
import {
  decodeBody,
  parseRetryAfter,
  withTransientRetry,
} from '../shared/http-client'

export const BASE_URL = 'https://www.aowu.tv'

const SECURE_PATH = '/api/site/secure'

// Internal-only — only the literal AOWU_* prefixes leave this module via thrown
// Error messages, where the renderer matches them with `.startsWith(...)`.
const ERR_UNREACHABLE = 'AOWU_UNREACHABLE'
const ERR_RATE_LIMITED = 'AOWU_RATE_LIMITED'
export const ERR_STRUCTURE = 'AOWU_STRUCTURE_CHANGED'

// ── Per-host browser session + rate limiter ───────────────────────────────────

const session = new BrowserSession({
  host: 'www.aowu.tv',
  baseUrl: BASE_URL,
  accept: '*/*',
  secFetchSite: 'same-origin',
  secFetchMode: 'cors',
  secFetchDest: 'empty',
})

// 500-2000ms gap between any two secure POSTs — kills the obvious bot
// "parallel burst" signal without imposing rigid timing.
const limiter = new RateLimiter({
  minGapMs: 500,
  jitterMs: 1500,
  name: 'aowu',
})

// Wrap the shared decoder so a bad compression frame surfaces as ERR_STRUCTURE
// (the renderer matches on this prefix to show a "site might have changed"
// message rather than a generic network error).
function decodeBodyOrThrow(
  headers: NodeJS.Dict<string | string[]>,
  body: Buffer,
): Buffer {
  try {
    return decodeBody(headers, body)
  } catch (e) {
    throw new Error(`${ERR_STRUCTURE}: 响应解压失败: ${(e as Error).message}`)
  }
}

// ── HTTP primitives ───────────────────────────────────────────────────────────

interface RawResponse {
  status: number
  body: Buffer
  retryAfter: number | null
}

function rawGet(url: string, signal?: AbortSignal): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request(
      {
        method: 'GET',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: session.headers({
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          'sec-fetch-site': 'none',
          'sec-fetch-user': '?1',
          'upgrade-insecure-requests': '1',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        }),
      },
      (res) => {
        session.ingestSetCookie(res.headers as { 'set-cookie'?: string[] })
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: decodeBodyOrThrow(res.headers, Buffer.concat(chunks)),
              retryAfter: parseRetryAfter(res.headers['retry-after']),
            })
          } catch (e) {
            reject(e)
          }
        })
      }
    )
    req.on('error', reject)
    if (signal) {
      const onAbort = (): void => { req.destroy(new Error('aborted')) }
      signal.addEventListener('abort', onAbort, { once: true })
      req.once('close', () => signal.removeEventListener('abort', onAbort))
    }
    req.end()
  })
}

function rawPost(url: string, body: string, signal?: AbortSignal): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: session.headers({
          'Origin': BASE_URL,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'Accept': 'application/json, text/plain, */*',
        }),
      },
      (res) => {
        session.ingestSetCookie(res.headers as { 'set-cookie'?: string[] })
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: decodeBodyOrThrow(res.headers, Buffer.concat(chunks)),
              retryAfter: parseRetryAfter(res.headers['retry-after']),
            })
          } catch (e) {
            reject(e)
          }
        })
      }
    )
    req.on('error', reject)
    if (signal) {
      const onAbort = (): void => { req.destroy(new Error('aborted')) }
      signal.addEventListener('abort', onAbort, { once: true })
      req.once('close', () => signal.removeEventListener('abort', onAbort))
    }
    req.write(body)
    req.end()
  })
}

// ── Key derivation ────────────────────────────────────────────────────────────

function stripQuotes(s: string): string {
  return (s || '').trim().replace(/^["']|["']$/g, '')
}

function extractFragments(html: string): { meta: string; fkS: string; fkm: string[]; fkc: string } {
  const meta =
    (html.match(/<meta[^>]+name=["']fk-p["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']fk-p["']/i) ||
      [])[1] || ''
  const fkS = (html.match(/<html[^>]+data-fk-s=["']([^"']+)["']/i) || [])[1] || ''
  const fkmRaw = (html.match(/__FKM\s*=\s*(\[[^\]]+\])/) || [])[1] || ''
  let fkm: string[] = []
  try {
    fkm = JSON.parse(fkmRaw.replace(/'/g, '"'))
    if (!Array.isArray(fkm)) fkm = []
  } catch {
    fkm = []
  }
  const fkc = (html.match(/--fk-c\s*:\s*"([^"]+)"/) || [])[1] || ''
  return { meta, fkS, fkm, fkc }
}

/**
 * Replicate the browser pipeline:
 *   parts = gt(meta) + gt(fkS) + gt(fkm[0]) + gt(fkc) + gt(fkm[1])
 *   keyBytes = TextEncoder().encode(atob(parts))
 *
 * In Node: latin-1 → utf-8 round trip is `Buffer.from(latin1Str, 'utf8')`. If
 * decoded bytes are all ≤ 0x7F (today's case) the result is identical to
 * Buffer.from(parts, 'base64'). The roundtrip protects against a future
 * high-bit key — each >0x7F byte expands to 2 utf-8 bytes, mirroring the
 * browser's TextEncoder behavior.
 */
function deriveKey(html: string): Buffer {
  const { meta, fkS, fkm, fkc } = extractFragments(html)
  if (!meta || !fkS || !fkc || fkm.length < 2 || !fkm[0] || !fkm[1]) {
    throw new Error(
      `${ERR_STRUCTURE}: 主页缺少加密密钥片段 (meta=${!!meta}, fkS=${!!fkS}, fkm=${fkm.length}, fkc=${!!fkc})`
    )
  }
  const parts = [meta, fkS, fkm[0], fkc, fkm[1]].map(stripQuotes).join('')
  const keyBinaryStr = Buffer.from(parts, 'base64').toString('latin1')
  const keyBytes = Buffer.from(keyBinaryStr, 'utf8')
  if (keyBytes.length !== 32) {
    throw new Error(
      `${ERR_STRUCTURE}: 派生密钥长度 ${keyBytes.length} ≠ 32 — 可能服务端切换了密钥格式`
    )
  }
  return keyBytes
}

// ── AES-GCM helpers ───────────────────────────────────────────────────────────

interface Envelope {
  n: string
  d: string
}

function encryptEnvelope(key: Buffer, payload: unknown): Envelope {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return { n: iv.toString('base64'), d: Buffer.concat([ct, tag]).toString('base64') }
}

function decryptEnvelope(key: Buffer, env: Envelope): unknown {
  const iv = Buffer.from(env.n, 'base64')
  const data = Buffer.from(env.d, 'base64')
  if (data.length < 16) throw new Error(`${ERR_STRUCTURE}: 密文长度过短 (${data.length})`)
  const ct = data.subarray(0, data.length - 16)
  const tag = data.subarray(data.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return JSON.parse(pt.toString('utf8'))
}

// ── Key cache ─────────────────────────────────────────────────────────────────

let _key: Buffer | null = null
let _keyPromise: Promise<Buffer> | null = null

async function bootstrapKey(signal?: AbortSignal): Promise<Buffer> {
  if (_key) return _key
  if (_keyPromise) return _keyPromise
  _keyPromise = (async () => {
    let res: RawResponse
    try {
      res = await withTransientRetry(() => rawGet(BASE_URL + '/', signal), signal)
    } catch (e) {
      throw new Error(`${ERR_UNREACHABLE}: 主页加载失败 (${(e as Error).message})`)
    }
    if (res.status === 429) {
      throw new Error(`${ERR_RATE_LIMITED}: 主页 HTTP 429${res.retryAfter ? ` (Retry-After ${res.retryAfter}s)` : ''}`)
    }
    if (res.status >= 500) {
      throw new Error(`${ERR_UNREACHABLE}: 主页 HTTP ${res.status}`)
    }
    if (res.status !== 200) {
      throw new Error(`${ERR_STRUCTURE}: 主页 HTTP ${res.status}`)
    }
    const key = deriveKey(res.body.toString('utf8'))
    _key = key
    return key
  })()
  try {
    return await _keyPromise
  } finally {
    _keyPromise = null
  }
}

/** Force a re-bootstrap on the next callSecure(). */
export function clearKeyCache(): void {
  _key = null
  _keyPromise = null
}

// ── Public API ────────────────────────────────────────────────────────────────

interface SecureResponse {
  code: number
  msg: string
  data?: unknown
}

interface CallOpts {
  signal?: AbortSignal
}

/**
 * POST an encrypted payload to /api/site/secure and return the decrypted
 * response data field. Throttled (500-2000ms gap), fingerprinted as Chrome,
 * cookies persisted.
 *
 * Retry policy:
 *   - 429/503 → no retry, throw ERR_RATE_LIMITED / ERR_UNREACHABLE
 *   - 401/403 → clear key, retry once (catches deploy-time key rotation)
 *   - decrypt fail → clear key, retry once (key may have rotated mid-flight)
 *   - 5xx other → no retry, throw ERR_UNREACHABLE
 *   - code !== 200 in decoded body → throw ERR_STRUCTURE (protocol drift)
 */
export async function callSecure<T = unknown>(
  payload: { action: string; params: Record<string, unknown> },
  opts: CallOpts = {}
): Promise<T> {
  const attempt = async (): Promise<SecureResponse> => {
    const key = await bootstrapKey(opts.signal)
    await limiter.wait(opts.signal)
    const env = encryptEnvelope(key, payload)
    let r: RawResponse
    try {
      r = await withTransientRetry(
        () => rawPost(BASE_URL + SECURE_PATH, JSON.stringify(env), opts.signal),
        opts.signal,
      )
    } catch (e) {
      throw new Error(`${ERR_UNREACHABLE}: ${(e as Error).message}`)
    }
    if (r.status === 429) {
      const tail = r.retryAfter != null ? ` (Retry-After ${r.retryAfter}s)` : ''
      throw new Error(`${ERR_RATE_LIMITED}: 服务器返回 HTTP 429${tail} — 触发限流，建议等几分钟再试`)
    }
    if (r.status === 503) {
      const tail = r.retryAfter != null ? ` (Retry-After ${r.retryAfter}s)` : ''
      throw new Error(`${ERR_UNREACHABLE}: 服务器返回 HTTP 503${tail} — 服务暂时不可用`)
    }
    if (r.status === 401 || r.status === 403) {
      throw new SecureRetryable(`HTTP ${r.status}: ${r.body.toString('utf8').slice(0, 200)}`)
    }
    if (r.status >= 500) {
      throw new Error(`${ERR_UNREACHABLE}: HTTP ${r.status}`)
    }
    if (r.status !== 200) {
      throw new Error(
        `${ERR_STRUCTURE}: HTTP ${r.status}: ${r.body.toString('utf8').slice(0, 200)}`
      )
    }
    let respEnv: Envelope
    try {
      const parsed = JSON.parse(r.body.toString('utf8'))
      if (!parsed || typeof parsed !== 'object' || typeof parsed.n !== 'string' || typeof parsed.d !== 'string') {
        throw new Error('shape')
      }
      respEnv = parsed as Envelope
    } catch {
      throw new Error(`${ERR_STRUCTURE}: 响应不是合法 envelope`)
    }
    let decoded: SecureResponse
    try {
      decoded = decryptEnvelope(key, respEnv) as SecureResponse
    } catch (e) {
      throw new SecureRetryable(`decrypt: ${(e as Error).message}`)
    }
    return decoded
  }

  let resp: SecureResponse
  try {
    resp = await attempt()
  } catch (e) {
    if (e instanceof SecureRetryable) {
      clearKeyCache()
      try {
        resp = await attempt()
      } catch (e2) {
        if (e2 instanceof SecureRetryable) {
          throw new Error(`${ERR_STRUCTURE}: 加解密重试仍失败 (${e2.message})`)
        }
        throw e2
      }
    } else {
      throw e
    }
  }

  if (resp.code !== 200) {
    throw new Error(
      `${ERR_STRUCTURE}: 服务端响应 code=${resp.code} msg=${resp.msg ?? ''}`.trim()
    )
  }
  return resp.data as T
}

class SecureRetryable extends Error {}
