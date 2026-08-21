// 稀饭 mp4 并发分片流代理 —— 网页版的 mtmedia://。
//
// 为什么必须放在服务端：最终签名地址 pan.wo.cn **一见到 Origin 头就 403**（不带 Origin 是 206）。
// 浏览器 JS 发的任何请求都必然带 Origin，所以 fetch + MSE 那条纯前端路线走不通；
// <video> 裸直连虽然是 no-CORS（不带 Origin）能播，但 JS 读不到字节，也就没法自己开多路。
// 服务端发请求不带 Origin，这是唯一能同时「拿到字节」和「开多路」的位置。
//
// 为什么要多路：线路一的源按连接限速。本机实测单路 ~170KB/s（1.4Mbps），6 路合计
// ~912KB/s（7.3Mbps），而视频码率约 2.6Mbps —— 单路追不上实时播放。
//
// **带宽账（实测）**：该集平均码率 2.67Mbps（474432984B / 1422.1s），VBR 峰值更高，
// 实践上要 3.5~4Mbps 才算稳。香港 VPS 12 路入口 5.0~5.3Mbps，够单人看且有余量；
// 但服务器**出口只有 6Mbps**，2 人同看就贴着上限，3 人必然一起卡 —— 出口才是硬顶。
//
// 调度逻辑对齐 src/main/shared/media-cache.ts（桌面端），两点差异：
//   1. **内存滑动窗口**而非落盘 —— 服务器不留临时文件，代价是只能复用窗口内的进度。
//   2. **一个会话可以有多个读取端** —— 见下面 Reader 的注释。

import '../http'
import { randomUUID } from 'node:crypto'
import { Agent, request } from 'undici'

/**
 * 只代理**确实需要加速的慢源**，而不是所有 mp4。
 *
 * 两个理由，缺一不可：
 *   1. 安全 —— 不设白名单，这个端点就是一个开放 SSRF 跳板。
 *   2. 带宽 —— 走代理的每一路都要吃服务器的入口和出口（出口只有 6Mbps，约 2.2 人份）。
 *      线路二（play.xfvod.pro）浏览器直连实测 30Mbps、给全套 CORS、不按连接限速，
 *      让它走代理是纯粹的浪费，还会把服务器名额占掉。
 *
 * 线路一（apn.moedot.net → 联通网盘）才是那个单路只有 1.4Mbps、非并发不可的源。
 */
const ALLOWED_HOSTS = new Set(['apn.moedot.net'])

/** 给播放页用：这个地址要不要走代理。不在名单里的一律浏览器直连。 */
export const PROXY_HOSTS = [...ALLOWED_HOSTS]

// 12 路。并发叠加曲线实测（每路 12s，无一失败）：
//   本机     6 路 5.25Mbps → 12 路 18.8Mbps → 24 路 34.7Mbps
//   香港 VPS 6 路 3.53Mbps → 12 路 4.93Mbps → 24 路 4.59Mbps（已饱和，再加只是摊薄）
// VPS 上 12 路是拐点，30s 持续复测稳定在 5.0~5.3Mbps。
const WORKERS = 12
const CHUNK_BYTES = 512 * 1024
const CHUNK_FAR_BYTES = 2 * 1024 * 1024
// 前沿告急（缓冲垫薄）时一律小块：掉队只赔 512KiB，不赔 2MiB。
const FRONTIER_URGENT_BYTES = 12 * 1024 * 1024
// 告急时的窄带窗口**必须喂得饱所有 worker**，否则并发是假的：12 路 × 512KiB = 6MiB，
// 窗口若只有 4MiB 就有一半 worker 在窗口边缘干等（实测经代理只跑出 1.9Mbps，
// 而同一时刻裸 12 路能跑 18.8Mbps）。留 2 倍余量，让下一轮块也已经在路上。
const FRONTIER_BAND_BYTES = 2 * WORKERS * CHUNK_BYTES
const WINDOW_BYTES = 24 * 1024 * 1024
const LEAD_BYTES = 32 * 1024 * 1024
// 起播闸门：冷 seek 时连续前缀攒够这些再回流，避免播放器拿到几百 KB 就起播、随后追上下载端。
const COLD_START_BYTES = 4 * CHUNK_BYTES
// 起播闸门的**时间上限**。多个区间并存时会抢同一个限速源，后来者可能十几秒都攒不够
// COLD_START_BYTES（实测冷 seek 到新区间时 14 秒拿到 0 字节）。攒不够也得先放行——
// 让播放器先动起来再慢慢追，总比一直转圈强。
const COLD_START_MAX_MS = 6_000
// 已被所有读取端越过的数据再往回留这么多，好让「跟得近的后来者」直接命中内存。
const KEEP_BEHIND_BYTES = 16 * 1024 * 1024
// 单会话内存上限。最慢的读取端拖过这个距离就被请出去（它会重连，另开会话），
// 不能让一个挂着不动的读取端把整段窗口钉死在内存里。
const SESSION_MEM_CAP = 64 * 1024 * 1024
// 全局内存预算。2G 的机器上 Node 堆不敢放肆，超了就先淘汰没人读的会话。
const TOTAL_MEM_CAP = 192 * 1024 * 1024
const MAX_SESSIONS_PER_URL = 3
// Chromium 打开 mp4 会先探一次**文件尾部**找 moov。这种小请求绝不能去顶掉正在跑的
// 会话（顶掉一次 = 前面攒的窗口全丢，播放器立刻 stall 回退 iframe），单路直连透传即可。
const TAIL_DIRECT_BYTES = 4 * 1024 * 1024
const IDLE_MS = 60_000
const WAIT_TICK_MS = 5_000
const WORKER_STAGGER_MS = 40
const CHUNK_SILENCE_MS = 15_000
const CHUNK_RETRY_LIMIT = 2

