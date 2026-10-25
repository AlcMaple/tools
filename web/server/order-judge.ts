// 桌面共享模式与网页走同一入口，避免资料与历史各自演进。AI 跟随账号设置，共用连接与额度。
// 材料预处理（截图缩放、长图切块、视频取帧、PDF / Word 取字）在浏览器里做完，这里只收文字和 JPEG。
//
// 历史是「DB 行 + 磁盘图片」两半：图片落 dataDir/order-judge/<uid>/<id>/，写入先落文件再插行（插行失败删目录），
// 删除（单条删除、超过 50 条的裁剪）先删行再删目录。目录名是随机 UUID，不存在同名文件先删后写的竞态。

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
import { judgeData, judgeHash, JudgeDataError } from './order-judge-data'
import { judgeEvents } from './order-judge-events'
import { dataDir } from './data-dir'
import { getSession, rateLimited } from './auth'
import { AgentRunError } from '../shared/agent-run'
import { estimateHours } from './order-judge-estimate'
import type { EstimateEvent, EstimateResult, HoursEstimate } from '../shared/order-judge-estimate'
import { chinaToday, quote, quoteYears, type Quote } from '../shared/order-judge-quote'
import { holidayYears } from './order-judge-holidays'
import { aiSource, judgeConnection, publicAddress, type JudgeConnection } from './agent/external-runtime'
import {
  MAX_IMAGES, SAME_SITE_GAP_MS, buildSystemPrompt, buildUserText, extractUrls, groupByHost,
  normalizeReport, pageDigest, type JudgeReport,
} from '../shared/order-judge'
import {
  ATTACH_FILE_RE, ATTACH_MAX_BYTES, ATTACH_MAX_FILES, ATTACH_MAX_TOTAL, DOC_MAX_BYTES, HISTORY_LIMIT, JUDGES_PER_MINUTE, JUDGE_MAX_BODY,
  type HistoryEntry, type HistoryFile, type JudgeEvent, type JudgeState, type JudgeSnapshot, type JudgeSyncEvent,
} from '../shared/order-judge-api'

const rootDir = join(dataDir, 'order-judge')
const entryDir = (uid: number, id: string): string => join(rootDir, String(uid), id)

const ID_RE = /^[0-9a-f-]{36}$/
const FILE_RE = /^\d{2}\.jpg$/
const DATA_URL_RE = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/
const MAX_IMAGE_BYTES = 1_500_000
const MAX_TEXT_CHARS = 200_000
const MAX_RUNNING = 4 // 同时在跑的评估；每个请求体最多 20MB，留在内存里
const FETCH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const IS_DEV = process.env.NODE_ENV !== 'production' && !process.env.VERCEL

type Source = 'server' | 'byok'

const MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: '请先登录。',
  NO_PROFILE: '还没有上传能力档案。',
  AGENT_AI_DISABLED: '服务器暂未开放 AI 功能。',
  PROVIDER_HTTP_429: 'AI 正在限流（HTTP 429），过一会儿再手动评估。',
  PROVIDER_UNAVAILABLE: '连不上 AI，请检查后手动重试。',
  INVALID_OUTPUT: 'AI 的回复读不出来，请手动重试。',
  EMPTY_RESPONSE: 'AI 连续 3 次返回空内容，请手动重试。',
  BAD_RESPONSE: 'AI 返回的结论不是有效 JSON，请手动重试。',
  CONTEXT_BUDGET: '材料太长，超出了模型一次能读的量，删掉一些再评估。',
  DAILY_QUOTA: '今天用服务器 AI 的次数用完了（和纱雾助手共用），明天再来，或者在设置里改用你自己的。',
  COST_LIMIT: '服务器 AI 的费用额度不够了：可能是这一单材料太多，也可能是今天的额度用完了。少放些截图再试，或者在设置里改用你自己的。',
  GLOBAL_BUSY: '同时在用服务器 AI 的人太多，稍后手动重试。',
  RUN_BUSY: '纱雾助手正在回答，等它说完再评估。',
  RATE_LIMITED: `评估太频繁了：每分钟最多 ${JUDGES_PER_MINUTE} 次。`,
  JUDGE_BUSY: '上一单还在评估，等它出结果再点。',
  ESTIMATE_BUSY: '上一单还在估价，等它出结果再点。',
  SERVER_BUSY: '服务器同时在评估的单子太多，稍后手动重试。',
  BAD_INPUT: '材料格式不对，刷新页面后重新放入。',
  MESSAGE_TOO_LARGE: '材料太大了：截图少放几张，或把视频换成几张关键截图。',
  NOT_FOUND: '这条记录不存在。',
  ABORTED: '评估超时或被取消了，请手动重试。',
}
// 同一个状态码在两种来源下是两回事：服务器 Key 余额用完不该叫用户去充值
const BY_SOURCE: Record<Source, Record<string, string>> = {
  server: {
    PROVIDER_CONNECTION_REQUIRED: '服务器的 AI 还没准备好，请手动重试。',
    PROVIDER_HTTP_401: '服务器的 AI Key 失效了（HTTP 401），可以先在设置里改用你自己的。',
    PROVIDER_HTTP_402: '服务器的 AI 余额用完了（HTTP 402），可以先在设置里改用你自己的，材料还在。',
  },
  byok: {
    PROVIDER_CONNECTION_REQUIRED: '你自己的 AI 连接断开了，请手动重试。',
    PROVIDER_HTTP_401: '你的 API key 不对（HTTP 401），请在设置里检查。',
    PROVIDER_HTTP_402: '你的 AI 账户余额不足（HTTP 402），充值后再评估，材料还在。',
  },
}

