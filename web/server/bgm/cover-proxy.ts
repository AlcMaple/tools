// BGM 封面代理的取图层：磁盘缓存 + 在途去重 + 与旧封面查条目共用的上游队列。
//
// 并发上限不能约束一批请求的速率，旧百科封面还会先查 BGM 条目。两种请求共用错峰队列；
// 两个请求可同时进行，慢图不应阻塞整批封面的起步。
// 一旦收到 429，停止尚未发出的请求，避免继续延长上游惩罚。这里不自动重试。
// 图床封面 URL 带内容 hash，取到一次就落盘，后续可直接从磁盘返回。
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from '../data-dir'
import { noteBgmRequest } from './bgm-health'

const cacheDir = join(dataDir, 'bgm-cover-cache')
mkdirSync(cacheDir, { recursive: true })

const MAX_QUEUE = 80
const MAX_CONCURRENT = 2
const REQUEST_GAP_MS = 1000
const MAX_BYTES = 8 * 1024 * 1024
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const TYPE_BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

export class CoverError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export interface CoverImage { contentType: string; body: Buffer<ArrayBuffer> }

const waiting: Array<() => void> = []
const inflight = new Map<string, Promise<CoverImage>>()
let running = 0
let nextRequestAt = 0
let limitedUntil = 0

async function acquire(): Promise<void> {
  if (Date.now() < limitedUntil) throw new CoverError('BGM cover rate limited', 503)
  if (running < MAX_CONCURRENT) { running++; return }
  if (waiting.length >= MAX_QUEUE) throw new CoverError('cover queue full', 503)
  await new Promise<void>((resolve) => waiting.push(resolve))
}

function release(): void {
  const next = waiting.shift()
  if (next) next()
  else running--
}

export async function scheduleBgmCoverRequest<T>(request: () => Promise<T>): Promise<T> {
  await acquire()
  try {
    const startAt = Math.max(Date.now(), nextRequestAt)
    nextRequestAt = startAt + REQUEST_GAP_MS
    const delay = startAt - Date.now()
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    if (Date.now() < limitedUntil) throw new CoverError('BGM cover rate limited', 503)
    return await request()
  } finally {
    release()
  }
}

export function noteCoverRateLimit(): void {
  limitedUntil = Math.max(limitedUntil, Date.now() + 15 * 60_000)
}

async function readCached(base: string): Promise<CoverImage | null> {
  for (const ext of Object.keys(TYPE_BY_EXT)) {
    try {
      return { contentType: TYPE_BY_EXT[ext], body: await readFile(`${base}.${ext}`) }
    } catch {
      // 没有这个扩展名的缓存，继续试下一个
    }
  }
  return null
}

async function fetchUpstream(path: string): Promise<CoverImage> {
  const url = `https://lain.bgm.tv${path}`
  let upstream: Response
  try {
    upstream = await fetch(url, {
      headers: { 'User-Agent': 'MapleTools-Web/0.1 (https://github.com/AlcMaple/tools)' },
      signal: AbortSignal.timeout(15000),
    })
  } catch (error) {
    noteBgmRequest(url, null)
    throw error
  }
  noteBgmRequest(url, upstream.status)
  if (upstream.status === 429) noteCoverRateLimit()
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel()
    throw new CoverError(`upstream HTTP ${upstream.status}`, 502)
  }
  const contentType = upstream.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase() ?? ''
  if (!EXT[contentType]) {
    await upstream.body.cancel()
    throw new CoverError(`unexpected content-type ${contentType}`, 502)
  }
  // 读完整张再落盘/发缓存头；流中途断掉不能把半张图永久缓存。
  const reader = upstream.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) throw new CoverError('cover exceeds 8 MiB', 502)
      chunks.push(value)
    }
    if (!size) throw new CoverError('empty cover', 502)
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return { contentType, body: Buffer.concat(chunks, size) }
}

export function getBgmCover(path: string): Promise<CoverImage> {
  let job = inflight.get(path)
  if (job) return job
  const base = join(cacheDir, createHash('sha1').update(path).digest('hex'))
  job = (async () => {
    const cached = await readCached(base)
    if (cached) return cached
    return scheduleBgmCoverRequest(async () => {
      const image = await fetchUpstream(path)
      const tmp = `${base}.tmp-${process.pid}`
      await writeFile(tmp, image.body)
      await rename(tmp, `${base}.${EXT[image.contentType]}`)
      return image
    })
  })()
  inflight.set(path, job)
  const clear = () => { if (inflight.get(path) === job) inflight.delete(path) }
  job.then(clear, clear)
  return job
}
