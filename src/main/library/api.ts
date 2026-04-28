import { app } from 'electron'
import { join, sep } from 'path'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import crypto from 'crypto'
import chokidar from 'chokidar'

export interface LibraryPath {
  path: string;
  label: string;
}

export interface LibraryEntry {
  id: string;
  title: string;
  nativeTitle: string;
  tags: string;
  episodes: number;
  specs: string;
  image: string;
  folderPath: string;
  addedAt: number;
  totalSize: number;
}

export interface LibraryFile {
  name: string;
  path: string;
  sizeBytes: number;
}

const getPathsFile = () => join(app.getPath('userData'), 'library_paths.json')
const getEntriesFile = () => join(app.getPath('userData'), 'library_entries.json')

// ==========================================
// 动态监听器模块
// ==========================================
let libraryWatcher: chokidar.FSWatcher | null = null
let currentWatchCallback: ((changedPaths: string[]) => void) | null = null
let currentDetectCallback: (() => void) | null = null

export function startLibraryWatch(onLibraryChanged: (changedPaths: string[]) => void, onEventDetected?: () => void) {
  currentWatchCallback = onLibraryChanged
  currentDetectCallback = onEventDetected || null

  if (libraryWatcher) {
    libraryWatcher.close()
  }

  const paths = getPaths().map(p => p.path)
  if (paths.length === 0) return

  libraryWatcher = chokidar.watch(paths, {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 500
    }
  })

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

  libraryWatcher
    .on('add', trigger)
    .on('unlink', trigger)
    .on('addDir', trigger)
    .on('unlinkDir', trigger)
}

// ==========================================
// 数据读写模块
// ==========================================
export function getPaths(): LibraryPath[] {
  try {
    const data = readFileSync(getPathsFile(), 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

export function setPaths(paths: LibraryPath[]): void {
  try {
    const target = getPathsFile()
    writeFileSync(target + '.tmp', JSON.stringify(paths, null, 2))
    renameSync(target + '.tmp', target)
  } catch (err) {
    console.error('Failed to write library paths:', err)
  }
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
  try {
    const data = readFileSync(getEntriesFile(), 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

export function setEntries(entries: LibraryEntry[]): void {
  try {
    const target = getEntriesFile()
    writeFileSync(target + '.tmp', JSON.stringify(entries, null, 2))
    renameSync(target + '.tmp', target)
  } catch (err) {
    console.error('Failed to write library entries:', err)
  }
}

// ==========================================
// 核心扫描模块
// ==========================================

// 递归遍历文件夹，找出直接包含视频文件的子文件夹并记录为条目
async function walkFolder(
  currentPath: string,
  entries: LibraryEntry[],
  existingMap: Map<string, LibraryEntry>
): Promise<void> {
  let episodeCount = 0
  let totalSize = 0

  try {
    const items = await readdir(currentPath, { withFileTypes: true })
    items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))

    const foldersToVisit: string[] = []

    for (const item of items) {
      if (item.name.startsWith('.')) continue

      if (item.isDirectory()) {
        foldersToVisit.push(join(currentPath, item.name))
      } else if (item.isFile()) {
        const ext = item.name.split('.').pop()?.toLowerCase()
        if (['mp4', 'mkv', 'avi', 'flv', 'mov', 'webm'].includes(ext || '')) {
          episodeCount++
          try {
            const s = await stat(join(currentPath, item.name))
            totalSize += s.size
          } catch { /* ignore */ }
        }
      }
    }

    if (episodeCount > 0) {
      const id = crypto.createHash('md5').update(currentPath).digest('hex')
      const sizeGB = (totalSize / (1024 * 1024 * 1024)).toFixed(1)
      const folderName = currentPath.split(/[\\/]/).pop() || 'Local Folder'

      entries.push({
        id,
        title: folderName,
        nativeTitle: '',
        tags: 'Local',
        episodes: episodeCount,
        specs: `${episodeCount > 0 ? 'Varying' : 'Unknown'} • ${sizeGB} GB`,
        image: '',
        folderPath: currentPath,
        addedAt: existingMap.get(id)?.addedAt ?? Date.now(),
        totalSize,
      })
    }

    for (const folder of foldersToVisit) {
      await walkFolder(folder, entries, existingMap)
    }
  } catch { /* path doesn't exist or not accessible */ }
}

export async function getFiles(folderPath: string): Promise<LibraryFile[]> {
  const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'flv', 'mov', 'webm']
  try {
    const items = await readdir(folderPath, { withFileTypes: true })
    const files: LibraryFile[] = []
    for (const item of items) {
      if (!item.isFile() || item.name.startsWith('.')) continue
      const ext = item.name.split('.').pop()?.toLowerCase() || ''
      if (!VIDEO_EXTS.includes(ext)) continue
      try {
        const s = await stat(join(folderPath, item.name))
        files.push({ name: item.name, path: join(folderPath, item.name), sizeBytes: s.size })
      } catch { /* ignore */ }
    }
    return files.sort((a, b) => a.name.localeCompare(b.name))
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
  const scopePath = topChild ? join(watchRoot.path, topChild) : watchRoot.path

  const allEntries = getEntries()
  const existingMap = new Map(allEntries.map(e => [e.id, e]))

  // 保留不在此 scope 下的条目
  const unchanged = allEntries.filter(e =>
    e.folderPath !== scopePath && !e.folderPath.startsWith(scopePath + sep)
  )

  // 只重扫受影响的子树
  const newEntries: LibraryEntry[] = []
  await walkFolder(scopePath, newEntries, existingMap)

  const result = [...unchanged, ...newEntries]
  setEntries(result)
  return result
}

// 全量扫描（用于手动触发和启动时初始化）
export async function scanLibrary(
  onProgress: (status: string, currentVal: number, totalVal: number) => void
): Promise<LibraryEntry[]> {
  const paths = getPaths()
  const entries: LibraryEntry[] = []
  const existingMap = new Map(getEntries().map(e => [e.id, e]))

  for (const libPath of paths) {
    onProgress(`Starting scan for ${libPath.label}...`, 0, 1)
    await walkFolder(libPath.path, entries, existingMap)
  }

  onProgress('Saving index...', 99, 100)
  setEntries(entries)
  onProgress('Scan complete', 100, 100)

  return entries
}