function errorBody(code: string, source?: Source): { code: string; error: string } {
  const http = /^PROVIDER_HTTP_(\d+)$/.exec(code)
  const known = (source && BY_SOURCE[source][code]) ?? MESSAGES[code]
  return { code, error: known ?? (http ? `AI 返回 HTTP ${http[1]}，没有自动重试。` : '这次评估失败了，请手动重试。') }
}

// ── 存取 ──

interface HistoryRow { id: string; at: number; report: string; order_text: string; images: string; snapshot: string | null; model: string | null; estimate: string | null; files: string | null }

function rowToEntry(r: HistoryRow): HistoryEntry {
  return { id: r.id, at: r.at, report: JSON.parse(r.report) as JudgeReport, order: r.order_text, images: JSON.parse(r.images) as HistoryEntry['images'], ...(r.files ? { files: JSON.parse(r.files) as HistoryFile[] } : {}), ...(r.snapshot ? { snapshot: JSON.parse(r.snapshot) as JudgeSnapshot } : {}), ...(r.model ? { model: r.model } : {}), ...(r.estimate ? { estimate: JSON.parse(r.estimate) as EstimateResult } : {}) }
}

function readState(uid: number): JudgeState {
  const history = (db.prepare('SELECT * FROM order_judge_history WHERE user_id = ? ORDER BY at DESC LIMIT ?').all(uid, HISTORY_LIMIT) as HistoryRow[]).map(rowToEntry)
  return { docs: judgeData.meta(uid), paths: judgeData.paths(uid), history, seq: judgeData.seq(uid) }
}

// 评估和估价带同一个 requestId 并行跑，谁先完成不一定：估价先到就暂存在这里，评估写历史时一并带上；
// 评估先到，估价完成时按 requestId 找到那条历史补写。暂存只在内存里，服务重启会丢（估价结果当时已显示给用户）。
const pendingEstimates = new Map<string, { result: EstimateResult; at: number }>()

function attachEstimate(uid: number, requestId: string, result: EstimateResult): boolean {
  const run = judgeData.runRow(uid, requestId)
  if (run?.entry_id) {
    db.prepare('UPDATE order_judge_history SET estimate=? WHERE id=? AND user_id=?').run(JSON.stringify(result), run.entry_id, uid)
    judgeData.bump(uid)
    return true
  }
  if (run?.status === 'error') return false
  const now = Date.now()
  for (const [k, v] of pendingEstimates) if (now - v.at > 600_000) pendingEstimates.delete(k)
  pendingEstimates.set(`${uid}:${requestId}`, { result, at: now })
  return false
}

