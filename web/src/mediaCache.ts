// 在线播放的本地缓存（OPFS `media-cache/<hash>/`）在网页这一侧只做两件事：列出 / 删除，和打开网站时清掉过期的。
// 写入只发生在播放页的 public/media-cache-worker.js，读取在 public/cover-cache-sw.js；目录结构三处一致：
// `meta.json` + 按 4MB 切开的 `<序号>.bin`（mp4），或 `index.m3u8` + 整片的 `r<序号>`（HLS）。
const DIR = 'media-cache'
const KEEP_DAYS = 30
const DAY_MS = 24 * 3600 * 1000

interface Meta {
  src: 'xifan' | 'girigiri'
  id: string
  title: string
  ep: number
  bgmId: number | null
  total: number
  savedAt: number
  complete: boolean
}

export interface CachedEpisode extends Meta {
  hash: string
  bytes: number
  daysLeft: number
  good: boolean
  // 神回查询失败时为 false：不知道是不是神回，不能按过期删
  knownGood: boolean
}

export function mediaCacheSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage && typeof navigator.storage.getDirectory === 'function'
}

async function topDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR)
  } catch {
    return null
  }
}

async function readEntry(hash: string, dir: FileSystemDirectoryHandle): Promise<(Meta & { hash: string; bytes: number }) | null> {
  let meta: Meta | null = null
  let bytes = 0
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file') continue
    const file = await (handle as FileSystemFileHandle).getFile()
    if (name === 'meta.json') meta = JSON.parse(await file.text()) as Meta
    else bytes += file.size
  }
  return meta ? { ...meta, hash, bytes } : null
}

// 播放页只查当前这一集，这里按番一次查全；查不到（未登录、网络失败）就当作不知道，宁可不删。
async function goodEpisodesOf(bgmIds: number[]): Promise<Map<number, Set<number> | null>> {
  const out = new Map<number, Set<number> | null>()
  await Promise.all(bgmIds.map(async (bgmId) => {
    try {
      const r = await fetch(`/api/tracks/${bgmId}/good-episodes`, { cache: 'no-store' })
      const d = r.ok ? ((await r.json()) as { goodEpisodes?: number[] }) : null
      out.set(bgmId, d ? new Set(d.goodEpisodes ?? []) : null)
    } catch {
      out.set(bgmId, null)
    }
  }))
  return out
}

export async function listCachedEpisodes(): Promise<CachedEpisode[]> {
  const top = await topDir()
  if (!top) return []
  const raw: (Meta & { hash: string; bytes: number })[] = []
  for await (const [hash, handle] of top.entries()) {
    if (handle.kind !== 'directory') continue
    try {
      const entry = await readEntry(hash, handle as FileSystemDirectoryHandle)
      if (entry) raw.push(entry)
    } catch (err) {
      console.error('[media-cache] 读取缓存条目失败', hash, err)
    }
  }
  const bgmIds = [...new Set(raw.map((e) => e.bgmId).filter((id): id is number => typeof id === 'number'))]
  const good = await goodEpisodesOf(bgmIds)
  const now = Date.now()
  return raw
    .map((e) => ({
      ...e,
      daysLeft: Math.max(0, Math.ceil(KEEP_DAYS - (now - e.savedAt) / DAY_MS)),
      good: e.bgmId !== null && !!good.get(e.bgmId)?.has(e.ep),
      knownGood: e.bgmId === null || good.get(e.bgmId) !== null,
    }))
    .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN') || a.ep - b.ep)
}

export async function removeCachedEpisode(hash: string): Promise<void> {
  const top = await topDir()
  if (top) await top.removeEntry(hash, { recursive: true })
}

// 超过 30 天没再播放的集删掉；鉴赏神回不删。神回查不到时这一番先不动，下次打开再判。
export async function cleanupExpiredEpisodes(): Promise<void> {
  if (!mediaCacheSupported()) return
  const entries = await listCachedEpisodes()
  for (const e of entries) {
    if (e.daysLeft > 0 || e.good || !e.knownGood) continue
    try {
      await removeCachedEpisode(e.hash)
    } catch (err) {
      console.error('[media-cache] 清理过期缓存失败', e.title, e.ep, err)
    }
  }
}
