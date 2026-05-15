import { app, ipcMain, shell, WebContents } from 'electron'
import { readdir, readFile, rm, stat } from 'fs/promises'
import { existsSync, watch as fsWatch, FSWatcher } from 'fs'
import { join, extname } from 'path'
import { homedir, platform as osPlatform, tmpdir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomBytes } from 'crypto'

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

/**
 * 跑一段 PS 脚本，**完全丢弃** stdout / stderr。从不读 PS 的输出来取数据。
 *
 * 历史教训：之前尝试过"PS 把 JSON 写到 stdout，Node 读 stdout 解析"——结果
 * 在 Chinese Windows 上时不时被编码问题搞炸（PS 默认输出 OEM / GBK, Node
 * 按 UTF-8 解码 → 中文字节序列被破坏 → JSON.parse 抛错）。试过
 * `[Console]::OutputEncoding = UTF8` + `chcp 65001` 强制统一也并不彻底
 * 可靠（PS 版本差异 / 外壳 hook / 防病毒 / 区域设置都能再次踩雷）。
 *
 * 根除方案：**数据交换走临时文件而非 stdout**。PS 用
 * `[System.IO.File]::WriteAllText` 显式写 UTF-8 字节到文件 → Node 用
 * `readFile(..., 'utf8')` 读 → 全程 PS string ↔ UTF-8 bytes 转换 in-process,
 * 完全绕开 console / OEM codepage。这个 helper 只负责"让 PS 把事情做完",
 * 失败不抛（exit code / 超时都视作"它尽力了"），由调用方根据文件系统
 * 状态（existsSync / 读临时文件）判断真实成败。
 */
async function runWindowsPowerShellSilent(psScript: string): Promise<void> {
  // 仍然加 UTF-8 prologue ——「就算 PS 内部某行 Write-Output 漏出来什么也不
  // 会在 console 那里被 OEM 转码炸出诡异错误」是廉价保险；但我们不依赖
  // stdout 拿数据，所以这只是 defense-in-depth。
  const utf8Prologue = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    'chcp 65001 *> $null',
  ].join('\n')
  const wrapped = `${utf8Prologue}\n${psScript}`
  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64')
  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 120000, maxBuffer: 1024 * 1024 }
    )
  } catch {
    // 不抛错 —— 调用方只关心"文件系统状态 / 临时文件内容"，不关心 PS 自己
    // 觉得自己成不成功。这种解耦正是这套架构的核心。
  }
}

interface KilledProcess { pid: number; name: string }

// Shared PowerShell fragment: defines the RmApi C# wrapper for Restart Manager
// and kills every process holding `$target` open (after also registering the
// directory's immediate file children — catches most lock-holders without
// recursing massive trees). Used by both trashItem and permanentDelete so the
// "what to actually delete" step can succeed.
//
// Contract:
//   - Input:  $target (string)  — set by caller before this fragment runs
//   - Output: $killed (List)    — @{ pid; name } objects, may be empty
//
// Idempotent: Add-Type checks if the type is already loaded.
const PS_KILL_PROCESSES_FRAGMENT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class RmApi {
    [StructLayout(LayoutKind.Sequential)]
    public struct RM_UNIQUE_PROCESS {
        public uint dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string strServiceShortName;
        public uint ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    public static extern int RmRegisterResources(uint pSessionHandle,
        uint nFiles, string[] rgsFilenames,
        uint nApplications, IntPtr rgApplications,
        uint nServices, IntPtr rgsServiceNames);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Auto)]
    public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);

    [DllImport("rstrtmgr.dll")]
    public static extern int RmEndSession(uint pSessionHandle);

    [DllImport("rstrtmgr.dll")]
    public static extern int RmGetList(uint dwSessionHandle,
        out uint pnProcInfoNeeded, ref uint pnProcInfo,
        [In, Out] RM_PROCESS_INFO[] rgAffectedApps,
        ref uint lpdwRebootReasons);
}
"@ -ErrorAction SilentlyContinue

$paths = New-Object System.Collections.Generic.List[string]
$paths.Add($target)
if (Test-Path -LiteralPath $target -PathType Container) {
  Get-ChildItem -LiteralPath $target -File -Force -ErrorAction SilentlyContinue |
    Select-Object -First 1000 -ExpandProperty FullName |
    ForEach-Object { $paths.Add($_) }
}

