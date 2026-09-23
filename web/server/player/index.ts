// 新播放页（稀饭 / Girigiri 共用）—— 一条路：解析 → 签名地址 → 全部经本服务器代理 → ArtPlayer。
//
// 为什么重写、为什么没有直连 / 探测 / 救援 / iframe，见 docs/design/播放页重写方案.md；
// 阶段 0 真机实测（同文档第三节）：VPS → 手机单连接 4.9Mbps，多连接零收益，所以纯 mp4 透传即可。
//
//   GET  /api/player/page?src=xifan|girigiri&id=&ep=[&bgmId=]   → 播放页
//   GET  /api/player/playlist?src&id&ep                          → 统一结构：{ title, lines, first, eps }
//   GET  /api/player/resolve?src&id&ep&source                    → 用户手动点线路时解析那一条
//   GET  /api/player/stream?u&s[&range]                          → mp4：盘上有预取好的整集先从盘答（prefetch.ts），否则 stream.ts
//   GET  /api/player/hls?u&s                                     → m3u8：拉回来把分片 / 子表 / key 改写成本站地址
//   GET  /api/player/seg?u&s                                     → HLS 分片 / key 的单连接透传（不做 mp4 那套 total 探测）
//   GET  /api/player/vendor/artplayer.js|hls.js                  → 自托管（CSP 只放行 self；国内也拉不到 CDN）
//   POST /api/player/client-log                                  → 页面日志回终端 + Sentry
//
// 媒体地址一律带 HMAC 签名 s：只有本服务器解析层产出的地址才会被代理，不需要维护域名白名单，
// 也不会变成任何人都能用的开放代理。密钥用 AUTH_SECRET（持久），重启不作废正在播的链接。

import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Agent, request } from 'undici'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getSession } from '../auth'
import { AUTH_SECRET } from '../secrets'
import { playerPageSecurity, renderNonce } from '../security'
import { captureClientLog } from '../monitoring'
import { sanitizeSentryUser } from '../../shared/sentry-user'
import { parsePlayerBgmId, playerSourceOptions, serializePlayerSources, type WebPlayerSource } from '../player-sources'
import { serveStream } from '../xifan/stream'
import { schedulePrefetch, servePrefetched } from '../xifan/prefetch'
import * as xifan from '../xifan/resolve'
import * as girigiri from '../girigiri/resolve'
import { XifanResolveError } from '../xifan/resolve'
import { XifanLocalRateLimitError, XifanUpstreamError } from '../xifan/session'
import probe from './probe'
import { PLAY_PAGE } from './page'

const player = new Hono()
player.route('/', probe)

// ——— 统一解析层 ———

interface Line { source: number; name: string }
interface PlayLine { source: number; kind: 'mp4' | 'hls'; url: string; s: string }
interface Playlist { title: string; lines: Line[]; first: PlayLine | null; eps: number[] }

function sign(url: string): string {
  return createHmac('sha256', AUTH_SECRET).update('player-media:' + url).digest('base64url').slice(0, 32)
}
function verifySigned(url: string, s: string): boolean {
  const expect = sign(url)
  return s.length === expect.length && timingSafeEqual(Buffer.from(s), Buffer.from(expect))
}
function signed(line: { source: number; kind: 'mp4' | 'hls'; url: string } | null): PlayLine | null {
  return line ? { source: line.source, kind: line.kind, url: line.url, s: sign(line.url) } : null
}

function parseSrc(c: Context): { src: WebPlayerSource; id: string; ep: number } | Response {
  const src = c.req.query('src')
  const ep = Number(c.req.query('ep') ?? '1')
  if (src !== 'xifan' && src !== 'girigiri') return c.json({ error: 'src 不合法' }, 400)
  if (!Number.isInteger(ep) || ep < 1) return c.json({ error: 'ep 不合法' }, 400)
  const raw = (c.req.query('id') ?? '').trim()
  if (src === 'xifan' && !/^\d+$/.test(raw)) return c.json({ error: 'animeId 不合法' }, 400)
  const id = src === 'girigiri' ? raw.toUpperCase() : raw
  if (src === 'girigiri' && !girigiri.isGirigiriId(id)) return c.json({ error: 'girigiriId 不合法' }, 400)
  return { src, id, ep }
}

