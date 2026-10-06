// 边下边播的盘上缓存：用户点开一集，服务器就用 12 条连接把整集 mp4 按顺序拉到盘上；播放器要哪段，
// 那段在盘上就从盘上答，不在就等它下到。整集下完之后拖进度跟本地文件一样。
//
// 为什么换成这个（2026-10-06）：之前 stream.ts 是「内存窗口 + 12 路分块 + 读取端调度 + 起播闸门」，
// 窗口外的数据随时丢、往回拖要重下、多个读取端互相驱逐，每修一个场景多一条特例。源站单连接掉到约 57KB/s
// （12 路合计约 650KB/s，码率约 154KB/s）后，512KB 一块要 9 秒且完成顺序乱，PC 上起播阶段反复「播 1~2 秒卡几秒」。
// 下到盘上的数据永不丢：只要源站合计速度高于码率，起播攒一小段领先之后就一路不卡。
//
// 几条不能改错的：
// - 块写完（await 写盘）才记「已到」，读取端只读已到的块——边写边读的落盘时机坑见 AGENTS.md
// - 一个 Range 请求开头先等「从请求位置起连续 LEAD_BYTES」再出第一个字节（GATE_MAX_MS 封顶）：
//   块完成顺序是乱的，第一块一到就放行，播放器起播后马上追上下载前沿，就是反复卡
// - 优先级只有一份：正在被看的集 > 预取的下一集。预取的集只在没有「正在被看且没下完」的集时才拿连接，
//   不跟当前这集抢入口
// - 重试预算只有一份：HTTP 4xx/5xx 不重试、整集标坏；只有传输中断才对同一块续传 ≤3 次

import { mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { open, rename, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Agent, request } from 'undici'
import { dataDir } from '../data-dir'
import { UPSTREAM_HEADERS, type StreamResult } from './stream'

const WORKERS = 12
// 一块的耗时就是起播 / 跳进度的下限：实测单连接约 57KB/s，512KB 一块要 9 秒；256KB 约 4.5 秒。
// 再小建连 / 首字节开销（0.2~3.7 秒）就吃掉太多吞吐。
const PIECE = 256 * 1024
// 起播 / 跳进度后，从请求位置起连续攒够这么多才出第一个字节。1.5MB ≈ 1.2Mbps 码率下 10 秒画面，
// 足够盖住「块完成顺序乱」的几秒抖动；12 条连接并发，一轮就能攒够。
const LEAD_BYTES = 1.5 * 1024 * 1024
// 闸门封顶：源站整体变慢时也不能让用户对着转圈干等，到点有多少先给多少。
const GATE_MAX_MS = 20_000
const PIECE_RESUME_LIMIT = 3
const SMALL_BYTES = 1024 * 1024
// 传输中断（断连 / 建连超时）的预算按时间算、整集只有一份：某块续传用尽后放回去冷却几秒、换条连接再拿；
// 连续这么久一块都没成才判源站不通。早先「一块续传用尽就整集作废」，本机实测一次 TLS 握手被掐，
// 正在看的这集就停在 0:42 再也不动。
const TRANSPORT_GIVEUP_MS = 60_000
const PIECE_COOLDOWN_MS = 3_000
// 正在被看 = 这么久内有过读取端。之后它还没下完也让位给预取。
const WATCH_TTL_MS = 2 * 60_000
const PREFETCH_DELAY_MS = 30_000
const MAX_BYTES = 4 * 1024 * 1024 * 1024
export const MAX_FILE_BYTES = 1.5 * 1024 * 1024 * 1024

const dir = join(dataDir, 'prefetch')
mkdirSync(dir, { recursive: true })
// 没下完的 .part 不跨重启：「哪些块已到」只在内存里，重启后无从得知，整个丢掉重下。
for (const name of readdirSync(dir)) if (name.endsWith('.part')) rmSync(join(dir, name), { force: true })

// 每条连接一个 Agent：undici 默认会把同源请求复用到同一连接池，写 12 个 Promise 不等于 12 条下载链。
const agents = Array.from({ length: WORKERS }, () => new Agent({ connections: 1, connectTimeout: 20_000, headersTimeout: 30_000, bodyTimeout: 30_000 }))

function log(msg: string): void {
  console.log('[xifan:disk] ' + msg)
}
// 媒体身份 = 去掉查询参数的地址。稀饭的播放地址带短效签名（sign=…&t=…），按整条 URL 当身份的话，
// 签名一换就认不出盘上已有的整集，重新从头下（2026-10-06 测试实测：第 40 集整集在盘，重开又「开始落盘 174MB」）。
// 签名变 ≠ 内容变：换签名后第一次复用时后台核一次总长度，对不上就删掉重下，防止串片。
export function mediaKey(url: string): string {
  const u = new URL(url)
  return u.host + u.pathname
}
const fileOf = (url: string): string => join(dir, createHash('sha1').update(mediaKey(url)).digest('hex') + '.mp4')
const verified = new Set<string>()

// 盘上有整集就返回路径（faststart 读头尾也从这里读，不再打源站）。
export function diskFile(url: string): string | null {
  const file = fileOf(url)
  try { statSync(file); return file } catch { return null }
}

function verifyLater(url: string, file: string): void {
  const key = mediaKey(url)
  if (verified.has(key)) return
  verified.add(key)
  void probeTotal(url).then((total) => {
    const size = statSync(file).size
    if (total !== size) {
      log(`${key} 源站长度 ${total} ≠ 盘上 ${size}，内容已变，删掉重下`)
      rmSync(file, { force: true })
      verified.delete(key)
    }
  }, (error: unknown) => {
    // 核不了（源站此刻不通）就先信盘上的：长度没法比，也就没有证据说它变了
    verified.delete(key)
    console.error(`[xifan:disk] ${key} 核对长度失败：`, error instanceof Error ? error.message : error)
  })
}

class HttpStatusError extends Error {}

interface Entry {
  url: string
  label: string
  total: number
  pieces: number
  done: Uint8Array
  doneCount: number
  inflight: Map<number, AbortController>
  fh: FileHandle | null
  // 下一块从哪儿往后找。读取端跳到没下的位置时挪过去，之后从那里一路往后、到尾再绕回开头补洞。
  cursor: number
  watchedAt: number
  prefetch: { notBefore: number } | null
  failure: Error | null
  complete: boolean
  waiters: Set<() => void>
  // 最近一次新开的 Range 请求编号。只有它能挪下载游标：PC Chrome 跳进度后旧连接常常还挂着、
  // 停在旧位置等数据，若它也能挪游标，两个位置来回抢，新位置永远攒不起领先。
  latestReader: number
  // 小段请求（iPhone 拖进度后去文件头补的几 KB、探测）要的块：插队先下，但不挪游标、不中止别处的块。
  urgent: Set<number>
  lastSuccessAt: number
  // 最近一次有块在飞的时刻。闲了一阵（暂停、让位给别的集）再开工时重置 lastSuccessAt，
  // 否则歇过 60 秒后遇到的第一次断连就会被当成「一分钟没成功」直接判死。
  lastActiveAt: number
  cooldown: Map<number, number>
}

const entries = new Map<string, Entry>()
const probing = new Map<string, Promise<Entry | null>>()
const freeSlots = Array.from({ length: WORKERS }, (_, i) => i)

function wake(e: Entry): void {
  for (const w of [...e.waiters]) w()
}

async function probeTotal(url: string): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    const res = await request(url, { dispatcher: agents[0], method: 'GET', maxRedirections: 5, headers: { ...UPSTREAM_HEADERS, Range: 'bytes=0-0' } })
    await res.body.dump()
    const m = String(res.headers['content-range'] ?? '').match(/\/(\d+)$/)
    if (res.statusCode === 206 && m) return Number(m[1])
    // 200 = 边缘还没缓存、无视 Range：等一下重打通常就是 206
    if (res.statusCode !== 200 || attempt >= PIECE_RESUME_LIMIT) throw new HttpStatusError('探长度状态 ' + res.statusCode)
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
  }
}

