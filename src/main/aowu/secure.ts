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
 *   - Browser-y headers (Accept / Accept-Language / Sec-Fetch-* / Sec-Ch-Ua-*)
 *   - Cookie jar persists __mxa* analytics cookies from the homepage GET so
 *     subsequent secure POSTs look continuous with the SPA.
 *   - gzip / br / deflate response decoding (we now advertise Accept-Encoding).
 *   - Global throttle: random 500-2000ms gap between any two secure POSTs.
 *     Search pagination uses this same throttle, so 6 pages ≈ 6-9s — close to
 *     a real user clicking through pages.
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
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

export const BASE_URL = 'https://www.aowu.tv'

const SECURE_PATH = '/api/site/secure'

export const ERR_UNREACHABLE = 'AOWU_UNREACHABLE'
export const ERR_RATE_LIMITED = 'AOWU_RATE_LIMITED'
export const ERR_STRUCTURE = 'AOWU_STRUCTURE_CHANGED'

// ── User-Agent pool ───────────────────────────────────────────────────────────
// Random Chrome version picked at module load — same value used for the whole
// app session so a single user looks consistent (browsers don't change UA mid-
// session). Platform follows the actual OS via process.platform; mismatching
// `User-Agent` and `sec-ch-ua-platform` is a stronger fingerprint than just
// using a single hard-coded combo, so we keep them aligned.

interface UAVariant {
  ua: string
  secChUa: string
  secChUaPlatform: string
}

function chromeVariants(platform: NodeJS.Platform): UAVariant[] {
  // Pick 5 recent Chrome versions. Each entry's `secChUa` matches its UA's
  // major version so a fingerprinting tool sees an internally consistent client.
  const versions = [119, 120, 121, 122, 123]
  if (platform === 'win32') {
    return versions.map((v) => ({
      ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
      secChUa: `"Not.A/Brand";v="8", "Chromium";v="${v}", "Google Chrome";v="${v}"`,
      secChUaPlatform: '"Windows"',
    }))
  }
  // darwin / linux / others → use macOS UA. Linux is rare for desktop Electron
  // anime apps so picking macOS keeps the pool simple and authentic-looking.
  return versions.map((v) => ({
    ua: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    secChUa: `"Not.A/Brand";v="8", "Chromium";v="${v}", "Google Chrome";v="${v}"`,
    secChUaPlatform: '"macOS"',
  }))
}

const _pool = chromeVariants(process.platform)
const SESSION_VARIANT: UAVariant = _pool[Math.floor(Math.random() * _pool.length)]

// ── Cookie jar ────────────────────────────────────────────────────────────────
// Tiny in-memory cookie store, scoped to the aowu host. Captures Set-Cookie
// from each response, replays via Cookie header on each request. Only stores
// name=value; ignores attributes (Path / Expires / etc.). Sufficient for the
// __mxa* analytics cookies the SPA sets on first homepage visit.

const _cookies = new Map<string, string>()

function ingestSetCookie(headers: { 'set-cookie'?: string[] | string }): void {
  const raw = headers['set-cookie']
  if (!raw) return
  const arr = Array.isArray(raw) ? raw : [raw]
  for (const line of arr) {
    const semi = line.indexOf(';')
    const kv = (semi >= 0 ? line.slice(0, semi) : line).trim()
    const eq = kv.indexOf('=')
    if (eq <= 0) continue
    const name = kv.slice(0, eq).trim()
    const val = kv.slice(eq + 1).trim()
    if (name) _cookies.set(name, val)
  }
}

function cookieHeader(): string | undefined {
  if (_cookies.size === 0) return undefined
  return Array.from(_cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
}

// ── Browser-y headers ─────────────────────────────────────────────────────────
// Order matters slightly for fingerprinting tools that hash header order.
// Chrome on macOS sends roughly this lineup; we mirror it.

function browserHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
    'Host': 'www.aowu.tv',
    'Connection': 'keep-alive',
    'sec-ch-ua': SESSION_VARIANT.secChUa,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': SESSION_VARIANT.secChUaPlatform,
    'User-Agent': SESSION_VARIANT.ua,
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'Referer': BASE_URL + '/',
    ...extra,
  }
  const c = cookieHeader()
  if (c) h['Cookie'] = c
  return h
}

// ── HTTP primitives ───────────────────────────────────────────────────────────

interface RawResponse {
  status: number
  body: Buffer
  retryAfter: number | null
}

