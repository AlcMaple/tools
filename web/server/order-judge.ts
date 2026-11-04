// 接单评估：把客户材料整理成需求清单，一单一个项目，客户每追加 / 调整一次就多一个版本。
// 方案见 docs/ideas/021-接单评估重新定位.md。材料预处理（截图缩放、长图切块、视频取帧、PDF / Word 取字）在浏览器里做完，
// 这里只收文字、JPEG 和原样留存的附件。AI 跟随账号设置，与助手共用连接和额度。

import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { stream } from 'hono/streaming'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { lookup as lookupAddress } from 'node:dns'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Agent, fetch as undiciFetch } from 'undici'
import { db } from './db'
import { judgeData, versionDir, JudgeDataError } from './order-judge-data'
import { judgeEvents } from './order-judge-events'
import { getSession, rateLimited } from './auth'
import { AgentRunError } from '../shared/agent-run'
import { aiSource, judgeConnection, publicAddress, type JudgeConnection } from './agent/external-runtime'
import { MAX_IMAGES, SAME_SITE_GAP_MS, extractUrls, groupByHost, pageDigest } from '../shared/order-judge'
import { briefSystemPrompt, briefUserText, diffBrief, isChoosableClientType, normalizeBrief, type Brief, type ChoosableClientType } from '../shared/order-judge-brief'
import { EMPTY_QUOTE, carryHourEdits, experienceLines, normalizeQuote, type QuoteState } from '../shared/order-judge-sheet'
import { normalizeMaintenance } from '../shared/order-judge-maintenance'
import {
  ATTACH_FILE_RE, ATTACH_MAX_BYTES, ATTACH_MAX_FILES, ATTACH_MAX_TOTAL, JUDGE_MAX_BODY, JUDGES_PER_MINUTE, MAX_TEXT_CHARS, VERSION_LIMIT,
  type JudgeEvent, type JudgeSyncEvent, type Project, type VersionFile,
} from '../shared/order-judge-api'

const ID_RE = /^[0-9a-f-]{36}$/
const FILE_RE = /^\d{2}\.jpg$/
const DATA_URL_RE = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/
const MAX_IMAGE_BYTES = 1_500_000
const MAX_RUNNING = 4 // 同时在整理的单子；每个请求体最多 20MB，留在内存里
const FETCH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const IS_DEV = process.env.NODE_ENV !== 'production' && !process.env.VERCEL

type Source = 'server' | 'byok'

const MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: '请先登录',
  AGENT_AI_DISABLED: '服务器暂未开放 AI 功能',
  PROVIDER_HTTP_429: 'AI 正在限流（HTTP 429），过一会儿再手动整理',
  PROVIDER_UNAVAILABLE: '连不上 AI，请检查后手动重试',
  INVALID_OUTPUT: 'AI 的回复读不出来，请手动重试',
  EMPTY_RESPONSE: 'AI 连续 3 次返回空内容，请手动重试',
  BAD_RESPONSE: 'AI 返回的需求清单不是有效 JSON，请手动重试',
  NO_ITEMS: 'AI 没有整理出任何一条需求，材料可能读不出内容，补些文字或截图再试',
  CONTEXT_BUDGET: '材料太长，超出了模型一次能读的量，删掉一些再整理',
  DAILY_QUOTA: '今天用服务器 AI 的次数用完了（和纱雾助手共用），明天再来，或者在设置里改用你自己的',
  COST_LIMIT: '服务器 AI 的费用额度不够了：可能是这一单材料太多，也可能是今天的额度用完了。少放些截图再试，或者在设置里改用你自己的',
  GLOBAL_BUSY: '同时在用服务器 AI 的人太多，稍后手动重试',
  RUN_BUSY: '纱雾助手正在回答，等它说完再整理',
  RATE_LIMITED: `整理太频繁了：每分钟最多 ${JUDGES_PER_MINUTE} 次`,
  JUDGE_BUSY: '上一单还在整理，等它出结果再点',
  SERVER_BUSY: '服务器同时在整理的单子太多，稍后手动重试',
  BAD_INPUT: '材料格式不对，刷新页面后重新放入',
  MESSAGE_TOO_LARGE: '材料太大了：截图少放几张，或把视频换成几张关键截图',
  NOT_FOUND: '这个项目不存在，可能已在别处删除',
  BAD_QUOTE: '报价或月维护的设置格式不对，刷新页面后再保存',
  VERSION_FULL: `这一单已经有 ${VERSION_LIMIT} 个版本，新开一个项目再追加`,
  ABORTED: '整理超时或被取消了，请手动重试',
}
// 新版本沿用上一版的报价设置，状态回到草稿；项目里已有成交版本时新版本是变更单，支出和交付后修改已经在原单收过，从空白开始
function carriedQuote(projectId: string): QuoteState {
  const rows = (db.prepare('SELECT quote FROM order_judge_versions WHERE project_id=? ORDER BY n DESC').all(projectId) as { quote: string }[])
    .map(r => normalizeQuote(JSON.parse(r.quote)))
  if (!rows.length || rows.some(q => q.status === '已成交')) return EMPTY_QUOTE
  return { ...rows[0], status: '草稿' }
}

