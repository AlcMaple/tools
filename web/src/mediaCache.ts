// 在线播放的本地缓存（OPFS `media-cache/<hash>/`）在网页这一侧只做两件事：列出 / 删除，和打开网站时清掉过期的。
// 写入只发生在播放页的 public/media-cache-worker.js，读取在 public/cover-cache-sw.js；目录结构三处一致：
// `meta.json` + 按 1MB 切开的 `<序号>.bin`（mp4），或 `index.m3u8` + 整片的 `r<序号>`（HLS）。
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

// 已下完的集 meta.total 就是总字节（mp4 是源站长度，HLS 是下完时累计的字节），不用再逐片 getFile：
// 一集有几百个分片文件，缓存几十集时逐个读文件是放映室打开慢的根因。没下完或旧数据（total 为 0）才扫目录，且并行读
async function readEntry(hash: string, dir: FileSystemDirectoryHandle): Promise<(Meta & { hash: string; bytes: number }) | null> {
  let meta: Meta
  try {
    meta = JSON.parse(await (await (await dir.getFileHandle('meta.json')).getFile()).text()) as Meta
  } catch (err) {
    if ((err as DOMException).name === 'NotFoundError') return null
    throw err
  }
  if (meta.complete && meta.total > 0) return { ...meta, hash, bytes: meta.total }
  const files: Promise<number>[] = []
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file' && name !== 'meta.json') files.push((handle as FileSystemFileHandle).getFile().then((f) => f.size))
  }
  const bytes = (await Promise.all(files)).reduce((sum, n) => sum + n, 0)
  return { ...meta, hash, bytes }
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
  const dirs: [string, FileSystemDirectoryHandle][] = []
  for await (const [hash, handle] of top.entries()) if (handle.kind === 'directory') dirs.push([hash, handle as FileSystemDirectoryHandle])
  const raw: (Meta & { hash: string; bytes: number })[] = []
  // 分批并行：一次全开会把浏览器的文件句柄请求堆满，8 个一批足够把磁盘读满
  for (let i = 0; i < dirs.length; i += 8) {
    await Promise.all(dirs.slice(i, i + 8).map(async ([hash, dir]) => {
      try {
        const entry = await readEntry(hash, dir)
        if (entry) raw.push(entry)
      } catch (err) {
        console.error('[media-cache] 读取缓存条目失败', hash, err)
      }
    }))
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
