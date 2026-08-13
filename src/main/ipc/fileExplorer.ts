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

// Windows 上表示「所有磁盘」这个虚拟根的哨兵路径
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
          // 跳过没有权限的条目和坏掉的符号链接
        }
      })
  )

  return { entries, isVirtualRoot: false }
}

// ── 特殊文件夹别名解析 ────────────────────────────────────────────────────────
//
// 资源管理器 / 访达按**本地化显示名**展示已知文件夹(下载、文稿、影片…),而地址栏「复制为
// 路径」拿到的就是这个显示名而不是绝对路径。用户把它粘进我们的地址栏时会直接 ENOENT
// 所以先用 app.getPath() 翻译一次。
//
// 映射表把英文 / 简体 / 繁体 / mac 各种写法都列全了 —— 每种系统和语言组合给出的标签都略有不同。
type SpecialFolderId = 'downloads' | 'desktop' | 'documents' | 'pictures' | 'videos' | 'music'

const ALIAS_MAP: Record<string, SpecialFolderId> = {
  // 英文(查表前会转小写)
  'downloads': 'downloads',
  'desktop': 'desktop',
  'documents': 'documents',
  'pictures': 'pictures',
  'videos': 'videos',
  'movies': 'videos',  // macOS English
  'music': 'music',
  // 简体中文
  '下载': 'downloads',
  '桌面': 'desktop',
  '文档': 'documents',
  '文稿': 'documents',  // macOS Chinese
  '图片': 'pictures',
  '视频': 'videos',
  '影片': 'videos',     // macOS Chinese
  '音乐': 'music',
  // 繁体中文
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
 * 永久删除。Windows 走 recycle-helper 的 `--purge`(Remove-Item → `rd /s /q` → robocopy /MIR
 * 三级 fallback,每级自动重试 4 次,重试前清属性 + takeown + icacls + 杀进程),几乎一次必成。
 * POSIX 上不需要这些花活:`fs.rm({recursive,force})` 本身就能处理正被打开的文件。
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
    // purge 模式不会返回这两种状态,防御性兜底当成功。
    return { status: 'success' }
  }
  return { status: r.status }
}

/**
 * 「移到回收站」的两个阶段:
 *   trashStage1     只跑 Stage 1(5s 整体送回收站窗口),失败返回 `stage1-failed` 并**停在这里**
 *                   由渲染层弹确认弹窗问用户。
 *   trashFragmented 用户确认后才调,跑完整两阶段(Stage 1 再试一次,失败进 Stage 2 分片回收)。
 *                   返回 `fragmented` 时渲染层必须强提示「回收站里是散件」。
 *
 * 非 Windows 平台直接用 Electron 的 `shell.trashItem` —— Stage 1/2 这套是为了绕开 Windows 上
 * 杀软拦截整目录移动才有的,别的平台没这问题。
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
    // stage1Only 模式下不会返回 fragmented,这条是防御性;真出现就当成功(文件确实进回收站了)。
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
    // 不带 stage1Only 时不会返回 stage1-failed,防御性分支。
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
    // 监听真实目录(非 Windows 上虚拟根解析成 /)
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
   * 找 `targetPath` 最近的、仍然存在的祖先目录(自身还在就返回自身),否则用 dirname 一层层
   * 往上爬到能 stat 成目录为止。
   *
   * 给删除流程用:用户删掉了正在浏览的目录(或它的某个祖先)时,UI 得跳到一个还能打开的地方,
   * 而不是停在一个已经不存在的路径上、静默地列不出东西。
   *
   * 只有连文件系统根都不可达这种极端情况才返回 null,调用方应回落到 home 或虚拟根。
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
        // 路径不存在或没权限 —— 继续往上爬
      }
      prev = cur
      cur = dirname(cur)
    }
    return null
  })
}
