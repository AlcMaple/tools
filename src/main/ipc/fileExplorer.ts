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

async function runWindowsPowerShell(psScript: string): Promise<void> {
  await runWindowsPowerShellWithStdout(psScript)
}

async function runWindowsPowerShellWithStdout(psScript: string): Promise<string> {
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 120000, maxBuffer: 16 * 1024 * 1024 }
    )
    return String(stdout ?? '')
  } catch (e: unknown) {
    // Surface stderr/stdout so the renderer can show actual cause to the user.
    const err = e as { stdout?: unknown; stderr?: unknown; message?: string }
    const stderr = String(err.stderr ?? '').trim()
    const stdout = String(err.stdout ?? '').trim()
    const detail = [stderr, stdout].filter(Boolean).join('\n').trim()
    throw new Error(detail || err.message || 'PowerShell 执行失败')
  }
}

async function permanentDelete(targetPath: string): Promise<void> {
  if (osPlatform() === 'win32') {
    // Use base64-encoded PowerShell to handle paths with spaces/Chinese chars.
    // Requires the app or the shell to run with administrator privileges.
    await runWindowsPowerShell(`
$target = @'
${targetPath}
'@.Trim()
takeown /f $target /r /d y
icacls $target /grant administrators:F /t /c
Remove-Item -Path $target -Recurse -Force
`.trim())
  } else {
    await rm(targetPath, { recursive: true, force: true })
  }
}

interface KilledProcess { pid: number; name: string }

// Force delete: enumerate processes locking the target via Restart Manager,
// kill them, then Remove-Item. Used as escalation when normal delete fails
// with "in use by another process". Returns the list of killed processes so
// the renderer can show what happened.
async function forceDeletePermanent(targetPath: string): Promise<{ killed: KilledProcess[] }> {
  if (osPlatform() !== 'win32') {
    // POSIX: rm -rf already succeeds against open files (unlink while open).
    await rm(targetPath, { recursive: true, force: true })
    return { killed: [] }
  }

  // PowerShell: register target + immediate children with Restart Manager,
  // get locking processes, Stop-Process them, then takeown + Remove-Item.
  // RmGetList cap'd to 64 process slots — enough for any realistic case.
  // Process list emitted between BEGIN/END markers as JSON.
  const stdout = await runWindowsPowerShellWithStdout(`
$target = @'
${targetPath}
'@.Trim()

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

# Build list of paths to register: target itself + non-recursive direct file
# children (covers most lock cases without paying recursion cost on big trees)
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

# Wait briefly for kernel to actually release the handles
if ($killed.Count -gt 0) { Start-Sleep -Milliseconds 400 }

# Now do the actual delete (mirrors permanentDelete)
takeown /f $target /r /d y 2>&1 | Out-Null
icacls $target /grant administrators:F /t /c 2>&1 | Out-Null
Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop

# Emit kill list as JSON between markers (so the parent can extract it
# regardless of whatever stdout chatter the prior commands produced).
Write-Output 'MAPLE_KILL_BEGIN'
if ($killed.Count -eq 0) {
  Write-Output '[]'
} else {
  $items = @()
  foreach ($k in $killed) { $items += (ConvertTo-Json -InputObject $k -Compress) }
  Write-Output ('[' + ($items -join ',') + ']')
}
Write-Output 'MAPLE_KILL_END'
`.trim())

  // Extract JSON between markers
  const m = stdout.match(/MAPLE_KILL_BEGIN\s*([\s\S]*?)\s*MAPLE_KILL_END/)
  if (!m) return { killed: [] }
  try {
    const parsed = JSON.parse(m[1].trim()) as Array<{ pid?: unknown; name?: unknown }>
    const killed = parsed.map(p => ({
      pid: typeof p.pid === 'number' ? p.pid : Number(p.pid) || 0,
      name: typeof p.name === 'string' ? p.name : String(p.name ?? ''),
    }))
    return { killed }
  } catch {
    return { killed: [] }
  }
}

async function trashItem(targetPath: string): Promise<void> {
  if (osPlatform() === 'win32') {
    // shell.trashItem fails on ACL-restricted files. We grant CURRENT USER
    // explicit Full Control (by SID) before recycling, so that emptying the
    // recycle bin later — which runs in the user's normal token, possibly with
    // Administrators filtered out by UAC — still has DELETE permission.
    // The file remains recoverable thanks to SendToRecycleBin (vs. Remove-Item).
    //
    // Diagnostic output from takeown/icacls is captured and only surfaced on
    // failure, so the renderer can show exactly which step rejected access.
    await runWindowsPowerShell(`
$target = @'
${targetPath}
'@.Trim()
$sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$takeownLog = (takeown /f $target /r /d y 2>&1) -join "\`n"
$icaclsUserLog = (icacls $target /grant "*\${sid}:F" /t /c 2>&1) -join "\`n"
$icaclsAdminLog = (icacls $target /grant administrators:F /t /c 2>&1) -join "\`n"
Add-Type -AssemblyName Microsoft.VisualBasic
try {
  if (Test-Path -LiteralPath $target -PathType Container) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, 'OnlyErrorDialogs', 'SendToRecycleBin')
  } else {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, 'OnlyErrorDialogs', 'SendToRecycleBin')
  }
} catch {
  [Console]::Error.WriteLine("SendToRecycleBin: $($_.Exception.Message)")
  [Console]::Error.WriteLine("--- takeown ---")
  [Console]::Error.WriteLine($takeownLog)
  [Console]::Error.WriteLine("--- icacls (current user) ---")
  [Console]::Error.WriteLine($icaclsUserLog)
  [Console]::Error.WriteLine("--- icacls (administrators) ---")
  [Console]::Error.WriteLine($icaclsAdminLog)
  exit 1
}
`.trim())
  } else {
    await shell.trashItem(targetPath)
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

  ipcMain.handle('fs:trash', (_event, targetPath: string) => trashItem(targetPath))

  ipcMain.handle('fs:delete-permanent', (_event, targetPath: string) => permanentDelete(targetPath))

  ipcMain.handle('fs:force-delete-permanent', (_event, targetPath: string) => forceDeletePermanent(targetPath))

  ipcMain.handle('fs:resolve-special', (_event, input: string) => resolveSpecialFolder(input))
}
