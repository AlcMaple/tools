import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import crypto from 'crypto'
import ffmpeg from 'fluent-ffmpeg'

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
}

const getPathsFile = () => join(app.getPath('userData'), 'library_paths.json')
const getEntriesFile = () => join(app.getPath('userData'), 'library_entries.json')

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
  }
  return current
}

export function removePath(folderPath: string): LibraryPath[] {
  const current = getPaths().filter(p => p.path !== folderPath)
  setPaths(current)
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

export async function scanLibrary(
  onProgress: (status: string, currentVal: number, totalVal: number) => void
): Promise<LibraryEntry[]> {
  const paths = getPaths()
  const entries: LibraryEntry[] = []

  const thumbnailsDir = join(app.getPath('userData'), 'thumbnails')

  if (existsSync(thumbnailsDir)) {
    onProgress('Clearing old cache...', 0, 1)
    rmSync(thumbnailsDir, { recursive: true, force: true })
  }
  // 重新创建一个干净的空目录
  mkdirSync(thumbnailsDir, { recursive: true })

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

          let imagePath = '' // 默认为空，前端将展示系统默认图

          if (firstVideoPath) {
            const thumbnailFilename = `${id}.jpg`
            const fullThumbnailPath = join(thumbnailsDir, thumbnailFilename)

            // 因为每次扫描前都清空了目录，这里理论上不需要 existsSync 判断了，但保留也无妨
            if (existsSync(fullThumbnailPath)) {
              imagePath = `archivist://${fullThumbnailPath.replace(/\\/g, '/')}`
            } else {
              onProgress(`Checking embedded cover for ${folderName}...`, entries.length, entries.length + 1)

              // 核心提取逻辑：先探测，后提取
              const hasEmbeddedCover = await new Promise<boolean>((resolve) => {
                ffmpeg.ffprobe(firstVideoPath, (err, metadata) => {
                  if (err || !metadata || !metadata.streams) {
                    return resolve(false)
                  }

                  // 寻找被打上了 attached_pic 标记的图片流（MP4/MKV 内嵌封面的标准做法）
                  const coverStreamIndex = metadata.streams.findIndex(
                    (s) => s.disposition && s.disposition.attached_pic === 1
                  )

                  if (coverStreamIndex === -1) {
                    return resolve(false) // 没有找到内嵌封面
                  }

                  // 如果找到了，将该流（通常是 mjpeg 或 png）原封不动拷贝出来
                  ffmpeg(firstVideoPath)
                    .outputOptions([
                      `-map 0:${coverStreamIndex}`, // 精确映射封面流
                      '-c copy'                     // 不重新编码，瞬间完成
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

              // 如果提取成功，才把路径赋给 imagePath
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
            image: imagePath, // 如果没提取到封面，这里依然是 ''
            folderPath: currentPath
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