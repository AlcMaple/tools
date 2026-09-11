// 线路一「预转 HLS」—— 分区版：可以从任意位置起转，播放器可跳到还没转出的地方。
//
// 为什么要转 HLS（三段带宽账，实测）：
//   入口  源站 → 服务器      12 路并发 5.3Mbps ✓（见 stream.ts）
//   出口  服务器 → 手机      **单连接只有 2.2Mbps**，低于 2.67Mbps 的码率 ✗
//                            但同一条链路 8 连接能到 5.22Mbps
//   <video> 直连服务器只开**一条**连接，所以卡在出口那一段。HLS 把整集切成分片，
//   播放器会并发拉多片，自然用上多连接 —— 这是绕开跨境单连接限速的唯一办法。
//
// 分片用 fMP4 不用 TS：TS 的 188 字节包头让体积比源涨 12%，fMP4 只涨 8.6%——
// 出口只有 5.22Mbps，这 3 个百分点值得省。（实测 TS 3.00Mbps / fMP4 2.90Mbps）
//
// 两档码率（ABR）：同一条 ffmpeg 从同一份输入出两档，入口只拉一次。
//   hd  源画质 -c copy（HEVC 1080p，约 1.5~2.7Mbps）
//   sd  1080p H.264 crf23 封顶 1.2Mbps —— **不降分辨率只降码率**：VPS 实测（60s 样本）
//       SSIM 0.982 vs 源；720p 各档只有 0.957~0.964，且体积差不多。番剧画面平坦，
//       1080p 降码率比降分辨率划算得多。
//   播放器（hls.js / iOS 原生）按缓冲水位自动选档，主 playlist 把 sd 放前面让手机先起播。
//   CPU：2 核 VPS 上 nice 19 + 2 线程 1.42x 实时；转码期间 /api/health p50 2ms、最差 8ms，
//   不影响网站；快源直连本来就不经过服务器。
//
// **分区（region）**：一集不再是「从 0 顺序转到尾」一条 ffmpeg，而是若干段 `-ss S [-to E]`：
//   用户跳到还没转出的 7:21 → 杀掉正在跑的那段（已产出的分片都留着）→ 从 7:18 起新开一段；
//   一段跑到尾（或跑到下一段的起点）后，回头补中间的空洞，全部补齐才写完成标记。
//   每档的 playlist 由本文件**按磁盘上的分片实时拼出来**（不是 ffmpeg 写的那份）：
//   各段按时间排好，中间的空洞用 `#EXT-X-GAP` 占位、片尾用一段 GAP 撑到整集时长——
//   这样进度条从第一秒起就是完整长度，用户可以跳到任何位置；跳进空洞时播放页去
//   `/prepared?from=T` 要求从那里起转。
//   段的起点 S 落在**全局 6 秒网格**上，sd 档从 S 精确起（解码后丢掉 S 之前的帧）、关键帧也钉在
//   同一张 6 秒网格上（关掉场景切换关键帧），于是 sd 分片边界永远对齐、段与段严丝合缝；
//   hd 档是 copy，只能从 S 之前最近的源关键帧 K 起——K 从 moov（mp4 索引，moov.ts 只读索引不下载画面）
//   查出来，而 hd 分片按「每个关键帧都切」（hls_time 1），任何 K 都是某片的边界，同样不留缝。
//   段与段之间用 `#EXT-X-DISCONTINUITY` 隔开（每段的时间戳都从 0 起，播放器按 playlist 里的
//   位置重新锚定），前一段越过 S/K 的分片直接丢掉、由后一段接管。
//   曾试过 `-copyts` 让 tfdt 带绝对时间——hls 复用器会把 tfdt 归零、把偏移塞进 elst，
//   ffprobe 读出来的 pts 是两倍，播放器怎么解释也说不准，弃用。

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, statSync, readdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs'
import { setPriority } from 'node:os'
import { join } from 'node:path'
import { statfsSync } from 'node:fs'
import { dataDir } from '../data-dir'
import { assertStreamableUrl, externalViewerCount, INTERNAL_TOKEN } from './stream'
import { probeMoov, type MoovInfo } from './moov'

