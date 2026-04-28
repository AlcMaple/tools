import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
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
// 动态监听器模块 (新增)
// ==========================================
let libraryWatcher: chokidar.FSWatcher | null = null
let currentWatchCallback: (() => void) | null = null
let currentDetectCallback: (() => void) | null = null

export function startLibraryWatch(onLibraryChanged: () => void, onEventDetected?: () => void) {
  currentWatchCallback = onLibraryChanged // 保存回调，以备后用
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
      pollInterval: 100
    }
  })

  let timeout: NodeJS.Timeout
  const trigger = () => {
    if (currentDetectCallback) currentDetectCallback();
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      onLibraryChanged()
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
    writeFileSync(getPathsFile(), JSON.stringify(paths, null, 2))
  } catch (err) {
    console.error('Failed to write library paths:', err)
  }
}

export function addPath(folderPath: string, label: string): LibraryPath[] {
  const current = getPaths()
  if (!current.some(p => p.path === folderPath)) {
    current.push({ path: folderPath, label })
    setPaths(current)
    // 添加新路径后，立刻用保存的回调重启监听器
    if (currentWatchCallback) startLibraryWatch(currentWatchCallback, currentDetectCallback || undefined)
  }
  return current
}

export function removePath(folderPath: string): LibraryPath[] {
  const current = getPaths().filter(p => p.path !== folderPath)
  setPaths(current)
  // 移除路径后，同样重启监听器
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
    writeFileSync(getEntriesFile(), JSON.stringify(entries, null, 2))
  } catch (err) {
    console.error('Failed to write library entries:', err)
  }
}

// ==========================================
// 核心扫描模块
// ==========================================
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

export async function scanLibrary(
  onProgress: (status: string, currentVal: number, totalVal: number) => void
): Promise<LibraryEntry[]> {
  const paths = getPaths()
  const entries: LibraryEntry[] = []
  const existingMap = new Map(getEntries().map(e => [e.id, e]))

  for (const libPath of paths) {
    onProgress(`Starting scan for ${libPath.label}...`, 0, 1)

    async function walk(currentPath: string) {
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
            if (['mp4', 'mkv', 'avi', 'flv', 'mov', 'webm', 'ts'].includes(ext || '')) {
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

          onProgress(`Found: ${folderName}`, entries.length, entries.length + 1)
        }

        for (const folder of foldersToVisit) {
          await walk(folder)
        }

      } catch (err) {
        console.error(`Failed to read path ${currentPath}:`, err)
      }
    }

    await walk(libPath.path)
  }

  onProgress('Saving index...', 99, 100)
  setEntries(entries)
  onProgress('Scan complete', 100, 100)

  return entries
}