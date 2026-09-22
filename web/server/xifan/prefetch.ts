// 预取下一集：看第 N 集时，服务器后台把第 N+1 集整段 mp4 拉到本地盘，下一集直接从盘上答，不受源站速度影响。
//
// 为什么值得：09-21 起源站 → 服务器入口只有 300KB/s 上下，低于码率时边看边拉必卡；而一集 ~200MB
// 按 300KB/s 约 11 分钟就能拉完，比看完一集（~23 分钟）短。
//
// 刻意**不做**的（09-17 删掉的预转那一套踩过）：不转码、不切 HLS、不做名额；只存原始 mp4、只预取「下一集」、
// 全站同一时刻只下一集、其余排队。没拉完的文件（.part）永远不对外答——边写边读的落盘时机坑见 AGENTS.md。

import { createReadStream, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Agent, request } from 'undici'
import { dataDir } from '../data-dir'
import { UPSTREAM_HEADERS, type StreamResult } from './stream'
import { canProxy } from './proxy-hosts'

// 盘上总量上限：VPS 配额 15G，DB / 封面 / 日志之外留出余量；一集 150~600MB，4G 够存近十集。
const MAX_BYTES = 4 * 1024 * 1024 * 1024
const MAX_FILE_BYTES = 1.5 * 1024 * 1024 * 1024
const START_DELAY_MS = 60_000 // 开播第一分钟让给当前这集攒缓冲
const JOB_DEADLINE_MS = 45 * 60_000
const STREAMS = 4 // 当前这集还有 12 路在拉同一个入口，预取只拿小头
const CHUNK_BYTES = 4 * 1024 * 1024
const CHUNK_RESUME_LIMIT = 3 // 只给「传输中断」续传；HTTP 4xx/5xx 直接放弃整个任务

const dir = join(dataDir, 'prefetch')
mkdirSync(dir, { recursive: true })
for (const name of readdirSync(dir)) if (name.endsWith('.part')) rmSync(join(dir, name), { force: true })

const agent = new Agent({ connections: STREAMS, connectTimeout: 20_000, headersTimeout: 30_000, bodyTimeout: 30_000 })

function log(msg: string): void {
  console.log('[xifan:prefetch] ' + msg)
}
function fileOf(url: string): string {
  return join(dir, createHash('sha1').update(url).digest('hex') + '.mp4')
}

interface Job {
  owner: number
  label: string
  resolveUrl: () => Promise<string | null>
  notBefore: number
  url: string
  ac: AbortController
}
let current: Job | null = null
const queue: Job[] = []
let pumpTimer: NodeJS.Timeout | null = null

class HttpStatusError extends Error {}

async function fetchChunk(job: Job, fh: import('node:fs/promises').FileHandle, start: number, end: number): Promise<void> {
  let got = 0
  for (let attempt = 0; ; attempt++) {
    // 上一次在收完最后一个字节后才断：已经齐了，再请求 bytes=end+1-end 只会换来 416。
    if (got === end - start + 1) return
    try {
      const res = await request(job.url, {
        dispatcher: agent, method: 'GET', maxRedirections: 5, signal: job.ac.signal,
        headers: { ...UPSTREAM_HEADERS, Range: `bytes=${start + got}-${end}` },
      })
      if (res.statusCode !== 206) {
        await res.body.dump()
        // 200 = 边缘还没缓存、无视 Range 回整文件（stream.ts rangeRequest 同一个坑），等一下重打通常就是 206，按续传算。
        if (res.statusCode === 200) throw new Error('上游对 Range 回了 200')
        throw new HttpStatusError(`上游状态 ${res.statusCode}（bytes=${start + got}-${end}）`)
      }
      for await (const piece of res.body) {
        const buf = piece as Buffer
        await fh.write(buf, 0, buf.length, start + got)
        got += buf.length
      }
      if (got !== end - start + 1) throw new Error(`分块截断 ${got}/${end - start + 1}`)
      return
    } catch (error) {
      if (job.ac.signal.aborted || error instanceof HttpStatusError || attempt >= CHUNK_RESUME_LIMIT) throw error
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
    }
  }
}

async function probeTotal(job: Job): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    const res = await request(job.url, {
      dispatcher: agent, method: 'GET', maxRedirections: 5, signal: job.ac.signal,
      headers: { ...UPSTREAM_HEADERS, Range: 'bytes=0-0' },
    })
    await res.body.dump()
    const m = String(res.headers['content-range'] ?? '').match(/\/(\d+)$/)
    if (res.statusCode === 206 && m) return Number(m[1])
    if (res.statusCode !== 200 || attempt >= CHUNK_RESUME_LIMIT) throw new HttpStatusError('探长度状态 ' + res.statusCode)
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
  }
}

function evictFor(incoming: number): void {
  const files = readdirSync(dir)
    .filter((n) => n.endsWith('.mp4'))
    .map((n) => { const p = join(dir, n); const st = statSync(p); return { p, size: st.size, used: st.mtimeMs } })
    .sort((a, b) => a.used - b.used)
  let held = files.reduce((sum, f) => sum + f.size, 0)
  for (const f of files) {
    if (held + incoming <= MAX_BYTES) break
    rmSync(f.p, { force: true })
    held -= f.size
    log(`腾空间删掉 ${f.p}（${Math.round(f.size / 1048576)}MB）`)
  }
}

