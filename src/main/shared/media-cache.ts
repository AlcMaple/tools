// 在线播放的 mp4 本地预抓缓存 —— 只服务 media-proxy 的 mp4 直链分支。
//
// 为什么要它(011「稀饭直链 mp4 播放卡顿」的结论,别再重新分析):
//   1. <video> 对 mtmedia:// 是**单连接**发 Range,而代理为了拿新鲜签名链**每个 Range
//      都重走一次 302** —— 每次 seek/续读都白付一份解析延迟。
//   2. 旧版只开一条持续顺序流;实机在冷 seek 后仍会几秒一停,暂停一会儿等它攒够缓冲才顺。
//      真实样本平均消耗约 422KB/s,单流慢段只有 226~484KB/s,没有抵抗抖动的余量。
//   3. 现在从播放位置起按 2MiB 小块开 6 条相邻 Range,每条都从原始 target 重新拿一条
//      签名链;快连接先把后续块落盘,慢连接不再决定整条下载速度。只有从 regionStart 起
//      **连续完成**的小块才对播放器可见(开场首块除外,它边写边播以免拉长首帧),
//      所以并发不会把文件空洞误报成已缓存。
//
// 形态:后台滑动窗口从 `regionStart` 并发写本地临时文件,`written` 只记已落盘的连续前缀。
// <video> 的 Range 落在 [regionStart, regionStart+written] 内就读本地文件,并**跟随写入
// 端继续吐**(读到写入位置就等 progress 事件),所以一个请求就能喂完整集,不会退化成
// 无数个小 Range。落在区间外(往后 seek)就以新起点重开一条流。
//
// 生命周期:同一时刻只留一个 session(换集/换源 = target 变了 → 旧的中止 + 删文件);
// 没人读超过 IDLE_MS 也自动收摊,避免关掉播放器后还在后台默默下满几百 MB。
import { app, session as electronSession, type Session as ElectronSession } from 'electron'
import { EventEmitter } from 'events'
import { promises as fsp, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/** 没有任何读取超过这个时间就把后台流收掉(关播放器 / 切走页面)。 */
const IDLE_MS = 60_000
/** 单个 session 的落盘上限,正片单集远小于此;纯粹是跑飞时的保险丝。 */
const MAX_BYTES = 4 * 1024 * 1024 * 1024
/** 小块而不是整份静态等分:冷 seek 并发抓相邻块,连续缓冲达标后一次恢复播放。 */
const CHUNK_BYTES = 2 * 1024 * 1024
/** 冷 seek 先攒 3 个连续块再吐首字节,把反复小卡顿收敛成一次可预期的缓冲。 */
const COLD_START_BYTES = 3 * CHUNK_BYTES
/** pan.wo 同一签名链不能并发,这里每个 worker 都从原始 target 获取自己的签名链。 */
const FETCH_CONCURRENCY = 6
/** 某个早期慢块卡住时最多在它后面预抓 12 块,避免一路跑到文件尾形成大空洞。 */
const PREFETCH_WINDOW_CHUNKS = 12
/** 最多比已经交给 Chromium 的位置领先 32MiB,避免打开一集就立刻打满整份文件。 */
const PREFETCH_LEAD_BYTES = 32 * 1024 * 1024
/** 读取端追上写入端时,等 progress 事件的上限;超时就再看一眼状态,防止事件丢了死等。 */
const WAIT_TICK_MS = 5_000

interface Session {
  key: string
  file: string
  /** 本次顺序流的起点(往后 seek 会以新起点重开一个 session)。 */
  regionStart: number
  /** 从 regionStart 起已连续落盘的字节数。 */
  written: number
  /** 从 regionStart 起已经交给 Chromium 的最远位置,用于约束预抓领先量。 */
  readThrough: number
  /** 资源总长度,0 = 未知(上游没给 content-range/content-length)。 */
  total: number
  done: boolean
  failed: boolean
  ac: AbortController
  ev: EventEmitter
  lastReadAt: number
  idleTimer: NodeJS.Timeout | null
  /** 还挂着几个读取流(<video> 暂停时它的那条并不会关)。>0 时 idle 看门狗不动手。 */
  readers: number
}

let current: Session | null = null
let rangeSessions: ElectronSession[] | null = null

function getRangeSession(slot: number): ElectronSession {
  // Chromium 会把同一 Session 的请求复用到一个 HTTP/2 连接上;pan.wo 在这个形态下
  // 6 个 Range 的总吞吐仍接近单流。每个固定 worker 使用独立的内存 Session,才能得到
  // 真正独立的连接;Session 只建 6 个并在应用生命周期内复用,不会随分块无限增长。
  if (!rangeSessions) {
    rangeSessions = Array.from(
      { length: FETCH_CONCURRENCY },
      (_, index) => electronSession.fromPartition(`mapletools-media-cache-${index}`, { cache: false }),
    )
  }
  return rangeSessions[slot]
}

function cacheDir(): string {
  // app.getPath('temp') 在 ready 前不可用,兜底到 os.tmpdir()
  try {
    return join(app.getPath('temp'), 'mapletools-media')
  } catch {
    return join(tmpdir(), 'mapletools-media')
  }
}

function disposeSession(s: Session): void {
  s.ac.abort()
  if (s.idleTimer) clearTimeout(s.idleTimer)
  s.idleTimer = null
  s.ev.emit('progress') // 唤醒可能正卡在等待里的读取端
  // **同步**删:这个函数也在 app 'before-quit' 里跑,异步 unlink 的回调等不到
  // (dev 下紧接着就是 process.exit(0))。Windows 上写句柄可能还没关 → 删不掉,
  // 交给下次启动的 sweepMediaCacheDir 兜底。
  try {
    rmSync(s.file, { force: true })
  } catch {
    /* 占用/已不在 —— 启动扫描会收拾 */
  }
}

/** 换集/换源/退出播放页/退出应用时调用:中止后台流并删临时文件。 */
export function disposeMediaCache(): void {
  if (!current) return
  const s = current
  current = null
  disposeSession(s)
}

/**
 * 启动时清掉上次遗留的临时文件 —— 应用被强杀 / 崩溃 / Windows 上文件还被占着删不掉时,
 * `before-quit` 那道来不及收拾,几百 MB 就一直躺在 temp 里。只删自己目录下的 `play-*.part`。
 */
export async function sweepMediaCacheDir(): Promise<void> {
  try {
    const dir = cacheDir()
    const names = await fsp.readdir(dir)
    await Promise.all(
      names
        .filter((n) => n.startsWith('play-') && n.endsWith('.part'))
        .map((n) => fsp.rm(join(dir, n), { force: true }).catch(() => { /* 忽略单个失败 */ })),
    )
  } catch {
    /* 目录还不存在 = 没有遗留,正常 */
  }
}

function armIdleTimer(s: Session): void {
  if (s.idleTimer) clearTimeout(s.idleTimer)
  s.idleTimer = setTimeout(() => {
    // 还有读取流挂着就不动手 —— 那多半是<video> 暂停(它的响应流一直开着)。
    // 强行收摊会把它的流 error 掉,用户恢复播放时直接变成播放失败。
    if (s.readers > 0 || Date.now() - s.lastReadAt < IDLE_MS) { armIdleTimer(s); return }
    if (current === s) current = null
    disposeSession(s)
  }, IDLE_MS)
}

interface RangeResponse {
  response: Response
  start: number
  end: number
  total: number
  ranged: boolean
}

type CacheFile = Awaited<ReturnType<typeof fsp.open>>

async function openRange(
  s: Session,
  target: string,
  headers: Record<string, string>,
  start: number,
  end: number,
  networkSlot: number,
): Promise<RangeResponse> {
  const response = await getRangeSession(networkSlot).fetch(target, {
    headers: { ...headers, Range: `bytes=${start}-${end}` },
    redirect: 'follow',
    signal: s.ac.signal,
  })
  if (response.status === 200) {
    const total = Number(response.headers.get('content-length') ?? 0)
    if (start !== 0 || !Number.isSafeInteger(total) || total <= 0 || total > MAX_BYTES) {
      throw new Error('mp4 range unsupported')
    }
    return { response, start: 0, end: total - 1, total, ranged: false }
  }
  if (response.status !== 206) throw new Error(`mp4 range status ${response.status}`)

  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') ?? '')
  if (!match) throw new Error('mp4 content-range missing')
  const actualStart = Number(match[1])
  const actualEnd = Number(match[2])
  const total = Number(match[3])
  const expectedEnd = Math.min(end, total - 1)
  if (
    !Number.isSafeInteger(total) || total <= start || total - start > MAX_BYTES ||
    actualStart !== start || actualEnd !== expectedEnd
  ) {
    throw new Error('mp4 content-range mismatch')
  }
  return { response, start: actualStart, end: actualEnd, total, ranged: true }
}

async function writeAll(file: CacheFile, value: Uint8Array, position: number): Promise<void> {
  let offset = 0
  while (offset < value.byteLength) {
    const { bytesWritten } = await file.write(value, offset, value.byteLength - offset, position + offset)
    if (bytesWritten <= 0) throw new Error('media cache write stalled')
    offset += bytesWritten
  }
}

async function writeRangeToFile(
  s: Session,
  file: CacheFile,
  chunk: RangeResponse,
  onProgress?: (received: number) => void,
): Promise<number> {
  const reader = chunk.response.body?.getReader()
  if (!reader) throw new Error('mp4 range body missing')
  const expected = chunk.end - chunk.start + 1
  const fileOffset = chunk.start - s.regionStart
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (received + value.byteLength > expected) throw new Error('mp4 range overflow')
      await writeAll(file, value, fileOffset + received)
      received += value.byteLength
      onProgress?.(received)
    }
  } catch (error) {
    await reader.cancel().catch(() => { /* 上游已经断开 */ })
    throw error
  }
  if (received !== expected) throw new Error('mp4 range truncated')
  return received
}