// 同一个状态码在两种来源下是两回事：服务器 Key 余额用完不该叫用户去充值
const BY_SOURCE: Record<Source, Record<string, string>> = {
  server: {
    PROVIDER_CONNECTION_REQUIRED: '服务器的 AI 还没准备好，请手动重试',
    PROVIDER_HTTP_401: '服务器的 AI Key 失效了（HTTP 401），可以先在设置里改用你自己的',
    PROVIDER_HTTP_402: '服务器的 AI 余额用完了（HTTP 402），可以先在设置里改用你自己的，材料还在',
  },
  byok: {
    PROVIDER_CONNECTION_REQUIRED: '你自己的 AI 连接断开了，请手动重试',
    PROVIDER_HTTP_401: '你的 API key 不对（HTTP 401），请在设置里检查',
    PROVIDER_HTTP_402: '你的 AI 账户余额不足（HTTP 402），充值后再整理，材料还在',
  },
}

// 桌面端只能用服务器 Key，设置里没有可改的地方，提示只能让用户等
const DESKTOP: Record<string, string> = {
  PROVIDER_HTTP_401: '服务器的 AI Key 失效了（HTTP 401），请等待服务器恢复，材料还在',
  PROVIDER_HTTP_402: '服务器的 AI 余额用完了（HTTP 402），请等待服务器充值后再整理，材料还在',
  DAILY_QUOTA: '今天用服务器 AI 的次数用完了，明天再来',
  COST_LIMIT: '服务器 AI 的费用额度不够了：可能是这一单材料太多，也可能是今天的额度用完了。少放些截图再试，或等明天',
}

const isDesktop = (c: Context<Env>): boolean => c.req.header('X-Maple-Client') === 'desktop'

function errorBody(code: string, source?: Source, desktop = false): { code: string; error: string } {
  const http = /^PROVIDER_HTTP_(\d+)$/.exec(code)
  const known = (desktop && DESKTOP[code]) || (source && BY_SOURCE[source][code]) || MESSAGES[code]
  return { code, error: known ?? (http ? `AI 返回 HTTP ${http[1]}，没有自动重试` : '这次整理失败了，请手动重试') }
}

// ── 打开材料里的网址 ──

// 网址来自用户材料，必须挡住内网：每一跳都解析并校验地址，再把连接固定到校验过的那个地址上。
// 本地开发走 Clash fake-ip 时 DNS 给的是 198.18.x，直连它就是走 TUN，开发环境放行。
function allowedAddress(address: string): boolean {
  return publicAddress(address) || (IS_DEV && isIP(address) === 4 && /^198\.(18|19)\./.test(address))
}

function charsetOf(contentType: string | null): string {
  return /charset=([\w-]+)/i.exec(contentType ?? '')?.[1] ?? 'utf-8'
}

async function fetchPage(url: string, signal: AbortSignal): Promise<string> {
  let current = url
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(current)
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) throw new Error('只打开 http / https 网址')
    if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) throw new Error(`不打开 ${u.port} 端口`)
    const host = u.hostname.replace(/^\[|\]$/g, '')
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true })
    if (!addresses.length || addresses.some((a) => !allowedAddress(a.address))) throw new Error('不打开内网地址')
    const pinned = addresses[0].address
    const dispatcher = new Agent({ connect: { lookup: (_h, options, callback) => lookupAddress(pinned, options, callback) } })
    try {
      const res = await undiciFetch(current, { redirect: 'manual', dispatcher, signal, headers: { 'User-Agent': FETCH_UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } })
      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel()
        current = new URL(location, current).toString()
        continue
      }
      if (res.status >= 400) {
        await res.body?.cancel()
        return `[${url}] 抓取失败：HTTP ${res.status}`
      }
      const reader = res.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      if (reader) {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          chunks.push(part.value)
          if (size > 5_000_000) { await reader.cancel(); break }
        }
      }
      const buf = Buffer.concat(chunks)
      let raw: string
      try { raw = new TextDecoder(charsetOf(res.headers.get('content-type'))).decode(buf) } catch { raw = buf.toString('utf-8') }
      return pageDigest(url, raw)
    } finally {
      await dispatcher.close()
    }
  }
  throw new Error('跳转次数过多')
}