async function run(job: Job): Promise<void> {
  const target = fileOf(job.url)
  const part = target + '.part'
  const began = Date.now()
  const deadline = setTimeout(() => job.ac.abort(new Error('超过 45 分钟仍未拉完')), JOB_DEADLINE_MS)
  let fh: import('node:fs/promises').FileHandle | null = null
  try {
    const total = await probeTotal(job)
    if (total > MAX_FILE_BYTES) { log(`${job.label} ${Math.round(total / 1048576)}MB 超过单集上限，不预取`); return }
    evictFor(total)
    fh = await open(part, 'w')
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < total) {
        const start = next
        const end = Math.min(start + CHUNK_BYTES, total) - 1
        next = end + 1
        await fetchChunk(job, fh!, start, end)
      }
    }
    await Promise.all(Array.from({ length: STREAMS }, worker))
    await fh.close()
    fh = null
    await rename(part, target)
    const sec = (Date.now() - began) / 1000
    log(`${job.label} 拉完 ${Math.round(total / 1048576)}MB，用时 ${Math.round(sec)}s（${Math.round(total / 1024 / sec)}KB/s）`)
  } catch (error) {
    const why = job.ac.signal.aborted ? String(job.ac.signal.reason instanceof Error ? job.ac.signal.reason.message : '已取消') : error instanceof Error ? error.message : String(error)
    log(`${job.label} 放弃：${why}`)
    job.ac.abort()
  } finally {
    clearTimeout(deadline)
    if (fh) await fh.close().catch(() => undefined)
    await rm(part, { force: true })
  }
}

// 全站同一时刻只下一集，其余按先来后到排队——不顶掉别人的（A 看 Re:0、B 看死神，两边的下一集都会下，B 的晚一点）。
// 同一个人只保留他最新的那一个：他换了番 / 往后看了，他排着的旧任务作废，正在下的旧任务也中止——
// 唯一例外是正在下的恰好就是他此刻打开的这一集（看到一半的预取继续下完，之后拖进度 / 重进走盘）。
// 下一集的地址等真轮到它时再解析——开播那一刻不多打一次稀饭，也不拿一个排了很久的过期地址。
export function schedulePrefetch(owner: number, label: string, watchingLabel: string, resolveUrl: () => Promise<string | null>): void {
  if (current?.label === label || queue.some((j) => j.label === label)) return
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].owner !== owner) continue
    log(`${queue[i].label} 出队：同一用户改看 ${watchingLabel}`)
    queue.splice(i, 1)
  }
  if (current && current.owner === owner && current.label !== watchingLabel) {
    log(`${current.label} 中止：同一用户改看 ${watchingLabel}`)
    current.ac.abort(new Error('同一用户改看 ' + watchingLabel))
  }
  queue.push({ owner, label, resolveUrl, notBefore: Date.now() + START_DELAY_MS, url: '', ac: new AbortController() })
  log(`排队预取 ${label}（前面 ${queue.length - 1 + (current ? 1 : 0)} 个）`)
  pump()
}

function pump(): void {
  if (current || pumpTimer || !queue.length) return
  const job = queue[0]
  const wait = job.notBefore - Date.now()
  if (wait > 0) {
    pumpTimer = setTimeout(() => { pumpTimer = null; pump() }, wait)
    return
  }
  queue.shift()
  current = job
  void (async () => {
    try {
      const url = await job.resolveUrl()
      if (job.ac.signal.aborted) return
      if (!url || !canProxy(url)) { log(`${job.label} 不是可预取的 mp4 源，跳过`); return }
      try { statSync(fileOf(url)); log(`${job.label} 盘上已有`); return } catch { /* 还没有 */ }
      job.url = url
      log(`开始预取 ${job.label}`)
      await run(job)
    } catch (error) {
      log(`${job.label} 解析下一集失败，不预取：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      current = null
      pump()
    }
  })()
}

// 盘上有整集就从盘上答；没有返回 null 走原来的在线路径。
export function servePrefetched(url: string, rangeHeader: string | undefined): StreamResult | null {
  const file = fileOf(url)
  let total: number
  try { total = statSync(file).size } catch { return null }
  try { const now = new Date(); utimesSync(file, now, now) } catch { /* 只影响回收顺序 */ }
  const m = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/)
  const ranged = !!m && (m[1] !== '' || m[2] !== '')
  let start = 0
  let end = total - 1
  if (ranged) {
    if (m![1] === '') { start = Math.max(0, total - Number(m![2])) } else {
      start = Number(m![1])
      if (m![2] !== '') end = Math.min(Number(m![2]), total - 1)
    }
  }
  if (start >= total || start > end) return { status: 416, headers: { 'Content-Range': `bytes */${total}` }, body: null }
  const headers: Record<string, string> = {
    'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    'Content-Length': String(end - start + 1),
  }
  if (ranged) headers['Content-Range'] = `bytes ${start}-${end}/${total}`
  const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>
  return { status: ranged ? 206 : 200, headers, body }
}