function decodeBody(headers: NodeJS.Dict<string | string[]>, body: Buffer): Buffer {
  const enc = String(headers['content-encoding'] || '').toLowerCase()
  try {
    if (enc === 'gzip') return gunzipSync(body)
    if (enc === 'br') return brotliDecompressSync(body)
    if (enc === 'deflate') return inflateSync(body)
  } catch (e) {
    // Bad compression frame — treat as a structural failure so caller surfaces it.
    throw new Error(`${ERR_STRUCTURE}: 响应解压失败 (${enc}): ${(e as Error).message}`)
  }
  return body
}

function parseRetryAfter(v: string | string[] | undefined): number | null {
  if (!v) return null
  const s = Array.isArray(v) ? v[0] : v
  const n = parseInt(s, 10)
  if (!Number.isNaN(n) && n >= 0) return n  // seconds
  const t = Date.parse(s)
  if (!Number.isNaN(t)) return Math.max(0, Math.round((t - Date.now()) / 1000))
  return null
}

function rawGet(url: string, signal?: AbortSignal): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request(
      {
        method: 'GET',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: browserHeaders({
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          'sec-fetch-site': 'none',
          'sec-fetch-user': '?1',
          'upgrade-insecure-requests': '1',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        }),
      },
      (res) => {
        ingestSetCookie(res.headers as { 'set-cookie'?: string[] })
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: decodeBody(res.headers, Buffer.concat(chunks)),
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
        headers: browserHeaders({
          'Origin': BASE_URL,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'Accept': 'application/json, text/plain, */*',
        }),
      },
      (res) => {
        ingestSetCookie(res.headers as { 'set-cookie'?: string[] })
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: decodeBody(res.headers, Buffer.concat(chunks)),
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

// ── Transient network retry ───────────────────────────────────────────────────
// Wi-Fi blips, brief DNS hiccups, and stray RST packets are normal background
// noise. One quick retry recovers from the vast majority without the user
// seeing anything. Anything more (true outages, server-side errors, abort) is
// surfaced so the caller / UI sees a real failure.

const TRANSIENT_ERRNOS = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  'EAI_AGAIN', 'ENETRESET', 'ENETUNREACH', 'ENOTFOUND',
])

function isTransientError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  if (e.message === 'aborted') return false
  const code = (e as NodeJS.ErrnoException).code
  return typeof code === 'string' && TRANSIENT_ERRNOS.has(code)
}

async function withRetry<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (signal?.aborted) throw e
    if (!isTransientError(e)) throw e
    // 200-500ms jitter before single retry — avoid hammering on a weak network.
    await sleep(200 + Math.floor(Math.random() * 300), signal)
    return await fn()
  }
}

// ── Global rate limiter ───────────────────────────────────────────────────────
// Serializes every secure POST and inserts a randomized 500-2000ms gap
// between any two of them. This kills the "6 parallel POSTs in 100ms" pattern
// (the most obvious bot signal) without imposing rigid timing that would
// look just as artificial.
//
// The throttle covers download flow too — between bundle(play) and play() for
// one episode there's now a half-to-two-second gap, mimicking the SPA's own
// pacing as it routes / fetches / decrypts in stages.

const MIN_GAP_MS = 500
const MAX_GAP_MS = 2000

let _throttleChain: Promise<void> = Promise.resolve()
let _lastPostAt = 0

function randomGap(): number {
  return MIN_GAP_MS + Math.floor(Math.random() * (MAX_GAP_MS - MIN_GAP_MS + 1))
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => { clearTimeout(t); reject(new Error('aborted')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Wait until we're past the per-call gap budget. Reentrancy-safe. */
async function throttle(signal?: AbortSignal): Promise<void> {
  // Chain so concurrent callers serialize.
  const prev = _throttleChain
  let release!: () => void
  _throttleChain = new Promise<void>((r) => { release = r })
  try {
    await prev
    const elapsed = Date.now() - _lastPostAt
    const target = randomGap()
    if (elapsed < target) await sleep(target - elapsed, signal)
    _lastPostAt = Date.now()
  } finally {
    release()
  }
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
      res = await withRetry(() => rawGet(BASE_URL + '/', signal), signal)
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
    await throttle(opts.signal)
    const env = encryptEnvelope(key, payload)
    let r: RawResponse
    try {
      r = await withRetry(
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