function evictFor(incoming: number): void {
  const live = new Set([...entries.values()].map((e) => fileOf(e.url) + '.part'))
  const files = readdirSync(dir)
    .map((n) => join(dir, n))
    .filter((p) => !live.has(p))
    .map((p) => { const st = statSync(p); return { p, size: st.size, used: st.mtimeMs } })
    .sort((a, b) => a.used - b.used)
  let held = files.reduce((sum, f) => sum + f.size, 0) + [...entries.values()].filter((e) => !e.complete).reduce((s, e) => s + e.total, 0)
  for (const f of files) {
    if (held + incoming <= MAX_BYTES) break
    rmSync(f.p, { force: true })
    held -= f.size
    log(`腾空间删掉 ${f.p}（${Math.round(f.size / 1048576)}MB）`)
  }
}

// null = 这个文件不走盘（太大 / 探不到长度），调用方回到原来的在线路径。
function entryOf(url: string, label: string): Promise<Entry | null> {
  const key = mediaKey(url)
  const have = entries.get(key)
  if (have) { have.url = url; return Promise.resolve(have) } // 新签名，后面的块用它
  const running = probing.get(key)
  if (running) return running
  if (diskFile(url)) return Promise.resolve(null)
  const job = (async () => {
    const total = await probeTotal(url)
    if (total > MAX_FILE_BYTES) { log(`${label} ${Math.round(total / 1048576)}MB 超过单集上限，不走盘`); return null }
    evictFor(total)
    const pieces = Math.ceil(total / PIECE)
    const e: Entry = {
      url, label, total, pieces, done: new Uint8Array(pieces), doneCount: 0, inflight: new Map(),
      fh: await open(fileOf(url) + '.part', 'w'), cursor: 0, watchedAt: 0, prefetch: null,
      failure: null, complete: false, waiters: new Set(), latestReader: 0, urgent: new Set(), lastSuccessAt: Date.now(), lastActiveAt: Date.now(), cooldown: new Map(),
    }
    entries.set(key, e)
    log(`${label} 开始落盘 ${Math.round(total / 1048576)}MB`)
    return e
  })().catch((error: unknown) => {
    console.error(`[xifan:disk] ${label} 探长度失败，走在线路径：`, error)
    return null
  }).finally(() => probing.delete(key))
  probing.set(key, job)
  return job
}

const watching = (e: Entry): boolean => Date.now() - e.watchedAt < WATCH_TTL_MS
const cooling = (e: Entry, i: number): boolean => (e.cooldown.get(i) ?? 0) > Date.now()

function pickPiece(): { e: Entry; i: number } | null {
  const active = [...entries.values()].filter((e) => !e.complete && !e.failure)
  const watched = active.filter(watching).sort((a, b) => b.watchedAt - a.watchedAt)
  const pool = watched.length
    ? watched
    : active.filter((e) => e.prefetch && Date.now() >= e.prefetch.notBefore)
  for (const e of pool) {
    for (const i of e.urgent) {
      if (e.done[i]) { e.urgent.delete(i); continue }
      if (!e.inflight.has(i) && !cooling(e, i)) return { e, i }
    }
    for (let k = 0; k < e.pieces; k++) {
      const i = (e.cursor + k) % e.pieces
      if (!e.done[i] && !e.inflight.has(i) && !cooling(e, i)) return { e, i }
    }
  }
  return null
}

async function fetchPiece(e: Entry, i: number, worker: number, ac: AbortController): Promise<void> {
  const start = i * PIECE
  const end = Math.min(start + PIECE, e.total) - 1
  let got = 0
  for (let attempt = 0; ; attempt++) {
    if (got === end - start + 1) return
    try {
      const res = await request(e.url, {
        dispatcher: agents[worker], method: 'GET', maxRedirections: 5, signal: ac.signal,
        headers: { ...UPSTREAM_HEADERS, Range: `bytes=${start + got}-${end}` },
      })
      if (res.statusCode !== 206) {
        await res.body.dump()
        if (res.statusCode === 200) throw new Error('上游对 Range 回了 200')
        throw new HttpStatusError(`上游状态 ${res.statusCode}（bytes=${start + got}-${end}）`)
      }
      for await (const chunk of res.body) {
        const buf = chunk as Buffer
        const take = Math.min(buf.length, end - start + 1 - got)
        const { bytesWritten } = await e.fh!.write(buf, 0, take, start + got)
        if (bytesWritten !== take) throw new HttpStatusError(`写盘不完整 ${bytesWritten}/${take}`) // 盘满之类，不是传输问题，不续传
        got += take
      }
      if (got !== end - start + 1) throw new Error(`分块截断 ${got}/${end - start + 1}`)
      return
    } catch (error) {
      if (ac.signal.aborted || error instanceof HttpStatusError || attempt >= PIECE_RESUME_LIMIT) throw error
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
    }
  }
}