export const hlsDir = join(dataDir, 'hls')
mkdirSync(hlsDir, { recursive: true })

// 一集 HLS：hd 约 452MB（实测和源 mp4 等大，fMP4 几乎无封装开销）+ sd 约 200MB。
const EPISODE_BYTES = 650 * 1024 * 1024
// **总配额**：预转产物占用的上限。这是硬闸——超了就先按 LRU 淘汰，淘汰不动就拒绝新任务。
// 25G 可用空间给到 15G 约合 23 集，剩下的留给数据库、日志和构建产物，别把盘吃干净：
// 磁盘写满会把整个服务拖垮，那是这套东西唯一有「炸掉」风险的地方。
const QUOTA_BYTES = Number(process.env.XIFAN_HLS_QUOTA_BYTES ?? 15 * 1024 * 1024 * 1024)
// 除了自身配额，也得给系统留活路：磁盘剩余低于此值一律不再接新任务。
const MIN_FREE_BYTES = 3 * 1024 * 1024 * 1024
// 最近被读过的**绝不淘汰**——正在看的人删掉就是直接播放中断。
const RECENT_GUARD_MS = 30 * 60_000
// **入口带宽只有一份**：同时转两集 = 两边都慢一半，还会跟正在观看的人抢；
// sd 档转码也只留了一条 2 线程的 CPU 余量。所以串行——一集之内也只有一段在跑。
const MAX_CONCURRENT = 1
// sd 档编码线程数与调度优先级：2 核机器留一整颗给 Node，且永远让路。
const ENCODE_THREADS = 2
const ENCODE_NICE = 19
const RUNGS = ['hd', 'sd'] as const
type Rung = (typeof RUNGS)[number]
const READY_MARK = 'done'
// moov 解析结果（时长、start_time、关键帧表）落盘：重启后拼 playlist 仍要整集时长。
const MOOV_FILE = 'moov.json'
// sd 分片长度 = 段起点网格 = sd 强制关键帧间隔。三者相等，各段的 sd 分片边界才落在同一张网格上。
const SEGMENT_SECONDS = 6
// 边转边播的缓冲垫：某个位置前方转出这么多秒就放行。转码 1.3~1.4x 实时，领先量只增不减，
// 30 秒足够吃掉入口抖动。以前按「15 片」算，源关键帧 10 秒一个时就是 150 秒——起稿要等两分钟。
const PLAYABLE_SECONDS = 30
// 跳转目标落在正在跑的这段前沿之后多远以内，就不重开一段、等它转过去。
const LOOKAHEAD_SECONDS = 45
// 小于这个的空洞不补（`-to` 结束位置与关键帧对不齐留下的零头），playlist 里用 GAP 让播放器跳过。
const MIN_GAP_SECONDS = 1.5
const MAX_REGION_FAILURES = 3

export type JobState = 'none' | 'running' | 'ready' | 'failed'

interface Region {
  start: number // 请求的起点（秒），也是文件名前缀里的那个数
  end: number | null // 有界段的终点；null = 转到尾
  proc?: ChildProcess
}

interface Job {
  key: string
  url: string
  origin: string
  state: JobState
  startedAt: number
  bytes: number
  error?: string
  regions: Region[]
  lastWanted: number
  failures: number
}

interface Seg { file: string; dur: number }
interface RegionOnDisk { start: number; prefix: string; segs: Record<Rung, Seg[]>; ended: boolean }

const jobs = new Map<string, Job>()
const moovCache = new Map<string, MoovInfo | null>()

export function keyFor(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32)
}

function dirFor(key: string): string {
  return join(hlsDir, key)
}