$killed = New-Object System.Collections.Generic.List[object]
$sessionHandle = [uint32]0
$sessionKey = [System.Guid]::NewGuid().ToString()
$startResult = [RmApi]::RmStartSession([ref]$sessionHandle, 0, $sessionKey)
if ($startResult -eq 0) {
  try {
    $arr = [string[]]$paths.ToArray()
    [void][RmApi]::RmRegisterResources($sessionHandle, [uint32]$arr.Length, $arr, 0, [IntPtr]::Zero, 0, [IntPtr]::Zero)

    $procInfoNeeded = [uint32]0
    $procInfo = [uint32]64
    $rebootReasons = [uint32]0
    $infoArray = New-Object 'RmApi+RM_PROCESS_INFO[]' 64
    $listResult = [RmApi]::RmGetList($sessionHandle, [ref]$procInfoNeeded, [ref]$procInfo, $infoArray, [ref]$rebootReasons)

    if ($listResult -eq 0 -and $procInfoNeeded -gt 0) {
      $count = [Math]::Min([int]$procInfoNeeded, $infoArray.Length)
      for ($i = 0; $i -lt $count; $i++) {
        $info = $infoArray[$i]
        $procPid = [int]$info.Process.dwProcessId
        $procName = $info.strAppName
        if (-not $procName) { $procName = "(pid $procPid)" }
        try {
          Stop-Process -Id $procPid -Force -ErrorAction Stop
          $killed.Add(@{ pid = $procPid; name = $procName })
        } catch {
          # process already gone or unkillable (e.g. system process) — skip
        }
      }
    }
  } finally {
    [void][RmApi]::RmEndSession($sessionHandle)
  }
}

if ($killed.Count -gt 0) { Start-Sleep -Milliseconds 400 }
`

// ── Prepare-for-delete: kill processes + elevate permissions ────────────────
//
// 单一职责的"准备阶段"——把"可能阻止删除"的所有障碍清掉，但本身不做
// 删除。删除留给 Node 自己干（fs.rm / shell.trashItem），这样真正的
// 文件操作完全在 JS 层，不依赖 PS 跟外界的字节流通信。
//
// 数据交换：用 temp file 走 UTF-8 显式编码，**不再通过 stdout**。这一条
// 直接消掉了"Windows 区域设置 / PS 版本 / OEM codepage 把 JSON 字符串
// 炸花"的整一类编码 bug。即使 PS 顶部 [Console]::OutputEncoding 这些
// 设置在某些环境下不生效，临时文件这条通路也不受影响。

interface PrepareForDeleteResult {
  killed: KilledProcess[]
}

/**
 * 临时文件路径，用唯一后缀避免并发删除时碰撞。
 */
function newTempPath(label: string): string {
  return join(tmpdir(), `maple-${label}-${Date.now()}-${randomBytes(6).toString('hex')}.json`)
}

/**
 * Best-effort 把 PS 写到临时文件的 JSON 解析成 KilledProcess 数组。
 * 任何异常都吞掉返回 `[]`——杀进程列表只是 toast 的锦上添花，缺了也不
 * 影响主流程。
 */
function parseKilledJson(text: string): KilledProcess[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  try {
    const raw = JSON.parse(trimmed) as unknown
    // ConvertTo-Json 在单元素时可能不包 array，统一兜成数组
    const list: unknown[] = Array.isArray(raw) ? raw : [raw]
    return list
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
      .map(p => ({
        pid: typeof p.pid === 'number' ? p.pid : Number(p.pid) || 0,
        name: typeof p.name === 'string' ? p.name : String(p.name ?? ''),
      }))
      .filter(k => k.pid > 0)
  } catch {
    return []
  }
}

/**
 * Windows-only: 跑 PS 把所有可能阻挠删除的事都做了——杀掉持有 target 的
 * 进程、takeown、icacls 放权——然后**只把"杀掉的进程列表"写到临时文件**,
 * 不通过 stdout 传任何数据。Node 这边读临时文件、解析、然后自己 rm /
 * trashItem。
 *
 * 不抛错：PS 跑不通 / 没杀到进程 / 写文件失败 都视作"已经尽力"，杀掉的
 * 列表能拿就拿，拿不到返回空。真实成败靠调用方 existsSync 判定。
 */
async function prepareForDelete(targetPath: string): Promise<PrepareForDeleteResult> {
  if (osPlatform() !== 'win32') return { killed: [] }

  const tempPath = newTempPath('killed')
  const psScript = `
$target = @'
${targetPath}
'@.Trim()
$resultPath = @'
${tempPath}
'@.Trim()

${PS_KILL_PROCESSES_FRAGMENT}

# Elevate permissions silently. takeown / icacls native exes 输出会走 console
# OEM codepage —— 我们一字不读，全 *> $null 丢掉，根本没机会出编码问题。
# 它们成功失败都不影响后续 Node 的 fs.rm / shell.trashItem 能不能干活。
$sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
takeown /f $target /r /d y *> $null
icacls $target /grant "*\${sid}:F" /t /c *> $null
icacls $target /grant administrators:F /t /c *> $null