async function finish(e: Entry): Promise<void> {
  const fh = e.fh
  e.fh = null
  await fh?.close()
  await rename(fileOf(e.url) + '.part', fileOf(e.url))
  e.complete = true
  log(`${e.label} 整集落盘完成`)
  wake(e)
  entries.delete(mediaKey(e.url))
  verified.add(mediaKey(e.url)) // 刚下完的就是当前内容
}

function pump(): void {
  while (freeSlots.length) {
    const job = pickPiece()
    if (!job) return
    const worker = freeSlots.pop()!
    const { e, i } = job
    const ac = new AbortController()
    if (e.inflight.size === 0 && Date.now() - e.lastActiveAt > 10_000) e.lastSuccessAt = Date.now()
    e.lastActiveAt = Date.now()
    e.inflight.set(i, ac)
    void fetchPiece(e, i, worker, ac).then(async () => {
      e.done[i] = 1
      e.doneCount++
      e.lastSuccessAt = Date.now()
      e.cooldown.delete(i)
      wake(e)
      if (e.doneCount === e.pieces) await finish(e)
    }, (error: unknown) => {
      if (ac.signal.aborted) return
      if (e.failure) return
      if (!(error instanceof HttpStatusError) && Date.now() - e.lastSuccessAt < TRANSPORT_GIVEUP_MS) {
        log(`${e.label} 第 ${i} 块传输中断（${error instanceof Error ? error.message : String(error)}），${PIECE_COOLDOWN_MS / 1000}s 后换连接再拿`)
        e.cooldown.set(i, Date.now() + PIECE_COOLDOWN_MS)
        setTimeout(pump, PIECE_COOLDOWN_MS + 50).unref()
        return
      }
      // 4xx/5xx 或连续 TRANSPORT_GIVEUP_MS 一块都没成：整集标坏，正在等的读取端收到错误；不在应用层再兜一轮。
      e.failure = error instanceof Error ? error : new Error(String(error))
      console.error(`[xifan:disk] ${e.label} 第 ${i} 块失败，停止落盘：`, error)
      wake(e)
      for (const c of e.inflight.values()) c.abort()
      // 坏掉的这份不留：用户下次重新点开时从头再来，而不是永远拿到同一个错误
      entries.delete(mediaKey(e.url))
      const fh = e.fh
      e.fh = null
      void fh?.close().catch(() => undefined).then(() => rmSync(fileOf(e.url) + '.part', { force: true }))
    }).finally(() => {
      e.inflight.delete(i)
      e.lastActiveAt = Date.now()
      freeSlots.push(worker)
      pump()
    })
  }
}
// 只是为了没有读取端时到点开始预取；正常推进全靠块完成和读取端请求时的 pump()。
setInterval(pump, 5_000).unref()

const contiguousFrom = (e: Entry, pos: number): number => {
  let i = Math.floor(pos / PIECE)
  while (i < e.pieces && e.done[i]) i++
  return Math.min(i * PIECE, e.total)
}

function waitChange(e: Entry, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => { clearTimeout(t); e.waiters.delete(done); resolve() }
    const t = setTimeout(done, ms)
    e.waiters.add(done)
  })
}

