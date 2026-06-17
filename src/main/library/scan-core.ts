// 媒体库扫描的「纯 Node」核心 —— 只依赖 fs/path/crypto，**不碰任何 Electron API**。
// 既能在主进程内直接调用（增量同步的兜底 / watch 增量），也能原样打包进
// scan-worker.ts 在 worker_threads 里跑（主线程不卡）。
//
// 【为什么不再全量扫描】参考网盘同步的做法：维护一份持久索引，启动只处理「变化」。
// NTFS 在**目录的直接子项**（文件/子目录）增删改名时会更新该目录的修改时间(mtime)。
// 于是我们持久化每个目录的 mtime；启动时只 stat 各目录、跟存档比对：
//   - mtime 没变 → 该目录的文件集合没变 → **直接复用缓存条目，连里面的文件都不读**
//     （跳过最贵的 .ts 探测 open + 每文件 stat），子目录列表也没变 → 用已知子目录
//     递归，连 readdir 都省了。整库没动时启动只剩「每目录 1 次 stat」，亚秒级。
//   - mtime 变了 / 新目录 → 才 readdir + 深扫这一处。
// 这是没有 USN journal / 原生代码下，最接近网盘「秒启动 + 全自动同步」的方案。

import { readdir, stat, open } from 'fs/promises'
import type { Dirent } from 'fs'
import { join, dirname } from 'path'
import crypto from 'crypto'

export interface LibraryPath {
  path: string
  label: string
}

export interface LibraryEntry {
  id: string
  title: string
  nativeTitle: string
  tags: string
  episodes: number
  specs: string
  image: string
  folderPath: string
  addedAt: number
  totalSize: number
}

/** 目录路径 → 上次扫描时的 mtimeMs。增量同步的「变化检测」依据，单独持久化。 */
export type DirMtimes = Record<string, number>

const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'flv', 'mov', 'webm']

// 「低 I/O 优先级」后台爬法：不跟前台抢磁盘。增量同步下绝大多数启动只剩少量 stat，
// 这套限速几乎无感；只有首次 / 大改动的深扫才会真正用到它，避免把慢盘打满拖卡整机。
// 这三个值是「温柔程度」旋钮：还卡就 SLEEP 调大 / EVERY_OPS 调小。
const SCAN_FS_CONCURRENCY = 2
const YIELD_EVERY_OPS = 24
const YIELD_SLEEP_MS = 10

export type ScanGate = <T>(fn: () => Promise<T>) => Promise<T>

// 直通闸（不限流）—— 给 getFiles 等按需小调用用，保持原行为。
export const passthroughGate: ScanGate = (fn) => fn()

export function createScanGate(maxConcurrent: number = SCAN_FS_CONCURRENCY): ScanGate {
  let active = 0
  const waiters: Array<() => void> = []
  let opsSinceYield = 0
  return async function gate<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) await new Promise<void>((res) => waiters.push(res))
    active++
    try {
      return await fn()
    } finally {
      active--
      waiters.shift()?.()
      if (++opsSinceYield >= YIELD_EVERY_OPS) {
        opsSinceYield = 0
        await new Promise<void>((res) => setTimeout(res, YIELD_SLEEP_MS))
      }
    }
  }
}

// MPEG-TS 同步字节检测：0x47 出现在 offset 0 和 188（一个 TS 包长度）
async function isMpegTs(filePath: string, gate: ScanGate = passthroughGate): Promise<boolean> {
  let fd: Awaited<ReturnType<typeof open>> | null = null
  try {
    fd = await gate(() => open(filePath, 'r'))
    const buf = Buffer.alloc(189)
    const { bytesRead } = await gate(() => fd!.read(buf, 0, 189, 0))
    return bytesRead === 189 && buf[0] === 0x47 && buf[188] === 0x47
  } catch {
    return false
  } finally {
    await fd?.close()
  }
}

export async function isVideoFile(filePath: string, name: string, gate: ScanGate = passthroughGate): Promise<boolean> {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  if (VIDEO_EXTS.includes(ext)) return true
  if (ext === 'ts') return isMpegTs(filePath, gate)
  return false
}

// 由文件夹路径 + 统计结果组装一条条目。addedAt 优先沿用旧条目（保留「加入时间」）。
function buildEntry(
  folderPath: string,
  episodeCount: number,
  totalSize: number,
  prevAddedAt?: number
): LibraryEntry {
  const id = crypto.createHash('md5').update(folderPath).digest('hex')
  const sizeGB = (totalSize / (1024 * 1024 * 1024)).toFixed(1)
  const folderName = folderPath.split(/[\\/]/).pop() || 'Local Folder'
  return {
    id,
    title: folderName,
    nativeTitle: '',
    tags: 'Local',
    episodes: episodeCount,
    specs: `Varying • ${sizeGB} GB`,
    image: '',
    folderPath,
    addedAt: prevAddedAt ?? Date.now(),
    totalSize,
  }
}

