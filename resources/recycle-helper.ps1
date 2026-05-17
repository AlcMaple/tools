# recycle-helper.ps1
# Send to Recycle Bin / permanently delete on Windows.
#
# Recycle strategy:
#   1. Try whole-folder IFileOperation recycle (fast path).
#   2. If aborted: kill known lockers, rename, retry up to N seconds.
#   3. If still stuck: PIECEMEAL recycle. Walk the tree bottom-up;
#      send each file to Recycle Bin individually, then each now-empty
#      directory. AV blocks WHOLE-TREE moves but allows single-item
#      recycles, so this works around the typical "directory rename
#      denied" case. Net effect: every original item is in the Recycle
#      Bin and restorable; the bin shows them as separate entries.
#
# Purge mode: Remove-Item -> cmd rd -> robocopy /MIR.

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Path,
    [int]$MaxRetries = 4,
    [int]$RecycleTimeoutSec = 5,
    [switch]$Purge,
    # Stage1Only: only attempt the fast whole-folder recycle path (Stage 1).
    # If Stage 1 fails within the timeout, exit 3 *without* attempting the
    # piecemeal recycle fallback (Stage 2). The MapleTools renderer reads
    # exit 3 to pop a user-confirmation dialog before scheduling Stage 2.
    [switch]$Stage1Only
)
$ErrorActionPreference = 'Stop'

# Exit codes:
#  0 = whole-folder recycle / purge succeeded
#  1 = failed
#  2 = bad path
#  3 = Stage 1 (whole-folder) recycle failed; Stage 2 (piecemeal) NOT attempted
#      because -Stage1Only was passed. Caller decides whether to invoke us
#      again without -Stage1Only.
#  4 = piecemeal recycle succeeded (every item is in the bin individually)

$nativeDef = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace RecycleHelper {

public static class FileLockInfo {
    [StructLayout(LayoutKind.Sequential)]
    struct RM_UNIQUE_PROCESS {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }
    const int CCH_RM_MAX_APP_NAME = 255;
    const int CCH_RM_MAX_SVC_NAME = 63;
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_APP_NAME + 1)] public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_SVC_NAME + 1)] public string strServiceShortName;
        public uint ApplicationType; public uint AppStatus; public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
    }
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint h, uint nF, string[] f, uint nA, [In] RM_UNIQUE_PROCESS[] a, uint nS, string[] s);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Auto)]
    static extern int RmStartSession(out uint h, int dwFlags, string strKey);
    [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint h, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);
    public static List<int> WhoIsLocking(string[] paths) {
        var pids = new List<int>();
        if (paths == null || paths.Length == 0) return pids;
        uint handle; string key = Guid.NewGuid().ToString();
        if (RmStartSession(out handle, 0, key) != 0) return pids;
        try {
            const int ERROR_MORE_DATA = 234;
            uint needed = 0, count = 0, reasons = 0;
            if (RmRegisterResources(handle, (uint)paths.Length, paths, 0, null, 0, null) != 0) return pids;
            int res = RmGetList(handle, out needed, ref count, null, ref reasons);
            if (res == ERROR_MORE_DATA && needed > 0) {
                var info = new RM_PROCESS_INFO[needed]; count = needed;
                if (RmGetList(handle, out needed, ref count, info, ref reasons) == 0) {
                    for (int i = 0; i < count; i++) pids.Add(info[i].Process.dwProcessId);
                }
            }
        } finally { RmEndSession(handle); }
        return pids;
    }
}

[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, out IntPtr ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
}
[ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFileOperation {
    uint Advise(IntPtr p); void Unadvise(uint c);
    void SetOperationFlags(uint f);
    void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string m);
    void SetProgressDialog(IntPtr p); void SetProperties(IntPtr p);
    void SetOwnerWindow(IntPtr h); void ApplyPropertiesToItem(IShellItem i);
    void ApplyPropertiesToItems([MarshalAs(UnmanagedType.IUnknown)] object i);
    void RenameItem(IShellItem i, [MarshalAs(UnmanagedType.LPWStr)] string n, IntPtr p);
    void RenameItems([MarshalAs(UnmanagedType.IUnknown)] object i, [MarshalAs(UnmanagedType.LPWStr)] string n);
    void MoveItem(IShellItem i, IShellItem d, [MarshalAs(UnmanagedType.LPWStr)] string n, IntPtr p);
    void MoveItems([MarshalAs(UnmanagedType.IUnknown)] object i, IShellItem d);
    void CopyItem(IShellItem i, IShellItem d, [MarshalAs(UnmanagedType.LPWStr)] string c, IntPtr p);
    void CopyItems([MarshalAs(UnmanagedType.IUnknown)] object i, IShellItem d);
    void DeleteItem(IShellItem i, IntPtr p);
    void DeleteItems([MarshalAs(UnmanagedType.IUnknown)] object i);
    uint NewItem(IShellItem d, uint a, [MarshalAs(UnmanagedType.LPWStr)] string n, [MarshalAs(UnmanagedType.LPWStr)] string t, IntPtr p);
    void PerformOperations();
    [return: MarshalAs(UnmanagedType.Bool)] bool GetAnyOperationsAborted();
}
public static class Win32 {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    public static extern IShellItem SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string p, IntPtr b, [In] ref Guid r);
}