// 读取端要的位置还没下：把下载游标挪过去。还在别处飞的块（跳进度前的旧位置）立刻中止，
// 12 条连接全部转到新位置——否则它们各自还要跑完一块（约 9 秒）才肯过来。
function prioritize(e: Entry, pos: number): void {
  const want = Math.floor(pos / PIECE)
  const leadPieces = Math.ceil(LEAD_BYTES / PIECE) * 2
  if (e.done[want] && contiguousFrom(e, pos) - pos >= LEAD_BYTES) return
  if (e.cursor !== want) {
    e.cursor = want
    for (const [i, c] of e.inflight) if (i < want || i >= want + leadPieces + WORKERS) c.abort()
  }
  pump()
}

function parseRange(header: string | undefined, total: number): { start: number; end: number; ranged: boolean } | null {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/)
  if (!m || (m[1] === '' && m[2] === '')) return { start: 0, end: total - 1, ranged: false }
  if (m[1] === '') return { start: Math.max(0, total - Number(m[2])), end: total - 1, ranged: true }
  const start = Number(m[1])
  const end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1)
  return start > end || start >= total ? null : { start, end, ranged: true }
}

function headersFor(start: number, end: number, total: number, ranged: boolean): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    'Content-Length': String(end - start + 1),
  }
  if (ranged) h['Content-Range'] = `bytes ${start}-${end}/${total}`
  return h
}

async function serveComplete(file: string, rangeHeader: string | undefined): Promise<StreamResult> {
  const total = statSync(file).size
  try { const now = new Date(); utimesSync(file, now, now) } catch { /* 只影响回收顺序 */ }
  const r = parseRange(rangeHeader, total)
  if (!r) return { status: 416, headers: { 'Content-Range': `bytes */${total}` }, body: null }
  const fh = await open(file, 'r')
  let pos = r.start
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (pos > r.end) { ctl.close(); await fh.close(); return }
      const buf = Buffer.alloc(Math.min(256 * 1024, r.end - pos + 1))
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
      if (!bytesRead) { ctl.close(); await fh.close(); return }
      pos += bytesRead
      ctl.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead))
    },
    async cancel() { await fh.close() },
  })
  return { status: r.ranged ? 206 : 200, headers: headersFor(r.start, r.end, total, r.ranged), body }
}

// 返回 null = 这个地址不走盘，调用方用原来的在线路径。
export async function serveFromDisk(url: string, label: string, rangeHeader: string | undefined): Promise<StreamResult | null> {
  const file = fileOf(url)
  if (diskFile(url)) { verifyLater(url, file); return serveComplete(file, rangeHeader) }
  const e = await entryOf(url, label)
  if (!e) return null
  if (e.complete) return serveComplete(file, rangeHeader)
  const r = parseRange(rangeHeader, e.total)
  if (!r) return { status: 416, headers: { 'Content-Range': `bytes */${e.total}` }, body: null }
  e.watchedAt = Date.now()
  const small = r.end - r.start + 1 <= SMALL_BYTES
  let readerId = 0
  if (small) {
    for (let i = Math.floor(r.start / PIECE); i <= Math.floor(r.end / PIECE); i++) if (!e.done[i]) e.urgent.add(i)
    pump()
  } else {
    readerId = ++e.latestReader
    prioritize(e, r.start)
  }

  // 起播闸门：从请求位置起连续攒够 LEAD_BYTES（或到文件尾 / 到请求终点）再出第一个字节。
  const gateEnd = Math.min(r.start + LEAD_BYTES, r.end + 1)
  const gateUntil = Date.now() + GATE_MAX_MS
  while (!e.failure && !e.complete && contiguousFrom(e, r.start) < gateEnd && Date.now() < gateUntil) {
    await waitChange(e, Math.min(1000, gateUntil - Date.now()))
  }
  if (e.failure) throw e.failure

  let pos = r.start
  let fh: FileHandle | null = null
  // 播放器断开后 pull 里正在等数据的那一轮还会醒来；不看这个标记就会一直空转、一直刷新 watchedAt，
  // 这集就永远占着「正在被看」的下载优先级。
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      for (;;) {
        if (cancelled) return
        if (pos > r.end) { ctl.close(); await fh?.close(); return }
        if (e.failure) { await fh?.close(); ctl.error(e.failure); return }
        e.watchedAt = Date.now()
        // 每个读取端自己开只读句柄：整集落盘时 .part 改名，已打开的句柄照样能读，不跟写入端的句柄抢关闭时机
        fh ??= await open(file + '.part', 'r').catch(() => open(file, 'r')) // 恰好赶上改名那一刻
        if (!e.complete && contiguousFrom(e, pos) <= pos) {
          if (small) { for (let i = Math.floor(pos / PIECE); i <= Math.floor(r.end / PIECE); i++) if (!e.done[i]) e.urgent.add(i); pump() }
          else if (readerId === e.latestReader) prioritize(e, pos)
          await waitChange(e, 5_000)
          continue
        }
        const avail = e.complete ? r.end + 1 : Math.min(contiguousFrom(e, pos), r.end + 1)
        const buf = Buffer.alloc(Math.min(256 * 1024, avail - pos))
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
        if (!bytesRead) { await waitChange(e, 1_000); continue }
        pos += bytesRead
        ctl.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead))
        return
      }
    },
    async cancel() { cancelled = true; wake(e); await fh?.close() },
  })
  return { status: r.ranged ? 206 : 200, headers: headersFor(r.start, r.end, e.total, r.ranged), body }
}