/** 不支持 Range 的普通 mp4 仍沿用单流;每次真实写入后才推进可读位置。 */
async function writeSequentialResponse(s: Session, chunk: RangeResponse): Promise<void> {
  const reader = chunk.response.body?.getReader()
  if (!reader) throw new Error('mp4 body missing')
  const file = await fsp.open(s.file, 'w')
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (s.written + value.byteLength > chunk.total) throw new Error('mp4 body overflow')
      await writeAll(file, value, s.written)
      s.written += value.byteLength
      s.ev.emit('progress')
    }
  } finally {
    await file.close()
  }
  if (s.written !== chunk.total) throw new Error('mp4 body truncated')
}

function waitForProgress(s: Session, timeoutMs = WAIT_TICK_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    const fire = (): void => {
      clearTimeout(timer)
      s.ev.off('progress', fire)
      resolve()
    }
    const timer = setTimeout(fire, timeoutMs)
    s.ev.once('progress', fire)
  })
}

async function writeParallelRanges(
  s: Session,
  target: string,
  headers: Record<string, string>,
  first: RangeResponse,
): Promise<void> {
  const regionLength = s.total - s.regionStart
  const chunkCount = Math.ceil(regionLength / CHUNK_BYTES)
  const completed = new Map<number, number>()
  let contiguousChunk = 0
  let nextChunk = 1
  let stopped = false
  let failure: unknown = null
  // 文件开场继续边写边播,保留原先的快速首帧;冷 seek 的块只推进连续落盘位置,
  // 读取端另有 6MiB 起播闸门,不让播放器拿到几百 KB 就立刻开始、随后反复追上下载端。
  const exposeFirstProgressively = s.regionStart < CHUNK_BYTES

  const markComplete = (index: number, bytes: number): void => {
    if (index === 0 && exposeFirstProgressively) {
      s.written = bytes
      contiguousChunk = 1
    } else {
      completed.set(index, bytes)
    }
    while (completed.has(contiguousChunk)) {
      s.written += completed.get(contiguousChunk)!
      completed.delete(contiguousChunk)
      contiguousChunk++
    }
    s.ev.emit('progress')
  }

  const claimChunk = async (): Promise<number | null> => {
    for (;;) {
      if (stopped || nextChunk >= chunkCount) return null
      // 只围绕最早缺口保留有界窗口;前面的慢块没完成时,后面的 worker 在窗口边缘等。
      const gapLimit = contiguousChunk + PREFETCH_WINDOW_CHUNKS
      const leadLimit = Math.ceil((s.readThrough + PREFETCH_LEAD_BYTES) / CHUNK_BYTES)
      if (nextChunk < Math.min(gapLimit, leadLimit)) return nextChunk++
      await waitForProgress(s)
    }
  }

  const runWorker = async (workerIndex: number, firstChunk: RangeResponse | null): Promise<void> => {
    const file = await fsp.open(s.file, 'r+')
    try {
      if (firstChunk) {
        const firstBytes = await writeRangeToFile(
          s,
          file,
          firstChunk,
          exposeFirstProgressively
            ? (received) => { s.written = received; s.ev.emit('progress') }
            : undefined,
        )
        markComplete(0, firstBytes)
      }
      for (;;) {
        const index = await claimChunk()
        if (index === null) return
        const start = s.regionStart + index * CHUNK_BYTES
        const end = Math.min(s.total - 1, start + CHUNK_BYTES - 1)
        const chunk = await openRange(s, target, headers, start, end, workerIndex)
        if (!chunk.ranged || chunk.total !== s.total) throw new Error('mp4 range source changed')
        markComplete(index, await writeRangeToFile(s, file, chunk))
      }
    } finally {
      await file.close()
    }
  }

  const guard = async (workerIndex: number, firstChunk: RangeResponse | null): Promise<void> => {
    try {
      await runWorker(workerIndex, firstChunk)
    } catch (error) {
      if (!failure) failure = error
      stopped = true
      s.ac.abort()
      s.ev.emit('progress')
    }
  }

  const created = await fsp.open(s.file, 'w')
  await created.close()
  // Chromium 打开 mp4 时会在几十到几百 ms 内依次请求开头、moov 尾部、再回到开头。
  // 开场就扇出 6 路会让这些马上被取消的探测各白打 6 次 302,反而更容易触发源站保护。
  // 所以仅开场首块先单流边写边播;首块稳定落盘后再展开窗口。冷 seek 直接并发,因为它
  // 已经是播放器最终要消费的位置,而且必须先攒出一段完整缓冲再恢复播放。
  if (exposeFirstProgressively) {
    const file = await fsp.open(s.file, 'r+')
    try {
      const firstBytes = await writeRangeToFile(
        s,
        file,
        first,
        (received) => { s.written = received; s.ev.emit('progress') },
      )
      markComplete(0, firstBytes)
    } finally {
      await file.close()
    }
  }

  const remainingChunks = chunkCount - contiguousChunk
  const workers = Math.min(FETCH_CONCURRENCY, remainingChunks)
  await Promise.all(Array.from(
    { length: workers },
    (_, index) => guard(index, !exposeFirstProgressively && index === 0 ? first : null),
  ))
  if (failure) throw failure
  if (s.written !== regionLength) throw new Error('media cache has a range gap')
}

