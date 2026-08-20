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
import { existsSync, mkdirSync, rmSync, statSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { statfsSync } from 'node:fs'
import { dataDir } from '../data-dir'
import { assertStreamableUrl } from './stream'

export const hlsDir = join(dataDir, 'hls')
mkdirSync(hlsDir, { recursive: true })

// 一集 HLS 约 490MB。低于这个余量就不再接新任务，别把盘写满拖垮整个服务。
const MIN_FREE_BYTES = 3 * 1024 * 1024 * 1024
// remux 是 IO 密集不是 CPU 密集（实测 CPU 0~1%），但**入口带宽只有一份**：
// 同时转两集 = 两边都慢一半，还会跟正在观看的人抢。所以串行。
const MAX_CONCURRENT = 1
const READY_MARK = 'done'

export type JobState = 'none' | 'running' | 'ready' | 'failed'

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

export function statusOf(url: string): { key: string; state: JobState; bytes: number; error?: string } {
  const key = keyFor(url)
  // 磁盘上的完成标记优先于内存 —— 重启后内存里的 job 没了，但转好的分片还在。
  if (existsSync(join(dirFor(key), READY_MARK))) {
    return { key, state: 'ready', bytes: dirSize(dirFor(key)) }
  }
  const job = jobs.get(key)
  if (!job) return { key, state: 'none', bytes: 0 }
  // ffmpeg 的 stderr 里常带服务端绝对路径，别原样吐给浏览器。
  const safeError = job.error ? job.error.replace(/\/[^\s'"]+/g, '<path>').slice(0, 200) : undefined
  return { key, state: job.state, bytes: job.state === 'running' ? dirSize(dirFor(key)) : job.bytes, error: safeError }
}

export class PrepareRejected extends Error {}

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

  const dir = dirFor(key)
  rmSync(dir, { recursive: true, force: true }) // 失败残留的半成品先清掉
  mkdirSync(dir, { recursive: true })

  // 输入走**自己的并发代理**而不是源站直连：源站单路只有 1.4Mbps，remux 会被入口饿死。
  const input = `${streamOrigin}/api/xifan/stream?u=${encodeURIComponent(url)}`
  const args = [
    '-nostdin', '-loglevel', 'error',
    '-i', input,
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', join(dir, 'seg%05d.m4s'),
    join(dir, 'index.m3u8'),
  ]
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  const job: Job = { key, url, state: 'running', startedAt: Date.now(), bytes: 0, proc }
  jobs.set(key, job)

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