async function fetchLinks(urls: string[], signal: AbortSignal): Promise<string> {
  const results = new Map<string, string>()
  await Promise.all(groupByHost(urls).map(async (group) => {
    for (let i = 0; i < group.length; i++) {
      if (i) {
        const [lo, hi] = SAME_SITE_GAP_MS
        await new Promise((r) => setTimeout(r, lo + Math.random() * (hi - lo)))
      }
      signal.throwIfAborted()
      try {
        results.set(group[i], await fetchPage(group[i], AbortSignal.any([signal, AbortSignal.timeout(10_000)])))
      } catch (e) {
        if (signal.aborted) throw e
        const reason = e instanceof Error ? e.message : String(e)
        console.warn(`[order-judge] 网址抓取失败 ${group[i]}: ${reason}`)
        results.set(group[i], `[${group[i]}] 抓取失败：${reason}`)
      }
    }
  }))
  return urls.map((u) => results.get(u) ?? '').join('\n\n')
}

// ── 限流 ──

const recent = new Map<number, number[]>()
const running = new Set<number>()

// 返回还要等几秒，0 表示放行并记一次
function takeSlot(uid: number, recent: Map<number, number[]>): number {
  const now = Date.now()
  const list = (recent.get(uid) ?? []).filter((t) => now - t < 60_000)
  if (list.length >= JUDGES_PER_MINUTE) {
    recent.set(uid, list)
    return Math.max(1, Math.ceil((list[0] + 60_000 - now) / 1000))
  }
  list.push(now)
  recent.set(uid, list)
  if (recent.size > 2000) for (const [k, v] of recent) if (v.every((t) => now - t >= 60_000)) recent.delete(k)
  return 0
}


// ── 调 AI ──

function contentOf(raw: unknown): string | null {
  const choices = (raw && typeof raw === 'object' ? (raw as { choices?: unknown }).choices : null)
  const first = Array.isArray(choices) ? choices[0] as { message?: { content?: unknown } } | undefined : undefined
  const content = first?.message?.content
  return typeof content === 'string' && content.trim() ? content : null
}

async function askBrief(conn: JudgeConnection, uid: number, previous: Brief | null, clientType: ChoosableClientType, userText: string, images: string[], signal: AbortSignal): Promise<Brief> {
  const model = conn.model
  const experience = experienceLines(judgeData.projects(uid), clientType)
  console.info(`[order-judge] uid=${uid} ${clientType} 带上历史修正 ${experience.length} 条`)
  const body = {
    model,
    temperature: 0.2,
    max_tokens: 8000,
    response_format: { type: 'json_object' },
    ...(model.startsWith('deepseek-') ? { thinking: { type: 'disabled' } } : {}),
    messages: [
      { role: 'system', content: briefSystemPrompt(previous, clientType, experience) },
      { role: 'user', content: [{ type: 'text', text: userText }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] },
    ],
  }
  // JSON 模式偶尔返回空内容，最多试 3 次；HTTP 错误不重试，原样交给界面
  for (let attempt = 1; attempt <= 3; attempt++) {
    const content = contentOf(await conn.call(body, signal))
    if (!content) {
      console.info(`[order-judge] uid=${uid} 第 ${attempt} 次返回空内容`)
      continue
    }
    let brief: Brief
    try {
      brief = normalizeBrief(JSON.parse(content), previous, clientType)
    } catch (e) {
      console.error(`[order-judge] uid=${uid} 需求清单不是 JSON: ${content.slice(0, 200)}`, e)
      throw new AgentRunError('BAD_RESPONSE', 503)
    }
    if (!brief.items.length) {
      console.error(`[order-judge] uid=${uid} 需求清单为空: ${content.slice(0, 500)}`)
      throw new AgentRunError('NO_ITEMS', 503)
    }
    return brief
  }
  throw new AgentRunError('EMPTY_RESPONSE', 503)
}

