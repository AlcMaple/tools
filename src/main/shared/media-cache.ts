// 在线播放的 mp4 本地预抓缓存 —— 只服务 media-proxy 的 mp4 直链分支。
//
// 为什么要它(011「稀饭直链 mp4 播放卡顿」的结论,别再重新分析):
//   1. <video> 对 mtmedia:// 是**单连接**发 Range,而代理为了拿新鲜签名链**每个 Range
//      都重走一次 302** —— 每次 seek/续读都白付一份解析延迟。
//   2. 稀饭这类源单流约 600KB/s、码率约 244KB/s,带宽其实够用,卡顿来自**突发延迟抖动**,
//      不是硬带宽上限。所以对症的不是并发切块(开场那 1/8 依然只有一条连接,已算过账否掉),
//      而是**一条持续往前跑的顺序流**:整份视频只解析一次签名链,并在播放位置前方攒出
//      一段不断变厚的缓冲把抖动吃掉。
//
// 形态:后台一条流从 `regionStart` 顺序写本地临时文件,`written` 记已落盘的连续字节数。
// <video> 的 Range 落在 [regionStart, regionStart+written] 内就读本地文件,并**跟随写入
// 端继续吐**(读到写入位置就等 progress 事件),所以一个请求就能喂完整集,不会退化成
// 无数个小 Range。落在区间外(往后 seek)就以新起点重开一条流。
//
// 生命周期:同一时刻只留一个 session(换集/换源 = target 变了 → 旧的中止 + 删文件);
// 没人读超过 IDLE_MS 也自动收摊,避免关掉播放器后还在后台默默下满几百 MB。
import { app, net } from 'electron'
import { EventEmitter } from 'events'
import { createWriteStream, promises as fsp, rmSync, type WriteStream } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/** 没有任何读取超过这个时间就把后台流收掉(关播放器 / 切走页面)。 */
const IDLE_MS = 60_000
/** 单个 session 的落盘上限,正片单集远小于此;纯粹是跑飞时的保险丝。 */
const MAX_BYTES = 4 * 1024 * 1024 * 1024
/** 读取端追上写入端时,等 progress 事件的上限;超时就再看一眼状态,防止事件丢了死等。 */
const WAIT_TICK_MS = 5_000

interface Session {
  key: string
  file: string
  /** 本次顺序流的起点(往后 seek 会以新起点重开一个 session)。 */
  regionStart: number
  /** 从 regionStart 起已连续落盘的字节数。 */
  written: number
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

/**
 * 后台顺序流:一次解析(302 跟随)拿到直链,从 regionStart 一路写到文件尾。
 * 失败只标记 failed,不重试也不报错给上层 —— 缓存是**加速层**,挂了就退回直连,
 * 绝不能因为它让播放彻底播不了(与「失败向上抛、不做应用层重试」的红线一致:
 * 这里没有隐藏任何用户可见的失败,真正的播放失败仍由直连路径抛出)。
 */
async function runFetchLoop(s: Session, target: string, headers: Record<string, string>): Promise<void> {
  let out: WriteStream | null = null
  try {
    const res = await net.fetch(target, {
      headers: { ...headers, Range: `bytes=${s.regionStart}-` },
      redirect: 'follow',
      signal: s.ac.signal,
    })
    if (res.status !== 206 && res.status !== 200) { s.failed = true; s.ev.emit('progress'); return }
    // 206 的 content-range 形如 `bytes 1000-999999/1000000`;200 说明上游不支持 Range,
    // 那它是从 0 开始给的整份 —— 只有 regionStart 本来就是 0 时才对得上。
    const cr = res.headers.get('content-range')
    if (res.status === 200) {
      if (s.regionStart !== 0) { s.failed = true; s.ev.emit('progress'); return }
      s.total = Number(res.headers.get('content-length') ?? 0)
    } else {
      const m = /\/(\d+)\s*$/.exec(cr ?? '')
      s.total = m ? Number(m[1]) : 0
    }

    await fsp.mkdir(cacheDir(), { recursive: true })
    out = createWriteStream(s.file)
    const reader = res.body?.getReader()
    if (!reader) { s.failed = true; s.ev.emit('progress'); return }

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (s.written + value.byteLength > MAX_BYTES) { s.failed = true; break }
      // written 只在**写回调**里推进 —— 回调触发时数据才真的落到 fd 上。用 write()
      // 返回后立刻加,会让读取端去读一段还堵在 WriteStream 内部缓冲里的区间,读到 0 字节
      // (甚至文件都还没建出来 → ENOENT)。
      const len = value.byteLength
      const flushed = out.write(value, () => {
        s.written += len
        s.ev.emit('progress')
      })
      // 背压:写不进就等 drain,别把整份视频堆在内存里
      if (!flushed) {
        await new Promise<void>((resolve) => out!.once('drain', resolve))
      }
    }
  } catch {
    // abort(换集/收摊)也走这里,不区分 —— 都是「别再往下读了」
    s.failed = true
  } finally {
    if (out) {
      // 等 finish:此时所有写回调都跑完了,written 才是真正落盘的字节数。
      // done 必须在这之后置位,否则读取端会在最后几 KB 还没落盘时就收到「下完了」。
      const w = out
      await new Promise<void>((resolve) => { w.end(() => resolve()) })
    }
    if (!s.failed) s.done = true
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
    if (start >= s.regionStart && start <= s.regionStart + s.written) return s
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
          const avail = s.written - pos
          if (avail > 0) {
            const fh = await fsp.open(s.file, 'r')
            try {
              const size = Math.min(avail, 512 * 1024)
              const buf = Buffer.allocUnsafe(size)
              const { bytesRead } = await fh.read(buf, 0, size, pos)
              pos += bytesRead
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
          await new Promise<void>((resolve) => {
            const fire = (): void => { clearTimeout(timer); resolve() }
            const timer = setTimeout(fire, WAIT_TICK_MS)
            s.ev.once('progress', fire)
          })
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