async function playlistOf(src: WebPlayerSource, id: string, ep: number, uid: number): Promise<Playlist> {
  if (src === 'xifan') {
    const p = await xifan.getPlaylist(id, ep, uid)
    return { title: p.title, lines: p.lines, first: signed(p.first), eps: p.eps }
  }
  const p = await girigiri.getPlaylist(id, ep)
  return { title: p.title, lines: p.lines, first: signed(p.first), eps: p.eps }
}

async function lineOf(src: WebPlayerSource, id: string, ep: number, source: number, uid: number): Promise<PlayLine | null> {
  return signed(src === 'xifan' ? await xifan.resolveLine(id, ep, source, uid) : await girigiri.resolveLine(id, ep, source))
}

// 已知 code 原样透出（AGENTS.md：兜底文案只给未知错误）。
function resolveFailure(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : '解析失败'
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined
  console.error('[player] 解析失败: ' + message + (cause ? ' | cause=' + String(cause) : ''))
  if (error instanceof XifanResolveError) {
    return c.json({ error: message, code: error.code }, error.code === 'XIFAN_AUTH_REQUIRED' ? 401 : 403)
  }
  if (error instanceof XifanLocalRateLimitError || error instanceof xifan.XifanBusyError) {
    c.header('Retry-After', String(error.retryAfterSec))
    return c.json({ error: message, code: 'RATE_LIMITED' }, 429)
  }
  if (error instanceof XifanUpstreamError) {
    return c.json({ error: message, code: 'UPSTREAM_' + error.status, upstreamStatus: error.status }, error.status === 429 ? 429 : 502)
  }
  return c.json({ error: message }, 502)
}

player.get('/playlist', async (c) => {
  const args = parseSrc(c)
  if (args instanceof Response) return args
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录', code: 'AUTH_REQUIRED' }, 401)
  c.header('Cache-Control', 'no-store')
  try {
    const playlist = await playlistOf(args.src, args.id, args.ep, session.uid)
    const next = args.ep + 1
    if (args.src === 'xifan' && playlist.eps.includes(next)) {
      const { id } = args
      schedulePrefetch(session.uid, `xifan:${id}:${next}`, `xifan:${id}:${args.ep}`, async () => (await xifan.getPlaylist(id, next, session.uid)).first?.url ?? null)
    }
    return c.json(playlist)
  } catch (error) {
    return resolveFailure(c, error)
  }
})

player.get('/resolve', async (c) => {
  const args = parseSrc(c)
  if (args instanceof Response) return args
  const source = Number(c.req.query('source') ?? '0')
  if (!Number.isInteger(source) || source < 1) return c.json({ error: 'source 不合法' }, 400)
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录', code: 'AUTH_REQUIRED' }, 401)
  c.header('Cache-Control', 'no-store')
  try {
    const line = await lineOf(args.src, args.id, args.ep, source, session.uid)
    return line ? c.json(line) : c.json({ error: '此线路解析不到（可能此线路没有这一集）', code: 'LINE_EMPTY' }, 404)
  } catch (error) {
    return resolveFailure(c, error)
  }
})

// ——— 媒体代理 ———

async function signedMedia(c: Context): Promise<{ url: string } | Response> {
  const u = c.req.query('u') ?? ''
  const s = c.req.query('s') ?? ''
  if (!u || !s) return c.json({ error: '缺少 u / s' }, 400)
  let parsed: URL
  try { parsed = new URL(u) } catch { return c.json({ error: '地址不合法' }, 400) }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return c.json({ error: '地址不合法' }, 400)
  if (!verifySigned(u, s)) return c.json({ error: '地址签名不对' }, 403)
  if (!await getSession(c)) return c.json({ error: '未登录' }, 401)
  return { url: parsed.toString() }
}

