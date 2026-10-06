// 「moov 在文件尾」的 mp4 就地改成虚拟 faststart：同样大小的文件，字节顺序变成 头部 → 尾块（含 moov）→ mdat。
//
// 为什么：2026-10 起稀饭新番（实测 Re:Zero 第四季 夺还篇全季）的 mp4 是 ftyp,free,mdat(730MB),moov(2.4MB)，
// 上一季同线路还是 ftyp,moov,mdat。iPhone 必须先拿到 moov 才能解码任何一帧：它要先去文件尾单独拉 2.4MB，
// 而这条尾部请求跟已经跑起来的 12 路会话抢同一个 ~5Mbps 入口，真机胶片前 38 秒 rs=0、一个字节都没解出来；
// 拿到 moov 后又要回头从 mdat 开头重新拉，起播前就浪费了一轮。
//
// 做法：服务器先把尾块拉一次（只拉一次、按媒体身份缓存，签名换了不重拉），把 stco/co64 里每个块偏移加上尾块长度，
// 放到 mdat 前面从内存答；其余区间一一映射回原文件（偏移 -尾块长度），底下走边下边播的盘上缓存（disk.ts），太大的文件才回到 12 路内存会话。
// 整集已在盘上时，头尾也直接从盘上读（fetchRange），不再为目录去源站排队。
// 文件总长不变，所以拖进度条的 Range 计算和原文件完全一致。

import { Readable } from 'node:stream'
import { Agent, request } from 'undici'
import { open } from 'node:fs/promises'
import { UPSTREAM_HEADERS, type StreamResult } from '../xifan/stream'
import { diskFile, mediaKey } from '../xifan/disk'

const HEAD_BYTES = 64 * 1024
const MAX_TAIL_BYTES = 32 * 1024 * 1024
const LAYOUT_CACHE_MAX = 64
const FAILURE_TTL_MS = 60_000

export interface Layout {
  total: number
  // 原文件里 mdat 盒子（含盒头）的起点；[0, prefixEnd) 原样
  prefixEnd: number
  // 原文件里 mdat 的终点 = 尾块起点；尾块长度 tail.length
  mdatEnd: number
  head: Buffer
  tail: Buffer
}

const agent = new Agent({ connections: 6, connectTimeout: 20_000, headersTimeout: 30_000, bodyTimeout: 60_000 })
const layouts = new Map<string, Layout | null>()
const failedAt = new Map<string, number>()
const inflight = new Map<string, Promise<Layout | null>>()

function log(msg: string): void {
  console.log('[player:faststart] ' + msg)
}

async function fetchRange(url: string, start: number, end: number): Promise<{ buf: Buffer; total: number }> {
  // 整集已在盘上：头尾直接读盘，不再为了 0.9MB 目录去源站排十几秒
  const file = diskFile(url)
  if (file) {
    const fh = await open(file, 'r')
    try {
      const total = (await fh.stat()).size
      const buf = Buffer.alloc(end - start + 1)
      const { bytesRead } = await fh.read(buf, 0, buf.length, start)
      if (bytesRead !== buf.length) throw new Error(`盘上区间截断 ${bytesRead}/${buf.length}`)
      return { buf, total }
    } finally { await fh.close() }
  }
  const res = await request(url, { dispatcher: agent, method: 'GET', maxRedirections: 5, headers: { ...UPSTREAM_HEADERS, Range: `bytes=${start}-${end}` } })
  if (res.statusCode !== 206) {
    await res.body.dump()
    throw new Error(`上游状态 ${res.statusCode}（bytes=${start}-${end}）`)
  }
  const cr = String(res.headers['content-range'] ?? '')
  const total = Number(cr.match(/\/(\d+)$/)?.[1])
  if (!Number.isSafeInteger(total)) throw new Error('上游 Content-Range 缺总长：' + cr)
  const buf = Buffer.from(await res.body.arrayBuffer())
  if (buf.length !== end - start + 1) throw new Error(`上游区间截断 ${buf.length}/${end - start + 1}`)
  return { buf, total }
}

interface Box { type: string; start: number; body: number; end: number }

