// 线路一「预转 HLS」—— 最小可用版。
//
// 为什么要转 HLS（三段带宽账，实测）：
//   入口  源站 → 服务器      12 路并发 5.3Mbps ✓（见 stream.ts）
//   出口  服务器 → 手机      **单连接只有 2.2Mbps**，低于 2.67Mbps 的码率 ✗
//                            但同一条链路 8 连接能到 5.22Mbps
//   <video> 直连服务器只开**一条**连接，所以卡在出口那一段。HLS 把整集切成分片，
//   播放器会并发拉多片，自然用上多连接 —— 这是绕开跨境单连接限速的唯一办法。
//
// 为什么必须**预转**而不是边下边切：
//   1. 边切只有 1.3x 实时余量（remux 60s 内容耗时 45s，受入口速度限制），入口一抖就追不上；
//   2. 边切生成的是 live playlist，用户跳不到还没切出来的位置，连跳 OP 都做不了。
//   预转成完整 VOD playlist 就没这两个问题。番剧每周更一集，有的是时间。
//
// 分片用 fMP4 不用 TS：TS 的 188 字节包头让体积比源涨 12%，fMP4 只涨 8.6%——
// 出口只有 5.22Mbps，这 3 个百分点值得省。（实测 TS 3.00Mbps / fMP4 2.90Mbps）

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, statSync, readdirSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { statfsSync } from 'node:fs'
import { dataDir } from '../data-dir'
import { assertStreamableUrl, INTERNAL_TOKEN, viewerCount } from './stream'

export const hlsDir = join(dataDir, 'hls')
mkdirSync(hlsDir, { recursive: true })

// 一集 HLS 约 452MB（实测和源 mp4 等大，fMP4 几乎无封装开销）。
const EPISODE_BYTES = 452 * 1024 * 1024
// **总配额**：预转产物占用的上限。这是硬闸——超了就先按 LRU 淘汰，淘汰不动就拒绝新任务。
// 25G 可用空间给到 15G 约合 34 集，剩下的留给数据库、日志和构建产物，别把盘吃干净：
// 磁盘写满会把整个服务拖垮，那是这套东西唯一有「炸掉」风险的地方。
const QUOTA_BYTES = Number(process.env.XIFAN_HLS_QUOTA_BYTES ?? 15 * 1024 * 1024 * 1024)
// 除了自身配额，也得给系统留活路：磁盘剩余低于此值一律不再接新任务。
const MIN_FREE_BYTES = 3 * 1024 * 1024 * 1024
// 最近被读过的**绝不淘汰**——正在看的人删掉就是直接播放中断。
const RECENT_GUARD_MS = 30 * 60_000
// 预转前若有人正在观看，先等；等过这个上限还没空就放弃这一轮（下次调度再来）。
const IDLE_WAIT_MAX_MS = 10 * 60_000
const IDLE_POLL_MS = 20_000
// remux 是 IO 密集不是 CPU 密集（实测 CPU 0~1%），但**入口带宽只有一份**：
// 同时转两集 = 两边都慢一半，还会跟正在观看的人抢。所以串行。
const MAX_CONCURRENT = 1
const READY_MARK = 'done'
// 边转边播的缓冲垫：转出这么多分片（6s 一片 ≈ 90 秒内容）就放行开播。
// remux 只有 1.3x 实时余量（入口 3.7Mbps ÷ 2.67Mbps 码率），领先量增长很慢，
// 所以开播前先攒一截，别让播放进度贴着转码前沿跑。
const PLAYABLE_SEGMENTS = 15

export type JobState = 'none' | 'running' | 'ready' | 'failed'

/** 已经转出多少个分片 —— 边转边播靠它判断能不能开播。 */
function segmentCount(key: string): number {
  try {
    return readdirSync(dirFor(key)).filter((f) => f.endsWith('.m4s')).length
  } catch {
    return 0
  }
}

interface Job {
  key: string
  url: string
  state: JobState
  startedAt: number
  bytes: number
  error?: string
  proc?: ChildProcess
}

const jobs = new Map<string, Job>()

export function keyFor(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32)
}

function dirFor(key: string): string {
  return join(hlsDir, key)
}

function dirSize(dir: string): number {
  try {
    return readdirSync(dir).reduce((n, f) => {
      try { return n + statSync(join(dir, f)).size } catch { return n }
    }, 0)
  } catch {
    return 0
  }
}