public static class RecycleBin {
    const uint FOF_SILENT          = 0x0004;
    const uint FOF_NOCONFIRMATION  = 0x0010;
    const uint FOF_ALLOWUNDO       = 0x0040;
    const uint FOF_NOERRORUI       = 0x0400;
    const uint FOFX_ADDUNDORECORD  = 0x20000000;
    const uint FOFX_RECYCLEONDELETE= 0x00080000;

    // Single-item recycle (one IFileOperation per call).
    public static void Recycle(string path) {
        Guid IID_IShellItem      = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
        Guid CLSID_FileOperation = new Guid("3AD05575-8857-4850-9277-11B85BDB8E09");
        Type t = Type.GetTypeFromCLSID(CLSID_FileOperation);
        IFileOperation fo = (IFileOperation)Activator.CreateInstance(t);
        IShellItem item = null;
        try {
            fo.SetOperationFlags(FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI |
                FOF_ALLOWUNDO | FOFX_ADDUNDORECORD | FOFX_RECYCLEONDELETE);
            item = Win32.SHCreateItemFromParsingName(path, IntPtr.Zero, ref IID_IShellItem);
            fo.DeleteItem(item, IntPtr.Zero);
            fo.PerformOperations();
            if (fo.GetAnyOperationsAborted())
                throw new System.IO.IOException("IFileOperation aborted.");
        } finally {
            if (item != null) Marshal.ReleaseComObject(item);
            if (fo   != null) Marshal.ReleaseComObject(fo);
        }
    }
}

}
'@
if (-not ([System.Management.Automation.PSTypeName]'RecycleHelper.RecycleBin').Type) {
    Add-Type -TypeDefinition $nativeDef -ErrorAction Stop
}

# -------------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------------
function Get-SelfPidSet {
    $set = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$set.Add($PID)
    try {
        $allProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
        $byPid = @{}
        foreach ($p in $allProcs) { $byPid[[int]$p.ProcessId] = [int]$p.ParentProcessId }
        $cur = $PID; $guard = 0
        while ($byPid.ContainsKey($cur) -and $guard -lt 64) {
            $parent = $byPid[$cur]
            if ($parent -le 0 -or $parent -eq $cur) { break }
            if (-not $set.Add($parent)) { break }
            $cur = $parent; $guard++
        }
        foreach ($p in $allProcs) {
            if ([int]$p.ParentProcessId -eq $PID) { [void]$set.Add([int]$p.ProcessId) }
        }
    } catch {}
    return $set
}
$script:SelfPids = Get-SelfPidSet
Write-Verbose ("Self PID chain (won't kill): {0}" -f (($script:SelfPids | Sort-Object) -join ', '))

