import { app } from 'electron'
import { join, basename, dirname } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs'
import { readdir, stat, unlink } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import crypto from 'crypto'
import ffmpeg from 'fluent-ffmpeg'
import chokidar from 'chokidar'

const execFileAsync = promisify(execFile)

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

// ==========================================
// 缩略图提取模块
// ==========================================

/**
 * 从视频文件提取缩略图，保存到 outputPath（.jpg）。
 * macOS：优先用 qlmanage（与访达/QuickLook 完全一致），失败时 fallback 到 ffmpeg 截帧。
 * Windows：优先用 IShellItemImageFactory（与资源管理器完全一致），失败时 fallback 到 ffmpeg。
 * Linux：ffmpeg 截帧。
 */
async function extractVideoThumbnail(videoPath: string, outputPath: string): Promise<boolean> {
  if (process.platform === 'darwin') {
    const folderName = basename(videoPath) // e.g. "ep01.mp4"
    const outputDir = dirname(outputPath)
    const qlOut = join(outputDir, `${folderName}.png`) // qlmanage 固定输出 <filename>.png

    try {
      await execFileAsync('/usr/bin/qlmanage', ['-t', '-s', '640', '-o', outputDir, videoPath], {
        timeout: 15000,
      })
      if (existsSync(qlOut)) {
        // 用 sips 将 PNG 转为 JPG（macOS 内置，无需 ffmpeg，不受 PATH 影响）
        try {
          await execFileAsync('/usr/bin/sips', ['-s', 'format', 'jpeg', qlOut, '--out', outputPath], { timeout: 10000 })
          await unlink(qlOut).catch(() => { /* ignore */ })
          if (existsSync(outputPath)) return true
        } catch { /* sips 失败，清理并 fallback */ }
        await unlink(qlOut).catch(() => { /* ignore */ })
      }
    } catch { /* qlmanage 失败，fallback 到 ffmpeg */ }
  }

  // Windows：使用 IShellItemImageFactory 获取与资源管理器完全一致的缩略图
  // 通过 PowerShell + P/Invoke 调用 Windows Shell API
  // 使用 -EncodedCommand（Base64 UTF-16LE）避免中文路径的编码问题
  if (process.platform === 'win32') {
    // 在单引号 here-string @'...'@ 中路径完全字面值，不被 PowerShell 解释
    const psScript = `
if (-not ([System.Management.Automation.PSTypeName]'WinThumb').Type) {
  Add-Type @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
public class WinThumb {
  [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; }
  [ComImport,Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem { void M1();void M2();void M3();void M4();void M5(); }
  [ComImport,Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemImageFactory { [PreserveSig] int GetImage([In] SIZE sz,[In] uint f,[Out] out IntPtr h); }
  [DllImport("shell32.dll",CharSet=CharSet.Unicode)]
  public static extern int SHCreateItemFromParsingName(string p,IntPtr b,ref Guid r,out IntPtr ppv);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr h);
  public static bool Extract(string src,string dst) {
    try {
      Guid g=new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
      IntPtr pItem;
      if(SHCreateItemFromParsingName(src,IntPtr.Zero,ref g,out pItem)!=0||pItem==IntPtr.Zero)return false;
      object obj=Marshal.GetObjectForIUnknown(pItem);
      Marshal.Release(pItem);
      var fac=obj as IShellItemImageFactory;
      if(fac==null)return false;
      SIZE sz=new SIZE{cx=256,cy=256};
      IntPtr hBm=IntPtr.Zero;
      // 策略1：SIIGBF_INCACHEONLY(16) — 只从 Windows 缩略图缓存读，与资源管理器显示完全一致
      // 策略2：SIIGBF_THUMBNAILONLY(8) — 重新生成纯视频缩略图（不含图标 overlay）
      if(fac.GetImage(sz,16,out hBm)!=0) fac.GetImage(sz,8,out hBm);
      if(hBm==IntPtr.Zero)return false;
      using(var src2=Image.FromHbitmap(hBm)){
        var bmp=new Bitmap(src2.Width,src2.Height,PixelFormat.Format24bppRgb);
        using(var g2=Graphics.FromImage(bmp)){g2.CompositingMode=CompositingMode.SourceCopy;g2.DrawImage(src2,0,0);}
        bmp.Save(dst,ImageFormat.Jpeg);bmp.Dispose();
      }
      DeleteObject(hBm);
      return System.IO.File.Exists(dst);
    }catch(Exception ex){Console.Error.WriteLine(ex.Message);return false;}
  }
}
"@ -ReferencedAssemblies System.Drawing
}
$src = @'
${videoPath}
'@.Trim()
$dst = @'
${outputPath}
'@.Trim()
$result = if([WinThumb]::Extract($src,$dst)){"ok"}else{"fail"}
Write-Host $result
`
    try {
      // Base64 UTF-16LE 编码整个脚本，彻底解决中文路径传递给 PowerShell 的编码问题
      const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { timeout: 30000 }
      )
      if (stdout.trim() === 'ok' && existsSync(outputPath)) return true
    } catch (e) {
      console.error('[Library] WinThumb Shell API failed:', (e as Error).message, '→ fallback to ffmpeg')
    }
  }

  // Linux / ffmpeg fallback（Windows Shell API 失败时也走这里）
  // 取视频 5% 位置，对 24 分钟动漫约 72 秒，通常在 OP 内
  return new Promise<boolean>((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      const duration = meta?.format?.duration ?? 0
      const seekSec = duration > 0 ? Math.min(duration * 0.05, 60) : 5
      ffmpeg(videoPath)
        .inputOptions([`-ss ${seekSec.toFixed(2)}`])
        .outputOptions(['-frames:v', '1', '-vf', 'scale=640:-1', '-q:v', '3'])
        .output(outputPath)
        .on('end', () => resolve(existsSync(outputPath)))
        .on('error', () => resolve(false))
        .run()
    })
  })
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
        // 按自然数字排序（与 Windows 资源管理器一致），确保 firstVideoPath 是集数最小的文件
        // NTFS 原始顺序通常按创建时间，不按文件名，会导致误选第 7 集、第 13 集等
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

            // archivist:/// 三斜杠格式：host 为空，完整路径（含 Windows 盘符）放在 pathname
            // 避免 Chromium 把 C: 当作 host 解析导致盘符丢失（如 archivist://C:/... → host=c, 盘符丢）
            const toArchivistUrl = (p: string) =>
              `archivist:///${p.replace(/\\/g, '/').replace(/^\//, '')}`

            // 后台自动扫描不清空目录，已有缓存直接复用
            if (existsSync(fullThumbnailPath)) {
              imagePath = toArchivistUrl(fullThumbnailPath)
            } else {
              // 先尝试 attached_pic 嵌入封面（BD/CRC 资源常见），否则走 extractVideoThumbnail
              onProgress(`Extracting thumbnail for ${folderName}...`, entries.length, entries.length + 1)

              const success = await new Promise<boolean>((resolve) => {
                ffmpeg.ffprobe(firstVideoPath, (err, metadata) => {
                  if (err || !metadata?.streams) {
                    extractVideoThumbnail(firstVideoPath, fullThumbnailPath).then(resolve)
                    return
                  }

                  const streams = metadata.streams
                  console.log(`[Library] ffprobe streams for ${firstVideoPath}:`,
                    streams.map(s => ({ idx: s.index, type: s.codec_type, codec: s.codec_name, attached: s.disposition?.attached_pic, fps: s.avg_frame_rate })))

                  // 策略1：标准 attached_pic（MP4 covr atom / 部分 MKV）
                  let coverIdx = streams.findIndex(
                    s => s.disposition?.attached_pic === 1
                  )

                  // 策略2：codec 为 mjpeg/png 且帧率为 0 的视频流（某些 muxer 不设 attached_pic 标志）
                  if (coverIdx === -1) {
                    coverIdx = streams.findIndex(
                      s => s.codec_type === 'video' &&
                        (s.codec_name === 'mjpeg' || s.codec_name === 'png') &&
                        (s.avg_frame_rate === '0/0' || s.r_frame_rate === '0/0')
                    )
                  }

                  // 策略3：MKV attachment 流（cover.jpg / poster.jpg 等附件）
                  if (coverIdx === -1) {
                    coverIdx = streams.findIndex(
                      s => s.codec_type === 'attachment' &&
                        /\.(jpe?g|png|webp)$/i.test((s.tags as Record<string, string>)?.filename ?? '')
                    )
                  }

                  console.log(`[Library] coverIdx=${coverIdx}`)
                  if (coverIdx !== -1) {
                    const coverStream = streams[coverIdx]
                    const isCopyable = coverStream?.codec_name === 'mjpeg' || coverStream?.codec_name === 'png'

                    // mjpeg/png 封面：优先 -c:v copy 直接复制（最快最准确）
                    // 其他格式（hevc/av1 等）：转码输出 JPEG
                    const extractCover = (useCopy: boolean) => new Promise<boolean>((res) => {
                      ffmpeg(firstVideoPath)
                        .outputOptions(
                          useCopy
                            ? [`-map 0:${coverIdx}`, '-c:v copy']
                            : [`-map 0:${coverIdx}`, '-vframes 1', '-q:v 2']
                        )
                        .output(fullThumbnailPath)
                        .on('end', () => {
                          const ok = existsSync(fullThumbnailPath)
                          console.log(`[Library] cover extract (${useCopy ? 'copy' : 'transcode'}) ${ok ? 'OK' : 'FAIL'} → ${fullThumbnailPath}`)
                          res(ok)
                        })
                        .on('error', (e) => {
                          console.error(`[Library] cover extract error (${useCopy ? 'copy' : 'transcode'}, stream ${coverIdx}):`, e.message)
                          res(false)
                        })
                        .run()
                    })

                    if (isCopyable) {
                      // 先 copy，失败再转码，再失败用 ffmpeg 截帧
                      extractCover(true).then(ok =>
                        ok ? resolve(ok) : extractCover(false).then(ok2 =>
                          ok2 ? resolve(ok2) : extractVideoThumbnail(firstVideoPath, fullThumbnailPath).then(resolve)
                        )
                      )
                    } else {
                      extractCover(false).then(ok =>
                        ok ? resolve(ok) : extractVideoThumbnail(firstVideoPath, fullThumbnailPath).then(resolve)
                      )
                    }

                  } else {
                    // 无嵌入封面：macOS 用 qlmanage（和访达完全一致），其他平台 ffmpeg thumbnail 截帧
                    extractVideoThumbnail(firstVideoPath, fullThumbnailPath).then(resolve)
                  }
                })
              })

              if (success) {
                imagePath = toArchivistUrl(fullThumbnailPath)
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