player.get('/stream', async (c) => {
  const media = await signedMedia(c)
  if (media instanceof Response) return media
  try {
    const r = servePrefetched(media.url, c.req.header('range')) ?? await serveStream(media.url, c.req.header('range'), false, 'player', true)
    return new Response(r.body, { status: r.status, headers: r.headers })
  } catch (error) {
    console.error('[player] stream 失败: ' + (error instanceof Error ? error.message : error))
    return c.json({ error: error instanceof Error ? error.message : '代理失败' }, 502)
  }
})

const UPSTREAM_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
}
const segAgent = new Agent({ connections: 16, connectTimeout: 10_000, headersTimeout: 15_000, bodyTimeout: 0 })

function proxied(kind: 'hls' | 'seg', absolute: string): string {
  return `/api/player/${kind}?u=${encodeURIComponent(absolute)}&s=${sign(absolute)}`
}

// m3u8 里的每一条地址都改成本站：子播放表走 /hls，分片和 key 走 /seg。
// 相对地址按 playlist 自己的 URL 解析成绝对地址后再签名；签名跟着绝对地址走，播放器拿到的就是完整链接。
function rewritePlaylist(text: string, base: string): string {
  const abs = (ref: string): string => { try { return new URL(ref, base).toString() } catch { return ref } }
  return text.split('\n').map((raw) => {
    const line = raw.trim()
    if (!line) return raw
    if (line.startsWith('#')) {
      return raw.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
        const a = abs(uri)
        return `URI="${/\.m3u8(?:$|[?#])/i.test(a) ? proxied('hls', a) : proxied('seg', a)}"`
      })
    }
    const a = abs(line)
    return /\.m3u8(?:$|[?#])/i.test(a) ? proxied('hls', a) : proxied('seg', a)
  }).join('\n')
}

player.get('/hls', async (c) => {
  const media = await signedMedia(c)
  if (media instanceof Response) return media
  try {
    const res = await request(media.url, { dispatcher: segAgent, method: 'GET', maxRedirections: 5, headers: UPSTREAM_HEADERS })
    if (res.statusCode !== 200) { await res.body.dump(); return c.json({ error: '上游 m3u8 状态 ' + res.statusCode }, 502) }
    const text = await res.body.text()
    if (!text.startsWith('#EXTM3U')) return c.json({ error: '上游返回的不是 m3u8' }, 502)
    return c.body(rewritePlaylist(text, media.url), 200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store',
    })
  } catch (error) {
    console.error('[player] hls 失败: ' + (error instanceof Error ? error.message : error))
    return c.json({ error: error instanceof Error ? error.message : 'm3u8 代理失败' }, 502)
  }
})

player.get('/seg', async (c) => {
  const media = await signedMedia(c)
  if (media instanceof Response) return media
  const headers: Record<string, string> = { ...UPSTREAM_HEADERS }
  const range = c.req.header('range')
  if (range) headers.Range = range
  try {
    const res = await request(media.url, { dispatcher: segAgent, method: 'GET', maxRedirections: 5, headers })
    if (res.statusCode !== 200 && res.statusCode !== 206) { await res.body.dump(); return c.json({ error: '上游分片状态 ' + res.statusCode }, 502) }
    const out: Record<string, string> = { 'Cache-Control': 'private, max-age=3600' }
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = res.headers[h]
      if (typeof v === 'string') out[h] = v
    }
    return new Response(res.body as unknown as ReadableStream, { status: res.statusCode, headers: out })
  } catch (error) {
    console.error('[player] seg 失败: ' + (error instanceof Error ? error.message : error))
    return c.json({ error: error instanceof Error ? error.message : '分片代理失败' }, 502)
  }
})