// 小时 → 交期和价格（服务端按北京时间当天算），再写进这次评估的历史。节假日拉不到时小时照样给，写明为什么没有价格
async function finishEstimate(uid: number, requestId: string, hours: HoursEstimate, started: number, model: string): Promise<EstimateResult> {
  const today = chinaToday()
  let priced: Quote | null = null, quoteError: string | undefined
  try {
    priced = quote(hours.totalHours, today, await holidayYears(quoteYears(today, hours.totalHours)))
  } catch (e) {
    console.error(`[order-judge:estimate] uid=${uid} 交期算不出`, e)
    quoteError = `交期和价格算不出：${(e as Error).message}`
  }
  const result: EstimateResult = { hours, quote: priced, ...(quoteError ? { quoteError } : {}), at: Date.now(), ms: Date.now() - started, model }
  const saved = attachEstimate(uid, requestId, result)
  if (saved) judgeEvents.changed(uid, judgeData.seq(uid))
  console.info(`[order-judge:estimate] ← uid=${uid} ${hours.totalHours}h ${hours.taskCount} 任务 ${result.ms}ms ${saved ? '已写入历史' : '等评估写历史'}`)
  return result
}

async function saveHistory(uid: number, report: JudgeReport, order: string, images: { name: string; bytes: Buffer }[], files: { name: string; bytes: Buffer }[], snapshot: JudgeSnapshot, model: string, requestId: string): Promise<HistoryEntry> {
  const id = randomUUID()
  const dir = entryDir(uid, id)
  await mkdir(dir, { recursive: true })
  const saved: HistoryEntry['images'] = []
  const savedFiles: HistoryFile[] = []
  try {
    for (let i = 0; i < images.length; i++) {
      const file = `${String(i + 1).padStart(2, '0')}.jpg`
      await writeFile(join(dir, file), images[i].bytes)
      saved.push({ file, name: images[i].name })
    }
    for (let i = 0; i < files.length; i++) {
      const ext = /\.([a-z0-9]{1,8})$/i.exec(files[i].name)?.[1].toLowerCase() ?? 'bin'
      const file = `att-${String(i + 1).padStart(2, '0')}.${ext}`
      await writeFile(join(dir, file), files[i].bytes)
      savedFiles.push({ file, name: files[i].name, size: files[i].bytes.length })
    }
    const estimate = pendingEstimates.get(`${uid}:${requestId}`)?.result
    pendingEstimates.delete(`${uid}:${requestId}`)
    const entry: HistoryEntry = { id, at: Date.now(), report, order, images: saved, ...(savedFiles.length ? { files: savedFiles } : {}), snapshot, model, ...(estimate ? { estimate } : {}) }
    const stale = db.transaction(() => {
      db.prepare('INSERT INTO order_judge_history (id, user_id, at, report, order_text, images, snapshot, model, estimate, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, uid, entry.at, JSON.stringify(report), order, JSON.stringify(saved), JSON.stringify(snapshot), model, estimate ? JSON.stringify(estimate) : null, savedFiles.length ? JSON.stringify(savedFiles) : null)
      judgeData.bump(uid)
      judgeData.endRun(uid, requestId, entry.id, null)
      const old = db.prepare('SELECT id FROM order_judge_history WHERE user_id = ? ORDER BY at DESC LIMIT -1 OFFSET ?').all(uid, HISTORY_LIMIT) as { id: string }[]
      const del = db.prepare('DELETE FROM order_judge_history WHERE id = ?')
      for (const o of old) del.run(o.id)
      return old.map((o) => o.id)
    })()
    for (const oldId of stale) {
      try { await rm(entryDir(uid, oldId), { recursive: true, force: true }) }
      catch (error) { console.warn(`[order-judge] 旧图片目录清理失败 uid=${uid} id=${oldId}`, error) }
    }
    return entry
  } catch (e) {
    await rm(dir, { recursive: true, force: true })
    throw e
  }
}

// ── 打开派单里的网址 ──

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

// 评估和估价同一次点击一起发，各自计数，互不占对方的名额
const recent = new Map<number, number[]>()
const recentEstimates = new Map<number, number[]>()
const running = new Set<number>()
const estimating = new Set<number>()

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

// ── 调 DeepSeek ──

function contentOf(raw: unknown): string | null {
  const choices = (raw && typeof raw === 'object' ? (raw as { choices?: unknown }).choices : null)
  const first = Array.isArray(choices) ? choices[0] as { message?: { content?: unknown } } | undefined : undefined
  const content = first?.message?.content
  return typeof content === 'string' && content.trim() ? content : null
}

async function askModel(conn: JudgeConnection, uid: number, system: string, userText: string, images: string[], signal: AbortSignal): Promise<JudgeReport> {
  const model = conn.model
  const body = {
    model,
    temperature: 0.2,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
    ...(model.startsWith('deepseek-') ? { thinking: { type: 'disabled' } } : {}),
    messages: [
      { role: 'system', content: system },
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
    try {
      return normalizeReport(JSON.parse(content))
    } catch (e) {
      console.error(`[order-judge] uid=${uid} 结论不是 JSON: ${content.slice(0, 200)}`, e)
      throw new AgentRunError('BAD_RESPONSE', 503)
    }
  }
  throw new AgentRunError('EMPTY_RESPONSE', 503)
}

// ── 路由 ──

type Env = { Variables: { uid: number } }
export function createOrderJudgeApi(connection: typeof judgeConnection = judgeConnection): Hono<Env> {
const api = new Hono<Env>()
api.onError((e, c) => {
  if (e instanceof JudgeDataError) return c.json({ code: e.code, error: e.message }, e.status)
  console.error('[order-judge] 请求失败', e)
  return c.json({ code: 'UNEXPECTED', error: '接单评估服务异常，请查看服务端日志。' }, 500)
})

api.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  const s = await getSession(c)
  if (!s) return c.json(errorBody('AUTH_REQUIRED'), 401)
  c.set('uid', s.uid)
  // 读写分桶：翻历史会一次加载几十张图，不能把保存档案的额度吃掉；评估另有每分钟次数
  const write = c.req.method !== 'GET'
  if (rateLimited(`order-judge:${write ? 'write' : 'read'}:${s.uid}`, write ? 60 : 600, 60_000)) {
    c.header('Retry-After', '60')
    console.warn(`[order-judge] 限流 uid=${s.uid} ${c.req.method} ${c.req.path}`)
    return c.json({ code: 'RATE_LIMITED', error: '操作太频繁了，一分钟后再试。' }, 429)
  }
  await next()
})

api.get('/', (c) => c.json(readState(c.get('uid'))))

api.get('/sync', async c => {
  const session = await getSession(c)
  return c.json({ protocol: 1, accountId: c.get('uid'), username: session!.username, seq: judgeData.seq(c.get('uid')), docs: judgeData.docs(c.get('uid')), paths: judgeData.paths(c.get('uid')) })
})

api.post('/sync/check/:id', bodyLimit({ maxSize: 4096 }), async c => {
  const input = await c.req.json().catch(() => null) as { deviceId?: unknown; error?: unknown } | null
  if (typeof input?.deviceId !== 'string' || (input.error !== undefined && typeof input.error !== 'string')) return c.json(errorBody('BAD_INPUT'), 400)
  judgeEvents.acknowledge(c.get('uid'), input.deviceId, c.req.param('id'), input.error as string | undefined)
  return c.json({ ok: true })
})

api.get('/sync/events', async c => {
  const uid = c.get('uid'), session = await getSession(c), device = c.req.query('deviceId') ?? null
  if (device !== null && !/^[a-zA-Z0-9-]{16,80}$/.test(device)) return c.json(errorBody('BAD_INPUT'), 400)
  judgeEvents.validate(uid, device)
  c.header('Content-Type', 'application/x-ndjson; charset=utf-8')
  c.header('X-Accel-Buffering', 'no')
  return stream(c, async out => {
    let stopped = false, wake = (): void => {}
    const queue: JudgeSyncEvent[] = [{ type: 'ready', seq: judgeData.seq(uid) }]
    const close = (): void => { stopped = true; wake() }
    const unsubscribe = judgeEvents.subscribe(uid, device, event => {
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

const docLimit = bodyLimit({ maxSize: DOC_MAX_BYTES + 4096, onError: (c) => c.json(errorBody('MESSAGE_TOO_LARGE'), 413) })

api.put('/docs/:kind', docLimit, async (c) => {
  const kind = c.req.param('kind')
  if (kind !== 'profile' && kind !== 'log') return c.json(errorBody('NOT_FOUND'), 404)
  const body = await c.req.json().catch(() => null) as { path?: unknown } | null
  // 带 path 的是电脑读本机文件后的覆盖；不带的是网页（含手机）上传，进路径列表。
  const receipt = typeof body?.path === 'string' && body.path ? judgeData.write(c.get('uid'), kind, body) : undefined
  if (!receipt) judgeData.upload(c.get('uid'), kind, body)
  judgeEvents.changed(c.get('uid'), judgeData.seq(c.get('uid')))
  return c.json({ ...(receipt ? { receipt } : {}), docs: judgeData.meta(c.get('uid')), paths: judgeData.paths(c.get('uid')) })
})

api.put('/paths/:kind', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
  const kind = c.req.param('kind')
  if (kind !== 'profile' && kind !== 'log') return c.json(errorBody('NOT_FOUND'), 404)
  const input = await c.req.json().catch(() => null) as { paths?: unknown } | null
  const paths = judgeData.setPaths(c.get('uid'), kind, input?.paths)
  judgeEvents.changed(c.get('uid'), judgeData.seq(c.get('uid')))
  return c.json({ paths })
})

api.post('/paths/merge', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
  const paths = judgeData.mergePaths(c.get('uid'), await c.req.json().catch(() => null))
  judgeEvents.changed(c.get('uid'), judgeData.seq(c.get('uid')))
  return c.json({ paths })
})

api.delete('/history/:id', async (c) => {
  const uid = c.get('uid'), id = c.req.param('id')
  if (!ID_RE.test(id)) return c.json(errorBody('NOT_FOUND'), 404)
  const r = db.prepare('DELETE FROM order_judge_history WHERE id = ? AND user_id = ?').run(id, uid)
  if (!r.changes) return c.json(errorBody('NOT_FOUND'), 404)
  judgeData.bump(uid); judgeEvents.changed(uid, judgeData.seq(uid))
  try { await rm(entryDir(uid, id), { recursive: true, force: true }) }
  catch (error) { console.warn(`[order-judge] 删除记录后的图片目录清理失败 uid=${uid} id=${id}`, error) }
  return c.json({ ok: true })
})

api.post('/history/import', bodyLimit({ maxSize: JUDGE_MAX_BODY, onError: c => c.json(errorBody('MESSAGE_TOO_LARGE'), 413) }), async c => {
  const input = await c.req.json().catch(() => null) as { sourceId?: unknown; at?: unknown; report?: unknown; text?: unknown; images?: unknown } | null
  const materials = parseJudge(input)
  if (!input || typeof input.sourceId !== 'string' || !ID_RE.test(input.sourceId) || !Number.isSafeInteger(input.at) || Number(input.at) < 0 || !input.report || typeof input.report !== 'object' || !materials) return c.json(errorBody('BAD_INPUT'), 400)
  const uid = c.get('uid'), report = normalizeReport(input.report)
  const hash = judgeHash(JSON.stringify([input.at, report, materials.text, materials.images.map(image => [image.name, judgeHash(image.dataUrl)])]))
  const lookup = (): { input_hash: string; entry_id: string } | undefined => db.prepare('SELECT input_hash,entry_id FROM order_judge_imports WHERE user_id=? AND source_id=?').get(uid, input.sourceId) as { input_hash: string; entry_id: string } | undefined
  const previous = lookup()
  if (previous) {
    if (previous.input_hash !== hash) throw new JudgeDataError('REQUEST_CHANGED', '这条本机历史在导入后发生变化，未覆盖共享记录。')
    return c.json({ imported: false, id: previous.entry_id })
  }
  const id = randomUUID(), dir = entryDir(uid, id), saved: HistoryEntry['images'] = []
  await mkdir(dir, { recursive: true })
  let committed = false
  try {
    for (let i = 0; i < materials.images.length; i++) {
      const file = `${String(i + 1).padStart(2, '0')}.jpg`
      await writeFile(join(dir, file), materials.images[i].bytes); saved.push({ file, name: materials.images[i].name })
    }
    const result = db.transaction(() => {
      const existing = lookup()
      if (existing) {
        if (existing.input_hash !== hash) throw new JudgeDataError('REQUEST_CHANGED', '导入来源已改变。')
        return { imported: false, id: existing.entry_id }
      }
      if ((db.prepare('SELECT count(*) AS n FROM order_judge_history WHERE user_id=?').get(uid) as { n: number }).n >= HISTORY_LIMIT) throw new JudgeDataError('HISTORY_FULL', '共享历史已满 50 条；本机记录与备份保留，请先整理共享历史再导入。')
      db.prepare('INSERT INTO order_judge_history (id,user_id,at,report,order_text,images) VALUES (?,?,?,?,?,?)').run(id, uid, input.at, JSON.stringify(report), materials.text, JSON.stringify(saved))
      db.prepare('INSERT INTO order_judge_imports VALUES (?,?,?,?)').run(uid, input.sourceId, hash, id)
      judgeData.bump(uid); return { imported: true, id }
    })()
    committed = result.imported
    judgeEvents.changed(uid, judgeData.seq(uid))
    return c.json(result)
  } finally { if (!committed) await rm(dir, { recursive: true, force: true }) }
})

api.get('/history/:id/:file', async (c) => {
  const uid = c.get('uid'), id = c.req.param('id'), file = c.req.param('file')
  if (!ID_RE.test(id) || !FILE_RE.test(file)) return c.json(errorBody('NOT_FOUND'), 404)
  if (!db.prepare('SELECT 1 FROM order_judge_history WHERE id = ? AND user_id = ?').get(id, uid)) return c.json(errorBody('NOT_FOUND'), 404)
  try {
    const bytes = await readFile(join(entryDir(uid, id), file))
    c.header('Cache-Control', 'private, max-age=86400')
    return c.body(new Uint8Array(bytes), 200, { 'Content-Type': 'image/jpeg' })
  } catch (e) {
    console.warn(`[order-judge] 历史图片读不到 uid=${uid} ${id}/${file}`, e)
    return c.json(errorBody('NOT_FOUND'), 404)
  }
})

const FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf', md: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8',
  html: 'text/plain; charset=utf-8', htm: 'text/plain; charset=utf-8', rtf: 'text/plain; charset=utf-8',
}

api.get('/history/:id/files/:file', async (c) => {
  const uid = c.get('uid'), id = c.req.param('id'), file = c.req.param('file')
  if (!ID_RE.test(id) || !ATTACH_FILE_RE.test(file)) return c.json(errorBody('NOT_FOUND'), 404)
  const row = db.prepare('SELECT files FROM order_judge_history WHERE id = ? AND user_id = ?').get(id, uid) as { files: string | null } | undefined
  const meta = (row?.files ? JSON.parse(row.files) as HistoryFile[] : []).find((f) => f.file === file)
  if (!meta) return c.json(errorBody('NOT_FOUND'), 404)
  try {
    const bytes = await readFile(join(entryDir(uid, id), file))
    const download = c.req.query('download') === '1'
    const type = FILE_TYPES[file.slice(file.lastIndexOf('.') + 1)]
    c.header('Cache-Control', 'private, max-age=86400')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Content-Disposition', `${download || !type ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(meta.name)}`)
    return c.body(new Uint8Array(bytes), 200, { 'Content-Type': download || !type ? 'application/octet-stream' : type })
  } catch (e) {
    console.warn(`[order-judge] 历史附件读不到 uid=${uid} ${id}/${file}`, e)
    return c.json(errorBody('NOT_FOUND'), 404)
  }
})

type ParsedJudge = { text: string; images: { name: string; bytes: Buffer; dataUrl: string }[]; files: { name: string; bytes: Buffer; hash: string }[] }

function parseJudge(input: unknown): ParsedJudge | null {
  const o = (input && typeof input === 'object' ? input : {}) as { text?: unknown; images?: unknown; files?: unknown }
  const text = typeof o.text === 'string' ? o.text : ''
  if (text.length > MAX_TEXT_CHARS || !Array.isArray(o.images) || o.images.length > MAX_IMAGES) return null
  const images: { name: string; bytes: Buffer; dataUrl: string }[] = []
  for (const x of o.images as unknown[]) {
    const item = (x && typeof x === 'object' ? x : {}) as { name?: unknown; dataUrl?: unknown }
    if (typeof item.name !== 'string' || typeof item.dataUrl !== 'string') return null
    const m = DATA_URL_RE.exec(item.dataUrl)
    if (!m) return null
    const bytes = Buffer.from(m[1], 'base64')
    if (bytes.length > MAX_IMAGE_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
    images.push({ name: item.name.slice(0, 120), bytes, dataUrl: item.dataUrl })
  }
  const files: ParsedJudge['files'] = []
  if (o.files !== undefined) {
    if (!Array.isArray(o.files) || o.files.length > ATTACH_MAX_FILES) return null
    let total = 0
    for (const x of o.files as unknown[]) {
      const item = (x && typeof x === 'object' ? x : {}) as { name?: unknown; data?: unknown }
      if (typeof item.name !== 'string' || !item.name.trim() || typeof item.data !== 'string' || !/^[A-Za-z0-9+/=]*$/.test(item.data)) return null
      const bytes = Buffer.from(item.data, 'base64')
      total += bytes.length
      if (bytes.length > ATTACH_MAX_BYTES || total > ATTACH_MAX_TOTAL) return null
      files.push({ name: item.name.slice(0, 120), bytes, hash: judgeHash(item.data) })
    }
  }
  if (!text.trim() && !images.length && !files.length) return null
  return { text, images, files }
}

api.post('/judge', bodyLimit({ maxSize: JUDGE_MAX_BODY, onError: (c) => c.json(errorBody('MESSAGE_TOO_LARGE'), 413) }), async (c: Context<Env>) => {
  const uid = c.get('uid')
  const raw = await c.req.json().catch(() => null) as Record<string, unknown> | null
  const input = parseJudge(raw)
  if (!input) return c.json(errorBody('BAD_INPUT'), 400)
  const requestId = raw?.requestId === undefined ? randomUUID() : raw.requestId
  const withEstimate = raw?.estimate === true
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) return c.json(errorBody('BAD_INPUT'), 400)
  const inputHash = judgeHash(JSON.stringify([input.text, input.images.map(x => [x.name, judgeHash(x.dataUrl)]), input.files.map(x => [x.name, x.hash])]))
  const previous = judgeData.run(uid, requestId, inputHash)
  if (previous) {
    if (previous.status === 'running') return c.json(errorBody('JUDGE_BUSY'), 409)
    const row = previous.entry_id ? db.prepare('SELECT * FROM order_judge_history WHERE id=? AND user_id=?').get(previous.entry_id, uid) as HistoryRow | undefined : undefined
    if (row) return c.body(JSON.stringify({ type: 'done', entry: rowToEntry(row) }) + '\n', 200, { 'Content-Type': 'application/x-ndjson' })
    return c.json({ code: previous.error_code ?? 'RESULT_REMOVED', error: '这次请求已结束；没有重复调用 AI。请查看历史，或明确发起一次新的评估。' }, 409)
  }
  if (running.has(uid)) return c.json(errorBody('JUDGE_BUSY'), 409)
  if (running.size >= MAX_RUNNING) return c.json(errorBody('SERVER_BUSY'), 429)
  const wait = takeSlot(uid, recent)
  if (wait) {
    c.header('Retry-After', String(wait))
    return c.json({ ...errorBody('RATE_LIMITED'), error: `${MESSAGES.RATE_LIMITED}${wait} 秒后可以再点。` }, 429)
  }

  judgeData.beginRun(uid, requestId, inputHash)
  running.add(uid)
  c.header('Content-Type', 'application/x-ndjson; charset=utf-8')
  c.header('X-Accel-Buffering', 'no')
  return stream(c, async (out) => {
    const send = (e: JudgeEvent): Promise<unknown> => out.write(JSON.stringify(e) + '\n')
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(240_000)])
    const started = Date.now()
    let source: Source | undefined
    const fail = async (e: unknown): Promise<void> => {
      const code = e instanceof AgentRunError || e instanceof JudgeDataError ? e.code : signal.aborted ? 'ABORTED' : 'UNEXPECTED'
      judgeData.endRun(uid, requestId, null, code)
      console.error(`[order-judge] ✗ uid=${uid} ${code} ${Date.now() - started}ms`, e)
      if (!out.aborted) await send({ type: 'error', ...(e instanceof JudgeDataError ? { code, error: e.message } : errorBody(code, source)) })
    }
    try {
      await judgeEvents.check(uid)
      signal.throwIfAborted()
      const frozen = judgeData.snapshot(uid)
      source = aiSource(uid)
      const urls = extractUrls(input.text)
      let links = ''
      if (urls.length) {
        await send({ type: 'stage', stage: 'links', count: urls.length })
        links = await fetchLinks(urls, signal)
      }
      await send({ type: 'stage', stage: 'ai' })
      const conn = await connection(uid, signal)
      const system = buildSystemPrompt(frozen.profile, frozen.log)
      console.info(`[order-judge] → uid=${uid} ${conn.source} ${conn.model} 文字 ${input.text.length} 字 网址 ${urls.length} 个 图片 ${input.images.length} 张`)
      const userText = buildUserText(input.text, links, input.images.map((x) => x.name))
      // 估价和评估放在同一个 AI 回合里并行：服务器 AI 每人同时只能占一个回合，分两个请求会互相顶掉（RUN_BUSY）。
      // 估价失败只发它自己的 error 事件，不影响评估结论。
      const estimating = withEstimate ? (async () => {
        try {
          const hours = await estimateHours(conn.call, conn.model, userText, input.images.map((x) => x.dataUrl), signal, (e) => send({ type: 'estimate', event: e }))
          await send({ type: 'estimate', event: { type: 'done', result: await finishEstimate(uid, requestId, hours, started, conn.model) } })
        } catch (e) {
          const code = e instanceof AgentRunError ? e.code : signal.aborted ? 'ABORTED' : 'UNEXPECTED'
          console.error(`[order-judge:estimate] ✗ uid=${uid} ${code} ${Date.now() - started}ms`, e)
          if (!out.aborted) await send({ type: 'estimate', event: { type: 'error', ...errorBody(code, source) } })
        }
      }) : null
      // 结论一出来就发，回合等估价也结束才释放（估价的计费要在回合内结算）
      await conn.execute(async () => {
        const est = estimating?.()
        try {
          const report = await askModel(conn, uid, system, userText, input.images.map((x) => x.dataUrl), signal)
          const entry = await saveHistory(uid, report, input.text, input.images, input.files, frozen.snapshot, conn.model, requestId)
          judgeEvents.changed(uid, judgeData.seq(uid))
          console.info(`[order-judge] ← uid=${uid} ${report.verdict} ${report.title} ${Date.now() - started}ms`)
          await send({ type: 'done', entry })
        } catch (e) {
          await fail(e)
        }
        await est
      })
    } catch (e) {
      await fail(e)
    } finally {
      running.delete(uid)
    }
  }, async (e) => {
    running.delete(uid)
    console.error('[order-judge] 响应流中断', e)
  })
})

// 单独重新估价（评估时附带的那次失败后用）：带评估的 requestId，结果写进那条历史；一次估价算一回合额度。
api.post('/estimate', bodyLimit({ maxSize: JUDGE_MAX_BODY, onError: (c) => c.json(errorBody('MESSAGE_TOO_LARGE'), 413) }), async (c: Context<Env>) => {
  const uid = c.get('uid')
  const raw = await c.req.json().catch(() => null) as Record<string, unknown> | null
  const input = parseJudge(raw)
  const requestId = raw?.requestId
  if (!input || typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) return c.json(errorBody('BAD_INPUT'), 400)
  if (estimating.has(uid)) return c.json(errorBody('ESTIMATE_BUSY'), 409)
  if (estimating.size >= MAX_RUNNING) return c.json(errorBody('SERVER_BUSY'), 429)
  const wait = takeSlot(uid, recentEstimates)
  if (wait) {
    c.header('Retry-After', String(wait))
    return c.json({ ...errorBody('RATE_LIMITED'), error: `估价太频繁了：每分钟最多 ${JUDGES_PER_MINUTE} 次，${wait} 秒后可以再点。` }, 429)
  }

  estimating.add(uid)
  c.header('Content-Type', 'application/x-ndjson; charset=utf-8')
  c.header('X-Accel-Buffering', 'no')
  return stream(c, async (out) => {
    const send = (e: EstimateEvent): Promise<unknown> => out.write(JSON.stringify(e) + '\n')
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(120_000)])
    const started = Date.now()
    let source: Source | undefined
    try {
      source = aiSource(uid)
      const urls = extractUrls(input.text)
      let links = ''
      if (urls.length) {
        await send({ type: 'stage', stage: 'links', count: urls.length })
        links = await fetchLinks(urls, signal)
      }
      const conn = await connection(uid, signal)
      console.info(`[order-judge:estimate] → uid=${uid} ${conn.source} ${conn.model} 文字 ${input.text.length} 字 网址 ${urls.length} 个 图片 ${input.images.length} 张`)
      const brief = buildUserText(input.text, links, input.images.map((x) => x.name))
      const hours = await conn.execute(() => estimateHours(conn.call, conn.model, brief, input.images.map((x) => x.dataUrl), signal, send))
      await send({ type: 'done', result: await finishEstimate(uid, requestId, hours, started, conn.model) })
    } catch (e) {
      const code = e instanceof AgentRunError ? e.code : signal.aborted ? 'ABORTED' : 'UNEXPECTED'
      console.error(`[order-judge:estimate] ✗ uid=${uid} ${code} ${Date.now() - started}ms`, e)
      if (!out.aborted) await send({ type: 'error', ...errorBody(code, source) })
    } finally {
      estimating.delete(uid)
    }
  }, async (e) => {
    estimating.delete(uid)
    console.error('[order-judge:estimate] 响应流中断', e)
  })
})

return api
}

export default createOrderJudgeApi()
