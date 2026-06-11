import { join, sep } from 'path'
import { existsSync, watch, type FSWatcher } from 'fs'
import { readdir, stat } from 'fs/promises'
import { Worker } from 'worker_threads'
import { JsonStore } from '../shared/json-store'
import {
  walkFolder,
  syncLibrary,
  isVideoFile,
  createScanGate,
  type LibraryPath,
  type LibraryEntry,
  type DirMtimes,
} from './scan-core'

// 扫描相关的纯逻辑 + 类型都收敛进 scan-core（既能进 worker 又能主线程兜底）。
// 这里 re-export 类型，所有老的 `import { LibraryEntry } from './library/api'` 不变。
export type { LibraryPath, LibraryEntry } from './scan-core'

export interface LibraryFile {
  name: string;
  path: string;
  sizeBytes: number;
}

// 路径表 + 扫描结果都走 JsonStore：内存权威值(读瞬时)、写异步合并落盘。
// getPaths/getEntries 等保持同步签名(内部 current() 同步读内存),所有调用方不变;
// 原本每次 setEntries 的同步 writeFileSync(entries 可能很大)改成异步,不再卡。
const pathsStore = new JsonStore<LibraryPath[]>('library_paths.json', (raw) =>
  Array.isArray(raw) ? (raw as LibraryPath[]) : [],
)
const entriesStore = new JsonStore<LibraryEntry[]>('library_entries.json', (raw) =>
  Array.isArray(raw) ? (raw as LibraryEntry[]) : [],
)
// 目录 mtime 索引：增量同步的「变化检测」存档（目录路径 → 上次扫到的 mtimeMs）。
// 跟 entries 分开存，不动 LibraryEntry 结构。空对象兜底 → 首次启动退化成全量扫描。
const dirIndexStore = new JsonStore<DirMtimes>('library_dir_index.json', (raw) =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as DirMtimes) : {},
)
function getDirIndex(): DirMtimes {
  return dirIndexStore.current()
}
function setDirIndex(dirMtimes: DirMtimes): void {
  dirIndexStore.set(dirMtimes)
}

// ==========================================
// 动态监听器模块
// ==========================================
//
// 用 Node 原生 fs.watch 递归监听,不用 chokidar:chokidar 不走 Windows 原生递归,
// 而是遍历整棵树给**每个目录**开一个 fs.watch 句柄 —— uv_fs_event_start 的系统调用
// 在主线程事件循环上同步执行,几千个目录连发就是 2-3s 的主进程冻结(实测拖不动窗口,
// 见 docs/ideas/010)。原生 fs.watch({recursive:true}) 每个库根只开 1 个句柄
// (Windows = ReadDirectoryChangesW 递归,macOS = FSEvents),零遍历、设置即时。
let libraryWatchers: FSWatcher[] = []
let currentWatchCallback: ((changedPaths: string[]) => void) | null = null
let currentDetectCallback: (() => void) | null = null

export function startLibraryWatch(onLibraryChanged: (changedPaths: string[]) => void, onEventDetected?: () => void) {
  currentWatchCallback = onLibraryChanged
  currentDetectCallback = onEventDetected || null

  for (const w of libraryWatchers) w.close()
  libraryWatchers = []

  const paths = getPaths().map(p => p.path)
  if (paths.length === 0) return

  let timeout: NodeJS.Timeout
  const pendingPaths = new Set<string>()

  const trigger = (eventPath: string) => {
    if (currentDetectCallback) currentDetectCallback()
    pendingPaths.add(eventPath)
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      const paths = [...pendingPaths]
      pendingPaths.clear()
      onLibraryChanged(paths)
    }, 1000)
  }

  for (const root of paths) {
    try {
      const w = watch(root, { recursive: true }, (eventType, filename) => {
        // 只听 rename(增删/改名,对应旧 chokidar 的 add/unlink/addDir/unlinkDir)。
        // change 是内容写入 —— 旧实现也不听,且下载中的文件会高频触发,纯噪音。
        if (eventType !== 'rename') return
        const rel = filename ? filename.toString() : ''
        // 隐藏文件/目录(路径任一段以 . 开头)不触发,与旧 ignored 规则一致。
        if (rel.split(/[\\/]/).some(seg => seg.startsWith('.'))) return
        trigger(rel ? join(root, rel) : root)
      })
      // 监听根被删除/失去权限时会发 error,不接住会变成未捕获异常炸主进程;
      // 失效路径下次启动由 reconcilePaths 对账剔除。
      w.on('error', (err) => console.error(`媒体库监听失效(${root}):`, err))
      libraryWatchers.push(w)
    } catch (err) {
      // 单个路径起不来(被删 / 平台不支持递归监听)不影响其余路径与扫描功能
      console.error(`媒体库监听启动失败(${root}):`, err)
    }
  }
}