function prefixFor(start: number): string {
  return `r${Math.round(start * 1000)}_`
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

// ——— 磁盘上的分区与时间线 ———

function parseVariant(path: string): { segs: Seg[]; ended: boolean } {
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { return { segs: [], ended: false } }
  const segs: Seg[] = []
  let dur = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('#EXTINF:')) dur = Number(line.slice(8).split(',')[0]) || 0
    else if (line && !line.startsWith('#')) { segs.push({ file: line, dur }); dur = 0 }
  }
  return { segs, ended: text.includes('#EXT-X-ENDLIST') }
}

/** 按文件名前缀扫出这一集已有的各段（不依赖内存，重启后照样能拼）。 */
function regionsOnDisk(key: string): RegionOnDisk[] {
  const dir = dirFor(key)
  let files: string[] = []
  try { files = readdirSync(dir) } catch { return [] }
  const out: RegionOnDisk[] = []
  for (const f of files) {
    const m = /^(r(\d+)_)vsd\.m3u8$/.exec(f)
    if (!m) continue
    const prefix = m[1]!
    const sd = parseVariant(join(dir, f))
    const hd = parseVariant(join(dir, `${prefix}vhd.m3u8`))
    out.push({ start: Number(m[2]) / 1000, prefix, segs: { hd: hd.segs, sd: sd.segs }, ended: sd.ended && hd.ended })
  }
  return out.sort((a, b) => a.start - b.start)
}

function moovOf(key: string): MoovInfo | null {
  const cached = moovCache.get(key)
  if (cached !== undefined) return cached
  let info: MoovInfo | null = null
  try {
    const raw = JSON.parse(readFileSync(join(dirFor(key), MOOV_FILE), 'utf8')) as MoovInfo
    if (Number.isFinite(raw.duration) && Array.isArray(raw.keyframes)) info = raw
  } catch { /* 还没探到或探测失败 */ }
  moovCache.set(key, info)
  return info
}

function durationOf(key: string): number | null {
  return moovOf(key)?.duration ?? null
}

/** 段起点：6 秒网格上 ≤ t 的那个点。没有 moov（不知道 hd 从哪个关键帧起）就只能从 0 顺序转。 */
function gridStart(key: string, t: number): number | null {
  const s = Math.max(0, Math.floor(t / SEGMENT_SECONDS) * SEGMENT_SECONDS)
  if (s === 0) return 0
  return moovOf(key) ? s : null
}

/** hd 档在这一段真正的起点：ffmpeg -ss S 对 copy 流取「dts ≤ S」的最后一个关键帧，时间线位置是它的 pts。 */
function hdStart(key: string, s: number): number {
  const info = moovOf(key)
  if (!info || s === 0) return s
  const abs = s + info.startTime
  let best: { pts: number; dts: number } | null = null
  for (const k of info.keyframes) {
    if (k.dts <= abs + 1e-6) best = k
    else break
  }
  return best ? Math.max(0, best.pts - info.startTime) : s
}

interface Placed { start: number; end: number; seg: Seg; prefix: string }

/** 把各段按真实时间排成一条线；后一段的起点之后、前一段多出来的分片是重复内容，丢掉。 */
function timeline(key: string, regions: RegionOnDisk[], rung: Rung): Placed[] {
  const out: Placed[] = []
  for (const region of regions) {
    let t = rung === 'hd' ? hdStart(key, region.start) : region.start
    const placed: Placed[] = []
    for (const seg of region.segs[rung]) { placed.push({ start: t, end: t + seg.dur, seg, prefix: region.prefix }); t += seg.dur }
    if (!placed.length) continue
    // 前面各段里越过本段起点的分片全丢——段间有 DISCONTINUITY，时间线只认 EXTINF 累加，留着会让后面漂移。
    // 起点落在网格 / 关键帧上，前一段恰好有一片在这里结束，所以不会留缝。
    const regionStart = placed[0]!.start
    while (out.length && out[out.length - 1]!.end > regionStart + 0.05) out.pop()
    out.push(...placed)
  }
  return out
}