/**
 * 后台预抓失败不做自动重试;首个响应失败时调用方仍可回落直连,已经开始播放后则让
 * <video> 收到流错误并走现有换线路路径。换集/收摊的 abort 也在这里统一结束。
 */
async function runFetchLoop(s: Session, target: string, headers: Record<string, string>): Promise<void> {
  try {
    const first = await openRange(s, target, headers, s.regionStart, s.regionStart + CHUNK_BYTES - 1, 0)
    s.total = first.total
    s.ev.emit('progress')
    await fsp.mkdir(cacheDir(), { recursive: true })
    if (first.ranged) await writeParallelRanges(s, target, headers, first)
    else await writeSequentialResponse(s, first)
    s.done = true
  } catch {
    s.failed = true
    s.ac.abort()
  } finally {
    s.ev.emit('progress')
  }
}

/**
 * 确保 target 有一个覆盖 `start` 的缓存 session。
 * 返回 null = 这次请求不该走缓存(调用方直连)。
 */
function ensureSession(target: string, start: number, headers: Record<string, string>): Session | null {
  if (current && current.key === target) {
    const s = current
    // 命中已落盘区间(含正好等于写入位置:跟着写入端往下读即可)
    if (!s.failed && start >= s.regionStart && start <= s.regionStart + s.written) return s
    // 往后 seek 出了区间,或旧流已经废了 → 以新起点重开
    disposeMediaCache()
  } else if (current) {
    // 换集/换源:旧 session 立即中止 + 删文件,不留着占带宽和磁盘
    disposeMediaCache()
  }
  const s: Session = {
    key: target,
    file: join(cacheDir(), `play-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.part`),
    regionStart: start,
    written: 0,
    readThrough: 0,
    total: 0,
    done: false,
    failed: false,
    ac: new AbortController(),
    ev: new EventEmitter(),
    lastReadAt: Date.now(),
    idleTimer: null,
    readers: 0,
  }
  s.ev.setMaxListeners(0)
  current = s
  armIdleTimer(s)
  void runFetchLoop(s, target, headers)
  return s
}