// ==========================================
// 数据读写模块
// ==========================================
export function getPaths(): LibraryPath[] {
  return pathsStore.current()
}

export function setPaths(paths: LibraryPath[]): void {
  pathsStore.set(paths)
}

export function addPath(folderPath: string, label: string): LibraryPath[] {
  const current = getPaths()
  if (!current.some(p => p.path === folderPath)) {
    current.push({ path: folderPath, label })
    setPaths(current)
    if (currentWatchCallback) startLibraryWatch(currentWatchCallback, currentDetectCallback || undefined)
  }
  return current
}

export function removePath(folderPath: string): LibraryPath[] {
  const current = getPaths().filter(p => p.path !== folderPath)
  setPaths(current)
  // 同步剔除该路径下的条目 + 目录 mtime 索引 —— 删路径只是把这块数据从索引里拿掉，
  // 不需要扫描（正是网盘思路：路径增删 = 索引加减）。否则要等下次同步才清理干净。
  const prefix = folderPath.endsWith(sep) ? folderPath : folderPath + sep
  const keep = (p: string): boolean => p !== folderPath && !p.startsWith(prefix)
  setEntries(getEntries().filter(e => keep(e.folderPath)))
  const di = getDirIndex()
  const nextDi: DirMtimes = {}
  for (const k of Object.keys(di)) if (keep(k)) nextDi[k] = di[k]
  setDirIndex(nextDi)
  if (currentWatchCallback) startLibraryWatch(currentWatchCallback, currentDetectCallback || undefined)
  return current
}

// 对账：剔除磁盘上已不存在的路径（用户手动删除文件夹后留下的残留条目）
export function reconcilePaths(): LibraryPath[] {
  const current = getPaths()
  const alive = current.filter(p => existsSync(p.path))
  if (alive.length !== current.length) {
    setPaths(alive)
  }
  return alive
}

export function getEntries(): LibraryEntry[] {
  return entriesStore.current()
}

export function setEntries(entries: LibraryEntry[]): void {
  entriesStore.set(entries)
}

// ==========================================
// 核心扫描模块
// ==========================================
//
// 遍历逻辑都在 scan-core.ts（纯 Node）。这里只负责：把增量同步丢进 worker_threads
// 跑（主线程不卡）、worker 起不来时退回主线程兜底、以及 watch 的小范围重扫。

interface SyncResult {
  entries: LibraryEntry[]
  dirMtimes: DirMtimes
}

// 在 worker 里跑增量同步。worker 有独立事件循环 + 独立 libuv 线程池，整棵树的遍历
// 都在那条线程上，主进程线程全程空闲 —— 同步期间封面 / 切页 / 读盘 / 拖窗口都不被
// 它占住。worker 脚本由 electron-vite 单独打包到 out/main/scan-worker.js。
function syncInWorker(
  paths: LibraryPath[],
  prevEntries: LibraryEntry[],
  prevDirMtimes: DirMtimes,
): Promise<SyncResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void): void => { if (!settled) { settled = true; fn() } }
    const worker = new Worker(join(__dirname, 'scan-worker.js'))
    worker.once('message', (msg: { ok: boolean; entries?: LibraryEntry[]; dirMtimes?: DirMtimes; error?: string }) => {
      void worker.terminate()
      if (msg?.ok && Array.isArray(msg.entries) && msg.dirMtimes) {
        finish(() => resolve({ entries: msg.entries!, dirMtimes: msg.dirMtimes! }))
      } else {
        finish(() => reject(new Error(msg?.error || 'scan worker failed')))
      }
    })
    worker.once('error', (err) => { void worker.terminate(); finish(() => reject(err)) })
    worker.postMessage({ paths, prevEntries, prevDirMtimes })
  })
}

