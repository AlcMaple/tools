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

interface PsDeleteResult {
  killed: KilledProcess[]
  success: boolean
  error: string | null
  diagnostics: {
    takeown?: string
    icaclsUser?: string
    icaclsAdmin?: string
  }
}

/**
 * Parse the JSON blob emitted between `MAPLE_RESULT_BEGIN` / `MAPLE_RESULT_END`
 * markers by trashItem/permanentDelete PowerShell scripts. Defensive — returns
 * a failure shape on any parse error so callers don't crash on unexpected
 * output (e.g. PowerShell itself crashed before emit).
 */
function parsePsDeleteResult(stdout: string): PsDeleteResult {
  const m = stdout.match(/MAPLE_RESULT_BEGIN\s*([\s\S]*?)\s*MAPLE_RESULT_END/)
  if (!m) {
    return { killed: [], success: false, error: '未拿到 PowerShell 结果输出', diagnostics: {} }
  }
  try {
    const parsed = JSON.parse(m[1].trim()) as {
      killed?: Array<{ pid?: unknown; name?: unknown }>
      success?: boolean
      error?: string | null
      diagnostics?: { takeown?: string; icaclsUser?: string; icaclsAdmin?: string }
    }
    const killed = (parsed.killed ?? []).map((p) => ({
      pid: typeof p.pid === 'number' ? p.pid : Number(p.pid) || 0,
      name: typeof p.name === 'string' ? p.name : String(p.name ?? ''),
    }))
    return {
      killed,
      success: parsed.success === true,
      error: typeof parsed.error === 'string' ? parsed.error : null,
      diagnostics: parsed.diagnostics ?? {},
    }
  } catch {
    return { killed: [], success: false, error: 'PowerShell 结果解析失败', diagnostics: {} }
  }
}

/** Build a multi-line error message from a failed PsDeleteResult, including
 *  the takeown / icacls diagnostics so the renderer's friendlyError() can
 *  classify it and the user can read the raw cause. */
function formatPsDeleteError(r: PsDeleteResult, opLabel: string): string {
  const lines = [`${opLabel}: ${r.error ?? '未知错误'}`]
  if (r.diagnostics.takeown) lines.push('--- takeown ---', r.diagnostics.takeown)
  if (r.diagnostics.icaclsUser) lines.push('--- icacls (current user) ---', r.diagnostics.icaclsUser)
  if (r.diagnostics.icaclsAdmin) lines.push('--- icacls (administrators) ---', r.diagnostics.icaclsAdmin)
  return lines.join('\n')
}

/**
 * Permanent delete: kills any processes holding the target, takes ownership,
 * grants Full Control to current user + Administrators, then Remove-Item.
 *
 * Subsumes the old `forceDeletePermanent` — there is no longer a "force vs
 * normal" distinction at this layer; permanent delete does everything it can
 * to succeed in one shot, and the caller doesn't need to retry or escalate.
 *
 * Returns the list of processes that were killed (may be empty), so the
 * renderer can disclose them post-hoc in the success toast.
 *
 * On failure: throws an Error whose message includes the underlying cause +
 * takeown/icacls diagnostics, so the renderer's friendlyError() can classify
 * it and the user can read the raw output.
 */
async function permanentDelete(targetPath: string): Promise<{ killed: KilledProcess[] }> {
  if (osPlatform() !== 'win32') {
    // POSIX: rm -rf already succeeds against open files (unlink while open).
    await rm(targetPath, { recursive: true, force: true })
    return { killed: [] }
  }

  // The PS script intentionally always exits 0 and reports outcome via the
  // MAPLE_RESULT JSON block. This lets us read `killed` even on Remove-Item
  // failure (the kill step might have legitimately killed processes before
  // the final delete tripped on a different cause).
  const stdout = await runWindowsPowerShellWithStdout(`
$target = @'
${targetPath}
'@.Trim()

${PS_KILL_PROCESSES_FRAGMENT}

$sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$takeownLog = (takeown /f $target /r /d y 2>&1) -join "\`n"
$icaclsUserLog = (icacls $target /grant "*\${sid}:F" /t /c 2>&1) -join "\`n"
$icaclsAdminLog = (icacls $target /grant administrators:F /t /c 2>&1) -join "\`n"

$success = $true
$errMsg = $null
try {
  Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
} catch {
  $success = $false
  $errMsg = $_.Exception.Message
}

$result = @{
  killed = @($killed)
  success = $success
  error = $errMsg
  diagnostics = @{
    takeown = $takeownLog
    icaclsUser = $icaclsUserLog
    icaclsAdmin = $icaclsAdminLog
  }
}
Write-Output 'MAPLE_RESULT_BEGIN'
Write-Output (ConvertTo-Json -InputObject $result -Compress -Depth 5)
Write-Output 'MAPLE_RESULT_END'
`.trim())

  const r = parsePsDeleteResult(stdout)
  if (!r.success) throw new Error(formatPsDeleteError(r, 'Remove-Item'))
  return { killed: r.killed }
}