/** sd 档已覆盖的区间（合并相邻/重叠），跳转判定与补洞调度都看它——它比 hd 略慢，以它为准最保守。 */
function coverage(key: string): { start: number; end: number }[] {
  const merged: { start: number; end: number }[] = []
  for (const p of timeline(key, regionsOnDisk(key), 'sd')) {
    const last = merged[merged.length - 1]
    if (last && p.start <= last.end + 0.05) last.end = Math.max(last.end, p.end)
    else merged.push({ start: p.start, end: p.end })
  }
  return merged
}

function coveredSeconds(key: string): number {
  return coverage(key).reduce((n, c) => n + (c.end - c.start), 0)
}

/** 位置 t 前方是否已经有足够缓冲垫（或这一段已经转到尾/转到下一段起点）。 */
function playableAt(key: string, t: number, job?: Job): boolean {
  const total = durationOf(key)
  for (const c of coverage(key)) {
    if (t < c.start - 0.05 || t > c.end) continue
    if (c.end - t >= PLAYABLE_SECONDS) return true
    if (total !== null && c.end >= total - 0.5) return true
    // 这一段有界且已经跑完（不会再长），前面接着的是下一段，照样能播。
    if (job && !job.regions.some((r) => r.proc && r.start <= t && t <= c.end + 0.05)) return true
  }
  return false
}

/** 拼一档的 playlist：各段之间 DISCONTINUITY；真实分片 + 空洞 GAP + 片尾 GAP 撑到整集时长；全部补齐才带 ENDLIST。 */
export function composePlaylist(key: string, rung: Rung): string | null {
  const regions = regionsOnDisk(key)
  if (!regions.length) return null
  const placed = timeline(key, regions, rung)
  const total = durationOf(key)
  const complete = existsSync(join(dirFor(key), READY_MARK))
  const lines = ['#EXTM3U', '#EXT-X-VERSION:8', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:EVENT']
  let target = SEGMENT_SECONDS
  let cursor = 0
  let prefix = ''
  const gap = (seconds: number): void => {
    if (seconds < 0.3) return
    lines.push(`#EXTINF:${seconds.toFixed(3)},`, '#EXT-X-GAP', 'gap.m4s')
    target = Math.max(target, Math.ceil(seconds))
  }
  for (const p of placed) {
    if (p.start > cursor + 0.3) gap(p.start - cursor)
    if (p.prefix !== prefix) {
      if (prefix) lines.push('#EXT-X-DISCONTINUITY')
      prefix = p.prefix
      lines.push(`#EXT-X-MAP:URI="${prefix}init_${rung}.mp4"`)
    }
    lines.push(`#EXTINF:${p.seg.dur.toFixed(3)},`, p.seg.file)
    target = Math.max(target, Math.ceil(p.seg.dur))
    cursor = Math.max(cursor, p.end)
  }
  if (total !== null && total > cursor + 0.3) gap(total - cursor)
  if (complete) lines.push('#EXT-X-ENDLIST')
  lines.splice(2, 0, `#EXT-X-TARGETDURATION:${target}`)
  return lines.join('\n') + '\n'
}

// ffmpeg 起手就写 master（hd 在前，带真实 CODECS）。播放页固定请求 index.m3u8，这里把各档按
// BANDWIDTH 升序重排、把带段前缀的变体名换成 vhd/vsd 后落成 index.m3u8：iOS 原生播放器从**第一条**
// 起播，手机要先拿到 sd。旧格式目录 index.m3u8 本身就是媒体 playlist，没有 master，不会走到这里。
function ensureMaster(dir: string): void {
  const index = join(dir, 'index.m3u8')
  if (existsSync(index)) return
  let masterFile: string | undefined
  try { masterFile = readdirSync(dir).find((f) => /^r\d+_master\.m3u8$/.test(f)) } catch { return }
  if (!masterFile) return
  try {
    const lines = readFileSync(join(dir, masterFile), 'utf8').split('\n')
    const head: string[] = [], variants: { bw: number; text: string }[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        const uri = (lines[++i] ?? '').replace(/^r\d+_v(hd|sd)\.m3u8$/, 'v$1.m3u8')
        const bw = Number(/BANDWIDTH=(\d+)/.exec(line)?.[1] ?? 0)
        variants.push({ bw, text: `${line}\n${uri}` })
      } else if (line.trim()) head.push(line)
    }
    if (!variants.length) return
    variants.sort((a, b) => a.bw - b.bw)
    writeFileSync(index, [...head, ...variants.map((v) => v.text), ''].join('\n'))
  } catch { /* 下次 statusOf 再试 */ }
}

