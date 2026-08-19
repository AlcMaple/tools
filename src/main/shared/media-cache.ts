// 在线播放 mp4 的本地预抓缓存(只服务 media-proxy 的 mp4 分支)。
//
// 为什么要:<video> 对 mtmedia:// 是单连接发 Range,单流吞吐追不上播放消耗就会「播几秒、停几秒」。
//
// 形态:从播放位置起开 FETCH_CONCURRENCY 条相邻 Range 并发写同一个临时文件。核心不变量是
// `written` 只记从 `regionStart` 起**连续**落盘的前缀 —— 并发因此不会把空洞误报成已缓存。
// 读取端跟着写入端吐,一个请求喂完整集;Range 落在区间外(往后 seek)才以新起点重开一条流。
//
// 三个别改回去的点:
//   - 每个 worker 用**独立的 Electron Session**:共用 Session 时 Chromium 会把多个 Range
//     复用到同一条 HTTP/2 连接上互相卡住,写了 6 个 Promise 也拿不到 6 条有效下载。
//   - 只有开场首块要走 302,后续 worker 直接打首块响应的 `Response.url`(已解析的最终
//     地址)——链接本身允许并发,不用每块重解一次签名链。
//   - 块调大之前必须先有前沿优先级(见 FRONTIER_URGENT_BYTES),否则带宽会被远端大块抢走。
//
// 生命周期:同一时刻只留一个 session(换集/换源 = target 变了 → 旧的中止 + 删文件);
// 离开播放页(media:release)、退出应用各有一道确定性回收,idle 看门狗只是兜底(见 IDLE_MS)。
import { app, net, session as electronSession, type Session as ElectronSession } from 'electron'
import { EventEmitter } from 'events'
import { promises as fsp, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { sleep } from './http-client'

/**
 * 看门狗只是兜底 —— 回收靠三条确定性路径(换集/换源、media:release、before-quit + 启动 sweep)。
 *
 * 分两档的原因:Chromium 在「暂停 + 缓冲已喂饱」时会主动取消响应流,readers 因此归 0。
 * 用一个 60 秒会把**正在暂停**的 session 连临时文件一起收掉,恢复播放被迫冷 seek 重来。
 * 所以喂过播放器的按暂停对待(PAUSED_IDLE_MS),没喂过的才是孤儿。
 */
const IDLE_MS = 60_000
/** 已经服务过播放器的 session(暂停场景)的收摊宽限,理由见 IDLE_MS。 */
const PAUSED_IDLE_MS = 30 * 60_000
/** 单个 session 的落盘上限,正片单集远小于此;纯粹是跑飞时的保险丝。 */
const MAX_BYTES = 4 * 1024 * 1024 * 1024
/**
 * 块越大整集请求数越少,但读取端只能吃连续前缀 —— 掉队一块前沿就停住,所以块大小按
 * 缓冲垫厚度升档,4MB 封顶(最坏单块 18s,仍小于缓冲垫)。取舍推导见 DEVLOG 2026-08-18。
 *
 * 距离必须量「离 readThrough(已交给播放器的位置)多远」而不是「离连续前沿多远」:后者只反映
 * 在途块跨度(恒为几 MB),档位永远升不上去。附带好处是 seek 后自动回到小块,不用降档状态机。
 */
const CHUNK_BYTES = 512 * 1024
const CHUNK_MID_BYTES = 2 * 1024 * 1024
const CHUNK_FAR_BYTES = 4 * 1024 * 1024
/** 缓冲垫薄于 8MiB 算「近」,24MiB 内算「中」,再厚算「远」。 */
const CHUNK_NEAR_LEAD_BYTES = 8 * 1024 * 1024
const CHUNK_MID_LEAD_BYTES = 24 * 1024 * 1024

function chunkSizeAt(bufferAhead: number): number {
  if (bufferAhead < CHUNK_NEAR_LEAD_BYTES) return CHUNK_BYTES
  if (bufferAhead < CHUNK_MID_LEAD_BYTES) return CHUNK_MID_BYTES
  return CHUNK_FAR_BYTES
}

/**
 * 前沿优先级:缓冲垫薄于此就算告急,所有 worker 收回前沿窄带、只取小块。
 *
 * 没有这道闸,分档在源站限流时**必卡**(不是概率问题):worker 平权领块,会散布在 32MiB 跨度上
 * 啃大块,前沿只分到 1/6 带宽 —— 播放器饿死,带宽却在下几分钟后才用得上的数据。
 */
const FRONTIER_URGENT_BYTES = 12 * 1024 * 1024
/** 告急时只允许在前沿之后这么窄的一带里分配(6 个 worker × 512KB 还富余)。 */
const FRONTIER_BAND_BYTES = 4 * 1024 * 1024
/** 冷 seek 先攒够这么多连续字节(约 4.7 秒播放量)再吐首字节;之后 worker 不停手
 *  继续把窗口填到 PREFETCH_LEAD_BYTES,靠聚合吞吐甩开播放进度。 */
const COLD_START_BYTES = 4 * CHUNK_BYTES
/**
 * 距文件末尾这么近的开放式 Range 视为「Chromium 在取尾部 moov 索引」,直连放行、不建流
 * (判据与代价见 tryServeFromCache 里的说明)。4MiB 够覆盖正片单集的索引体积,同时只让
 * 「真的拖到最后约 1 分钟」这一种情况退化成直连。
 */
const TAIL_DIRECT_BYTES = 4 * 1024 * 1024
/** 并发 worker 数,每个用独立 Electron Session(理由见文件头)。 */
const FETCH_CONCURRENCY = 6
/** 某个早期慢块卡住时最多在它后面预抓 24MiB,避免一路跑到文件尾形成大空洞。 */
const PREFETCH_WINDOW_BYTES = 24 * 1024 * 1024
/** 最多比已经交给 Chromium 的位置领先 32MiB,避免打开一集就立刻打满整份文件。 */
const PREFETCH_LEAD_BYTES = 32 * 1024 * 1024
/** 读取端追上写入端时,等 progress 事件的上限;超时就再看一眼状态,防止事件丢了死等。 */
const WAIT_TICK_MS = 5_000
/**
 * worker 之间错峰起跑:`index * BASE + 0~JITTER 随机`。同一 tick 打出 6 个连接在源站眼里
 * 是强特征,完全等长的间隔又是另一种脚本指纹。只推迟发起时间,不改变总并发和吞吐。
 */
const WORKER_STAGGER_BASE_MS = 40
const WORKER_STAGGER_JITTER_MS = 40
/** 单块最慢样本也就 2~3 秒,超过这个时长值得记一笔。只打日志,不干预(判据见 CHUNK_SILENCE_MS)。 */
const CHUNK_STALL_WARN_MS = 8_000
/**
 * 单块多久没收到**新字节**就判定连接已死。红线是「**慢不动它,死才换连接**」:判据必须是
 * 字节静默而非单块总耗时 —— 打断一条还在慢慢吐数据的连接,已下字节全白费、请求数反涨。
 */
const CHUNK_SILENCE_MS = 15_000
/** 一块最多重发几次(带断点续传,不重下已收部分);用尽则整条 session 失败,回落到换线路。 */
const CHUNK_RETRY_LIMIT = 2
/**
 * 闲置这么久的 slot,下次发请求前先清掉**它自己**的连接池:闲置期间源站会单方面掐掉连接
 * (实测 net_error -100),复用到死 socket 会一直挂到 CHUNK_SILENCE_MS 才被发现。
 *
 * 清池不产生任何 HTTP 请求,只是让本来就要发的请求走新连接。只清即将发请求的那个 slot ——
 * 它此刻按定义空闲,碰不到其余在途下载。判据用闲置时长而非「用户是否暂停」:worker 停在
 * leadLimit 上时用户在正常观看,没有暂停事件可捕获。
 */
const STALE_CONN_IDLE_MS = 30_000
/**
 * 拖动进度条时 Chromium 会对每个中间位置各发一条 Range,条条重开 session 的话,每个中间
 * 位置都要白打一次 302 + 展开并发。所以**只有需要重开流的冷 seek 才防抖**:命中已缓存
 * 区间的读取仍是 0ms;防抖期间来了更新的请求就把自己作废,只让手停下来的位置真正开流。
 * 代价:点击式跳转且没命中缓存时多等这 180ms。
 */
const SEEK_DEBOUNCE_MS = 180
/**
 * 被取代的中间请求**不能直接报错打发掉** —— 实测它们并没有被 Chromium 取消,而是一直等
 * 在那里、最后被新建的流覆盖到并正常喂了数据。所以这里挂起观察,每 100ms 看一眼当前流
 * 有没有覆盖自己的位置。8 秒只是防泄漏上限(正常路径是毫秒级);到点后按**当时观测到的
 * 状态**收尾:已有别的流在喂播放器 → 回错误;没有 → 自己建流兜底。
 */
const SUPERSEDED_HOLD_MS = 8_000
const SUPERSEDED_POLL_MS = 100

interface Session {
  /** 建流的那条请求的 seekSeq,日志里用 `#n` 把「建流 → 起播」两条串起来。 */
  seq: number
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
  /** 首个 / 分块请求拿到确定 HTTP 失败；代理不得再把同一请求直连重发。 */
  upstreamRejected: boolean
  ac: AbortController
  ev: EventEmitter
  lastReadAt: number
  idleTimer: NodeJS.Timeout | null
  /**
   * 挂着的读取流数量。>0 时 idle 看门狗不动手。
   * 注意**不能**反过来假设「归 0 = 播放器不要了」:Chromium 在暂停且内部缓冲喂饱时会主动
   * 取消这条响应流,恢复播放时再发一条新的 Range —— 那期间 readers 就是 0(见 IDLE_MS)。
   */
  readers: number
  /** 这个 session 建立的时刻,用于算「冷 seek 到恢复播放花了多久」这条日志。 */
  createdAt: number
  /** 冷 seek 起播闸门的耗时日志只打一次,防止同一个 session 里重复读触发重复打印。 */
  bufferGateLogged: boolean
  /** 六个 worker 共用的下一次重连时刻，断网时把重试摊开，不能同一 tick 一起冲。 */
  nextRetryAt: number
}

let current: Session | null = null
let rangeSessions: ElectronSession[] | null = null
/** 每来一次 mp4 Range 请求就 +1;冷 seek 等完防抖后发现它变了 = 自己已被更新的 seek 取代。 */
let seekSeq = 0
/** 距上一次真正建流为止被防抖合并掉的中间请求数,只用于日志(让「一次拖动只建一条流」可数)。 */
let mergedSeeks = 0
/** 同一地址连续建流的次数,只用于日志(见 ensureSession 里的说明)。 */
let lastBuiltKey = ''
let buildsForKey = 0

/** 每个 slot 上次成功收到字节的时刻,用于判断连接池是否已经闲置到可能被源站掐掉。 */
const slotLastDataAt: number[] = []

/** 闲置过久就清掉该 slot 的连接池(理由与代价见 STALE_CONN_IDLE_MS)。 */
async function dropStaleConnections(slot: number): Promise<void> {
  const last = slotLastDataAt[slot] ?? 0
  if (last === 0 || Date.now() - last < STALE_CONN_IDLE_MS) return
  slotLastDataAt[slot] = Date.now() // 先记时,避免清池失败时每块都重清
  try {
    await getRangeSession(slot).closeAllConnections()
  } catch {
    /* 清不掉就让请求自己撞死连接,有 CHUNK_SILENCE_MS 兜底 */
  }
}

function getRangeSession(slot: number): ElectronSession {
  // 独立的内存 Session 才能拿到真正独立的连接(同 Session 会被复用到一条 HTTP/2 上)。
  // 只建 FETCH_CONCURRENCY 个并在应用生命周期内复用,不随分块增长。
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
  // (dev 下紧接着就是 process.exit(0))。
  try {
    rmSync(s.file, { force: true })
    return
  } catch {
    /* 多半是写句柄还没关(Windows 上 abort 到 file.close() 之间有一小段) */
  }
  // 同步删失败**不能**就直接扔给下次启动的 sweep:退出播放页后这个文件会一直躺在
  // temp 里(一集几百 MB),用户本次会话里再也收不掉。写句柄在 abort 后的下一个
  // tick 就会关,所以退到后台重试几次;仍失败(应用正在退出)才由 sweep 兜底。
  void (async () => {
    for (const wait of [200, 800, 3000]) {
      await sleep(wait)
      try {
        await fsp.rm(s.file, { force: true })
        return
      } catch {
        /* 还占着,下一轮再试 */
      }
    }
  })()
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
    // 还有读取流挂着 = 播放器正连着,强行收摊会让它恢复播放时直接失败。
    // readThrough > 0 = 这条流真的喂过播放器 → 按「用户暂停」对待,给长宽限(见 IDLE_MS)。
    const grace = s.readThrough > 0 ? PAUSED_IDLE_MS : IDLE_MS
    if (s.readers > 0 || Date.now() - s.lastReadAt < grace) { armIdleTimer(s); return }
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
  /** 跟完 302 之后的最终地址(Response.url);后续同一 session 的请求直接打这里,不再重新 302。 */
  resolvedUrl: string
}

class RangeHttpError extends Error {
  constructor(readonly status: number) {
    super(`mp4 range status ${status}`)
  }
}

class RangeTransportError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
  }
}