// ── 材料 ──

type Materials = { text: string; clientType: ChoosableClientType; images: { name: string; bytes: Buffer; dataUrl: string }[]; files: { name: string; bytes: Buffer }[] }

function parseMaterials(input: unknown): Materials | null {
  const o = (input && typeof input === 'object' ? input : {}) as { text?: unknown; images?: unknown; files?: unknown; clientType?: unknown }
  if (!isChoosableClientType(o.clientType)) return null
  const text = typeof o.text === 'string' ? o.text : ''
  if (text.length > MAX_TEXT_CHARS || !Array.isArray(o.images) || o.images.length > MAX_IMAGES) return null
  const images: Materials['images'] = []
  for (const x of o.images as unknown[]) {
    const item = (x && typeof x === 'object' ? x : {}) as { name?: unknown; dataUrl?: unknown }
    if (typeof item.name !== 'string' || typeof item.dataUrl !== 'string') return null
    const m = DATA_URL_RE.exec(item.dataUrl)
    if (!m) return null
    const bytes = Buffer.from(m[1], 'base64')
    if (bytes.length > MAX_IMAGE_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
    images.push({ name: item.name.slice(0, 120), bytes, dataUrl: item.dataUrl })
  }
  const files: Materials['files'] = []
  if (o.files !== undefined) {
    if (!Array.isArray(o.files) || o.files.length > ATTACH_MAX_FILES) return null
    let total = 0
    for (const x of o.files as unknown[]) {
      const item = (x && typeof x === 'object' ? x : {}) as { name?: unknown; data?: unknown }
      if (typeof item.name !== 'string' || !item.name.trim() || typeof item.data !== 'string' || !/^[A-Za-z0-9+/=]*$/.test(item.data)) return null
      const bytes = Buffer.from(item.data, 'base64')
      total += bytes.length
      if (bytes.length > ATTACH_MAX_BYTES || total > ATTACH_MAX_TOTAL) return null
      files.push({ name: item.name.slice(0, 120), bytes })
    }
  }
  if (!text.trim() && !images.length && !files.length) return null
  return { text, images, files, clientType: o.clientType }
}

async function removeDirs(uid: number, ids: string[]): Promise<void> {
  for (const id of ids) {
    try { await rm(versionDir(uid, id), { recursive: true, force: true }) }
    catch (error) { console.warn(`[order-judge] 版本目录清理失败 uid=${uid} id=${id}`, error) }
  }
}

// 先落文件再插行；插行失败删掉刚写的目录。用户的项目从不自动删除
async function saveVersion(uid: number, projectId: string | null, input: Materials, brief: Brief, previous: Brief | null, model: string): Promise<Project> {
  const id = randomUUID()
  const dir = versionDir(uid, id)
  await mkdir(dir, { recursive: true })
  const images: { file: string; name: string }[] = []
  const files: VersionFile[] = []
  try {
    for (let i = 0; i < input.images.length; i++) {
      const file = `${String(i + 1).padStart(2, '0')}.jpg`
      await writeFile(join(dir, file), input.images[i].bytes)
      images.push({ file, name: input.images[i].name })
    }
    for (let i = 0; i < input.files.length; i++) {
      const ext = /\.([a-z0-9]{1,8})$/i.exec(input.files[i].name)?.[1].toLowerCase() ?? 'bin'
      const file = `att-${String(i + 1).padStart(2, '0')}.${ext}`
      await writeFile(join(dir, file), input.files[i].bytes)
      files.push({ file, name: input.files[i].name, size: input.files[i].bytes.length })
    }
    const now = Date.now()
    const { project } = db.transaction(() => {
      let pid = projectId
      let n = 1
      if (pid) {
        const row = db.prepare('SELECT max(v.n) AS n FROM order_judge_versions v JOIN order_judge_projects p ON p.id=v.project_id WHERE p.id=? AND p.user_id=?').get(pid, uid) as { n: number | null }
        if (row.n === null) throw new JudgeDataError('NOT_FOUND', MESSAGES.NOT_FOUND, 404)
        if (row.n >= VERSION_LIMIT) throw new JudgeDataError('VERSION_FULL', MESSAGES.VERSION_FULL)
        n = row.n + 1
        db.prepare('UPDATE order_judge_projects SET title=?, updated_at=? WHERE id=?').run(brief.title || '未命名项目', now, pid)
      } else {
        pid = randomUUID()
        db.prepare('INSERT INTO order_judge_projects (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)').run(pid, uid, brief.title || '未命名项目', now, now)
      }
      db.prepare('INSERT INTO order_judge_versions (id,project_id,user_id,n,at,text,images,files,brief,changes,model,quote) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, pid, uid, n, now, input.text, JSON.stringify(images), JSON.stringify(files), JSON.stringify(brief), JSON.stringify(diffBrief(previous, brief)), model, JSON.stringify(carryHourEdits(carriedQuote(pid), previous, brief)))
      judgeData.bump(uid)
      return { project: judgeData.project(uid, pid)! }
    })()
    return project
  } catch (e) {
    await rm(dir, { recursive: true, force: true })
    throw e
  }
}

// ── 路由 ──

type Env = { Variables: { uid: number } }
export function createOrderJudgeApi(connection: typeof judgeConnection = judgeConnection): Hono<Env> {
const api = new Hono<Env>()
api.onError((e, c) => {
  if (e instanceof JudgeDataError) return c.json({ code: e.code, error: e.message }, e.status)
  console.error('[order-judge] 请求失败', e)
  return c.json({ code: 'UNEXPECTED', error: '接单评估服务异常，请查看服务端日志' }, 500)
})

api.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  const s = await getSession(c)
  if (!s) return c.json(errorBody('AUTH_REQUIRED'), 401)
  c.set('uid', s.uid)
  // 读写分桶：翻项目会一次加载几十张图，不能把写的额度吃掉；整理另有每分钟次数
  const write = c.req.method !== 'GET'
  if (rateLimited(`order-judge:${write ? 'write' : 'read'}:${s.uid}`, write ? 60 : 600, 60_000)) {
    c.header('Retry-After', '60')
    console.warn(`[order-judge] 限流 uid=${s.uid} ${c.req.method} ${c.req.path}`)
    return c.json({ code: 'RATE_LIMITED', error: '操作太频繁了，一分钟后再试' }, 429)
  }
  await next()
})

api.get('/', (c) => c.json({ projects: judgeData.projects(c.get('uid')), seq: judgeData.seq(c.get('uid')), market: judgeData.market() }))

api.get('/sync/events', async c => {
  const uid = c.get('uid'), session = await getSession(c)
  c.header('Content-Type', 'application/x-ndjson; charset=utf-8')
  c.header('X-Accel-Buffering', 'no')
  return stream(c, async out => {
    let stopped = false, wake = (): void => {}
    const queue: JudgeSyncEvent[] = [{ type: 'ready', seq: judgeData.seq(uid) }]
    const close = (): void => { stopped = true; wake() }
    const unsubscribe = judgeEvents.subscribe(uid, event => {
      if (queue.length >= 64) { close(); return }
      queue.push(event); wake()
    }, close)
    out.onAbort(close)
    const write = async (event: JudgeSyncEvent): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([out.write(JSON.stringify(event) + '\n'), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('SYNC_STREAM_IDLE')), 45_000) })]) }
      finally { clearTimeout(timer) }
    }
    try {
      while (!stopped) {
        const current = await getSession(c)
        if (!current || current.uid !== uid || current.tv !== session!.tv) break
        for (const event of queue.splice(0)) await write(event)
        if (stopped) break
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { queue.push({ type: 'ping', seq: judgeData.seq(uid) }); resolve() }, 15_000)
          wake = () => { clearTimeout(timer); resolve() }
          if (stopped || queue.length) wake()
        })
      }
    } finally { close(); unsubscribe() }
  }, async e => { console.warn('[order-judge] 同步连接中断', e) })
})