export interface CachedResponse {
  stream: ReadableStream<Uint8Array>
  status: number
  headers: Record<string, string>
}

/**
 * 尝试用本地缓存服务一次 mp4 Range 请求。
 *
 * 只接管**开放式 Range**(`bytes=N-`,即 <video> 的正常顺序播放/seek 续读)。带结束位的
 * 小段请求(Chromium 取 moov 索引那种)直接放行走直连 —— 用它去重开顺序流会把预抓
 * 起点带到文件尾部,反而把开场缓冲毁掉。
 */
export async function tryServeFromCache(
  target: string,
  rangeHeader: string | null,
  headers: Record<string, string>,
): Promise<CachedResponse | null> {
  let path: string
  try { path = new URL(target).pathname } catch { return null }
  if (!/\.mp4$/i.test(path)) return null
  // 无 Range 头 = 从 0 开始要整份;`bytes=N-` = 开放式续读。其余形态不接管。
  let start = 0
  if (rangeHeader) {
    const m = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader.trim())
    if (!m || m[2] !== '') return null
    start = Number(m[1])
  }
  if (!Number.isSafeInteger(start) || start < 0) return null

  const s = ensureSession(target, start, headers)
  if (!s) return null

  // 等首个响应头落地(total 出来)或直接失败;失败就让调用方走直连。
  const t0 = Date.now()
  while (s.total === 0 && !s.failed && !s.done && Date.now() - t0 < 10_000) {
    await new Promise<void>((resolve) => {
      const done = (): void => { clearTimeout(timer); resolve() }
      const timer = setTimeout(done, 200)
      s.ev.once('progress', done)
    })
  }
  if (s.failed || s.total === 0) return null

  // s.total = 资源总长度(content-range 尾部的 `/N`)。本次响应从 start 一直给到文件尾,
  // 读取端跟着写入端走,所以一个请求就能喂完整集。
  const regionLen = s.total - s.regionStart // 本条顺序流最终会落盘的字节数
  let pos = start - s.regionStart // 在缓存文件里的读游标
  const initialBufferTarget = s.regionStart >= CHUNK_BYTES && pos === 0
    ? Math.min(regionLen, COLD_START_BYTES)
    : 0

  s.readers++
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    s.readers--
    s.lastReadAt = Date.now() // 从此刻开始算 idle
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      s.lastReadAt = Date.now()
      try {
        for (;;) {
          // 冷 seek 不把刚落下的零碎首块立即交给播放器:先攒出连续 6MiB,避免播几秒
          // 就追上下载端再转圈。开场与已命中缓存中段的读取不走这道闸。
          if (pos === 0 && s.written < initialBufferTarget && !s.done && !s.failed) {
            await waitForProgress(s)
            continue
          }
          const avail = s.written - pos
          if (avail > 0) {
            const fh = await fsp.open(s.file, 'r')
            try {
              const size = Math.min(avail, 512 * 1024)
              const buf = Buffer.allocUnsafe(size)
              const { bytesRead } = await fh.read(buf, 0, size, pos)
              pos += bytesRead
              s.readThrough = Math.max(s.readThrough, pos)
              s.ev.emit('progress')
              ctrl.enqueue(new Uint8Array(buf.subarray(0, bytesRead)))
            } finally {
              await fh.close()
            }
            return
          }
          if (pos >= regionLen) { release(); ctrl.close(); return }
          if (s.done) { release(); ctrl.close(); return }
          if (s.failed) { release(); ctrl.error(new Error('media cache aborted')); return }
          // 读到写入端了:等它继续写。超时兜一下,防止事件丢了死等。
          await waitForProgress(s)
        }
      } catch (e) {
        release()
        ctrl.error(e as Error)
      }
    },
    // 渲染层丢弃这条响应(seek / 切集 / 销毁 <video>)时走这里
    cancel() { release() },
  })

  return {
    stream,
    status: 206,
    headers: {
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${s.total - 1}/${s.total}`,
      'content-length': String(s.total - start),
      'cache-control': 'no-store',
    },
  }
}