/**
 * Move-to-recycle-bin. Like `permanentDelete`, this does everything it can
 * internally — kill processes, takeown, swap APIs — and either succeeds or
 * fails. Returns the list of processes that were killed (if any) so the
 * renderer can surface them in the success toast.
 *
 * Windows trash chain (three attempts, fast → slow):
 *
 *   1. shell.trashItem — Electron's modern IFileOperation-based API.
 *      Fast path: no PowerShell, no killed processes, no ACL changes.
 *      Handles most normal cases.
 *
 *   2. PowerShell: kill processes + takeown + icacls + legacy SendToRecycleBin
 *      (Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory under the
 *      hood, which is SHFileOperation). Used for ACL-restricted / locked
 *      files. Grants Full Control to current user + Administrators so the
 *      eventual "empty recycle bin" (UAC-filtered token) still has DELETE.
 *
 *   3. shell.trashItem AGAIN — sometimes succeeds where step 2's legacy
 *      VB API returns "system does not support this function" (real-world
 *      report: a game-mod folder with mixed file types). IFileOperation
 *      often works after permissions + processes are cleared.
 *
 * Killed-processes from step 2 propagate even when step 2's SendToRecycleBin
 * leg failed and we recovered via step 3 — the kills were real, the user
 * deserves to see them in the toast.
 */
async function trashItem(targetPath: string): Promise<{ killed: KilledProcess[] }> {
  if (osPlatform() !== 'win32') {
    await shell.trashItem(targetPath)
    return { killed: [] }
  }

  // Step 1
  try {
    await shell.trashItem(targetPath)
    return { killed: [] }
  } catch {
    /* fall through to elevated path */
  }

  // Step 2: heavy machinery. PS always exits 0 and reports outcome via JSON,
  // so we can read $killed even when SendToRecycleBin itself failed.
  let killed: KilledProcess[] = []
  let psFailure: string | null = null
  try {
    const stdout = await runWindowsPowerShellWithStdout(`
$target = @'
${targetPath}
'@.Trim()

${PS_KILL_PROCESSES_FRAGMENT}

$sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$takeownLog = (takeown /f $target /r /d y 2>&1) -join "\`n"
$icaclsUserLog = (icacls $target /grant "*\${sid}:F" /t /c 2>&1) -join "\`n"
$icaclsAdminLog = (icacls $target /grant administrators:F /t /c 2>&1) -join "\`n"

Add-Type -AssemblyName Microsoft.VisualBasic
$success = $true
$errMsg = $null
try {
  if (Test-Path -LiteralPath $target -PathType Container) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, 'OnlyErrorDialogs', 'SendToRecycleBin')
  } else {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, 'OnlyErrorDialogs', 'SendToRecycleBin')
  }
} catch {
  $success = $false
  $errMsg = $_.Exception.Message
}

$result = @{
  killed = @($killed)
  success = $success
  error = $errMsg
  diagnostics = @{
    takeown = $takeownLog
    icaclsUser = $icaclsUserLog
    icaclsAdmin = $icaclsAdminLog
  }
}
Write-Output 'MAPLE_RESULT_BEGIN'
Write-Output (ConvertTo-Json -InputObject $result -Compress -Depth 5)
Write-Output 'MAPLE_RESULT_END'
`.trim())

    const r = parsePsDeleteResult(stdout)
    killed = r.killed
    if (r.success) return { killed }
    psFailure = formatPsDeleteError(r, 'SendToRecycleBin')
  } catch (e) {
    psFailure = (e as Error).message
  }

  // Step 3: IFileOperation retry now that processes are killed and permissions
  // are wide open. Preserves the killed list from step 2 either way.
  try {
    await shell.trashItem(targetPath)
    return { killed }
  } catch {
    // Surface step 2's diagnostic — it has the most detail about why the
    // operation can't recycle this target.
    throw new Error(psFailure ?? 'trashItem failed')
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

  // Both delete operations return `{ killed }` so the renderer can mention
  // in the success toast which processes (if any) were terminated to free
  // the file. There's intentionally no "force delete" handler anymore —
  // trashItem and permanentDelete each do their own kill-processes step.
  ipcMain.handle('fs:trash', (_event, targetPath: string) => trashItem(targetPath))
  ipcMain.handle('fs:delete-permanent', (_event, targetPath: string) => permanentDelete(targetPath))

  ipcMain.handle('fs:resolve-special', (_event, input: string) => resolveSpecialFolder(input))
}