// 浏览器里预处理材料失败（PDF / 视频解不开）只有浏览器知道，打回服务端终端，不留在 devtools 里
api.post('/log', bodyLimit({ maxSize: 4096 }), async (c) => {
  const body = await c.req.json().catch(() => null) as { tag?: unknown; detail?: unknown } | null
  if (typeof body?.tag !== 'string' || typeof body.detail !== 'string') return c.body(null, 400)
  if (rateLimited(`order-judge:log:${c.get('uid')}`, 30, 60_000)) return c.body(null, 429)
  console.warn('[order-judge:client] ' + JSON.stringify({ uid: c.get('uid'), tag: body.tag.slice(0, 60), detail: body.detail.slice(0, 2000) }))
  return c.body(null, 204)
})

api.delete('/projects/:id', async (c) => {
  const uid = c.get('uid'), id = c.req.param('id')
  if (!ID_RE.test(id)) return c.json(errorBody('NOT_FOUND'), 404)
  const ids = judgeData.versionIds(uid, id)
  const r = db.prepare('DELETE FROM order_judge_projects WHERE id = ? AND user_id = ?').run(id, uid)
  if (!r.changes) return c.json(errorBody('NOT_FOUND'), 404)
  judgeData.removeSamples(ids)
  judgeData.bump(uid); judgeEvents.changed(uid, judgeData.seq(uid))
  await removeDirs(uid, ids)
  return c.json({ ok: true })
})