function freeBytes(): number {
  try {
    const s = statfsSync(hlsDir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** 分片被读到就更新完成标记的 mtime —— LRU 靠它排序（「最后真的被看过」而不是「什么时候转的」）。 */
export function touch(key: string): void {
  const mark = join(dirFor(key), READY_MARK)
  try {
    const now = new Date()
    utimesSync(mark, now, now)
  } catch { /* 标记没了说明这份已被清掉，不用管 */ }
}

function totalBytes(): number {
  return listPrepared().reduce((n, it) => n + it.bytes, 0)
}

/**
 * 腾出 need 字节：按最后访问时间从旧到新淘汰，跳过正在转的和刚被看过的。
 * 返回是否腾够。腾不够的情况是「留着的全都在保护期内」——此时只能拒绝新任务，
 * 绝不能去删正在被人看的那份。
 */
export function reclaim(need: number): boolean {
  const running = new Set([...jobs.values()].filter((j) => j.state === 'running').map((j) => j.key))
  const now = Date.now()
  let free = QUOTA_BYTES - totalBytes()
  if (free >= need) return true
  const victims = listPrepared()
    .filter((it) => !running.has(it.key) && now - it.at > RECENT_GUARD_MS)
    .sort((a, b) => a.at - b.at) // 最久没被看的先走
  for (const v of victims) {
    if (free >= need) break
    if (dropPrepared(v.key)) {
      free += v.bytes
      console.log(`[xifan:prepare] 配额回收 ${v.key}，${(v.bytes / 1048576).toFixed(0)}MB，` +
        `最后访问 ${Math.round((now - v.at) / 60000)} 分钟前`)
    }
  }
  return free >= need
}

export function statusOf(url: string): {
  key: string; state: JobState; bytes: number; playable: boolean; segments: number; error?: string
} {
  const key = keyFor(url)
  // 磁盘上的完成标记优先于内存 —— 重启后内存里的 job 没了，但转好的分片还在。
  if (existsSync(join(dirFor(key), READY_MARK))) {
    return { key, state: 'ready', bytes: dirSize(dirFor(key)), playable: true, segments: segmentCount(key) }
  }
  const job = jobs.get(key)
  if (!job) return { key, state: 'none', bytes: 0, playable: false, segments: 0 }
  const segs = job.state === 'running' ? segmentCount(key) : 0
  // ffmpeg 的 stderr 里常带服务端绝对路径，别原样吐给浏览器。
  const safeError = job.error ? job.error.replace(/\/[^\s'"]+/g, '<path>').slice(0, 200) : undefined
  return {
    key,
    state: job.state,
    bytes: job.state === 'running' ? dirSize(dirFor(key)) : job.bytes,
    // 转到一半也能播：EVENT playlist 会持续追加，播放器边播边等后面的分片。
    playable: job.state === 'running' && segs >= PLAYABLE_SEGMENTS,
    segments: segs,
    error: safeError,
  }
}

export class PrepareRejected extends Error {}

/**
 * 预转让位给观众。
 *
 * 入口带宽只有一份（12 路并发合起来约 5Mbps），预转会把它吃满，而观看只要 2.67Mbps ——
 * 两者同时跑必然互相拖慢，用户看到的就是「莫名其妙开始卡」。所以只要检测到有人在真看，
 * 就给 ffmpeg 发 SIGSTOP 把它冻住，人走了再 SIGCONT 解冻。
 *
 * 为什么用 SIGSTOP 而不是杀掉重来：ffmpeg 一杀，已经转好的那部分全废（分片可以留，
 * 但 playlist 要重头生成），而暂停是零成本的——它的 TCP 连接会闲置，stream.ts 那边
 * 有 CHUNK_SILENCE_MS 看门狗兜底，恢复时自己会重连。
 */
function guardViewers(job: Job): void {
  let paused = false
  const timer = setInterval(() => {
    if (!job.proc || job.state !== 'running') {
      clearInterval(timer)
      return
    }
    const watching = viewerCount() > 0
    try {
      if (watching && !paused) {
        job.proc.kill('SIGSTOP')
        paused = true
        console.log(`[xifan:prepare] ${job.key} 有人在看，暂停预转让出带宽`)
      } else if (!watching && paused) {
        job.proc.kill('SIGCONT')
        paused = false
        console.log(`[xifan:prepare] ${job.key} 观众已散，恢复预转`)
      }
    } catch { /* 进程已退出，下一轮 clearInterval */ }
  }, 5_000)
  timer.unref?.()
}

export function startPrepare(rawUrl: string, streamOrigin: string): { key: string; state: JobState } {
  const url = assertStreamableUrl(rawUrl).toString() // 白名单校验，顺带挡掉 SSRF
  const key = keyFor(url)
  const existing = statusOf(url)
  if (existing.state === 'ready' || existing.state === 'running') return { key, state: existing.state }

  if ([...jobs.values()].filter((j) => j.state === 'running').length >= MAX_CONCURRENT) {
    throw new PrepareRejected('已有一集正在预转，等它完成再来')
  }
  if (freeBytes() < MIN_FREE_BYTES) {
    throw new PrepareRejected('磁盘剩余空间不足，先清理已转好的剧集')
  }
  if (!reclaim(EPISODE_BYTES)) {
    throw new PrepareRejected('预转空间已满，且留着的都是最近在看的，暂时腾不出位置')
  }

  const dir = dirFor(key)
  rmSync(dir, { recursive: true, force: true }) // 失败残留的半成品先清掉
  mkdirSync(dir, { recursive: true })

  // 输入走**自己的并发代理**而不是源站直连：源站单路只有 1.4Mbps，remux 会被入口饿死。
  const input = `${streamOrigin}/api/xifan/stream?u=${encodeURIComponent(url)}&t=${INTERNAL_TOKEN}`
  const args = [
    '-nostdin', '-loglevel', 'error',
    // **必须允许重连**：让位逻辑会 SIGSTOP 冻住 ffmpeg，冻超过 60 秒时代理那边的会话
    // 会被 idle 看门狗收摊，输入流就断了。ffmpeg 的 HTTP 输入默认**不会**自己重连，
    // 于是解冻后直接退出码 255 —— 实测反复失败、一个分片都产不出来就是这个原因。
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_on_network_error', '1',
    '-reconnect_delay_max', '60',
    '-i', input,
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '6',
    // event 而非 vod：playlist 边转边追加，用户不必等整集转完（12 分钟）才能开播；
    // ffmpeg 正常结束时会自己补上 #EXT-X-ENDLIST，届时它就是一份完整 VOD，可以随意 seek。
    '-hls_playlist_type', 'event',
    '-hls_list_size', '0', // 0 = 保留全部分片，别把前面的从 playlist 里滚掉
    '-hls_segment_type', 'fmp4',
    // 绝对路径：相对文件名会写到**进程的工作目录**（部署目录）而不是分片目录，
    // playlist 里引用的却是同目录的 init.mp4，两边对不上。
    '-hls_fmp4_init_filename', join(dir, 'init.mp4'),
    '-hls_segment_filename', join(dir, 'seg%05d.m4s'),
    join(dir, 'index.m3u8'),
  ]
  const job: Job = { key, url, state: 'running', startedAt: Date.now(), bytes: 0 }
  jobs.set(key, job)
  const proc = spawn('ffmpeg', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] })
  job.proc = proc
  guardViewers(job)

  let stderr = ''
  proc.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000) })
  proc.on('error', (err) => {
    job.state = 'failed'
    job.error = 'ffmpeg 启动失败：' + err.message
    console.error('[xifan:prepare] ' + job.error)
  })
  proc.on('close', (code) => {
    job.proc = undefined
    job.bytes = dirSize(dir)
    if (code === 0) {
      job.state = 'ready'
      // 完成标记必须**最后**写：中途崩了目录里虽有分片但没有标记，下次会当成没转过重来，
      // 而不是把一份缺尾巴的 playlist 当成品端出去。
      try { writeFileSync(join(dir, READY_MARK), String(Date.now())) } catch { /* 标记写不上就当没转过 */ }
      console.log(`[xifan:prepare] ${key} 转完，${(job.bytes / 1048576).toFixed(0)}MB，耗时 ${Math.round((Date.now() - job.startedAt) / 1000)}s`)
    } else {
      job.state = 'failed'
      job.error = stderr.split('\n').filter(Boolean).slice(-2).join(' | ') || `ffmpeg 退出码 ${code}`
      rmSync(dir, { recursive: true, force: true })
      console.error(`[xifan:prepare] ${key} 失败：${job.error}`)
    }
  })
  console.log(`[xifan:prepare] ${key} 开始预转`)
  return { key, state: 'running' }
}

// 分片文件名白名单：只放行自己生成的那几种，杜绝 ../ 之类的路径穿越。
export function resolveAsset(key: string, file: string): string | null {
  if (!/^[0-9a-f]{32}$/.test(key)) return null
  if (!/^(index\.m3u8|init\.mp4|seg\d{5}\.m4s)$/.test(file)) return null
  const p = join(dirFor(key), file)
  return existsSync(p) ? p : null
}

export function listPrepared(): { key: string; bytes: number; at: number }[] {
  try {
    return readdirSync(hlsDir)
      .filter((k) => existsSync(join(hlsDir, k, READY_MARK)))
      .map((k) => ({ key: k, bytes: dirSize(join(hlsDir, k)), at: statSync(join(hlsDir, k, READY_MARK)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
  } catch {
    return []
  }
}

export function dropPrepared(key: string): boolean {
  if (!/^[0-9a-f]{32}$/.test(key)) return false
  const dir = dirFor(key)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}