function readBox(buf: Buffer, at: number, base = 0): Box | null {
  if (at + 8 > buf.length) return null
  let size = buf.readUInt32BE(at)
  const type = buf.toString('latin1', at + 4, at + 8)
  let header = 8
  if (size === 1) {
    if (at + 16 > buf.length) return null
    size = Number(buf.readBigUInt64BE(at + 8))
    header = 16
  } else if (size === 0) {
    return null
  }
  if (size < header) return null
  return { type, start: base + at, body: base + at + header, end: base + at + size }
}

function childBoxes(buf: Buffer, from: number, to: number): Box[] {
  const out: Box[] = []
  for (let at = from; at < to;) {
    const b = readBox(buf, at)
    if (!b || b.end > to) throw new Error(`盒子越界 @${at}`)
    out.push(b)
    at = b.end
  }
  return out
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta'])

// 返回改过偏移的块数；stco 加完溢出 32 位就放弃（那得改成 co64、尾块长度变，不值得）。
function shiftChunkOffsets(buf: Buffer, from: number, to: number, delta: number): number {
  let patched = 0
  for (const b of childBoxes(buf, from, to)) {
    if (CONTAINERS.has(b.type)) {
      patched += shiftChunkOffsets(buf, b.body, b.end, delta)
    } else if (b.type === 'stco' || b.type === 'co64') {
      const n = buf.readUInt32BE(b.body + 4)
      const wide = b.type === 'co64'
      for (let i = 0; i < n; i++) {
        const at = b.body + 8 + i * (wide ? 8 : 4)
        if (wide) {
          buf.writeBigUInt64BE(buf.readBigUInt64BE(at) + BigInt(delta), at)
        } else {
          const v = buf.readUInt32BE(at) + delta
          if (v > 0xffffffff) throw new Error('stco 偏移加上尾块后溢出 32 位')
          buf.writeUInt32BE(v, at)
        }
      }
      patched += n
    }
  }
  return patched
}

async function buildLayout(url: string): Promise<Layout | null> {
  const { buf: head, total } = await fetchRange(url, 0, HEAD_BYTES - 1)
  let at = 0
  let mdat: Box | null = null
  for (;;) {
    const b = readBox(head, at)
    if (!b) return null
    if (b.type === 'moov') return null // 本来就是 faststart
    if (b.type === 'mdat') { mdat = b; break }
    at = b.end
  }
  if (mdat.end >= total) return null
  const tailLen = total - mdat.end
  if (tailLen > MAX_TAIL_BYTES) throw new Error(`尾块 ${tailLen}B 超过上限`)
  // 尾块分几段并发拉：源站单连接只有几十 KB/s（2026-10-06 实测约 57KB/s），0.9MB 单连接要十几秒，
  // 这段时间 /stream 一个字节都答不出，播放按钮迟迟不出现。
  const TAIL_PARTS = 6
  const step = Math.ceil(tailLen / TAIL_PARTS)
  const parts = await Promise.all(Array.from({ length: Math.ceil(tailLen / step) }, (_, i) =>
    fetchRange(url, mdat.end + i * step, Math.min(total - 1, mdat.end + (i + 1) * step - 1))))
  const tail = Buffer.concat(parts.map((p) => p.buf))
  const moov = childBoxes(tail, 0, tail.length).find((b) => b.type === 'moov')
  if (!moov) return null
  const patched = shiftChunkOffsets(tail, moov.body, moov.end, tailLen)
  log(`moov 在尾部：mdat ${mdat.start}-${mdat.end}，尾块 ${(tailLen / 1048576).toFixed(1)}MB 前移，改了 ${patched} 个块偏移`)
  return { total, prefixEnd: mdat.start, mdatEnd: mdat.end, head: head.subarray(0, mdat.start), tail }
}

// null = 不需要改（已是 faststart / 不是能识别的 mp4）或刚失败过（60 秒内不再打上游，直接按原文件透传）。
export function layoutOf(url: string): Promise<Layout | null> {
  // 按媒体身份缓存：签名换了还是同一个文件，不重新拉尾块
  const key = mediaKey(url)
  if (layouts.has(key)) return Promise.resolve(layouts.get(key)!)
  const failed = failedAt.get(key)
  if (failed && Date.now() - failed < FAILURE_TTL_MS) return Promise.resolve(null)
  const running = inflight.get(key)
  if (running) return running
  const job = buildLayout(url).then((layout) => {
    if (layouts.size >= LAYOUT_CACHE_MAX) layouts.delete(layouts.keys().next().value as string)
    layouts.set(key, layout)
    return layout
  }, (error: unknown) => {
    console.error('[player:faststart] 解析 mp4 结构失败，按原文件透传：', error)
    failedAt.set(key, Date.now())
    return null
  }).finally(() => { inflight.delete(key) })
  inflight.set(key, job)
  return job
}

function parseRange(header: string | undefined, total: number): { start: number; end: number; ranged: boolean } | null {
  if (!header) return { start: 0, end: total - 1, ranged: false }
  const m = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!m || (m[1] === '' && m[2] === '')) return { start: 0, end: total - 1, ranged: false }
  if (m[1] === '') return { start: Math.max(0, total - Number(m[2])), end: total - 1, ranged: true }
  const start = Number(m[1])
  const end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1)
  return start > end || start >= total ? null : { start, end, ranged: true }
}