api.get('/versions/:id/:file', async (c) => {
  const uid = c.get('uid'), id = c.req.param('id'), file = c.req.param('file')
  if (!ID_RE.test(id) || !FILE_RE.test(file)) return c.json(errorBody('NOT_FOUND'), 404)
  if (!judgeData.versionFiles(uid, id)?.images.some(i => i.file === file)) return c.json(errorBody('NOT_FOUND'), 404)
  try {
    const bytes = await readFile(join(versionDir(uid, id), file))
    c.header('Cache-Control', 'private, max-age=86400')
    return c.body(new Uint8Array(bytes), 200, { 'Content-Type': 'image/jpeg' })
  } catch (e) {
    console.warn(`[order-judge] 版本图片读不到 uid=${uid} ${id}/${file}`, e)
    return c.json(errorBody('NOT_FOUND'), 404)
  }
})

const FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf', md: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8',
  html: 'text/plain; charset=utf-8', htm: 'text/plain; charset=utf-8', rtf: 'text/plain; charset=utf-8',
}

api.get('/versions/:id/files/:file', async (c) => {
  const uid = c.get('uid'), id = c.req.param('id'), file = c.req.param('file')
  if (!ID_RE.test(id) || !ATTACH_FILE_RE.test(file)) return c.json(errorBody('NOT_FOUND'), 404)
  const meta = judgeData.versionFiles(uid, id)?.files.find((f) => f.file === file)
  if (!meta) return c.json(errorBody('NOT_FOUND'), 404)
  try {
    const bytes = await readFile(join(versionDir(uid, id), file))
    const download = c.req.query('download') === '1'
    const type = FILE_TYPES[file.slice(file.lastIndexOf('.') + 1)]
    c.header('Cache-Control', 'private, max-age=86400')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Content-Disposition', `${download || !type ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(meta.name)}`)
    return c.body(new Uint8Array(bytes), 200, { 'Content-Type': download || !type ? 'application/octet-stream' : type })
  } catch (e) {
    console.warn(`[order-judge] 版本附件读不到 uid=${uid} ${id}/${file}`, e)
    return c.json(errorBody('NOT_FOUND'), 404)
  }
})

