import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import crypto from 'crypto'
import ffmpeg from 'fluent-ffmpeg'
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

export function startLibraryWatch(onLibraryChanged: () => void,onEventDetected?: () => void) {
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
    .on('change', trigger)
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
  onProgress: (status: string, currentVal: number, totalVal: number) => void,
  isAutoScan: boolean = false // 👈 新增标识：区分是手动强制扫描，还是后台自动更新
): Promise<LibraryEntry[]> {
  const paths = getPaths()
  const entries: LibraryEntry[] = []
  // 保留旧条目的 addedAt，避免重扫时丢失首次发现时间
  const existingMap = new Map(getEntries().map(e => [e.id, e]))

  const thumbnailsDir = join(app.getPath('userData'), 'thumbnails')

  // 如果是手动扫描，暴力清理旧缓存；如果是自动扫描，保留现有缓存以提升性能
  if (!isAutoScan && existsSync(thumbnailsDir)) {
    onProgress('Clearing old cache...', 0, 1)
    rmSync(thumbnailsDir, { recursive: true, force: true })
  }
  if (!existsSync(thumbnailsDir)) {
    mkdirSync(thumbnailsDir, { recursive: true })
  }

  for (const libPath of paths) {
    onProgress(`Starting scan for ${libPath.label}...`, 0, 1)

    async function walk(currentPath: string) {
      let episodeCount = 0
      let totalSize = 0
      let firstVideoPath = ''

      try {
        const items = await readdir(currentPath, { withFileTypes: true })
        const foldersToVisit: string[] = []

        for (const item of items) {
          if (item.name.startsWith('.')) continue

          if (item.isDirectory()) {
            foldersToVisit.push(join(currentPath, item.name))
          } else if (item.isFile()) {
            const ext = item.name.split('.').pop()?.toLowerCase()
            if (['mp4', 'mkv', 'avi', 'flv', 'mov', 'webm'].includes(ext || '')) {
              episodeCount++
              if (!firstVideoPath) firstVideoPath = join(currentPath, item.name)
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

          let imagePath = '' 

          if (firstVideoPath) {
            const thumbnailFilename = `${id}.jpg`
            const fullThumbnailPath = join(thumbnailsDir, thumbnailFilename)

            // 因为后台自动扫描不会清空目录，这里存在的话就直接复用，秒出结果
            if (existsSync(fullThumbnailPath)) {
              imagePath = `archivist://${fullThumbnailPath.replace(/\\/g, '/')}`
            } else {
              onProgress(`Checking embedded cover for ${folderName}...`, entries.length, entries.length + 1)

              const hasEmbeddedCover = await new Promise<boolean>((resolve) => {
                ffmpeg.ffprobe(firstVideoPath, (err, metadata) => {
                  if (err || !metadata || !metadata.streams) {
                    return resolve(false)
                  }

                  const coverStreamIndex = metadata.streams.findIndex(
                    (s) => s.disposition && s.disposition.attached_pic === 1
                  )

                  if (coverStreamIndex === -1) {
                    return resolve(false) 
                  }

                  ffmpeg(firstVideoPath)
                    .outputOptions([
                      `-map 0:${coverStreamIndex}`, 
                      '-c copy'                     
                    ])
                    .output(fullThumbnailPath)
                    .on('end', () => resolve(true))
                    .on('error', (e) => {
                      console.error(`Failed to extract embedded cover for ${folderName}:`, e)
                      resolve(false)
                    })
                    .run()
                })
              })

              if (hasEmbeddedCover) {
                imagePath = `archivist://${fullThumbnailPath.replace(/\\/g, '/')}`
              }
            }
          }

          entries.push({
            id,
            title: folderName,
            nativeTitle: '',
            tags: 'Local',
            episodes: episodeCount,
            specs: `${episodeCount > 0 ? 'Varying' : 'Unknown'} • ${sizeGB} GB`,
            image: imagePath,
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