const UPSTREAM_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
}

// 每个 worker 一个独立 Agent 且 connections:1 —— undici 默认会把同源请求复用到同一连接池，
// 代码里写 6 个 Promise 不等于 6 条有效下载链（桌面端用 6 个独立 Electron Session 解决同一问题）。
const agents: Agent[] = Array.from(
  { length: WORKERS },
  () => new Agent({ connections: 1, connectTimeout: 10_000, headersTimeout: 15_000, bodyTimeout: 0 }),
)

/**
 * 一个读取端 = 一条挂在会话上的 HTTP 响应流（一个观众的 <video>，或它自己开的某条请求）。
 *
 * 为什么必须支持多个：Chromium 打开一个 mp4 会连开好几条请求再 abort 掉大半（实测 4 条
 * abort 3 条），两个人同看同一集更是天然多读取端。早先「块一发出就释放 + 全局单会话」的
 * 写法下，它们会互抢同一批块，两边都攒不出连续前缀 —— 表现为播放器一个字节都拿不到。
 */
interface Reader {
  id: number
  cursor: number // 相对 regionStart
  evicted: boolean
  /** 预转（ffmpeg）自己拉的那条，不算「观众」——否则预转会把自己当观众冻住自己。 */
  internal: boolean
}

interface Session {
  url: string
  total: number
  regionStart: number
  chunks: Map<number, Buffer> // key = 相对 regionStart 的起始偏移
  bytesHeld: number
  contiguousEnd: number // 从 regionStart 起**连续**就绪到哪里
  createdAt: number
  readers: Map<number, Reader>
  ac: AbortController
  ev: EventTarget
  idleTimer: NodeJS.Timeout | null
  failure: unknown
  done: boolean
}

const sessions = new Map<string, Session[]>() // url → 该视频当前活着的几段区间
const totalCache = new Map<string, number>() // probeTotal 要一次往返，缓存住
let nextReaderId = 1

function log(msg: string): void {
  console.log('[xifan:stream] ' + msg)
}

function notify(s: Session): void {
  s.ev.dispatchEvent(new Event('progress'))
}

function waitProgress(s: Session, timeoutMs = WAIT_TICK_MS): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      s.ev.removeEventListener('progress', done)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    s.ev.addEventListener('progress', done, { once: true })
  })
}

function liveReaders(s: Session): Reader[] {
  return [...s.readers.values()].filter((r) => !r.evicted)
}

// 下载前沿跟**最远**的那个读取端走：落在后面的人要的数据已经在内存里，不会卡；
// 只有跑在最前面的人才可能追上下载端。
function frontCursor(s: Session): number {
  const live = liveReaders(s)
  return live.length ? Math.max(...live.map((r) => r.cursor)) : 0
}

function rearCursor(s: Session): number {
  const live = liveReaders(s)
  return live.length ? Math.min(...live.map((r) => r.cursor)) : s.contiguousEnd
}