// 深扫某目录的「直接文件」，并发判定 + 累计视频数 / 体积（顺序无关，安全）。
async function scanDirFiles(
  dir: string,
  fileNames: string[],
  gate: ScanGate
): Promise<{ episodeCount: number; totalSize: number }> {
  let episodeCount = 0
  let totalSize = 0
  await Promise.all(fileNames.map(async (name) => {
    const fullPath = join(dir, name)
    if (!(await isVideoFile(fullPath, name, gate))) return
    episodeCount++
    try {
      const s = await gate(() => stat(fullPath))
      totalSize += s.size
    } catch { /* ignore */ }
  }))
  return { episodeCount, totalSize }
}

// 全量深扫一个子树（不走 mtime 快捷）—— 给 watch 增量更新用：某目录确实变了，
// 重扫它这一支。entries 顺序由调用方统一 sort。
export async function walkFolder(
  currentPath: string,
  entries: LibraryEntry[],
  existingMap: Map<string, LibraryEntry>,
  gate: ScanGate
): Promise<void> {
  // @types/node 25 起 Dirent 变成泛型；string 路径下 withFileTypes 返回 Dirent<string>[]。
  // 用 Awaited<ReturnType<typeof readdir>> 会错选到 Buffer 重载，故显式标注。
  let items: Dirent<string>[]
  try {
    items = await gate(() => readdir(currentPath, { withFileTypes: true }))
  } catch {
    return
  }
  const subdirs: string[] = []
  const files: string[] = []
  for (const item of items) {
    if (item.name.startsWith('.')) continue
    if (item.isDirectory()) subdirs.push(join(currentPath, item.name))
    else if (item.isFile()) files.push(item.name)
  }
  const { episodeCount, totalSize } = await scanDirFiles(currentPath, files, gate)
  if (episodeCount > 0) {
    const id = crypto.createHash('md5').update(currentPath).digest('hex')
    entries.push(buildEntry(currentPath, episodeCount, totalSize, existingMap.get(id)?.addedAt))
  }
  await Promise.all(subdirs.map((sub) => walkFolder(sub, entries, existingMap, gate)))
}

// 增量同步：基于上次的目录 mtime 索引，只读真正变化的目录。返回新的条目 + 新的
// 目录 mtime 索引（两者一起持久化）。prevDirMtimes 为空（首次 / 强制全扫）时，
// 每个目录都被当成"变了"，自然退化成一次全量扫描，并把 mtime 建起来。
export async function syncLibrary(
  paths: LibraryPath[],
  prevEntries: LibraryEntry[],
  prevDirMtimes: DirMtimes
): Promise<{ entries: LibraryEntry[]; dirMtimes: DirMtimes }> {
  const prevByPath = new Map(prevEntries.map((e) => [e.folderPath, e]))
  // 上次已知的「父目录 → 子目录列表」—— 未变目录据此递归，省掉 readdir。
  const prevChildren = new Map<string, string[]>()
  for (const d of Object.keys(prevDirMtimes)) {
    const parent = dirname(d)
    const arr = prevChildren.get(parent)
    if (arr) arr.push(d)
    else prevChildren.set(parent, [d])
  }

  const entries: LibraryEntry[] = []
  const dirMtimes: DirMtimes = {}
  const gate = createScanGate()

  async function visit(dir: string): Promise<void> {
    let mtimeMs: number
    try {
      mtimeMs = (await gate(() => stat(dir))).mtimeMs
    } catch {
      return // 目录不存在 / 不可访问 —— 不收录（被删的目录自然被剔除）
    }
    dirMtimes[dir] = mtimeMs

    const prevMtime = prevDirMtimes[dir]
    if (prevMtime !== undefined && prevMtime === mtimeMs) {
      // 未变：复用缓存条目；子目录列表也没变 → 用已知子目录递归，不 readdir、不读文件。
      const cached = prevByPath.get(dir)
      if (cached) entries.push(cached)
      const kids = prevChildren.get(dir)
      if (kids) await Promise.all(kids.map(visit))
      return
    }

    // 变了 / 新目录：readdir 发现当前结构，深扫这一层文件，再递归子目录。
    // @types/node 25 起 Dirent 变成泛型；string 路径下 withFileTypes 返回 Dirent<string>[]。
  // 用 Awaited<ReturnType<typeof readdir>> 会错选到 Buffer 重载，故显式标注。
  let items: Dirent<string>[]
    try {
      items = await gate(() => readdir(dir, { withFileTypes: true }))
    } catch {
      return
    }
    const subdirs: string[] = []
    const files: string[] = []
    for (const item of items) {
      if (item.name.startsWith('.')) continue
      if (item.isDirectory()) subdirs.push(join(dir, item.name))
      else if (item.isFile()) files.push(item.name)
    }
    const { episodeCount, totalSize } = await scanDirFiles(dir, files, gate)
    if (episodeCount > 0) {
      entries.push(buildEntry(dir, episodeCount, totalSize, prevByPath.get(dir)?.addedAt))
    }
    await Promise.all(subdirs.map(visit))
  }

  for (const libPath of paths) await visit(libPath.path)
  entries.sort((a, b) => (a.folderPath < b.folderPath ? -1 : a.folderPath > b.folderPath ? 1 : 0))
  return { entries, dirMtimes }
}
