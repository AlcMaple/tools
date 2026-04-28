import { app, ipcMain, shell, WebContents } from 'electron'
import { readdir, stat, rm } from 'fs/promises'
import { existsSync, watch as fsWatch, FSWatcher } from 'fs'
import { join, extname } from 'path'
import { homedir, platform as osPlatform } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'

// ── Directory watcher ──────────────────────────────────────────────────────────

let _watcher: FSWatcher | null = null
let _debounce: ReturnType<typeof setTimeout> | null = null

function startWatching(dirPath: string, sender: WebContents): void {
  _watcher?.close()
  _watcher = null
  if (_debounce) { clearTimeout(_debounce); _debounce = null }
  try {
    _watcher = fsWatch(dirPath, { persistent: false }, () => {
      if (_debounce) clearTimeout(_debounce)
      _debounce = setTimeout(() => {
        if (!sender.isDestroyed()) sender.send('fs:dir-changed')
      }, 300)
    })
    _watcher.on('error', () => { _watcher?.close(); _watcher = null })
  } catch { /* ignore watch errors (e.g. permission denied) */ }
}

const execFileAsync = promisify(execFile)

export interface FsEntry {
  name: string
  path: string
  type: 'file' | 'folder'
  size?: number
  mtime?: string
  ext?: string
  kind?: 'video' | 'image' | 'archive' | 'text'
}

const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.m4v', '.webm', '.ts'])
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.heic', '.tiff'])
const ARCHIVE_EXTS = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.xz', '.bz2'])
const TEXT_EXTS = new Set(['.txt', '.md', '.log', '.json', '.xml', '.csv', '.ini', '.cfg', '.yaml', '.toml'])

function kindFromExt(ext: string): FsEntry['kind'] | undefined {
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (ARCHIVE_EXTS.has(ext)) return 'archive'
  if (TEXT_EXTS.has(ext)) return 'text'
  return undefined
}

// Sentinel path used on Windows to represent the "all drives" virtual root
export const VIRTUAL_ROOT = '__root__'

async function listWindowsDrives(): Promise<FsEntry[]> {
  const drives: FsEntry[] = []
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const p = `${letter}:\\`
    if (existsSync(p)) {
      drives.push({ name: `本地磁盘 (${letter}:)`, path: p, type: 'folder' })
    }
  }
  return drives
}

async function listDirEntries(dirPath: string): Promise<{ entries: FsEntry[]; isVirtualRoot: boolean }> {
  if (dirPath === VIRTUAL_ROOT) {
    if (osPlatform() === 'win32') {
      return { entries: await listWindowsDrives(), isVirtualRoot: true }
    }
    dirPath = '/'
  }

  const names = await readdir(dirPath)
  const entries: FsEntry[] = []

  await Promise.all(
    names
      .filter((n) => !n.startsWith('.'))
      .map(async (name) => {
        const fullPath = join(dirPath as string, name)
        try {
          const s = await stat(fullPath)
          const isDir = s.isDirectory()
          const ext = isDir ? undefined : extname(name).toLowerCase()
          entries.push({
            name,
            path: fullPath,
            type: isDir ? 'folder' : 'file',
            size: isDir ? undefined : s.size,
            mtime: s.mtime.toISOString().slice(0, 16).replace('T', ' '),
            ext: ext || undefined,
            kind: ext ? kindFromExt(ext) : undefined,
          })
        } catch {
          // skip permission-denied entries and broken symlinks
        }
      })
  )

  return { entries, isVirtualRoot: false }
}

// ── Special-folder alias resolution ────────────────────────────────────────────
//
// Windows Explorer shows known folders by localized display name (e.g. "下载" for
// Downloads), and the address bar's "Copy as path" returns just the display name
// rather than the absolute path. Same on macOS Finder for some folders ("文稿" for
// Documents, "影片" for Movies). When users paste those names into our address bar
// we'd otherwise fail with ENOENT — translate first via Electron's app.getPath().
//
// Mapping is exhaustively keyed (English / Simplified / Traditional / mac variants)
// because each system / language combo surfaces a slightly different label.
type SpecialFolderId = 'downloads' | 'desktop' | 'documents' | 'pictures' | 'videos' | 'music'

const ALIAS_MAP: Record<string, SpecialFolderId> = {
  // English (lower-cased before lookup)
  'downloads': 'downloads',
  'desktop': 'desktop',
  'documents': 'documents',
  'pictures': 'pictures',
  'videos': 'videos',
  'movies': 'videos',  // macOS English
  'music': 'music',
  // Simplified Chinese (Windows / macOS zh-CN)
  '下载': 'downloads',
  '桌面': 'desktop',
  '文档': 'documents',
  '文稿': 'documents',  // macOS Chinese
  '图片': 'pictures',
  '视频': 'videos',
  '影片': 'videos',     // macOS Chinese
  '音乐': 'music',
  // Traditional Chinese (zh-TW)
  '下載': 'downloads',
  '文檔': 'documents',
  '圖片': 'pictures',
  '音樂': 'music',
}

function resolveSpecialFolder(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const id = ALIAS_MAP[trimmed] ?? ALIAS_MAP[trimmed.toLowerCase()]
  if (!id) return null
  try { return app.getPath(id) } catch { return null }
}

async function permanentDelete(targetPath: string): Promise<void> {
  if (osPlatform() === 'win32') {
    // Use base64-encoded PowerShell to handle paths with spaces/Chinese chars.
    // Requires the app or the shell to run with administrator privileges.
    const psScript = `
$target = @'
${targetPath}
'@.Trim()
takeown /f $target /r /d y
icacls $target /grant administrators:F /t /c
Remove-Item -Path $target -Recurse -Force
`.trim()
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 120000 }
    )
  } else {
    await rm(targetPath, { recursive: true, force: true })
  }
}

export function registerFileExplorerIpc(): void {
  ipcMain.handle('fs:home-info', () => ({
    homeDir: homedir(),
    platform: osPlatform(),
  }))

  ipcMain.handle('fs:list-dir', async (event, dirPath: string) => {
    const result = await listDirEntries(dirPath)
    // Watch the actual directory (VIRTUAL_ROOT on non-Windows resolves to /)
    const watchPath = dirPath === VIRTUAL_ROOT
      ? (osPlatform() !== 'win32' ? '/' : null)
      : dirPath
    if (watchPath) startWatching(watchPath, event.sender)
    else { _watcher?.close(); _watcher = null }
    return result
  })

  ipcMain.handle('fs:open', async (_event, targetPath: string) => {
    await shell.openPath(targetPath)
  })

  ipcMain.handle('fs:reveal', (_event, targetPath: string) => {
    shell.showItemInFolder(targetPath)
  })

  ipcMain.handle('fs:trash', (_event, targetPath: string) => shell.trashItem(targetPath))

  ipcMain.handle('fs:delete-permanent', (_event, targetPath: string) => permanentDelete(targetPath))

  ipcMain.handle('fs:resolve-special', (_event, input: string) => resolveSpecialFolder(input))
}
