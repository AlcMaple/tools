/**
 * 嗷呜的 /api/site/secure 协议实现:走 Electron net 复刻,不再开 BrowserWindow 抓页面(快 ~30 倍)。
 *
 *   信封: { n: 12 字节 IV 的 b64, d: 密文+16 字节 GCM tag 的 b64 }
 *   算法: AES-256-GCM
 *   密钥: 32 字节 —— 把页面上 5 个碎片按序拼起来再 atob(每片先 trim 并去掉包裹引号):
 *         meta[name="fk-p"].content、html[data-fk-s]、window.__FKM[0]、
 *         CSS 变量 --fk-c、window.__FKM[1]
 *
 * 反检测(单用户桌面客户端的姿态):
 *   - 走 BrowserSession 带浏览器化请求头 + cookie 罐,分析类 cookie 保留下来
 *     让后续 secure POST 看起来和 SPA 是连续的。
 *   - 全局节流:任意两次 secure POST 之间随机间隔 500~2000ms,搜索翻页共用
 *     6 页约 6~9s,接近真人翻页。
 *   - **429/503 一律不重试** —— 那是限流信号,原样抛成 ERR_RATE_LIMITED,让 UI 提示等几分钟。
 *   - 401/403/5xx 一律不重试；只有成功响应无法解密时允许换新密钥再试一次。
 *
 * 错误分类保留了「是我的问题还是协议变了」这个区分:
 *   ERR_UNREACHABLE       网络层失败或 5xx(临时)
 *   ERR_RATE_LIMITED      429,被盯上了,退避
 *   ERR_STRUCTURE_CHANGED 取密钥 / 解密 / 响应结构失败,多半是服务端改了协议,得改代码
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'
import { BrowserSession } from '../shared/browser-session'
import { RateLimiter } from '../shared/rate-limit'
import {
  parseRetryAfter,
} from '../shared/http-client'
import { netRequest } from '../shared/net-request'

export const BASE_URL = 'https://www.aowu.tv'

const SECURE_PATH = '/api/site/secure'

// 仅内部使用 —— 只有 AOWU_* 这些字面前缀会随 Error message 出去,渲染层靠 startsWith 匹配。
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

// 两次 secure POST 之间 500~2000ms,消掉「并发突发」这个最明显的机器人特征,又不至于
// 变成刻板的固定节奏。
const limiter = new RateLimiter({
  minGapMs: 500,
  jitterMs: 1500,
  name: 'aowu',
})

// ── HTTP primitives ───────────────────────────────────────────────────────────

interface RawResponse {
  status: number
  body: Buffer
  retryAfter: number | null
}

async function rawGet(url: string, signal?: AbortSignal): Promise<RawResponse> {
  const res = await netRequest(url, {
    method: 'GET',
    headers: session.headers({
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    }),
    timeoutMs: 15_000,
    maxBytes: 20 * 1024 * 1024,
    signal,
  })
  session.ingestSetCookie(res.headers)
  return {
    status: res.status,
    body: res.body,
    retryAfter: parseRetryAfter(res.headers['retry-after']),
  }
}

async function rawPost(url: string, body: string, signal?: AbortSignal): Promise<RawResponse> {
  const res = await netRequest(url, {
    method: 'POST',
    headers: session.headers({
      'Origin': BASE_URL,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
    }),
    body,
    timeoutMs: 15_000,
    maxBytes: 20 * 1024 * 1024,
    signal,
  })
  session.ingestSetCookie(res.headers)
  return {
    status: res.status,
    body: res.body,
    retryAfter: parseRetryAfter(res.headers['retry-after']),
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
 * 复刻浏览器那边的密钥推导:五段碎片拼接后 atob,再按 UTF-8 编码成字节。
 * 用 latin-1 → utf-8 的往返(而不是直接 base64 解码)是为了防将来碎片里出现非 ASCII 字节;
 * 目前解出来全是 ≤0x7F,两种写法结果一致。
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
 * 向 /api/site/secure 发一个加密载荷,返回解密后的 data。带节流、浏览器指纹和持久 cookie。
 *
 * 重试策略:
 *   429/503        不重试,抛限流 / 不可达
 *   401/403        不重试,按协议 / 凭据失败上抛
 *   解密失败        清掉密钥重试一次(密钥可能中途换了)
 *   其他 5xx       不重试,抛不可达
 *   body code≠200  抛结构变更(协议漂移)
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
      r = await rawPost(BASE_URL + SECURE_PATH, JSON.stringify(env), opts.signal)
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
      throw new Error(`${ERR_STRUCTURE}: HTTP ${r.status}: ${r.body.toString('utf8').slice(0, 200)}`)
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