/** 播放页要的 playlist：index.m3u8 读文件（主 playlist / 旧格式媒体 playlist），vhd/vsd 实时拼。 */
export function readPlaylist(key: string, file: string): string | null {
  if (!/^[0-9a-f]{32}$/.test(key)) return null
  const dir = dirFor(key)
  if (file === 'index.m3u8') {
    ensureMaster(dir)
    try { return readFileSync(join(dir, file), 'utf8') } catch { return null }
  }
  const m = /^v(hd|sd)\.m3u8$/.exec(file)
  if (!m) return null
  return composePlaylist(key, m[1] as Rung)
}

export function statusOf(url: string, wanted?: number): {
  key: string; state: JobState; bytes: number; playable: boolean; seconds: number; duration: number | null; error?: string
} {
  const key = keyFor(url)
  const dir = dirFor(key)
  // 磁盘上的完成标记优先于内存 —— 重启后内存里的 job 没了，但转好的分片还在。
  if (existsSync(join(dir, READY_MARK))) {
    return { key, state: 'ready', bytes: dirSize(dir), playable: true, seconds: coveredSeconds(key), duration: durationOf(key) }
  }
  const job = jobs.get(key)
  if (!job) return { key, state: 'none', bytes: 0, playable: false, seconds: 0, duration: null }
  if (job.state === 'running') {
    ensureMaster(dir)
    if (wanted !== undefined) ensureRegion(job, wanted)
  }
  // ffmpeg 的 stderr 里常带服务端绝对路径，别原样吐给浏览器。
  const safeError = job.error ? job.error.replace(/\/[^\s'"]+/g, '<path>').slice(0, 200) : undefined
  return {
    key,
    state: job.state,
    bytes: job.state === 'running' ? dirSize(dir) : job.bytes,
    // 转到一半也能播：问的是「这个位置前方够不够」，不问整集。
    playable: job.state === 'running' && playableAt(key, wanted ?? job.lastWanted, job),
    seconds: job.state === 'running' ? coveredSeconds(key) : 0,
    duration: durationOf(key),
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
function guardViewers(job: Job, region: Region): void {
  let paused = false
  const timer = setInterval(() => {
    if (!region.proc || job.state !== 'running') {
      clearInterval(timer)
      return
    }
    // 只数经代理直连拉流的人（占入口）。慢源名额里看 HLS 的人读的是磁盘分片，不占入口；
    // 用名额数会把正在边转边看这一集的观众也算进去 —— 预转把自己冻住，播放器 90 秒后追上转码前沿必卡。
    const watching = externalViewerCount() > 0
    try {
      if (watching && !paused) {
        region.proc.kill('SIGSTOP')
        paused = true
        console.log(`[xifan:prepare] ${job.key} 有人在看，暂停预转让出带宽`)
      } else if (!watching && paused) {
        region.proc.kill('SIGCONT')
        paused = false
        console.log(`[xifan:prepare] ${job.key} 观众已散，恢复预转`)
      }
    } catch { /* 进程已退出，下一轮 clearInterval */ }
  }, 5_000)
  timer.unref?.()
}

function runningRegion(job: Job): Region | undefined {
  return job.regions.find((r) => r.proc)
}

/**
 * 用户想看 t：已覆盖、或正在跑的那段马上就会转到，就什么都不做；否则杀掉正在跑的段，
 * 从 t 起新开一段（有界到下一段的起点）。被杀那段已产出的分片全留着，空洞稍后回头补。
 */
function ensureRegion(job: Job, t: number): void {
  if (job.state !== 'running') return
  job.lastWanted = Math.max(0, t)
  const total = durationOf(job.key)
  if (total !== null && t >= total - 1) return
  const running = runningRegion(job)
  const covered = coverage(job.key)
  let target = t
  const hit = covered.find((c) => t >= c.start - 0.05 && t <= c.end)
  if (hit) {
    const growing = running && running.start - 0.05 <= hit.end && running.start <= t && (running.end === null || t < running.end)
    if (growing) return // 正在跑的这段会转过去，杀了重开只是浪费
    const remaining = hit.end - t
    if (remaining >= PLAYABLE_SECONDS || (total !== null && hit.end >= total - 0.5)) return
    // 这段已经停了、前方不够：从它的尽头接着补，别从 t 重转一遍已有的
    if (covered.some((c) => c !== hit && c.start <= hit.end + MIN_GAP_SECONDS && c.end > hit.end)) return
    target = hit.end
  }
  const snapped = gridStart(job.key, target)
  if (snapped === null) return // 没有 moov 就没法从中间起转，只能顺着转
  target = snapped
  if (running) {
    const frontier = covered.find((c) => c.start - 0.05 <= running.start && c.end >= running.start)?.end ?? running.start
    if (running.start <= target && target <= frontier + LOOKAHEAD_SECONDS && (running.end === null || target < running.end)) return
    // 杀掉：`close` 回调看到是主动杀的就不计失败，直接调度下一段。
    try { running.proc?.kill('SIGKILL') } catch { /* 已退出 */ }
    running.proc = undefined
  }
  const next = job.regions.map((r) => r.start).filter((s) => s > target).sort((a, b) => a - b)[0]
  spawnRegion(job, { start: target, end: next ?? null })
}

/** 一段跑完后找下一个空洞：优先用户正在看的位置往后的那个；全补完就写完成标记。 */
function scheduleNext(job: Job): void {
  if (job.state !== 'running' || runningRegion(job)) return
  const total = durationOf(job.key)
  const covered = coverage(job.key)
  const gaps: { start: number; end: number | null }[] = []
  let cursor = 0
  for (const c of covered) {
    if (c.start > cursor + MIN_GAP_SECONDS) gaps.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (total === null) {
    // 时长还没探到（探测失败）：只能顺序转到尾，跟旧版一样。
    if (!covered.length || !regionsOnDisk(job.key).some((r) => r.ended)) gaps.push({ start: cursor, end: null })
  } else if (total > cursor + MIN_GAP_SECONDS) {
    gaps.push({ start: cursor, end: null })
  }
  if (!gaps.length) { finish(job); return }
  const pick = gaps.find((g) => g.end === null || g.end > job.lastWanted) ?? gaps[0]!
  const start = gridStart(job.key, pick.start)
  if (start === null) { finish(job); return } // 无 moov：顺序转完即算完成
  spawnRegion(job, { start, end: pick.end })
}

function finish(job: Job): void {
  const dir = dirFor(job.key)
  job.bytes = dirSize(dir)
  job.state = 'ready'
  ensureMaster(dir)
  // 完成标记必须**最后**写：中途崩了目录里虽有分片但没有标记，下次会当成没转过重来，
  // 而不是把一份缺尾巴的 playlist 当成品端出去。
  try { writeFileSync(join(dir, READY_MARK), String(Date.now())) } catch { /* 标记写不上就当没转过 */ }
  console.log(`[xifan:prepare] ${job.key} 转完，${(job.bytes / 1048576).toFixed(0)}MB，耗时 ${Math.round((Date.now() - job.startedAt) / 1000)}s`)
}

function inputFor(job: Job): string {
  // 输入走**自己的并发代理**而不是源站直连：源站单路只有 1.4Mbps，remux 会被入口饿死。
  return `${job.origin}/api/xifan/stream?u=${encodeURIComponent(job.url)}&t=${INTERNAL_TOKEN}`
}

const RECONNECT_ARGS = [
  // **必须允许重连**：让位逻辑会 SIGSTOP 冻住 ffmpeg，冻超过 60 秒时代理那边的会话
  // 会被 idle 看门狗收摊，输入流就断了。ffmpeg 的 HTTP 输入默认**不会**自己重连，
  // 于是解冻后直接退出码 255 —— 实测反复失败、一个分片都产不出来就是这个原因。
  '-reconnect', '1',
  '-reconnect_streamed', '1',
  '-reconnect_on_network_error', '1',
  '-reconnect_delay_max', '60',
]

/** 读 moov：整集时长 + 关键帧表。走自己的代理地址（尾部小请求直连透传，不建并发会话）。探不到就只能顺序转。 */
async function probeJobMoov(job: Job): Promise<void> {
  try {
    const info = await probeMoov(inputFor(job))
    writeFileSync(join(dirFor(job.key), MOOV_FILE), JSON.stringify(info))
    moovCache.set(job.key, info)
  } catch (error) {
    moovCache.set(job.key, null)
    console.warn(`[xifan:prepare] ${job.key} moov 解析失败，按顺序转：${error instanceof Error ? error.message : error}`)
  }
}

function spawnRegion(job: Job, region: Region): void {
  const dir = dirFor(job.key)
  const prefix = prefixFor(region.start)
  job.regions.push(region)
  const args = [
    '-nostdin', '-loglevel', 'error',
    ...RECONNECT_ARGS,
    '-threads', String(ENCODE_THREADS),
    // 输入侧 seek：mp4 走字节 Range 直接跳，不用把前面的都读一遍。ffmpeg 的 -ss 相对 format.start_time，
    // 而 region.start 是 playlist 时间线（已减去 start_time），两者口径一致，直接用。
    // sd 档（解码）丢掉 pts < S 的帧、恰从 S 起；hd 档（copy）从「dts ≤ S」的最后一个关键帧起（见 hdStart）。
    ...(region.start > 0 ? ['-ss', region.start.toFixed(6)] : []),
    '-i', inputFor(job),
    // 有界段：-t 按**输入**时间计——copy 流看 ist->pts ≥ S + t 停，编码流看输出帧时间 ≥ t 停，
    // 两档都在 E = S + t 处收口，不会因为 hd 早从关键帧起而少转一截。
    ...(region.end !== null ? ['-t', (region.end - region.start).toFixed(6)] : []),
    // 同一份输入出两档：v:0/a:0 原样 copy 为 hd；v:1 重编 H.264 为 sd，音频两档都 copy。
    '-map', '0:v:0', '-map', '0:a:0', '-map', '0:v:0', '-map', '0:a:0',
    '-c:v:0', 'copy', '-c:a', 'copy',
    '-c:v:1', 'libx264', '-preset:v:1', 'veryfast', '-crf:v:1', '23',
    '-maxrate:v:1', '1200k', '-bufsize:v:1', '2400k',
    // sd 关键帧**只**在 6 秒网格上（段起点在网格上，所以相对时间的网格就是全局网格）；
    // 关掉场景切换插关键帧，否则分片会在任意位置断开，段与段就对不齐了。
    '-force_key_frames:v:1', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
    '-sc_threshold:v:1', '0',
    '-f', 'hls',
    // 每个关键帧都切一片：sd 的关键帧只在网格上 → 整齐 6 秒；hd 按源关键帧切 → 任何关键帧都是片边界，
    // 后一段从关键帧 K 起时前一段恰有一片在 K 结束。
    '-hls_time', '1',
    // event 而非 vod：playlist 边转边追加。真正给播放器的那份由 composePlaylist 拼，这里的只当分片清单用。
    '-hls_playlist_type', 'event',
    '-hls_list_size', '0', // 0 = 保留全部分片，别把前面的从 playlist 里滚掉
    '-hls_segment_type', 'fmp4',
    // 保持**相对**文件名：它同时是写入路径和 playlist 里的引用名，给绝对路径会让
    // ffmpeg 写 header 时直接失败。写到哪儿由 spawn 的 cwd 决定。%v 展开成 var_stream_map 里的 name。
    '-hls_fmp4_init_filename', `${prefix}init_%v.mp4`,
    '-hls_segment_filename', join(dir, `${prefix}seg_%v_%05d.m4s`),
    '-var_stream_map', 'v:0,a:0,name:hd v:1,a:1,name:sd',
    '-master_pl_name', `${prefix}master.m3u8`,
    join(dir, `${prefix}v%v.m3u8`),
  ]
  const proc = spawn('ffmpeg', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] })
  region.proc = proc
  // 最低优先级：sd 档编码会吃满 2 个线程，但只要 Node 想要 CPU 就立刻让路（VPS 实测
  // 转码期间接口延迟仍是毫秒级）。macOS 开发机同样适用。
  if (proc.pid) { try { setPriority(proc.pid, ENCODE_NICE) } catch { /* 权限不够就按默认优先级跑 */ } }
  guardViewers(job, region)

  let stderr = ''
  proc.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000) })
  proc.on('error', (err) => {
    job.state = 'failed'
    job.error = 'ffmpeg 启动失败：' + err.message
    console.error('[xifan:prepare] ' + job.error)
  })
  proc.on('close', (code, signal) => {
    const killed = region.proc === undefined // ensureRegion 主动杀的
    region.proc = undefined
    if (job.state !== 'running') return
    const produced = regionsOnDisk(job.key).find((r) => r.prefix === prefix)?.segs.sd.length ?? 0
    if (code !== 0 && !killed) {
      job.failures++
      const why = stderr.split('\n').filter(Boolean).slice(-2).join(' | ') || `ffmpeg 退出码 ${code ?? signal}`
      console.error(`[xifan:prepare] ${job.key} 段 ${region.start}s 失败（第 ${job.failures} 次）：${why}`)
      if (job.failures >= MAX_REGION_FAILURES || (!produced && job.regions.length === 1)) {
        job.state = 'failed'
        job.error = why
        job.bytes = 0
        rmSync(dir, { recursive: true, force: true })
        return
      }
    }
    scheduleNext(job)
  })
  console.log(`[xifan:prepare] ${job.key} 开始转 ${region.start}s → ${region.end === null ? '尾' : region.end + 's'}`)
}