class RangeTruncatedError extends Error {}

type CacheFile = Awaited<ReturnType<typeof fsp.open>>

async function openRange(
  s: Session,
  target: string,
  headers: Record<string, string>,
  start: number,
  end: number,
  networkSlot: number,
  /** 单块自己的 signal(字节静默看门狗用),它已经串接了 session 的 abort。 */
  signal: AbortSignal = s.ac.signal,
): Promise<RangeResponse> {
  let response: Response
  try {
    response = await getRangeSession(networkSlot).fetch(target, {
      headers: { ...headers, Range: `bytes=${start}-${end}` },
      redirect: 'follow',
      signal,
    })
  } catch (error) {
    throw new RangeTransportError(error)
  }
  const resolvedUrl = response.url || target
  if (response.status === 200) {
    const total = Number(response.headers.get('content-length') ?? 0)
    if (start !== 0 || !Number.isSafeInteger(total) || total <= 0 || total > MAX_BYTES) {
      throw new Error('mp4 range unsupported')
    }
    return { response, start: 0, end: total - 1, total, ranged: false, resolvedUrl }
  }
  if (response.status !== 206) throw new RangeHttpError(response.status)

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
  return { response, start: actualStart, end: actualEnd, total, ranged: true, resolvedUrl }
}

async function writeAll(file: CacheFile, value: Uint8Array, position: number): Promise<void> {
  let offset = 0
  while (offset < value.byteLength) {
    const { bytesWritten } = await file.write(value, offset, value.byteLength - offset, position + offset)
    if (bytesWritten <= 0) throw new Error('media cache write stalled')
    offset += bytesWritten
  }
}