function Test-IsAdmin {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object System.Security.Principal.WindowsPrincipal($id)).IsInRole(
        [System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-PathInside {
    param([string]$Child, [string]$Parent)
    if (-not $Child -or -not $Parent) { return $false }
    try {
        $c = [IO.Path]::GetFullPath($Child).TrimEnd('\').ToLowerInvariant()
        $p = [IO.Path]::GetFullPath($Parent).TrimEnd('\').ToLowerInvariant()
        return ($c -eq $p) -or $c.StartsWith($p + '\')
    } catch { return $false }
}

function Get-TargetFiles {
    param([string]$P)
    if (Test-Path -LiteralPath $P -PathType Container) {
        try {
            return @(Get-ChildItem -LiteralPath $P -Recurse -Force -File -ErrorAction SilentlyContinue |
                ForEach-Object { $_.FullName })
        } catch { return @() }
    }
    return @($P)
}

function Stop-KnownLockers {
    param([string]$P)
    $killed = 0
    function _try_kill {
        param([System.Diagnostics.Process]$proc, [string]$why)
        if (-not $proc) { return $false }
        if ($script:SelfPids.Contains([int]$proc.Id)) { return $false }
        if ($proc.Id -le 4) { return $false }
        if ($proc.ProcessName -ieq 'explorer') { return $false }
        try {
            Write-Verbose ("  killing PID {0} {1}.exe - {2}" -f $proc.Id, $proc.ProcessName, $why)
            Stop-Process -Id $proc.Id -Force -ErrorAction Stop
            return $true
        } catch {
            return $false
        }
    }
    $files = Get-TargetFiles $P
    if ($files.Count -eq 0) { $files = @($P) }
    $batch = 200
    $rmPids = New-Object 'System.Collections.Generic.HashSet[int]'
    for ($i = 0; $i -lt $files.Count; $i += $batch) {
        $end = [Math]::Min($i + $batch - 1, $files.Count - 1)
        $chunk = $files[$i..$end]
        try {
            foreach ($x in [RecycleHelper.FileLockInfo]::WhoIsLocking($chunk)) {
                [void]$rmPids.Add([int]$x)
            }
        } catch {}
    }
    foreach ($id in $rmPids) {
        try {
            $proc = Get-Process -Id $id -ErrorAction Stop
            if (_try_kill $proc 'RM file-handle') { $killed++ }
        } catch {}
    }
    foreach ($proc in (Get-Process -ErrorAction SilentlyContinue)) {
        try {
            if ($proc.Path -and (Test-PathInside $proc.Path $P)) {
                if (_try_kill $proc '.exe inside target') { $killed++ }
            }
        } catch {}
    }
    if (Test-IsAdmin) {
        foreach ($proc in (Get-Process -ErrorAction SilentlyContinue)) {
            try {
                foreach ($mod in $proc.Modules) {
                    if ($mod.FileName -and (Test-PathInside $mod.FileName $P)) {
                        if (_try_kill $proc 'loaded module inside target') { $killed++ }
                        break
                    }
                }
            } catch {}
        }
    }
    return $killed
}

function Grant-FullAccess {
    param([string]$P)
    try {
        $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        if (Test-Path -LiteralPath $P -PathType Container) {
            & takeown.exe /F "$P" /R /D Y 2>&1 | Out-Null
            & icacls.exe  "$P" /grant "*S-1-5-32-544:(F)" /T /C /Q 2>&1 | Out-Null
            & icacls.exe  "$P" /grant ("{0}:(F)" -f $me)  /T /C /Q 2>&1 | Out-Null
        } else {
            & takeown.exe /F "$P" 2>&1 | Out-Null
            & icacls.exe  "$P" /grant "*S-1-5-32-544:(F)" /C /Q 2>&1 | Out-Null
            & icacls.exe  "$P" /grant ("{0}:(F)" -f $me)  /C /Q 2>&1 | Out-Null
        }
    } catch {}
}

function Clear-Attributes {
    param([string]$P)
    try {
        $items = @()
        $items += Get-Item -LiteralPath $P -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $P -PathType Container) {
            $items += Get-ChildItem -LiteralPath $P -Recurse -Force -ErrorAction SilentlyContinue
        }
        $bad = [IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System
        foreach ($it in $items) {
            if ($null -eq $it) { continue }
            try {
                if ($it.Attributes -band $bad) {
                    $it.Attributes = $it.Attributes -band -bnot $bad
                }
            } catch {}
        }
    } catch {}
}

function Rename-ToFresh {
    param([string]$P)
    $parent = Split-Path -Parent $P
    $stamp = [guid]::NewGuid().ToString("N").Substring(0,8)
    $newName = '_to_delete_' + $stamp
    $newPath = Join-Path $parent $newName
    try {
        Rename-Item -LiteralPath $P -NewName $newName -Force -ErrorAction Stop
        Write-Verbose ("  renamed to: {0}" -f $newPath)
        return $newPath
    } catch {
        return $P
    }
}

# Single-item send-to-recycle-bin with small retries.
# Returns $true if the item is no longer at $P.
function Recycle-OneItem {
    param([string]$P, [int]$Retries = 3)
    for ($i = 1; $i -le $Retries; $i++) {
        try {
            [RecycleHelper.RecycleBin]::Recycle($P)
            if (-not (Test-Path -LiteralPath $P)) { return $true }
        } catch {
            if ($i -eq $Retries) {
                Write-Verbose ("    recycle failed for: {0} ({1})" -f $P, $_.Exception.Message)
            }
        }
        Start-Sleep -Milliseconds (100 * $i)
    }
    return (-not (Test-Path -LiteralPath $P))
}

# Piecemeal recycle: walk the tree bottom-up, sending every file then
# every (now-empty) directory to the Recycle Bin individually.
# Returns @{ Success = $true|$false; FilesOk = N; FilesFailed = N; DirsOk = N; DirsFailed = N }
function Invoke-PiecemealRecycle {
    param([string]$Root)
    $stat = @{ Success = $false; FilesOk = 0; FilesFailed = 0; DirsOk = 0; DirsFailed = 0; FailedItems = @() }

    if (-not (Test-Path -LiteralPath $Root)) { $stat.Success = $true; return $stat }

    # If $Root is a file, just recycle it
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        if (Recycle-OneItem $Root) { $stat.FilesOk++ } else { $stat.FilesFailed++; $stat.FailedItems += $Root }
        $stat.Success = (-not (Test-Path -LiteralPath $Root))
        return $stat
    }

    # Collect all files and dirs, sort by depth descending (deepest first)
    Write-Verbose "Enumerating tree..."
    $allFiles = @()
    $allDirs = @()
    try {
        $allFiles = @(Get-ChildItem -LiteralPath $Root -Recurse -Force -File -ErrorAction SilentlyContinue |
                      ForEach-Object { $_.FullName })
        $allDirs = @(Get-ChildItem -LiteralPath $Root -Recurse -Force -Directory -ErrorAction SilentlyContinue |
                     ForEach-Object { $_.FullName })
    } catch {}

    Write-Verbose ("  total: {0} files, {1} subdirs" -f $allFiles.Count, $allDirs.Count)

    # 1) Recycle all files
    foreach ($f in $allFiles) {
        if (-not (Test-Path -LiteralPath $f)) { $stat.FilesOk++; continue }
        try {
            $it = Get-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
            if ($it -and ($it.Attributes -band [IO.FileAttributes]::ReadOnly)) {
                $it.Attributes = $it.Attributes -band -bnot [IO.FileAttributes]::ReadOnly
            }
        } catch {}
        if (Recycle-OneItem $f) {
            $stat.FilesOk++
        } else {
            $stat.FilesFailed++
            $stat.FailedItems += $f
        }
    }

    # 2) Recycle directories deepest-first
    $allDirs = $allDirs | Sort-Object { ($_ -split '[\\/]').Count } -Descending
    foreach ($d in $allDirs) {
        if (-not (Test-Path -LiteralPath $d)) { $stat.DirsOk++; continue }
        # Skip dirs that still have content (couldn't recycle some files)
        $hasContent = $false
        try {
            $hasContent = @(Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue).Count -gt 0
        } catch {}
        if ($hasContent) {
            $stat.DirsFailed++
            $stat.FailedItems += $d
            continue
        }
        if (Recycle-OneItem $d) {
            $stat.DirsOk++
        } else {
            $stat.DirsFailed++
            $stat.FailedItems += $d
        }
    }

    # 3) Finally, the root itself
    if (Test-Path -LiteralPath $Root) {
        $rootHasContent = $false
        try {
            $rootHasContent = @(Get-ChildItem -LiteralPath $Root -Force -ErrorAction SilentlyContinue).Count -gt 0
        } catch {}
        if (-not $rootHasContent) {
            if (Recycle-OneItem $Root) {
                $stat.DirsOk++
            } else {
                $stat.DirsFailed++
                $stat.FailedItems += $Root
            }
        } else {
            $stat.DirsFailed++
            $stat.FailedItems += "$Root (still contains items)"
        }
    } else {
        $stat.DirsOk++
    }

    $stat.Success = (-not (Test-Path -LiteralPath $Root))
    return $stat
}

# -------------------------------------------------------------------------
# Strategies
# -------------------------------------------------------------------------
function Try-Recycle    { param([string]$P) [RecycleHelper.RecycleBin]::Recycle($P) }
function Try-RemoveItem { param([string]$P) Remove-Item -LiteralPath $P -Recurse -Force -ErrorAction Stop }
function Try-CmdRd {
    param([string]$P)
    if (Test-Path -LiteralPath $P -PathType Container) {
        & cmd.exe /c "rd /s /q `"$P`"" 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $P)) { throw "rd failed" }
    } else {
        & cmd.exe /c "del /f /q `"$P`"" 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $P)) { throw "del failed" }
    }
}
function Try-Robocopy {
    param([string]$P)
    if (-not (Test-Path -LiteralPath $P -PathType Container)) { Try-RemoveItem $P; return }
    $tmp = Join-Path $env:TEMP ("recycle-empty-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        & robocopy.exe $tmp $P /MIR /NFL /NDL /NJH /NJS /NC /NS /NP /R:1 /W:1 2>&1 | Out-Null
        Remove-Item -LiteralPath $P -Force -ErrorAction Stop
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# -------------------------------------------------------------------------
# Main
# -------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $Path)) {
    Write-Error "Path does not exist: $Path"
    exit 2
}

$isAdmin = Test-IsAdmin
$mode = if ($Purge) { 'PURGE' } else { 'RECYCLE' }
Write-Verbose ("Target  : {0}" -f $Path)
Write-Verbose ("Mode    : {0}  Admin: {1}" -f $mode, $isAdmin)

$currentPath = $Path

if ($Purge) {
    $strategies = @(
        @{ Name = 'Remove-Item';   Action = { Try-RemoveItem $currentPath } },
        @{ Name = 'cmd rd /s /q';  Action = { Try-CmdRd $currentPath } },
        @{ Name = 'robocopy /MIR'; Action = { Try-Robocopy $currentPath } }
    )
    $lastErr = $null; $succeeded = $false
    foreach ($strat in $strategies) {
        if ($succeeded) { break }
        for ($attempt = 1; $attempt -le $MaxRetries; $attempt++) {
            try {
                Write-Verbose ("[{0}] attempt #{1}" -f $strat.Name, $attempt)
                & $strat.Action
                if (-not (Test-Path -LiteralPath $currentPath)) {
                    $succeeded = $true; break
                }
                throw "still exists"
            } catch {
                $lastErr = $_
                if ($attempt -lt $MaxRetries) {
                    Clear-Attributes $currentPath
                    Grant-FullAccess $currentPath
                    [void](Stop-KnownLockers $currentPath)
                    Start-Sleep -Milliseconds (300 * $attempt)
                }
            }
        }
    }
    if ($succeeded) { exit 0 }
    Write-Error ("Purge failed. Last error: {0}" -f $lastErr.Exception.Message)
    exit 1
}

# === Recycle mode ===
$deadline = (Get-Date).AddSeconds($RecycleTimeoutSec)
$attempt = 0
$lastErr = $null
$renamedOnce = $false

while ((Get-Date) -lt $deadline) {
    $attempt++
    try {
        Write-Verbose ("[whole-folder] attempt #{0} on: {1}" -f $attempt, $currentPath)
        Try-Recycle $currentPath
        if (-not (Test-Path -LiteralPath $currentPath)) {
            Write-Verbose "SUCCESS (whole-folder recycle)"
            exit 0
        }
        throw "still exists"
    } catch {
        $lastErr = $_
        Write-Verbose ("  failed: {0}" -f $_.Exception.Message)
    }

    Clear-Attributes $currentPath
    Grant-FullAccess $currentPath
    $killed = Stop-KnownLockers $currentPath
    if ($killed -gt 0) {
        Start-Sleep -Milliseconds 400
        continue
    }
    if (-not $renamedOnce -and $attempt -ge 2) {
        Write-Verbose "  trying rename-to-fresh..."
        $newP = Rename-ToFresh $currentPath
        if ($newP -ne $currentPath) {
            $currentPath = $newP
            $renamedOnce = $true
            Start-Sleep -Milliseconds 500
            continue
        }
    }
    $waitMs = [Math]::Min(800, 150 + $attempt * 100)
    Write-Verbose ("  no killable lockers; waiting {0}ms" -f $waitMs)
    Start-Sleep -Milliseconds $waitMs
}

# Stage1Only early exit: caller wants user confirmation before fragmented recycle.
if ($Stage1Only) {
    Write-Verbose "Stage 1 exhausted; -Stage1Only set, NOT attempting piecemeal. Exit 3."
    exit 3
}

# === Piecemeal recycle fallback ===
Write-Verbose ""
Write-Verbose "=== Whole-folder recycle exhausted. Falling back to PIECEMEAL recycle. ==="
Write-Verbose "Each file/subfolder will be sent to Recycle Bin individually."

Clear-Attributes $currentPath
Grant-FullAccess $currentPath
[void](Stop-KnownLockers $currentPath)

$stat = Invoke-PiecemealRecycle $currentPath

Write-Verbose ("Piecemeal result: {0} files OK / {1} failed, {2} dirs OK / {3} failed" -f
    $stat.FilesOk, $stat.FilesFailed, $stat.DirsOk, $stat.DirsFailed)

if ($stat.Success) {
    Write-Verbose "SUCCESS (piecemeal recycle - all items in Recycle Bin individually)"
    exit 4
}

# Some items refused even individual recycle. Show what's left.
Write-Verbose "Some items could not be recycled individually:"
foreach ($f in ($stat.FailedItems | Select-Object -First 10)) {
    Write-Verbose ("  - {0}" -f $f)
}
Write-Error ("Piecemeal recycle incomplete. {0} item(s) remain. Use --purge to force." -f $stat.FailedItems.Count)
exit 1