export async function getFiles(folderPath: string): Promise<LibraryFile[]> {
  try {
    const items = await readdir(folderPath, { withFileTypes: true })
    const files: LibraryFile[] = []
    for (const item of items) {
      if (!item.isFile() || item.name.startsWith('.')) continue
      const fullPath = join(folderPath, item.name)
      if (!await isVideoFile(fullPath, item.name)) continue
      try {
        const s = await stat(fullPath)
        files.push({ name: item.name, path: fullPath, sizeBytes: s.size })
      } catch { /* ignore */ }
    }
    return files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  } catch {
    return []
  }
}

// 增量更新：只重扫 changedPath 所在的顶层子目录，不触动其他路径
export async function incrementalUpdate(changedPath: string): Promise<LibraryEntry[]> {
  const watchedPaths = getPaths()

  // 找到包含此事件路径的监听根目录
  const watchRoot = watchedPaths.find(p => {
    const root = p.path.endsWith(sep) ? p.path : p.path + sep
    return changedPath === p.path || changedPath.startsWith(root)
  })
  if (!watchRoot) return getEntries()

  // 确定扫描范围：监听根的第一层子目录（或根本身）
  const rel = changedPath.slice(watchRoot.path.length).replace(/^[/\\]/, '')
  const topChild = rel.split(/[/\\]/)[0]
  let scopePath: string
  if (!topChild) {
    scopePath = watchRoot.path
  } else {
    const candidate = join(watchRoot.path, topChild)
    try {
      const s = await stat(candidate)
      // 是目录才以它为 scope；是文件说明变动发生在 watch root 直接层，重扫 root
      scopePath = s.isDirectory() ? candidate : watchRoot.path
    } catch {
      // 已删除：若事件路径含子目录分隔符，说明删的是子目录内的项，用顶层子目录为 scope
      // 否则删的是 watch root 的直接子项（文件或文件夹），重扫 root
      scopePath = rel.includes(sep) ? candidate : watchRoot.path
    }
  }

  const allEntries = getEntries()
  const existingMap = new Map(allEntries.map(e => [e.id, e]))

  // 保留不在此 scope 下的条目
  const unchanged = allEntries.filter(e =>
    e.folderPath !== scopePath && !e.folderPath.startsWith(scopePath + sep)
  )

  // 只重扫受影响的子树（增量范围小，直接主线程跑即可，不值得起 worker）
  const newEntries: LibraryEntry[] = []
  await walkFolder(scopePath, newEntries, existingMap, createScanGate())

  const result = [...unchanged, ...newEntries]
    .sort((a, b) => (a.folderPath < b.folderPath ? -1 : a.folderPath > b.folderPath ? 1 : 0))
  setEntries(result)
  return result
}

// 增量同步（启动 / 手动刷新 / 加路径后都走它）。基于上次的目录 mtime 索引只读变化的
// 目录：整库没动时只剩"每目录 1 次 stat"，亚秒级；改了的目录才深扫。首次 / 索引为空
// 时自然退化成一次全量扫描并建好索引。优先丢进 worker（主线程不卡），worker 起不来则
// 退回主线程兜底 —— 功能不丢。
export async function scanLibrary(
  onProgress: (status: string, currentVal: number, totalVal: number) => void
): Promise<LibraryEntry[]> {
  const paths = getPaths()
  const prevEntries = getEntries()
  const prevDirMtimes = getDirIndex()
  onProgress('Scanning library...', 0, 1)

  let result: SyncResult
  try {
    result = await syncInWorker(paths, prevEntries, prevDirMtimes)
  } catch (err) {
    console.error('扫描 worker 失败，退回主线程扫描:', err)
    result = await syncLibrary(paths, prevEntries, prevDirMtimes)
  }

  onProgress('Saving index...', 99, 100)
  setEntries(result.entries)
  setDirIndex(result.dirMtimes)
  onProgress('Scan complete', 100, 100)

  return result.entries
}