function totalHeld(): number {
  let n = 0
  for (const list of sessions.values()) for (const s of list) n += s.bytesHeld
  return n
}

/**
 * 回收：所有读取端都越过、且已经落在 KEEP_BEHIND 之外的块才丢。
 * 内存超顶时先把最慢的读取端请出去（它一走，它钉住的那段就能回收），而不是丢块 ——
 * 丢掉某个读取端正要读的块会让它收到半截流，那正是「看着看着突然卡」。
 */
function gc(s: Session): void {
  if (s.bytesHeld > SESSION_MEM_CAP) {
    const live = liveReaders(s)
    if (live.length > 1) {
      const slowest = live.reduce((a, b) => (a.cursor <= b.cursor ? a : b))
      slowest.evicted = true
      log(`会话 ${s.regionStart} 内存超顶，请出最慢读取端 #${slowest.id}（它会重连另开区间）`)
      notify(s)
    }
  }
  const keepFrom = Math.max(0, rearCursor(s) - KEEP_BEHIND_BYTES)
  for (const [key, buf] of s.chunks) {
    if (key + buf.length <= keepFrom) {
      s.chunks.delete(key)
      s.bytesHeld -= buf.length
    }
  }
}

function armIdle(s: Session): void {
  if (s.idleTimer) clearTimeout(s.idleTimer)
  s.idleTimer = setTimeout(() => {
    if (liveReaders(s).length === 0) {
      log(`会话 ${s.regionStart} 空转 60s，收摊`)
      disposeSession(s)
    } else {
      armIdle(s)
    }
  }, IDLE_MS)
  s.idleTimer.unref?.()
}

function disposeSession(s: Session): void {
  s.ac.abort()
  if (s.idleTimer) clearTimeout(s.idleTimer)
  s.idleTimer = null
  s.chunks.clear()
  s.bytesHeld = 0
  const list = sessions.get(s.url)
  if (list) {
    const rest = list.filter((x) => x !== s)
    if (rest.length) sessions.set(s.url, rest)
    else sessions.delete(s.url)
  }
  notify(s)
}

export function disposeXifanStream(): void {
  for (const list of [...sessions.values()]) for (const s of [...list]) disposeSession(s)
}

function chunkSizeAt(bufferAhead: number): number {
  return bufferAhead >= FRONTIER_URGENT_BYTES ? CHUNK_FAR_BYTES : CHUNK_BYTES
}

// 每块都从**原始稀饭地址**重走 302 各自拿签名链：签名链是绑连接的，复用给多路会互相挤住
// （桌面端 2026-08-08 那版的结论，勿改）。
async function fetchRange(s: Session, worker: number, absStart: number, absEnd: number): Promise<Buffer> {
  let received = 0
  const parts: Buffer[] = []
  for (let attempt = 0; ; attempt++) {
    if (s.ac.signal.aborted) throw new Error('stream aborted')
    const ctl = new AbortController()
    const onAbort = (): void => ctl.abort()
    s.ac.signal.addEventListener('abort', onAbort, { once: true })
    let lastByteAt = Date.now()
    const silence = setInterval(() => {
      if (Date.now() - lastByteAt >= CHUNK_SILENCE_MS) ctl.abort()
    }, 1_000)
    try {
      const res = await request(s.url, {
        dispatcher: agents[worker],
        method: 'GET',
        maxRedirections: 5,
        headers: { ...UPSTREAM_HEADERS, Range: `bytes=${absStart + received}-${absEnd}` },
        signal: ctl.signal,
      })
      if (res.statusCode !== 206) {
        await res.body.dump()
        throw new Error('upstream status ' + res.statusCode)
      }
      for await (const piece of res.body) {
        const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece)
        parts.push(buf)
        received += buf.length
        lastByteAt = Date.now()
      }
      const want = absEnd - absStart + 1
      if (received !== want) throw new Error(`range truncated ${received}/${want}`)
      return Buffer.concat(parts)
    } catch (error) {
      if (s.ac.signal.aborted || attempt >= CHUNK_RETRY_LIMIT) throw error
      // 已收到的部分留着，下一次尝试从这里续传。
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
    } finally {
      clearInterval(silence)
      s.ac.signal.removeEventListener('abort', onAbort)
    }
  }
}

