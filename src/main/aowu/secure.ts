/**
 * Aowu (FantasyKon) /api/site/secure protocol.
 *
 * Reverse-engineered against the live site (2026-05). Replaces the previous
 * BrowserWindow-driven scraping with plain HTTPS — ~30× faster (sub-second
 * cold start vs ~20–40 s).
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
 * The bundle's wt() does `new TextEncoder().encode(atob(parts))` — that is, a
 * latin-1 → utf-8 round-trip on the decoded bytes. We replicate it exactly so a
 * future >0x7F key byte doesn't silently break us.
 *
 * Key cache: in-memory, cleared on decrypt failure or 4xx. One bootstrap GET
 * costs ~150 ms; amortized to zero across batched downloads.
 */
import https from 'node:https'
import { URL } from 'node:url'
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'

export const BASE_URL = 'https://www.aowu.tv'

const SECURE_PATH = '/api/site/secure'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export const ERR_UNREACHABLE = 'AOWU_UNREACHABLE'
export const ERR_STRUCTURE = 'AOWU_STRUCTURE_CHANGED'

// ── HTTP primitives ───────────────────────────────────────────────────────────

interface RawResponse {
  status: number
  body: Buffer
}

function rawGet(url: string, signal?: AbortSignal): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: 'GET', headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
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
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/json',
          'Origin': BASE_URL,
          'Referer': BASE_URL + '/',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
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

/** Strip wrapping `"` or `'` (browser bundle's `gt()`). */
function stripQuotes(s: string): string {
  return (s || '').trim().replace(/^["']|["']$/g, '')
}

/**
 * Pull the 5 key fragments out of the homepage HTML. Fragments live in:
 *   <meta name="fk-p" content="..."> — site-specific, cycle indicator
 *   <html data-fk-s="..."> — html element dataset
 *   <style>...:root{--fk-c:"..."}</style> — CSS custom property
 *   <script>window.__FKM=["x","y"]</script> — inline globals
 */
function extractFragments(html: string): { meta: string; fkS: string; fkm: string[]; fkc: string } {
  // Meta — content attribute may appear in either order
  const meta =
    (html.match(/<meta[^>]+name=["']fk-p["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']fk-p["']/i) ||
      [])[1] || ''
  // <html ... data-fk-s="...">
  const fkS = (html.match(/<html[^>]+data-fk-s=["']([^"']+)["']/i) || [])[1] || ''
  // window.__FKM = ["a", "b"]  (allow single or double quotes inside)
  const fkmRaw = (html.match(/__FKM\s*=\s*(\[[^\]]+\])/) || [])[1] || ''
  let fkm: string[] = []
  try {
    fkm = JSON.parse(fkmRaw.replace(/'/g, '"'))
    if (!Array.isArray(fkm)) fkm = []
  } catch {
    fkm = []
  }
  // CSS variable `--fk-c: "..."` (always quoted in the wild)
  const fkc = (html.match(/--fk-c\s*:\s*"([^"]+)"/) || [])[1] || ''
  return { meta, fkS, fkm, fkc }
}

/**
 * Replicate the browser pipeline:
 *   parts = gt(meta) + gt(fkS) + gt(fkm[0]) + gt(fkc) + gt(fkm[1])
 *   keyBinaryStr = atob(parts)            // 32-char latin-1 string
 *   keyBytes = TextEncoder().encode(keyBinaryStr)  // utf-8 bytes
 *
 * In Node: latin-1 → utf-8 round trip is `Buffer.from(latin1Str, 'utf8')`.
 * If decoded bytes are all ≤ 0x7F (today's case) the result is identical to
 * Buffer.from(parts, 'base64'). The roundtrip protects against future high-bit
 * keys: each >0x7F byte expands to 2 utf-8 bytes, exactly like the browser.
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
      res = await rawGet(BASE_URL + '/', signal)
    } catch (e) {
      throw new Error(`${ERR_UNREACHABLE}: 主页加载失败 (${(e as Error).message})`)
    }
    if (res.status !== 200) {
      throw new Error(`${ERR_UNREACHABLE}: 主页 HTTP ${res.status}`)
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
 * response envelope's `data` field (or throw on non-200 inner code).
 *
 * On decrypt failure or 4xx HTTP, clears the cached key once and retries —
 * server may have rotated keys at deploy time.
 */
export async function callSecure<T = unknown>(
  payload: { action: string; params: Record<string, unknown> },
  opts: CallOpts = {}
): Promise<T> {
  const attempt = async (): Promise<SecureResponse> => {
    const key = await bootstrapKey(opts.signal)
    const env = encryptEnvelope(key, payload)
    let r: RawResponse
    try {
      r = await rawPost(BASE_URL + SECURE_PATH, JSON.stringify(env), opts.signal)
    } catch (e) {
      throw new Error(`${ERR_UNREACHABLE}: ${(e as Error).message}`)
    }
    if (r.status === 401 || r.status === 403) {
      // Server rejected — likely key rotation or signed-token expiry.
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
      // Decrypt failure usually = wrong key. Treat as retryable.
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

/**
 * Lightweight signal class for "key is wrong, refresh and retry" — distinct
 * from terminal errors that should bubble up.
 */
class SecureRetryable extends Error {}