// 拿到播放地址时就开始下（播放器建好、用户点播放之前还有几秒），不等第一个 Range。
export function warmDisk(url: string, label: string): void {
  if (diskFile(url)) return
  void entryOf(url, label).then((e) => {
    if (!e || e.complete) return
    e.watchedAt = Date.now()
    pump()
  })
}

// 看第 N 集时把第 N+1 集排进来。它只在没有「正在被看且没下完」的集时才拿连接（见 pickPiece），
// 所以当前这集下完之前完全不动它；地址等真开始前再解析，不拿一个排了很久的过期地址。
// 每个用户只保留最新的一个预取：换番 / 往后跳着看时，他上一个还没下完的预取撤掉（已下的块留着，回来接着用）。
const prefetchOf = new Map<number, { label: string; key: string | null; timer: NodeJS.Timeout | null }>()

function dropPrefetch(owner: number): void {
  const old = prefetchOf.get(owner)
  if (!old) return
  prefetchOf.delete(owner)
  if (old.timer) clearTimeout(old.timer)
  const e = old.key ? entries.get(old.key) : undefined
  if (e?.prefetch) {
    e.prefetch = null
    for (const c of e.inflight.values()) c.abort()
    log(`${old.label} 预取撤销：同一用户改看别的`)
  }
}

export function schedulePrefetch(owner: number, label: string, resolveUrl: () => Promise<string | null>): void {
  if (prefetchOf.get(owner)?.label === label) return
  dropPrefetch(owner)
  const slot: { label: string; key: string | null; timer: NodeJS.Timeout | null } = { label, key: null, timer: null }
  prefetchOf.set(owner, slot)
  slot.timer = setTimeout(() => {
    slot.timer = null
    void (async () => {
      try {
        const url = await resolveUrl()
        if (!url || prefetchOf.get(owner) !== slot) return
        slot.key = mediaKey(url)
        if (diskFile(url)) return
        const e = await entryOf(url, label)
        if (prefetchOf.get(owner) !== slot) return
        if (e && !e.complete && !e.prefetch) {
          e.prefetch = { notBefore: Date.now() }
          log(`排队预取 ${label}`)
          pump()
        }
      } catch (error) {
        console.error(`[xifan:disk] ${label} 解析下一集失败，不预取：`, error)
      }
    })()
  }, PREFETCH_DELAY_MS)
  slot.timer.unref()
}

// 诊断用：每集当前游标处的连续领先、已下比例。
export function diskStats(): string[] {
  return [...entries.values()].map((e) =>
    `${e.label} cursor=${(e.cursor * PIECE / 1048576).toFixed(0)}MB lead=${((contiguousFrom(e, e.cursor * PIECE) - e.cursor * PIECE) / 1048576).toFixed(1)}MB done=${(e.doneCount / e.pieces * 100).toFixed(0)}% inflight=${e.inflight.size}`)
}
