import { app, ipcMain, shell, WebContents } from 'electron'
import { readdir, rm, stat } from 'fs/promises'
import { existsSync, watch as fsWatch, FSWatcher } from 'fs'
import { join, extname, dirname } from 'path'
import { homedir, platform as osPlatform } from 'os'
import { runRecycle } from '../recycle/runner'

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


/**
 * 永久删除：Windows 走 recycle-helper 的 `--purge` 模式
 * （Remove-Item → cmd `rd /s /q` → robocopy /MIR 三级 fallback，每个策略
 * 自动重试 4 次，每次重试前自动清属性 + takeown + icacls + 杀进程）。
 * 几乎一次必成；真失败抛 Error，message 用 `Purge:` 前缀方便 renderer
 * friendlyError 归类。
 *
 * POSIX 上不需要这些花活——`fs.rm({recursive,force})` 自己就能处理 in-use
 * 文件（unlink while open），直接调即可。
 */
async function permanentDelete(
  targetPath: string,
): Promise<{ status: 'success' | 'already-absent' }> {
  if (osPlatform() !== 'win32') {
    if (!existsSync(targetPath)) return { status: 'already-absent' }
    await rm(targetPath, { recursive: true, force: true })
    return { status: 'success' }
  }
  const r = await runRecycle(targetPath, { purge: true })
  if (r.status === 'fragmented' || r.status === 'stage1-failed') {
    // purge 模式不会返回这两种状态，防御性兜底当 success。
    return { status: 'success' }
  }
  return { status: r.status }
}

/**
 * 「移到回收站」的两个阶段入口：
 *   trashStage1     —— 只跑 Stage 1（5s 整体送回收站窗口），Stage 1 失败时
 *                      返回 `stage1-failed`，**不**自动进 Stage 2。renderer
 *                      会读到这个状态去弹用户确认弹窗。
 *   trashFragmented —— 用户确认 Stage 2 后调这个，跑完整两阶段（Stage 1
 *                      重试一次，失败就进 Stage 2 分片回收）。exit 4 时
 *                      返回 `fragmented`，renderer 必须强提示"散件"。
 *
 * non-Windows 平台直接走 Electron 原生 `shell.trashItem`（一次过没有分片
 * 概念，Stage 1 / 2 概念是 Windows AV 拦截整目录移动这个具体问题催生的）。
 */
async function trashStage1(
  targetPath: string,
): Promise<{ status: 'success' | 'stage1-failed' | 'already-absent' }> {
  if (osPlatform() !== 'win32') {
    if (!existsSync(targetPath)) return { status: 'already-absent' }
    await shell.trashItem(targetPath)
    return { status: 'success' }
  }
  const r = await runRecycle(targetPath, { stage1Only: true })
  if (r.status === 'fragmented') {
    // 在 stage1Only 模式下永不返回 fragmented，理论上不会进这条分支；
    // 真出现就当 success（文件确实进回收站了）。
    return { status: 'success' }
  }
  return { status: r.status }
}

async function trashFragmented(
  targetPath: string,
): Promise<{ status: 'success' | 'fragmented' | 'already-absent' }> {
  if (osPlatform() !== 'win32') {
    if (!existsSync(targetPath)) return { status: 'already-absent' }
    await shell.trashItem(targetPath)
    return { status: 'success' }
  }
  const r = await runRecycle(targetPath, {})
  if (r.status === 'stage1-failed') {
    // 不带 stage1Only 时不会返回 stage1-failed，这条是防御性；按未发生算。
    throw new Error('Recycle: 内部状态异常（stage1-failed in full mode）')
  }
  return { status: r.status }
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

  // 删除操作走 recycle-helper.ps1 两阶段方案：
  //   - fs:trash             → 跑 Stage 1（5s 整体送回收站）。失败返回
  //                            'stage1-failed'，renderer 弹用户确认弹窗,
  //                            **不**自动进 Stage 2。
  //   - fs:trash-fragmented  → 用户在弹窗里点「继续」后调，跑完整两阶段。
  //                            exit 4 返回 'fragmented'，renderer 必须强
  //                            提示"回收站里是散件"。
  //   - fs:delete-permanent  → recycle-helper --purge 模式（Remove-Item →
  //                            cmd rd /s /q → robocopy /MIR），UX 跟旧版
  //                            完全一致，二次确认弹窗仍由 renderer 控制。
  // 不再返回 killed 进程列表 —— helper 不通过 stdout 回传数据，杀进程的
  // 名单留在 Verbose 日志里仅供调试，UI 上不展示。
  ipcMain.handle('fs:trash', (_event, targetPath: string) => trashStage1(targetPath))
  ipcMain.handle('fs:trash-fragmented', (_event, targetPath: string) => trashFragmented(targetPath))
  ipcMain.handle('fs:delete-permanent', (_event, targetPath: string) => permanentDelete(targetPath))

  ipcMain.handle('fs:resolve-special', (_event, input: string) => resolveSpecialFolder(input))

  /**
   * Find the closest existing ancestor directory of `targetPath` (including
   * the path itself). Returns `targetPath` if it still exists, otherwise
   * walks up with `dirname()` until `stat().isDirectory()` succeeds.
   *
   * Used by the renderer's delete flow: when the user deletes the directory
   * they're currently viewing (or one of its ancestors via the path input
   * box), the UI needs to navigate somewhere reachable instead of sitting on
   * a now-nonexistent path with a silent listDir failure.
   *
   * Returns null only in the pathological case where even the filesystem
   * root is unreachable — caller should fall back to home/virtual root.
   */
  ipcMain.handle('fs:find-existing-ancestor', async (_event, targetPath: string): Promise<string | null> => {
    if (!targetPath) return null
    let cur = targetPath
    let prev = ''
    // dirname() of a root path returns itself (e.g. '/' on POSIX, 'C:\\' on
    // Windows), so we detect the no-progress case via `cur === prev`.
    while (cur && cur !== prev) {
      try {
        const s = await stat(cur)
        if (s.isDirectory()) return cur
      } catch {
        // path doesn't exist (or no permission) — keep walking up
      }
      prev = cur
      cur = dirname(cur)
    }
    return null
  })
}