async function probeTotal(url: string): Promise<number> {
  const res = await request(url, {
    dispatcher: agents[0],
    method: 'GET',
    maxRedirections: 5,
    headers: { ...UPSTREAM_HEADERS, Range: 'bytes=0-0' },
  })
  const cr = res.headers['content-range']
  // 必须 dump() 不能 destroy()：destroy 会在 BodyReadable 上 emit 一个没人接的 error，
  // 直接把整个 Node 进程带走（UND_ERR_ABORTED 未捕获异常）。
  await res.body.dump()
  const m = typeof cr === 'string' ? cr.match(/\/(\d+)$/) : null
  if (!m) throw new Error('上游不支持 Range，拿不到总长度')
  return Number(m[1])
}

function runWorkers(s: Session): void {
  const regionLength = s.total - s.regionStart
  let nextOffset = 0
  const completed = new Map<number, number>()

  const markComplete = (relStart: number, buf: Buffer): void => {
    s.chunks.set(relStart, buf)
    s.bytesHeld += buf.length
    completed.set(relStart, buf.length)
    while (completed.has(s.contiguousEnd)) {
      const len = completed.get(s.contiguousEnd)!
      completed.delete(s.contiguousEnd)
      s.contiguousEnd += len
    }
    gc(s)
    notify(s)
  }

  const claim = async (): Promise<{ relStart: number; len: number } | null> => {
    for (;;) {
      if (s.ac.signal.aborted || nextOffset >= regionLength) return null
      // 没有活跃读取端就**停手**，只留着已下好的窗口等人回来（idle 看门狗另行收摊）。
      // 否则每 seek 一次都留下一个后台会话继续下满窗口，反过来抢新会话的带宽——
      // 实测连续三次冷 seek，速度从 4.03Mbps 一路掉到 0.17Mbps，就是被残留会话吃掉的。
      if (liveReaders(s).length === 0) {
        await waitProgress(s)
        continue
      }
      const front = frontCursor(s)
      const bufferAhead = Math.max(0, s.contiguousEnd - front)
      const urgent = bufferAhead < FRONTIER_URGENT_BYTES
      // 两道闸都以字节计：只围绕最早缺口保留有界窗口，同时不比最靠前的读取端领先太多。
      const gapLimit = s.contiguousEnd + (urgent ? FRONTIER_BAND_BYTES : WINDOW_BYTES)
      const leadLimit = front + LEAD_BYTES
      if (nextOffset < Math.min(gapLimit, leadLimit)) {
        const relStart = nextOffset
        const want = urgent ? CHUNK_BYTES : chunkSizeAt(relStart - front)
        const len = Math.min(want, regionLength - relStart)
        nextOffset = relStart + len
        return { relStart, len }
      }
      await waitProgress(s)
    }
  }

  const worker = async (index: number): Promise<void> => {
    await new Promise((r) => setTimeout(r, index * WORKER_STAGGER_MS))
    for (;;) {
      const job = await claim()
      if (!job) return
      const absStart = s.regionStart + job.relStart
      const buf = await fetchRange(s, index, absStart, absStart + job.len - 1)
      if (s.ac.signal.aborted) return
      markComplete(job.relStart, buf)
    }
  }

  Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)))
    .then(() => {
      s.done = true
      notify(s)
    })
    .catch((error) => {
      if (s.ac.signal.aborted) return
      s.failure = error
      log('worker 失败：' + (error instanceof Error ? error.message : String(error)))
      notify(s)
    })
}

function startSession(url: string, total: number, regionStart: number): Session {
  const s: Session = {
    url,
    total,
    regionStart,
    chunks: new Map(),
    bytesHeld: 0,
    contiguousEnd: 0,
    createdAt: Date.now(),
    readers: new Map(),
    ac: new AbortController(),
    ev: new EventTarget(),
    idleTimer: null,
    failure: null,
    done: false,
  }
  const list = sessions.get(url) ?? []
  list.push(s)
  sessions.set(url, list)
  armIdle(s)
  runWorkers(s)
  log(`会话开启 start=${regionStart} total=${total} workers=${WORKERS}（该视频区间数 ${list.length}）`)
  return s
}