function bytesStream(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(ctl) { ctl.enqueue(new Uint8Array(buf)); ctl.close() } })
}

// 虚拟文件：[0,P) 原头部 · [P,P+T) 尾块 · [P+T,total) = 原文件 [P, mdatEnd)。
// origin(range) 是底层取原文件区间的方式（盘上缓存或会话），这里只做偏移换算和拼接。
export async function serveFaststart(
  layout: Layout,
  rangeHeader: string | undefined,
  origin: (range: string) => Promise<StreamResult>,
): Promise<StreamResult> {
  const { total, prefixEnd: P, tail } = layout
  const T = tail.length
  const r = parseRange(rangeHeader, total)
  if (!r) return { status: 416, headers: { 'Content-Range': `bytes */${total}` }, body: null }
  const { start, end, ranged } = r
  const headers: Record<string, string> = {
    'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    'Content-Length': String(end - start + 1),
  }
  if (ranged) headers['Content-Range'] = `bytes ${start}-${end}/${total}`
  const status = ranged ? 206 : 200

  const memEnd = P + T
  const memory = start < memEnd
    ? Buffer.concat([layout.head, tail]).subarray(start, Math.min(end + 1, memEnd))
    : null
  if (end < memEnd) return { status, headers, body: bytesStream(memory!) }

  const srcStart = Math.max(start, memEnd) - T
  const srcEnd = end - T
  const res = await origin(`bytes=${srcStart}-${srcEnd}`)
  // stream.ts 的透传分支把 undici 的 Node Readable 硬转成 ReadableStream 类型交出来，实际没有 getReader。
  // 2026-10-03 真机拖进度时这里抛错、那条上游响应没人消费，源站断开连接时它的 error 事件无人监听，整个进程崩掉重启。
  // 统一转成 Web 流（toWeb 会接住 error），失败分支也必须把它关掉。
  const raw = res.body as unknown
  const originBody = raw instanceof Readable ? Readable.toWeb(raw) as ReadableStream<Uint8Array> : res.body
  if (res.status !== 206 || !originBody) {
    await originBody?.cancel().catch(() => {})
    throw new Error(`底层区间 ${srcStart}-${srcEnd} 状态 ${res.status}`)
  }
  // 会话路径（serveStream）不认 Range 的终点、总是吐到原文件末尾，原文件末尾正是已经挪走的尾块，必须按长度截住。
  const reader = originBody.getReader()
  let sentMemory = !memory
  let left = srcEnd - srcStart + 1
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (!sentMemory) { sentMemory = true; ctl.enqueue(new Uint8Array(memory!)); return }
      if (left <= 0) { ctl.close(); void reader.cancel(); return }
      const { done, value } = await reader.read()
      if (done) { ctl.close(); return }
      const piece = value.length > left ? value.subarray(0, left) : value
      left -= piece.length
      ctl.enqueue(piece)
    },
    cancel(reason) { return reader.cancel(reason) },
  })
  return { status, headers, body }
}