// 新项目（projectId 为 null）或给已有项目追加一个版本，共用一条整理流程
async function organize(c: Context<Env>, projectId: string | null): Promise<Response> {
  const uid = c.get('uid'), desktop = isDesktop(c)
  const input = parseMaterials(await c.req.json().catch(() => null))
  if (!input) return c.json(errorBody('BAD_INPUT'), 400)
  const previous = projectId ? judgeData.latest(uid, projectId) : null
  if (projectId && !previous) return c.json(errorBody('NOT_FOUND'), 404)
  if (previous && previous.n >= VERSION_LIMIT) return c.json(errorBody('VERSION_FULL'), 409)
  if (running.has(uid)) return c.json(errorBody('JUDGE_BUSY'), 409)
  if (running.size >= MAX_RUNNING) return c.json(errorBody('SERVER_BUSY'), 429)
  const wait = takeSlot(uid, recent)
  if (wait) {
    c.header('Retry-After', String(wait))
    return c.json({ ...errorBody('RATE_LIMITED'), error: `${MESSAGES.RATE_LIMITED}，${wait} 秒后可以再点` }, 429)
  }

  running.add(uid)
  c.header('Content-Type', 'application/x-ndjson; charset=utf-8')
  c.header('X-Accel-Buffering', 'no')
  return stream(c, async (out) => {
    const send = (e: JudgeEvent): Promise<unknown> => out.write(JSON.stringify(e) + '\n')
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(240_000)])
    const started = Date.now()
    let source: Source | undefined
    try {
      source = aiSource(uid, desktop)
      const urls = extractUrls(input.text)
      let links = ''
      if (urls.length) {
        await send({ type: 'stage', stage: 'links', count: urls.length })
        links = await fetchLinks(urls, signal)
      }
      await send({ type: 'stage', stage: 'ai' })
      const conn = await connection(uid, signal, desktop)
      console.info(`[order-judge] → uid=${uid} ${conn.source} ${conn.model} ${previous ? `追加第 ${previous.n + 1} 版` : '新项目'} 文字 ${input.text.length} 字 网址 ${urls.length} 个 图片 ${input.images.length} 张`)
      const userText = briefUserText(input.text, links, input.images.map((x) => x.name), previous?.brief ?? null)
      const brief = await conn.execute(() => askBrief(conn, uid, previous?.brief ?? null, input.clientType, userText, input.images.map((x) => x.dataUrl), signal))
      const project = await saveVersion(uid, projectId, input, brief, previous?.brief ?? null, conn.model)
      judgeEvents.changed(uid, judgeData.seq(uid))
      console.info(`[order-judge] ← uid=${uid} ${brief.title} ${brief.items.length} 条 ${Date.now() - started}ms`)
      await send({ type: 'done', project })
    } catch (e) {
      const code = e instanceof AgentRunError || e instanceof JudgeDataError ? e.code : signal.aborted ? 'ABORTED' : 'UNEXPECTED'
      console.error(`[order-judge] ✗ uid=${uid} ${code} ${Date.now() - started}ms`, e)
      if (!out.aborted) await send({ type: 'error', ...(e instanceof JudgeDataError ? { code, error: e.message } : errorBody(code, source, desktop)) })
    } finally {
      running.delete(uid)
    }
  }, async (e) => {
    running.delete(uid)
    console.error('[order-judge] 响应流中断', e)
  })
}

api.put('/versions/:id/quote', bodyLimit({ maxSize: 8192 }), async (c) => {
  const uid = c.get('uid'), id = c.req.param('id')
  if (!ID_RE.test(id)) return c.json(errorBody('NOT_FOUND'), 404)
  const body: unknown = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object') return c.json(errorBody('BAD_QUOTE'), 400)
  const quote = normalizeQuote(body)
  const project = db.transaction(() => {
    const row = db.prepare('SELECT project_id FROM order_judge_versions WHERE id=? AND user_id=?').get(id, uid) as { project_id: string } | undefined
    if (!row) return null
    db.prepare('UPDATE order_judge_versions SET quote=? WHERE id=?').run(JSON.stringify(quote), id)
    db.prepare('UPDATE order_judge_projects SET updated_at=? WHERE id=?').run(Date.now(), row.project_id)
    judgeData.syncSample(uid, row.project_id, id)
    judgeData.bump(uid)
    return judgeData.project(uid, row.project_id)
  })()
  if (!project) return c.json(errorBody('NOT_FOUND'), 404)
  judgeEvents.changed(uid, judgeData.seq(uid))
  return c.json({ project })
})

api.put('/projects/:id/maintenance', bodyLimit({ maxSize: 32768 }), async (c) => {
  const uid = c.get('uid'), id = c.req.param('id')
  if (!ID_RE.test(id)) return c.json(errorBody('NOT_FOUND'), 404)
  const body: unknown = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object') return c.json(errorBody('BAD_QUOTE'), 400)
  const maintenance = normalizeMaintenance(body)
  const r = db.prepare('UPDATE order_judge_projects SET maintenance=?, updated_at=? WHERE id=? AND user_id=?').run(JSON.stringify(maintenance), Date.now(), id, uid)
  if (!r.changes) return c.json(errorBody('NOT_FOUND'), 404)
  judgeData.bump(uid); judgeEvents.changed(uid, judgeData.seq(uid))
  return c.json({ project: judgeData.project(uid, id) })
})

const materialLimit = bodyLimit({ maxSize: JUDGE_MAX_BODY, onError: (c) => c.json(errorBody('MESSAGE_TOO_LARGE'), 413) })

api.post('/projects', materialLimit, (c) => organize(c, null))

api.post('/projects/:id/versions', materialLimit, (c) => {
  const id = c.req.param('id')
  if (!ID_RE.test(id)) return c.json(errorBody('NOT_FOUND'), 404)
  return organize(c, id)
})

return api
}

export default createOrderJudgeApi()