# 数据回传 ✦ 走临时文件而非 stdout。WriteAllText + UTF8Encoding(no BOM) 在
# PS 内部直接 string(UTF-16) → UTF-8 bytes，完全不经过 [Console]::OutputEncoding
# 这条容易被环境弄花的链路。Node 那头 readFile(path, 'utf8') 同样精确按
# UTF-8 解码。整条 round-trip 在我们的代码里完全确定，没有外部因素能搅局。
$json = ConvertTo-Json -InputObject @($killed) -Compress -Depth 3
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($resultPath, $json, $utf8NoBom)
`.trim()

  try {
    await runWindowsPowerShellSilent(psScript)
    let text = ''
    try {
      text = await readFile(tempPath, 'utf8')
    } catch {
      // 文件没生成 = PS 没跑到 WriteAllText 那行。我们继续走 —— 杀进程虽然
      // 没拿到列表，但权限和进程那两步可能已经做完了，让 Node 这边正常往下。
      return { killed: [] }
    }
    return { killed: parseKilledJson(text) }
  } finally {
    rm(tempPath, { force: true }).catch(() => {})
  }
}

/**
 * Permanent delete: 先 prepareForDelete 清障碍，然后 Node 自己用 fs.rm 做
 * 实际删除（POSIX 上直接走这条；Windows 上是 prepareForDelete 之后的主路径）。
 *
 * 失败兜底：Node fs.rm 在 Windows 上偶尔会因为长路径 / OneDrive placeholder
 * / NTFS 特殊属性翻车——这种情况退到 PS Remove-Item 再试一次（PS 跑完不读
 * stdout，只看后面 existsSync 是真成功 vs 真失败）。
 *
 * 最终判定：`existsSync(target)`。文件没了 = 成功（返回 killed 列表）；还
 * 在 = 抛 Error，message 用 `Remove-Item:` 前缀方便 friendlyError 归类。
 */
async function permanentDelete(targetPath: string): Promise<{ killed: KilledProcess[] }> {
  if (osPlatform() !== 'win32') {
    // POSIX: rm -rf 自己就能处理 in-use 文件（unlink while open）。
    await rm(targetPath, { recursive: true, force: true })
    return { killed: [] }
  }

  const { killed } = await prepareForDelete(targetPath)

  // 主路径：Node 原生 rm。无 shell，无编码风险，速度也快。
  try {
    await rm(targetPath, { recursive: true, force: true })
  } catch {
    // 兜底：PS Remove-Item。我们不读它输出，只看下面 existsSync。
    await runWindowsPowerShellSilent(`
$target = @'
${targetPath}
'@.Trim()
try { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop } catch { }
`.trim())
  }

  if (existsSync(targetPath)) {
    throw new Error('Remove-Item: 操作未生效，文件夹仍然存在（可能被系统驱动 / 内核 / 杀软占用）')
  }
  return { killed }
}

/**
 * Move-to-recycle-bin。和 permanentDelete 同思路：让 Node / Electron 自己
 * 做实际删除（shell.trashItem），PS 只负责"清障碍"。
 *
 * 链路：
 *   1. shell.trashItem 直接试一次（绝大多数普通文件这步就成）
 *   2. 失败 → prepareForDelete 杀进程 + 改权限
 *   3. shell.trashItem 再试一次（90% 的硬骨头到这步搞定）
 *   4. 还失败 → 退到 VB FileSystem.DeleteDirectory(SendToRecycleBin)，PS 跑完
 *      不读 stdout，看 existsSync
 *
 * 最终判定还是 existsSync。失败时 Error message 加 `SendToRecycleBin:` 前缀。
 */
async function trashItem(targetPath: string): Promise<{ killed: KilledProcess[] }> {
  if (osPlatform() !== 'win32') {
    await shell.trashItem(targetPath)
    return { killed: [] }
  }

  // Step 1: 快路径 —— IFileOperation。无 PS、无杀进程、无 ACL 改动。
  try {
    await shell.trashItem(targetPath)
    return { killed: [] }
  } catch { /* 继续走重路径 */ }

  // Step 2: 清障碍
  const { killed } = await prepareForDelete(targetPath)

  // Step 3: IFileOperation 重试（进程清掉、权限放开后通常就能 trash 成功）
  try {
    await shell.trashItem(targetPath)
    if (!existsSync(targetPath)) return { killed }
  } catch { /* 继续走 VB 兜底 */ }

  // Step 4: 老 VB DeleteDirectory 兜底（极少数 IFileOperation 不 work 的盘 /
  // 文件类型组合，比如某些游戏 mod 文件夹）。PS 跑完不读 stdout，看 existsSync。
  await runWindowsPowerShellSilent(`
$target = @'
${targetPath}
'@.Trim()
Add-Type -AssemblyName Microsoft.VisualBasic
try {
  if (Test-Path -LiteralPath $target -PathType Container) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, 'OnlyErrorDialogs', 'SendToRecycleBin')
  } else {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, 'OnlyErrorDialogs', 'SendToRecycleBin')
  }
} catch { }
`.trim())

  if (existsSync(targetPath)) {
    throw new Error('SendToRecycleBin: 操作未生效，无法移到回收站（可能磁盘格式不支持回收站、回收站满了、或被系统驱动占用）')
  }
  return { killed }
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

  // Both delete operations return `{ killed }` so the renderer can mention
  // in the success toast which processes (if any) were terminated to free
  // the file. There's intentionally no "force delete" handler anymore —
  // trashItem and permanentDelete each do their own kill-processes step.
  ipcMain.handle('fs:trash', (_event, targetPath: string) => trashItem(targetPath))
  ipcMain.handle('fs:delete-permanent', (_event, targetPath: string) => permanentDelete(targetPath))

  ipcMain.handle('fs:resolve-special', (_event, input: string) => resolveSpecialFolder(input))
}