export function startPrepare(rawUrl: string, streamOrigin: string, from = 0): { key: string; state: JobState } {
  const url = assertStreamableUrl(rawUrl).toString() // 白名单校验，顺带挡掉 SSRF
  const key = keyFor(url)
  const existing = statusOf(url)
  if (existing.state === 'ready') return { key, state: existing.state }
  if (existing.state === 'running') {
    const job = jobs.get(key)
    if (job) ensureRegion(job, from)
    return { key, state: 'running' }
  }

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

  const job: Job = {
    key, url, origin: streamOrigin, state: 'running', startedAt: Date.now(), bytes: 0,
    regions: [], lastWanted: Math.max(0, from), failures: 0,
  }
  jobs.set(key, job)
  moovCache.delete(key)
  // 先读 moov 拿关键帧表，再从用户要看的位置起转（手机救援时用户可能已经在 7 分钟处）。
  // moov 读不到就退回从 0 顺序转——跟旧版一样，只是不能跳。
  void probeJobMoov(job).then(() => {
    if (job.state !== 'running' || runningRegion(job)) return
    const start = gridStart(key, from) ?? 0
    spawnRegion(job, { start, end: null })
  })
  return { key, state: 'running' }
}

// 分片文件名白名单：只放行自己生成的那几种，杜绝 ../ 之类的路径穿越。
export function resolveAsset(key: string, file: string): string | null {
  if (!/^[0-9a-f]{32}$/.test(key)) return null
  // 分区格式：r<起点ms>_init_hd.mp4 / r<起点ms>_seg_sd_00000.m4s；旧格式无前缀、无档位。
  if (!/^(index\.m3u8|v(?:hd|sd)\.m3u8|(?:r\d+_)?init(?:_(?:hd|sd))?\.mp4|(?:r\d+_)?seg(?:_(?:hd|sd)_)?\d{5}\.m4s)$/.test(file)) return null
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