// ——— 自托管前端依赖 ———

const vendorCache = new Map<string, string>()
const VENDOR: Record<string, string> = {
  'artplayer.js': 'node_modules/artplayer/dist/artplayer.js',
  'hls.js': 'node_modules/hls.js/dist/hls.min.js',
  // 播放页专用的浏览器监控 bundle，由 npm run build 第二步产出（scripts/build-player-monitor.ts）。
  // **dev 下 dist 不存在是正常的**，发一段空脚本让页面照常跑（页面里所有 playerMonitor 调用都判了空）。
  'monitor.js': 'dist/player-monitor.js',
}
player.get('/vendor/:file', (c) => {
  const file = c.req.param('file')
  const path = VENDOR[file]
  if (!path) return c.body(null, 404)
  let js = vendorCache.get(file)
  if (js === undefined) {
    try { js = readFileSync(join(process.cwd(), path), 'utf8') } catch {
      if (file !== 'monitor.js') return c.body(null, 404)
      js = '/* player monitor not built (dev) */'
    }
    vendorCache.set(file, js)
  }
  c.header('Content-Type', 'application/javascript; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=86400')
  return c.body(js)
})

// ——— 日志：页面里发生的事只有浏览器知道，打回终端（AGENTS.md：用户只看终端）———
const CLIENT_LOG_MAX = 300
player.post('/client-log', async (c) => {
  let body: unknown
  try { body = await c.req.json() } catch { return c.body(null, 204) }
  const o = body && typeof body === 'object' ? body as { msg?: unknown; tape?: unknown; sdk?: unknown } : {}
  const msg = typeof o.msg === 'string' ? o.msg.slice(0, CLIENT_LOG_MAX) : ''
  const tape = Array.isArray(o.tape) ? o.tape.slice(-40).map((l) => String(l).slice(0, 120)) : undefined
  if (msg) {
    console.log('[player:client] ' + msg)
    if (tape?.length) console.log('[player:client]   tape: ' + tape.join(' | '))
    // 只有带胶片的（=出错诊断）才进 Sentry；「mount line=2」这种面包屑只留终端，不然 Issues 里全是 Info 噪音。
    if (!o.sdk && tape?.length) captureClientLog(msg, c.req.header('user-agent'), tape)
  }
  return c.body(null, 204)
})

// ——— 页面 ———

const INLINE_JSON_ESCAPES: Record<string, string> = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' }
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (ch) => INLINE_JSON_ESCAPES[ch]!)
}

player.get('/page', async (c) => {
  const session = await getSession(c)
  // 这是给浏览器打开的页面，不是接口：会话过期（后台挂久了刷新回来）时回 JSON 只会让整页变成一行黑底白字。
  if (!session) return c.redirect('/#/tracks')
  const args = parseSrc(c)
  if (args instanceof Response) return args
  const bgmIdRaw = c.req.query('bgmId')
  const bgmId = parsePlayerBgmId(bgmIdRaw)
  if (bgmIdRaw && bgmId == null) return c.json({ error: 'bgmId 不合法' }, 400)
  c.header('Cache-Control', 'no-store')
  const dsn = process.env.PLAYER_SENTRY_DSN?.trim() ?? ''
  const monitor = {
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE || '',
    ...(dsn ? { user: sanitizeSentryUser(session) } : {}),
  }
  const page = renderNonce(
    PLAY_PAGE
      .replace('__PLAYER_SOURCES__', serializePlayerSources(playerSourceOptions(args.src, args.id, args.ep, bgmId)))
      .replace('__MONITOR_CONFIG__', inlineJson(monitor))
      .replace('__PAGE_ARGS__', inlineJson({ src: args.src, id: args.id, ep: args.ep, bgmId })),
  )
  playerPageSecurity(c, page.nonce, { inlineStyles: true })
  c.header('Referrer-Policy', 'no-referrer')
  return c.html(page.html)
})

export default player