// 内存吃紧时先清掉没人读的会话；还不够就放弃最老的那个空闲区间。
function reclaimMemory(): void {
  if (totalHeld() <= TOTAL_MEM_CAP) return
  for (const list of [...sessions.values()]) {
    for (const s of [...list]) {
      if (liveReaders(s).length === 0) {
        log('内存超预算，回收空闲会话 ' + s.regionStart)
        disposeSession(s)
        if (totalHeld() <= TOTAL_MEM_CAP) return
      }
    }
  }
}

/**
 * 挑一个能直接接上的会话：start 落在它「还留着的数据」区间内就复用。
 * 这就是「第二个人看同一集时无需重新加载」——只要他的进度落在前面那位的窗口里，
 * 一个字节都不用回源站要。
 */
function pickSession(url: string, start: number): Session | null {
  const list = sessions.get(url)
  if (!list) return null
  for (const s of list) {
    if (s.failure) continue
    const rel = start - s.regionStart
    const keepFrom = Math.max(0, rearCursor(s) - KEEP_BEHIND_BYTES)
    if (rel >= keepFrom && rel <= s.contiguousEnd) return s
  }
  return null
}

function parseRange(header: string | undefined): { start: number; end: number | null; ranged: boolean } {
  const m = header?.match(/^bytes=(\d+)-(\d*)/)
  if (!m) return { start: 0, end: null, ranged: false }
  return { start: Number(m[1]), end: m[2] ? Number(m[2]) : null, ranged: true }
}

// 单路直连透传，完全不碰会话。用于 moov 尾部探测这类小请求。
async function passthrough(url: string, start: number, end: number, total: number): Promise<StreamResult> {
  const res = await request(url, {
    dispatcher: agents[0],
    method: 'GET',
    maxRedirections: 5,
    headers: { ...UPSTREAM_HEADERS, Range: `bytes=${start}-${end}` },
  })
  if (res.statusCode !== 206) {
    await res.body.dump()
    throw new Error('上游 passthrough 状态 ' + res.statusCode)
  }
  return {
    status: 206,
    headers: {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(end - start + 1),
      'Cache-Control': 'no-store',
    },
    body: res.body as unknown as ReadableStream<Uint8Array>,
  }
}

/**
 * 当前有多少人正在真看。预转会把入口带宽吃满，必须让位给正在观看的人（见 prepare.ts）。
 *
 * **按读取端标记而不是按 URL 排除**：用户很可能正在看的就是正在预转的那一集
 * （边看直连版边后台转），按 URL 排除会把真观众一起漏掉，让位就失效了。
 */
export function viewerCount(): number {
  let n = 0
  for (const list of sessions.values()) {
    for (const s of list) n += liveReaders(s).filter((r) => !r.internal).length
  }
  return n
}

/** 只有本进程知道的一次性令牌：预转拉流时带上，外部无法伪造成「不算观众」。 */
export const INTERNAL_TOKEN = randomUUID()

export function assertStreamableUrl(raw: string): URL {
  const u = new URL(raw)
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
    throw new Error('不允许代理该地址：' + u.hostname)
  }
  return u
}

export interface StreamResult {
  status: number
  headers: Record<string, string>
  body: ReadableStream<Uint8Array> | null
}