/**
 * 把一次 Range 响应写进缓存文件。**收足才算数**:少一字节就抛错,绝不能标记完成 —— 否则文件
 * 留下空洞而 `written` 越过它,播放器读到垃圾数据(花屏),不报错、最难查。
 *
 * 但检测与恢复要分开:已收字节已按正确偏移落盘,抛错时用 `progress.received` 交回调用方续传。
 */
async function writeRangeToFile(
  s: Session,
  file: CacheFile,
  chunk: RangeResponse,
  /** 出参:本次已落盘字节数。抛错时调用方读它续传。 */
  progress: { received: number },
  onProgress?: (received: number) => void,
): Promise<number> {
  const reader = chunk.response.body?.getReader()
  if (!reader) throw new Error('mp4 range body missing')
  const expected = chunk.end - chunk.start + 1
  const fileOffset = chunk.start - s.regionStart
  let received = 0
  try {
    for (;;) {
      let read: ReadableStreamReadResult<Uint8Array>
      try {
        read = await reader.read()
      } catch (error) {
        throw new RangeTransportError(error)
      }
      const { done, value } = read
      if (done) break
      if (!value) continue
      if (received + value.byteLength > expected) throw new Error('mp4 range overflow')
      await writeAll(file, value, fileOffset + received)
      received += value.byteLength
      progress.received = received
      onProgress?.(received)
    }
  } catch (error) {
    await reader.cancel().catch(() => { /* 上游已经断开 */ })
    throw error
  }
  if (received !== expected) throw new RangeTruncatedError('mp4 range truncated')
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

/** 可被 session 中止唤醒的 sleep;中止时直接 resolve,让调用方紧接着的 fetch 自己因 signal 报错。 */
function staggerSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

function isChunkRetryable(error: unknown, attemptSignal: AbortSignal): boolean {
  if (!net.isOnline()) return false
  return attemptSignal.aborted || error instanceof RangeTransportError || error instanceof RangeTruncatedError
}

async function waitForChunkRetry(s: Session, attempt: number): Promise<number> {
  const backoff = 1000 * (2 ** attempt) + Math.floor(Math.random() * 500)
  const retryAt = Math.max(Date.now() + backoff, s.nextRetryAt)
  s.nextRetryAt = retryAt + 500 // 多 worker 至少错开半秒
  const waitMs = Math.max(0, retryAt - Date.now())
  await staggerSleep(waitMs, s.ac.signal)
  return waitMs
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
  fetchUrl: string,
  headers: Record<string, string>,
  first: RangeResponse,
): Promise<void> {
  const regionLength = s.total - s.regionStart
  /**
   * 调度用**字节游标**而不是块序号 —— 块是变长的,而且续传后一次响应只覆盖块的一部分,
   * 按序号记账对不上。三个量都以「相对 regionStart 的字节偏移」为单位:
   *   - contiguousEnd:从 0 起**连续**落盘到哪里(= s.written,读取端只能吃到这里)
   *   - nextOffset:下一块从哪里开始分配
   *   - completed:已完成但前面还有缺口的块,key = 起始偏移,value = 长度
   */
  let contiguousEnd = 0
  let nextOffset = 0
  const completed = new Map<number, number>()
  let stopped = false
  let failure: unknown = null
  // 文件开场继续边写边播,保留原先的快速首帧;冷 seek 的块只推进连续落盘位置,
  // 读取端另有 COLD_START_BYTES 起播闸门,不让播放器拿到几百 KB 就立刻开始、随后反复追上下载端。
  const exposeFirstProgressively = s.regionStart < CHUNK_BYTES

  const markComplete = (relStart: number, bytes: number): void => {
    completed.set(relStart, bytes)
    while (completed.has(contiguousEnd)) {
      const len = completed.get(contiguousEnd)!
      completed.delete(contiguousEnd)
      contiguousEnd += len
    }
    s.written = contiguousEnd
    s.ev.emit('progress')
  }

  const claimChunk = async (): Promise<{ relStart: number; len: number } | null> => {
    for (;;) {
      if (stopped || nextOffset >= regionLength) return null
      // 缓冲垫 = 连续前缀比播放器已消费位置领先多少。它同时决定「能不能跑远」和「块能多大」。
      const bufferAhead = Math.max(0, contiguousEnd - s.readThrough)
      const urgent = bufferAhead < FRONTIER_URGENT_BYTES
      // 两道闸都以字节计:只围绕最早缺口保留有界窗口(前面的慢块没完成时后面的 worker 在窗口边缘等),
      // 同时不比「已交给 Chromium 的位置」领先太多。**前沿告急时把窗口再收窄到一条窄带** ——
      // 让全部带宽都砸在播放器马上要吃的那几块上(理由见 FRONTIER_URGENT_BYTES)。
      const gapLimit = contiguousEnd + (urgent ? FRONTIER_BAND_BYTES : PREFETCH_WINDOW_BYTES)
      const leadLimit = s.readThrough + PREFETCH_LEAD_BYTES
      if (nextOffset < Math.min(gapLimit, leadLimit)) {
        const relStart = nextOffset
        // 告急时一律小块(掉队只赔 2.3s);富余时按缓冲垫厚度升档。
        const want = urgent ? CHUNK_BYTES : chunkSizeAt(relStart - s.readThrough)
        const len = Math.min(want, regionLength - relStart)
        nextOffset = relStart + len
        return { relStart, len }
      }
      await waitForProgress(s)
    }
  }

  /**
   * 取一块,带断点续传:断了从已落盘字节数接着要。每次尝试有自己的 AbortController,
   * 交给字节静默看门狗掌控(判据见 CHUNK_SILENCE_MS)。
   */
  const fetchChunk = async (
    workerIndex: number,
    file: CacheFile,
    relStart: number,
    len: number,
  ): Promise<void> => {
    const absStart = s.regionStart + relStart
    const absEnd = absStart + len - 1
    let received = 0
    for (let attempt = 0; ; attempt++) {
      if (s.ac.signal.aborted) throw new Error('media cache aborted')
      await dropStaleConnections(workerIndex)

      const ctl = new AbortController()
      const onSessionAbort = (): void => ctl.abort()
      s.ac.signal.addEventListener('abort', onSessionAbort, { once: true })
      let lastByteAt = Date.now()
      const progress = { received: 0 }
      const silenceTimer = setInterval(() => {
        if (Date.now() - lastByteAt >= CHUNK_SILENCE_MS) ctl.abort()
      }, 1_000)
      const stallTimer = setTimeout(() => {
        console.warn(
          `[media-cache] worker ${workerIndex} 在偏移 ${absStart + received} 上超过 ` +
          `${Math.round(CHUNK_STALL_WARN_MS / 1000)}s 没取完这一块（块长 ${len}）`,
        )
      }, CHUNK_STALL_WARN_MS)

      try {
        const chunk = await openRange(s, fetchUrl, headers, absStart + received, absEnd, workerIndex, ctl.signal)
        if (!chunk.ranged || chunk.total !== s.total) throw new Error('mp4 range source changed')
        await writeRangeToFile(s, file, chunk, progress, (bytes) => {
          void bytes
          lastByteAt = Date.now()
          slotLastDataAt[workerIndex] = lastByteAt
        })
        received += progress.received
        if (received !== len) throw new RangeTruncatedError('mp4 range truncated')
        return
      } catch (error) {
        received += progress.received // 已落盘的部分留着,下一次尝试从这里续
        if (
          s.ac.signal.aborted ||
          attempt >= CHUNK_RETRY_LIMIT ||
          !isChunkRetryable(error, ctl.signal)
        ) throw error
        const waitMs = await waitForChunkRetry(s, attempt)
        console.warn(
          `[media-cache] worker ${workerIndex} 偏移 ${absStart + received} 断流，` +
          `${Math.round(waitMs)}ms 后第 ${attempt + 1} 次换连接续传（已收 ${received}/${len}）`,
        )
        // 这条连接已经证明不可用,下一次尝试前强制新建(不等 STALE_CONN_IDLE_MS)
        slotLastDataAt[workerIndex] = 0
        await getRangeSession(workerIndex).closeAllConnections().catch(() => { /* 无所谓 */ })
      } finally {
        clearInterval(silenceTimer)
        clearTimeout(stallTimer)
        s.ac.signal.removeEventListener('abort', onSessionAbort)
      }
    }
  }

  const runWorker = async (workerIndex: number, firstChunk: RangeResponse | null): Promise<void> => {
    const file = await fsp.open(s.file, 'r+')
    try {
      if (firstChunk) {
        const progress = { received: 0 }
        const firstBytes = await writeRangeToFile(s, file, firstChunk, progress)
        slotLastDataAt[workerIndex] = Date.now()
        markComplete(0, firstBytes)
      }
      for (;;) {
        const claim = await claimChunk()
        if (claim === null) return
        await fetchChunk(workerIndex, file, claim.relStart, claim.len)
        markComplete(claim.relStart, claim.len)
      }
    } finally {
      await file.close()
    }
  }

  const guard = async (workerIndex: number, firstChunk: RangeResponse | null): Promise<void> => {
    try {
      // firstChunk 非空的 worker(0 号)在进这里之前已经吃到一个现成响应,天然错开;
      // 其余 worker 在第一次真正发起网络请求前按「序号基础间隔 + 随机抖动」错峰,
      // 避免 6 路同一 tick 起跑,也避免延迟本身呈现完全等长的规律。
      if (!firstChunk) {
        const delay = workerIndex * WORKER_STAGGER_BASE_MS + Math.random() * WORKER_STAGGER_JITTER_MS
        await staggerSleep(delay, s.ac.signal)
      }
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
      const progress = { received: 0 }
      const firstBytes = await writeRangeToFile(
        s,
        file,
        first,
        progress,
        (received) => { s.written = received; s.ev.emit('progress') },
      )
      slotLastDataAt[0] = Date.now()
      markComplete(0, firstBytes)
    } finally {
      await file.close()
    }
  }
  // 首块由 0 号 worker 直接吃掉那个现成响应(见下面 guard 的 firstChunk),必须先把它占掉,
  // 否则 claimChunk 会把 [0, 首块长) 再分配给别人 —— 重复下载 + 铺不齐区间。
  nextOffset = exposeFirstProgressively ? contiguousEnd : first.end - first.start + 1

  const workers = Math.min(FETCH_CONCURRENCY, Math.ceil((regionLength - nextOffset) / CHUNK_BYTES))
  await Promise.all(Array.from(
    { length: Math.max(workers, 1) },
    (_, index) => guard(index, !exposeFirstProgressively && index === 0 ? first : null),
  ))
  if (failure) throw failure
  // 变长块调度动的正是「连续前缀」这个核心不变量,写错了不会报错、只会把带空洞的文件喂给
  // 播放器(花屏)。所以收尾必须双向确认:连续前缀刚好铺满整个区间,且没有落单的孤岛块。
  if (contiguousEnd !== regionLength || completed.size > 0) {
    throw new Error(`media cache has a range gap (${contiguousEnd}/${regionLength}, ${completed.size} islands)`)
  }
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
    // 首块的响应已经替我们跟完了 302,后续 5 个 worker 直接打 first.resolvedUrl,
    // 不用每块都再解一次签名链——这份 302 延迟是实测过的、与带宽无关的固定开销。
    if (first.ranged) await writeParallelRanges(s, first.resolvedUrl, headers, first)
    else await writeSequentialResponse(s, first)
    s.done = true
  } catch (error) {
    s.upstreamRejected = error instanceof RangeHttpError || error instanceof RangeTransportError
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
function coversOffset(target: string, start: number): boolean {
  const s = current
  return !!s && s.key === target && !s.failed &&
    start >= s.regionStart && start <= s.regionStart + s.written
}

function ensureSession(
  target: string,
  start: number,
  headers: Record<string, string>,
  seq: number,
): Session | null {
  if (current && current.key === target) {
    const s = current
    // 命中已落盘区间(含正好等于写入位置:跟着写入端往下读即可)
    if (coversOffset(target, start)) {
      // 情况 A:跳到的位置本地已经有,0ms 恢复——和情况 B 的耗时日志对照着看。
      console.log(`[media-cache] #${seq} 命中本地缓存，0ms 直接续播（偏移 ${start}）`)
      return s
    }
    // 往后 seek 出了区间,或旧流已经废了 → 以新起点重开
    disposeMediaCache()
  } else if (current) {
    // 换集/换源:旧 session 立即中止 + 删文件,不留着占带宽和磁盘
    disposeMediaCache()
  }
  const s: Session = {
    seq,
    key: target,
    file: join(cacheDir(), `play-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.part`),
    regionStart: start,
    written: 0,
    readThrough: 0,
    total: 0,
    done: false,
    failed: false,
    upstreamRejected: false,
    ac: new AbortController(),
    ev: new EventEmitter(),
    lastReadAt: Date.now(),
    idleTimer: null,
    readers: 0,
    createdAt: Date.now(),
    bufferGateLogged: false,
    nextRetryAt: 0,
  }
  s.ev.setMaxListeners(0)
  current = s
  armIdleTimer(s)
  // 建流是唯一会真正发起网络请求的入口。一次拖动可能出现多条(手速慢下来、停顿超过
  // 防抖窗口就会被当成「停下了」而开始缓冲,实测一次长拖动 4 条),看的是「合并 N 条」
  // 这个数——N 越大说明挡掉的中间请求越多。
  // 「同一地址第 N 次建流」是判断有没有**重复下载**的唯一凭据:一次正常观看应当只有
  // 第 1 次(开场),之后无论 Chromium 发多少条 Range 都该走「命中本地缓存」。同一地址
  // 的次数持续往上涨 = 有两路在抢同一个 session(例如游离的 <video> 还在取流),不是
  // 拖动进度条造成的 —— 拖动会换偏移,但那时用户是有操作的。
  buildsForKey = target === lastBuiltKey ? buildsForKey + 1 : 1
  lastBuiltKey = target
  console.log(
    `[media-cache] #${seq} 建流：本地没有，为偏移 ${start} 新建冷 seek 缓冲` +
    `（同一地址第 ${buildsForKey} 次建流，防抖合并掉 ${mergedSeeks} 条中间请求）`,
  )
  mergedSeeks = 0
  void runFetchLoop(s, target, headers)
  return s
}

export interface CachedResponse {
  stream: ReadableStream<Uint8Array>
  status: number
  headers: Record<string, string>
}

/**
 * 「这条 Range 请求在防抖窗口里被更新的 seek 取代了」。调用方应当**什么网络请求都不发**,
 * 直接回一个错误响应:拖动进度条时这些中间位置的请求,Chromium 在发下一条之前就已经把
 * 它取消了,回什么都不会被消费;真去直连反而正好制造出我们想避免的那串请求。
 */
export const SUPERSEDED_SEEK = Symbol('media-cache superseded seek')
/** 缓存层已经拿到确定 HTTP 失败，代理不得再直连重发同一个 Range。 */
export const MEDIA_CACHE_UPSTREAM_REJECTED = Symbol('media-cache upstream rejected')

/**
 * 防抖窗口里被更新的 seek 取代之后的挂起观察(判据见 SUPERSEDED_HOLD_MS 的注释)。
 * `discard` = 已确认播放器换用了别的流,回错误;`continue` = 继续往下走(要么赢家的流已经
 * 覆盖了本位置,要么到点自愈自己建流)。
 */
async function holdSuperseded(target: string, start: number, seq: number): Promise<'discard' | 'continue'> {
  mergedSeeks++
  console.log(`[media-cache] #${seq} 拖动中：偏移 ${start} 已被更新的请求取代，挂起观察`)
  const until = Date.now() + SUPERSEDED_HOLD_MS
  for (;;) {
    // 赢家的流正好覆盖了本位置(拖动幅度很小时会这样)→ 当命中缓存服务,不用重开流
    if (coversOffset(target, start)) return 'continue'
    if (Date.now() >= until) break
    await sleep(SUPERSEDED_POLL_MS)
  }
  if (current && current.readers > 0) return 'discard'
  console.warn(
    `[media-cache] #${seq} 挂起 ${SUPERSEDED_HOLD_MS}ms 后仍没有任何流在喂播放器 —— ` +
    `「被取代的请求已被 Chromium 取消」这个前提不成立，改为自己建流兜底`,
  )
  return 'continue'
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
  isStale: () => boolean = () => false,
): Promise<CachedResponse | typeof SUPERSEDED_SEEK | typeof MEDIA_CACHE_UPSTREAM_REJECTED | null> {
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

  // Chromium 播 mp4 的固定动作:开场先要 `bytes=0-`,紧接着要**文件尾部**的 moov 索引
  // (这个 mp4 不是 faststart,时长/关键帧表都在末尾),拿到索引才回到开头正式播。
  // 尾部这条同样是开放式 Range,形态和「拖到片尾」一模一样,旧代码把它当冷 seek:
  //   - 为几百 KB 的索引按冷 seek 规格攒 COLD_START_BYTES 连续缓冲才吐首字节
  //     (实测白等 5982ms + 2069ms,用户看到的就是「进去等半天才播」);
  //   - 还顺手把开场那条流 dispose 掉,回到开头时开场那段得重下一遍。
  // 现在:靠近文件末尾的开放式 Range 一律放行直连,并且**不碰现有 session** —— 索引很小,
  // 直连一次就够;开场的预抓不被打断,Chromium 回到开头时正好命中缓存,全程只建一次流。
  // 代价:真的拖到最后 TAIL_DIRECT_BYTES 以内时退化成直连(能播,只是没有预抓加速)。
  if (
    current && current.key === target && current.total > 0 &&
    start > 0 && current.total - start <= TAIL_DIRECT_BYTES
  ) {
    return null
  }

  // 拖动进度条防抖:每条请求都推进 seekSeq(命中缓存的那条也算,它同样能作废还在等待的
  // 冷 seek);只有要重开流的冷 seek 才真的等这 180ms,等完发现序号变了就交给挂起观察。
  const mySeq = ++seekSeq
  if (!coversOffset(target, start)) {
    await sleep(SEEK_DEBOUNCE_MS)
    if (isStale()) return SUPERSEDED_SEEK
    if (mySeq !== seekSeq && (await holdSuperseded(target, start, mySeq)) === 'discard') {
      return SUPERSEDED_SEEK
    }
  }

  if (isStale()) return SUPERSEDED_SEEK
  const s = ensureSession(target, start, headers, mySeq)
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
  if (s.failed) return s.upstreamRejected ? MEDIA_CACHE_UPSTREAM_REJECTED : null
  if (s.total === 0) return null

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
          // 冷 seek 不把刚落下的零碎首块立即交给播放器:先攒出连续 COLD_START_BYTES,
          // 避免播几秒就追上下载端再转圈。开场与已命中缓存中段的读取不走这道闸。
          if (pos === 0 && s.written < initialBufferTarget && !s.done && !s.failed) {
            await waitForProgress(s)
            continue
          }
          // 情况 B 的耗时日志:闸门刚放行的这一刻(不管是等出来的还是本来就够),
          // 记一次「从建 session 到真正能恢复播放」花了多久,只打一次。
          if (initialBufferTarget > 0 && pos === 0 && !s.bufferGateLogged) {
            s.bufferGateLogged = true
            const elapsedMs = Date.now() - s.createdAt
            console.log(`[media-cache] #${s.seq} 起播：冷 seek 缓冲完成，等待 ${elapsedMs}ms（目标 ~3000ms）`)
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