export async function serveStream(
  rawUrl: string,
  rangeHeader: string | undefined,
  internal = false,
): Promise<StreamResult> {
  const url = assertStreamableUrl(rawUrl).toString()
  const { start, end, ranged } = parseRange(rangeHeader)

  let total = totalCache.get(url)
  if (total === undefined) {
    total = await probeTotal(url)
    totalCache.set(url, total)
  }
  if (start >= total) return { status: 416, headers: { 'Content-Range': `bytes */${total}` }, body: null }

  // 尾部探测 / 明确要一小段 → 直连透传，绝不触碰正在跑的会话。
  const wantsSmallSlice = end !== null && end - start + 1 <= TAIL_DIRECT_BYTES
  const isTail = start >= total - TAIL_DIRECT_BYTES
  if (wantsSmallSlice || isTail) {
    const realEnd = end === null ? total - 1 : Math.min(end, total - 1)
    return passthrough(url, start, realEnd, total)
  }

  reclaimMemory()
  // 能接上就接上（后来者直接吃前面那位攒下的窗口）；接不上就为这段进度另开一个区间，
  // **绝不顶掉正在被人看的会话** —— 顶掉就意味着那位观众正看着突然卡住。
  let session = pickSession(url, start)
  if (!session) {
    const list = sessions.get(url) ?? []
    if (list.length >= MAX_SESSIONS_PER_URL) {
      const idle = list.find((s) => liveReaders(s).length === 0)
      if (idle) disposeSession(idle)
      else disposeSession(list[0]) // 都有人读也只能让位，否则区间数无上限
    }
    session = startSession(url, total, start)
  } else {
    log(`复用已有区间 start=${session.regionStart} 供给 ${start}（省掉一次回源）`)
  }

  const reader: Reader = { id: nextReaderId++, cursor: start - session.regionStart, evicted: false, internal }
  session.readers.set(reader.id, reader)
  armIdle(session)
  notify(session) // 新读取端可能把下载前沿推远，叫醒 claim

  const headers: Record<string, string> = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(total - start),
    'Cache-Control': 'no-store',
  }
  // Chromium 打开 <video> 时**首个请求不带 Range 头**，这时回 206 是不合法的
  // （206 只能用来回应 Range 请求），媒体栈会把响应体整个丢掉——现象是响应头到了但
  // encodedBodySize 恒为 0，播放器一个字节都等不到。没有 Range 就老老实实回 200。
  if (ranged) headers['Content-Range'] = `bytes ${start}-${total - 1}/${total}`

  const detach = (): void => {
    session!.readers.delete(reader.id)
    gc(session!)
    notify(session!)
    armIdle(session!)
  }

  let pulls = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const s = session!
        if (reader.evicted || s.ac.signal.aborted) {
          // 被请出去/会话没了：截断，浏览器会自己带新 Range 重连，那时另开区间。
          detach()
          controller.close()
          return
        }
        if (s.failure) {
          detach()
          controller.error(s.failure)
          return
        }
        if (reader.cursor >= s.total - s.regionStart) {
          detach()
          controller.close()
          return
        }
        // 起播闸门只管**冷 seek**：跳到新位置时先攒够再放行，免得播放器拿到几百 KB 就起播、
        // 随后立刻追上下载端反复卡顿。**文件开场必须豁免**（对齐桌面端 exposeFirstProgressively）：
        // 开场时下载才刚建连，攒满 2MB 要十几秒，而播放器侧的缓冲闸门只等 10 秒——
        // 闸门互相顶死，表现为播放器一个字节都拿不到、直接回退 iframe。
        const atFileStart = s.regionStart < CHUNK_BYTES
        const warmedUp =
          atFileStart ||
          s.contiguousEnd >= Math.min(COLD_START_BYTES, s.total - s.regionStart) ||
          Date.now() - s.createdAt >= COLD_START_MAX_MS
        if (warmedUp && reader.cursor < s.contiguousEnd) {
          let hit: { key: number; buf: Buffer } | null = null
          for (const [key, buf] of s.chunks) {
            if (key <= reader.cursor && reader.cursor < key + buf.length) {
              hit = { key, buf }
              break
            }
          }
          if (!hit) {
            // 窗口已经滑过该位置。这里**截断**而不是报错：响应头早就发出去了，
            // 这时 error 只会让 <video> 收到半截损坏的流并触发回退 iframe。
            log(`窗口已滑过 cursor=${reader.cursor}，截断让浏览器重连`)
            detach()
            controller.close()
            return
          }
          const slice = hit.buf.subarray(reader.cursor - hit.key)
          reader.cursor += slice.length
          pulls++
          if (pulls % 64 === 0) {
            log(
              `reader#${reader.id} 已出库 ${(reader.cursor / 1048576).toFixed(0)}MB，` +
              `前缀 ${(s.contiguousEnd / 1048576).toFixed(0)}MB，` +
              `内存 ${(s.bytesHeld / 1048576).toFixed(0)}MB，读取端 ${liveReaders(s).length}`,
            )
          }
          gc(s)
          notify(s)
          armIdle(s)
          controller.enqueue(new Uint8Array(slice))
          return
        }
        if (s.done && reader.cursor >= s.contiguousEnd) {
          detach()
          controller.close()
          return
        }
        await waitProgress(s)
      }
    },
    cancel() {
      // 浏览器断开（换集 / 关页面 / seek 触发新请求）不立刻杀会话 —— <video> 暂停时
      // 也会断流，交给 idle 看门狗决定，避免一暂停就把攒好的窗口全丢了。
      detach()
    },
  })

  return { status: ranged ? 206 : 200, headers, body }
}
