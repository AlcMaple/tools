import { useEffect, useMemo, useRef, useState } from 'react'
import TopBar from '../components/TopBar'
import type { FsEntry } from '../env.d.ts'
import { friendlyError } from '../utils/errorMessage'

// ── Constants ─────────────────────────────────────────────────────────────────

const VIRTUAL_ROOT = '__root__'

// ── Path helpers (platform-aware) ─────────────────────────────────────────────

function normPath(input: string, plat: string): string {
  if (!input) return ''
  if (plat === 'win32') {
    let p = input.trim().replace(/\//g, '\\').replace(/\\+/g, '\\')
    if (/^[a-z]:$/i.test(p)) p += '\\'
    if (p.length > 3 && p.endsWith('\\')) p = p.slice(0, -1)
    if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1)
    return p
  }
  return input.trim()
}

function parentOf(p: string, plat: string): string | null {
  if (!p || p === VIRTUAL_ROOT) return null
  if (plat === 'win32') {
    if (/^[A-Z]:\\?$/i.test(p)) return VIRTUAL_ROOT
    const clean = p.replace(/\\$/, '')
    const idx = clean.lastIndexOf('\\')
    if (idx <= 2) return clean.slice(0, 3)
    return clean.slice(0, idx)
  } else {
    if (p === '/') return null
    const clean = p.replace(/\/$/, '')
    const idx = clean.lastIndexOf('/')
    if (idx === 0) return '/'
    return clean.slice(0, idx)
  }
}

/**
 * Whether `s` looks like a single token without path structure — candidate for
 * a special-folder alias resolution (e.g. "下载", "Downloads"). Inputs that
 * already contain separators or a Windows drive prefix are real paths and
 * shouldn't be aliased.
 */
function looksLikeAlias(s: string): boolean {
  return !s.includes('/') && !s.includes('\\') && !/^[a-z]:/i.test(s)
}

/**
 * Paths the user must never be able to delete: the virtual "我的电脑" root,
 * Windows drive roots (C:\, D:\, ...), and POSIX root /. Deleting any of these
 * either makes no semantic sense or is catastrophic.
 */
function isProtectedPath(p: string, plat: string): boolean {
  if (!p || p === VIRTUAL_ROOT) return true
  if (plat === 'win32') return /^[A-Z]:\\?$/i.test(p)
  return p === '/'
}

function basenameOf(p: string, plat: string): string {
  if (!p || p === VIRTUAL_ROOT) return '我的电脑'
  if (plat === 'win32') {
    if (/^[A-Z]:\\?$/i.test(p)) return p.slice(0, 2)
    return p.slice(p.lastIndexOf('\\') + 1)
  }
  if (p === '/') return '/'
  const clean = p.replace(/\/$/, '')
  return clean.slice(clean.lastIndexOf('/') + 1)
}

// ── Display helpers ───────────────────────────────────────────────────────────

function fmtSize(b: number | undefined): string {
  if (b == null) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, n = b
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n < 10 && i > 0 ? n.toFixed(2) : n < 100 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`
}

function kindLabel(node: FsEntry): string {
  if (node.type === 'folder') return '文件夹'
  const m: Record<string, string> = { video: '视频文件', image: '图像文件', archive: '压缩文件', text: '文本文档' }
  return m[node.kind ?? ''] ?? (node.ext ? `${node.ext.replace('.', '').toUpperCase()} 文件` : '文件')
}

function iconFor(node: FsEntry): string {
  if (node.type === 'folder') return 'folder'
  return ({ video: 'movie', image: 'image', archive: 'folder_zip', text: 'description' } as Record<string, string>)[node.kind ?? ''] ?? 'draft'
}

function colorFor(node: FsEntry): string {
  if (node.type === 'folder') return 'text-primary'
  return ({ video: 'text-primary/80', image: 'text-secondary', archive: 'text-[#c8c6c6]', text: 'text-[#d9c1c1]' } as Record<string, string>)[node.kind ?? ''] ?? 'text-on-surface-variant'
}

// ── Types ─────────────────────────────────────────────────────────────────────

type ViewMode = 'list' | 'grid'
type SortKey = 'name' | 'size' | 'mtime' | 'kind'

const SORT_LABELS: Record<SortKey, string> = { name: 'Name', size: 'Size', mtime: 'Modified', kind: 'Type' }

interface DeletePending { targets: FsEntry[]; permanent: boolean }
interface CtxState { x: number; y: number; path: string; flipX: boolean; flipY: boolean }
interface ToastState { title: string; msg: string; icon: string }
interface DeleteFailure { name: string; path: string; error: unknown }
interface DeleteResultState {
  permanent: boolean
  succeededCount: number
  failures: DeleteFailure[]
}
/**
 * 「移到回收站」Stage 1 失败后弹的中段确认弹窗的 state。
 *
 * - `targets`        Stage 1 失败、等用户决策的目标列表
 * - `succeededSoFar` 同一批操作里 Stage 1 已经成功的数量（弹窗等用户决策
 *                    期间不能丢失这部分进度，用户取消时仅 finalize 这部分）
 * - `failuresSoFar`  同一批里 Stage 1 抛错的（spawn 失败 / 路径错等）
 * - `totalTargets`   这一批的总目标数，用于最终 finalize 时的文案
 */
interface PendingStage2 {
  targets: FsEntry[]
  succeededSoFar: number
  failuresSoFar: DeleteFailure[]
  totalTargets: number
}

/**
 * 删除进行中状态 —— 用来弹"正在删除…"的阻塞加载层。删除流程的耗时不是
 * 立即可见的：
 *   - trash-stage1：每个目标 5s 整体回收窗口 + 杀进程 + ACL 操作
 *   - trash-stage2：递归枚举整棵树后逐个 IFileOperation，文件多时分钟级别
 *   - permanent：Remove-Item → rd /s /q → robocopy /MIR 三级 fallback
 * 没有 loader 用户只看到弹窗一关就什么动静都没了，会怀疑 app 卡死。
 *
 * 多目标时用 currentIndex/total/currentTarget 给个粗粒度进度感（每个目标
 * 跨过去就更新一次），单目标时只显示目标名。这是"模糊但有"的进度反馈,
 * 比 indeterminate spinner 强一档，比真实子步骤进度（需要 PS streaming）
 * 弱一档但实现成本低。
 */
interface DeleteInProgress {
  mode: 'trash-stage1' | 'trash-stage2' | 'permanent'
  currentTarget: string
  currentIndex: number
  total: number
}

// ── Title slot ────────────────────────────────────────────────────────────────

const TITLE_SLOT = (
  <div className="flex items-center gap-4">
    <h2 className="text-2xl font-bold tracking-tighter text-primary">File Explorer</h2>
    <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/60 hidden lg:inline">
      Windows / macOS — like file system
    </span>
  </div>
)

// ── Component ─────────────────────────────────────────────────────────────────

function lsPref<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(`fe.${key}`); return v !== null ? JSON.parse(v) as T : fallback } catch { return fallback }
}
function svPref(key: string, value: unknown): void {
  try { localStorage.setItem(`fe.${key}`, JSON.stringify(value)) } catch {}
}

function FileExplorer(): JSX.Element {
  const [platform, setPlatform] = useState('darwin')
  const [homeDir, setHomeDir] = useState('')
  const [cwd, setCwd] = useState('')
  const [isVirtualRoot, setIsVirtualRoot] = useState(false)
  const [items, setItems] = useState<FsEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [history, setHistory] = useState<string[]>([])
  const [hIdx, setHIdx] = useState(-1)
  const [view, setView] = useState<ViewMode>(() => lsPref<ViewMode>('view', 'list'))
  const [sort, setSort] = useState<SortKey>(() => lsPref<SortKey>('sort', 'name'))
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false)
  const sortDropdownRef = useRef<HTMLDivElement | null>(null)
  const [deleteMenuOpen, setDeleteMenuOpen] = useState(false)
  const deleteMenuRef = useRef<HTMLDivElement | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [addressInput, setAddressInput] = useState('')
  const [pathStatus, setPathStatus] = useState<{ msg: string; tone: 'ok' | 'error' | 'info' } | null>(null)
  const [ctx, setCtx] = useState<CtxState | null>(null)
  const [pendingDelete, setPendingDelete] = useState<DeletePending | null>(null)
  const [pendingStage2, setPendingStage2] = useState<PendingStage2 | null>(null)
  const [deleteInProgress, setDeleteInProgress] = useState<DeleteInProgress | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [deleteResult, setDeleteResult] = useState<DeleteResultState | null>(null)

  // Refs so stable callbacks (keyboard handler) always read fresh state
  const platformRef = useRef('darwin')
  const homeDirRef = useRef('')
  const cwdRef = useRef('')
  const histRef = useRef<string[]>([])
  const hIdxRef = useRef(-1)
  const selectedRef = useRef<Set<string>>(new Set())
  const itemsRef = useRef<FsEntry[]>([])
  const pendingDeleteRef = useRef<DeletePending | null>(null)

  platformRef.current = platform
  homeDirRef.current = homeDir
  cwdRef.current = cwd
  histRef.current = history
  hIdxRef.current = hIdx
  selectedRef.current = selected
  itemsRef.current = items
  pendingDeleteRef.current = pendingDelete

  // Keep address input in sync with cwd
  useEffect(() => {
    setAddressInput(cwd === VIRTUAL_ROOT ? '' : cwd)
  }, [cwd])

  // Auto-dismiss status flash
  useEffect(() => {
    if (!pathStatus) return
    const t = setTimeout(() => setPathStatus(null), 2200)
    return () => clearTimeout(t)
  }, [pathStatus])

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(t)
  }, [toast])

  // Sort dropdown click-away
  useEffect(() => {
    if (!sortDropdownOpen) return
    const onClickAway = (e: MouseEvent): void => {
      if (sortDropdownRef.current && !sortDropdownRef.current.contains(e.target as Node)) {
        setSortDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickAway)
    return () => document.removeEventListener('mousedown', onClickAway)
  }, [sortDropdownOpen])

  // Delete split-button menu click-away
  useEffect(() => {
    if (!deleteMenuOpen) return
    const onClickAway = (e: MouseEvent): void => {
      if (deleteMenuRef.current && !deleteMenuRef.current.contains(e.target as Node)) {
        setDeleteMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickAway)
    return () => document.removeEventListener('mousedown', onClickAway)
  }, [deleteMenuOpen])

  // Context menu dismissal
  useEffect(() => {
    if (!ctx) return
    const onClickAway = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement).closest('[data-ctx-menu]')) setCtx(null)
    }
    const onScroll = (): void => setCtx(null)
    document.addEventListener('click', onClickAway)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', () => setCtx(null))
    return () => {
      document.removeEventListener('click', onClickAway)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [ctx])

  // ── Navigation ──

  async function doNavTo(path: string, fromHistory: boolean): Promise<void> {
    setLoading(true)
    try {
      const result = await window.fileExplorerApi.listDir(path)
      setCwd(path)
      setItems(result.entries)
      setIsVirtualRoot(result.isVirtualRoot)
      setSelected(new Set())
      if (!fromHistory) {
        const next = histRef.current.slice(0, hIdxRef.current + 1).concat(path)
        setHistory(next)
        setHIdx(next.length - 1)
      }
    } catch (e) {
      setPathStatus({ msg: `无法访问: ${(e as Error).message}`, tone: 'error' })
    } finally {
      setLoading(false)
    }
  }

  async function refresh(): Promise<void> {
    if (!cwdRef.current) return
    setLoading(true)
    try {
      const result = await window.fileExplorerApi.listDir(cwdRef.current)
      setItems(result.entries)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  /**
   * 删完之后让 UI 退到一个还存在的目录上 —— 永远不让 cwd 卡在已删除的路径。
   *
   * 双保险：
   *   1. 优先调 fs:find-existing-ancestor IPC（主进程 stat 测，一次定位）
   *   2. IPC 不可用 / 报错 → 用 platform-aware 字符串 dirname 爬一层、用
   *      listDir 当存在性探针，循环直到能列出来或爬到顶
   *
   * 一切都不行就 up() 兜底跳 home / virtual root。
   */
  async function navigateToSurvivingAncestor(): Promise<void> {
    const cwd = cwdRef.current
    if (!cwd) return

    // Path 1: precise via main IPC
    let survivor: string | null | undefined
    try {
      survivor = await window.fileExplorerApi.findExistingAncestor(cwd)
    } catch {
      survivor = undefined
    }

    // Path 2: fallback —— renderer 自己爬 dirname，每一级用 listDir 试探
    if (survivor === undefined) {
      let cur = cwd
      while (true) {
        const next = parentOf(cur, platformRef.current)
        if (!next || next === cur) {
          survivor = null
          break
        }
        try {
          await window.fileExplorerApi.listDir(next)
          survivor = next
          break
        } catch {
          cur = next
        }
      }
    }

    if (!survivor) {
      up()
      return
    }
    if (survivor === cwd) {
      // cwd 还活着（删的是 children），照常 refresh
      await refresh()
      return
    }
    await doNavTo(survivor, false)
  }

  function back(): void {
    if (hIdxRef.current > 0) {
      const i = hIdxRef.current - 1
      setHIdx(i)
      doNavTo(histRef.current[i], true)
    }
  }

  function forward(): void {
    if (hIdxRef.current < histRef.current.length - 1) {
      const i = hIdxRef.current + 1
      setHIdx(i)
      doNavTo(histRef.current[i], true)
    }
  }

  function up(): void {
    const root = platformRef.current === 'win32' ? VIRTUAL_ROOT : homeDirRef.current
    if (root && cwdRef.current !== root) doNavTo(root, false)
  }

  // Persist sort/view/path to localStorage on every change
  useEffect(() => { svPref('sort', sort) }, [sort])
  useEffect(() => { svPref('view', view) }, [view])
  useEffect(() => { if (cwd) svPref('lastPath', cwd) }, [cwd])

  // Initial load — platform info + navigate to last path (sort/view already init'd from localStorage)
  useEffect(() => {
    window.fileExplorerApi.getHomeInfo().then(async ({ homeDir: hd, platform: plat }) => {
      setPlatform(plat)
      platformRef.current = plat
      setHomeDir(hd)
      homeDirRef.current = hd

      const startPath = lsPref('lastPath', hd) || hd
      setLoading(true)
      try {
        const result = await window.fileExplorerApi.listDir(startPath)
        setCwd(startPath)
        setItems(result.entries)
        setIsVirtualRoot(result.isVirtualRoot)
        setHistory([startPath])
        setHIdx(0)
      } catch {
        doNavTo(hd, false)
      } finally {
        setLoading(false)
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-refresh when the current directory changes on disk
  useEffect(() => {
    const unsub = window.fileExplorerApi.onDirChange(() => refresh())
    return unsub
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Keyboard shortcuts (stable — reads via refs) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return

      if (pendingDeleteRef.current) {
        if (e.key === 'Escape') setPendingDelete(null)
        else if (e.key === 'Enter') confirmDelete()
        return
      }

      if (e.key === 'Backspace') { e.preventDefault(); up() }
      else if (e.key === 'Enter' && selectedRef.current.size === 1) {
        const p = [...selectedRef.current][0]
        const item = itemsRef.current.find((i) => i.path === p)
        if (item?.type === 'folder') doNavTo(p, false)
        else if (item) window.fileExplorerApi.open(p)
      }
      else if (e.key === 'Delete' && selectedRef.current.size) {
        // Filter out drive roots / virtual root — never deletable.
        const allowed = [...selectedRef.current].filter((p) => !isProtectedPath(p, platformRef.current))
        if (allowed.length) openDeleteDialog(allowed, e.shiftKey)
      }
      else if (e.key === 'Escape') setSelected(new Set())
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Address bar actions ──

  async function tryOpenInput(): Promise<void> {
    const raw = addressInput.trim()
    if (!raw) { setPathStatus({ msg: '请输入路径', tone: 'error' }); return }

    // Try special-folder alias resolution first when the input looks like a bare
    // localized name (e.g. "下载" copied from Windows Explorer's address bar).
    // On hit, expand the address bar to the real path so the user sees what was
    // resolved.
    let p = normPath(raw, platform)
    if (looksLikeAlias(raw)) {
      const resolved = await window.fileExplorerApi.resolveSpecial(raw)
      if (resolved) {
        p = resolved
        setAddressInput(resolved)
      }
    }

    try {
      const result = await window.fileExplorerApi.listDir(p)
      setCwd(p)
      setItems(result.entries)
      setIsVirtualRoot(result.isVirtualRoot)
      setSelected(new Set())
      const next = histRef.current.slice(0, hIdxRef.current + 1).concat(p)
      setHistory(next)
      setHIdx(next.length - 1)
      setPathStatus({ msg: '已打开', tone: 'ok' })
    } catch {
      // might be a file — navigate to parent and select
      const parent = parentOf(p, platform)
      if (parent) {
        try {
          const result = await window.fileExplorerApi.listDir(parent)
          setCwd(parent)
          setItems(result.entries)
          setIsVirtualRoot(result.isVirtualRoot)
          setSelected(new Set([p]))
          const next = histRef.current.slice(0, hIdxRef.current + 1).concat(parent)
          setHistory(next)
          setHIdx(next.length - 1)
          setPathStatus({ msg: '已定位文件', tone: 'ok' })
        } catch {
          setPathStatus({ msg: '路径不存在', tone: 'error' })
        }
      } else {
        setPathStatus({ msg: '路径不存在', tone: 'error' })
      }
    }
  }

  async function tryDeleteInput(permanent = false): Promise<void> {
    const raw = addressInput.trim()
    if (!raw) { setPathStatus({ msg: '请输入要删除的路径', tone: 'error' }); return }

    // Same alias resolution as Open — pasting "下载" should target the real
    // Downloads folder. The confirmation dialog will display the resolved path,
    // so the user can still abort if it's not what they intended.
    let p = normPath(raw, platform)
    if (looksLikeAlias(raw)) {
      const resolved = await window.fileExplorerApi.resolveSpecial(raw)
      if (resolved) {
        p = resolved
        setAddressInput(resolved)
      }
    }

    if (isProtectedPath(p, platform)) {
      setPathStatus({ msg: '系统根目录不可删除', tone: 'error' })
      return
    }

    const found = items.find((i) => i.path === p) ?? { name: basenameOf(p, platform), path: p, type: 'file' as const }
    openDeleteDialog([p], permanent, [found])
  }

  // ── Delete flow ──

  function openDeleteDialog(paths: string[], permanent: boolean, overrideTargets?: FsEntry[]): void {
    const targets = overrideTargets ?? paths.map((p) => items.find((i) => i.path === p)).filter(Boolean) as FsEntry[]
    if (!targets.length) return
    setPendingDelete({ targets, permanent })
  }

  // Stable ref so keyboard handler can call confirmDelete without stale closure
  const confirmDeleteRef = useRef<() => void>(() => {})

  /**
   * 三段式：finalize → 永久删除一把跑 / 回收站走 Stage 1 + 可能弹 Stage 2 确认。
   *
   * - **永久删除**：跑完所有目标，根据 success / failures 决定 toast vs 结果弹窗。
   *   没有 Stage 概念，行为跟旧版一致。
   *
   * - **回收站（默认）**：先对所有目标跑 Stage 1（每个目标 5s 整体送回收站窗口）。
   *   Stage 1 成功 → 直接计入 succeeded；
   *   Stage 1 失败（返回 `stage1-failed`） → 收集到 stage1Failed[]，**不**自动
   *   进 Stage 2；
   *   Stage 1 抛错 → 计入 failures。
   *   循环跑完后，如果 stage1Failed 非空，弹 PendingStage2 确认弹窗让用户决策；
   *   弹窗里继续 → 调 trashFragmented 跑完 Stage 2；取消 → 仅 finalize Stage 1
   *   阶段的结果，**不**自动 fallback 到永久删除。
   */
  async function confirmDelete(): Promise<void> {
    const pd = pendingDeleteRef.current
    if (!pd) return
    setPendingDelete(null)

    if (pd.permanent) {
      await runPermanentDelete(pd.targets)
      return
    }

    // 回收站模式 —— Stage 1 pass
    const failures: DeleteFailure[] = []
    const stage1Failed: FsEntry[] = []
    let succeeded = 0
    for (let i = 0; i < pd.targets.length; i++) {
      const t = pd.targets[i]
      setDeleteInProgress({
        mode: 'trash-stage1',
        currentTarget: t.name,
        currentIndex: i + 1,
        total: pd.targets.length,
      })
      try {
        const r = await window.fileExplorerApi.trash(t.path)
        if (r.status === 'stage1-failed') {
          stage1Failed.push(t)
        } else {
          // success / already-absent —— 都当成功
          succeeded += 1
        }
      } catch (e: unknown) {
        failures.push({ name: t.name, path: t.path, error: e })
      }
    }
    setDeleteInProgress(null)

    setSelected(new Set())
    await navigateToSurvivingAncestor()

    if (stage1Failed.length > 0) {
      // 弹 Stage 2 确认弹窗，保留 Stage 1 已经累积的进度数据让取消 / 继续
      // 都能正确 finalize。
      setPendingStage2({
        targets: stage1Failed,
        succeededSoFar: succeeded,
        failuresSoFar: failures,
        totalTargets: pd.targets.length,
      })
      return
    }

    finalizeTrashResult(succeeded, failures, [], pd.targets.length)
  }

  /**
   * 永久删除 —— 跟回收站完全分开，没有 Stage 概念。
   *
   * IPC 现在返回 `{ status: 'success' | 'already-absent' }`，两种都当成功；
   * 抛错走 failures。沿用 deleteResult / toast 同一套展示路径。
   */
  async function runPermanentDelete(targets: FsEntry[]): Promise<void> {
    const failures: DeleteFailure[] = []
    let succeeded = 0
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]
      setDeleteInProgress({
        mode: 'permanent',
        currentTarget: t.name,
        currentIndex: i + 1,
        total: targets.length,
      })
      try {
        await window.fileExplorerApi.deletePermanent(t.path)
        succeeded += 1
      } catch (e: unknown) {
        failures.push({ name: t.name, path: t.path, error: e })
      }
    }
    setDeleteInProgress(null)
    setSelected(new Set())
    await navigateToSurvivingAncestor()
    if (failures.length) {
      setDeleteResult({ permanent: true, succeededCount: succeeded, failures })
      return
    }
    setToast({
      title: '已永久删除',
      msg: targets.length === 1 ? targets[0].name : `${targets.length} 个项目`,
      icon: 'delete_forever',
    })
  }

  /**
   * 用户在 Stage 2 弹窗点「继续走分片回收」后调。
   *
   * 对 `pendingStage2.targets` 里每个目标调 trashFragmented（跑完整两阶段：
   * Stage 1 重试 → 失败进 Stage 2 分片）。`fragmented` 状态需要在 toast 里
   * 强提示"散件可还原"。这一轮的 success / fragmented / failures 跟之前
   * Stage 1 阶段累积的进度合并后 finalize。
   */
  async function confirmStage2(): Promise<void> {
    const s2 = pendingStage2
    if (!s2) return
    setPendingStage2(null)

    const failures = [...s2.failuresSoFar]
    const fragmented: FsEntry[] = []
    let succeeded = s2.succeededSoFar
    for (let i = 0; i < s2.targets.length; i++) {
      const t = s2.targets[i]
      setDeleteInProgress({
        mode: 'trash-stage2',
        currentTarget: t.name,
        currentIndex: i + 1,
        total: s2.targets.length,
      })
      try {
        const r = await window.fileExplorerApi.trashFragmented(t.path)
        if (r.status === 'fragmented') fragmented.push(t)
        succeeded += 1
      } catch (e: unknown) {
        failures.push({ name: t.name, path: t.path, error: e })
      }
    }
    setDeleteInProgress(null)
    await navigateToSurvivingAncestor()
    finalizeTrashResult(succeeded, failures, fragmented, s2.totalTargets)
  }

  /**
   * 用户在 Stage 2 弹窗点「取消」 —— 不自动 fallback 到永久删除（用户明确
   * 决策）。Stage 1 失败的目标维持现状（文件还在），不算 failures。只 finalize
   * 这一批里 Stage 1 已经成功的 / Stage 1 抛错的部分。
   */
  function cancelStage2(): void {
    const s2 = pendingStage2
    if (!s2) return
    setPendingStage2(null)
    finalizeTrashResult(
      s2.succeededSoFar,
      s2.failuresSoFar,
      [],
      s2.succeededSoFar + s2.failuresSoFar.length,
    )
    // 附加一行 hint：被用户取消的那批可以手动用永久删除处理。这条不弹错误弹窗,
    // 只在 toast 里以低调形式提示。如果同时还有 failures 走 deleteResult，
    // 后者会盖住这条 toast —— OK，那种情况下 hint 也不是最关键的信息。
    if (s2.targets.length > 0) {
      setTimeout(() => {
        setToast({
          title: '已取消分片回收',
          msg: `${s2.targets.length} 个项目仍在原位置。如要清理，请使用「永久删除」。`,
          icon: 'cancel',
        })
      }, 100)
    }
  }

  /**
   * 通用收尾：决定走 toast 还是 deleteResult 富错误弹窗。
   *
   * fragmented 列表非空时 toast 文案要区分：
   *   - 全分片：单独的"已分片送入回收站"标题，msg 解释散件 + 还原方法
   *   - 混合：标题保留"已移到回收站"，msg 提一句"其中 N 个为分片回收"
   */
  function finalizeTrashResult(
    succeeded: number,
    failures: DeleteFailure[],
    fragmented: FsEntry[],
    totalTargets: number,
  ): void {
    if (failures.length) {
      setDeleteResult({ permanent: false, succeededCount: succeeded, failures })
      return
    }
    const baseName = totalTargets === 1 && succeeded === 1
      ? '已成功（详见回收站）'
      : `${totalTargets} 个项目`
    if (fragmented.length === 0) {
      setToast({ title: '已移到回收站', msg: baseName, icon: 'delete' })
      return
    }
    if (fragmented.length === totalTargets) {
      setToast({
        title: '已分片送入回收站',
        msg: '内容仍可还原 —— 打开回收站全选 → 右键「还原」可重建目录结构',
        icon: 'splitscreen',
      })
      return
    }
    setToast({
      title: '已移到回收站',
      msg: `其中 ${fragmented.length} 个为分片回收，回收站里是散件可还原`,
      icon: 'delete',
    })
  }

  confirmDeleteRef.current = confirmDelete
  // Expose stable wrapper for keyboard handler
  function confirmDeleteStable(): void { confirmDeleteRef.current() }

  // ── Sorted items ──

  const sortedItems = useMemo(() => {
    const folders = items.filter((i) => i.type === 'folder')
    const files = items.filter((i) => i.type !== 'folder')
    const cmp = (a: FsEntry, b: FsEntry): number => {
      if (sort === 'size') return (b.size ?? 0) - (a.size ?? 0)
      if (sort === 'mtime') return String(b.mtime).localeCompare(String(a.mtime))
      if (sort === 'kind') return (a.kind ?? a.ext ?? '').localeCompare(b.kind ?? b.ext ?? '')
      return a.name.localeCompare(b.name, 'zh')
    }
    folders.sort(cmp); files.sort(cmp)
    return [...folders, ...files]
  }, [items, sort])

  const totalSize = sortedItems.reduce((s, i) => s + (i.size ?? 0), 0)

  // ── Row interactions ──

  function onRowClick(e: React.MouseEvent, path: string): void {
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(selected)
      if (next.has(path)) next.delete(path); else next.add(path)
      setSelected(next)
    } else {
      setSelected(new Set([path]))
    }
  }

  function onRowDoubleClick(item: FsEntry): void {
    if (item.type === 'folder') doNavTo(item.path, false)
    else window.fileExplorerApi.open(item.path)
  }

  function onRowContextMenu(e: React.MouseEvent, path: string): void {
    e.preventDefault()
    if (!selected.has(path)) setSelected(new Set([path]))
    // Native-style flipping: when the menu would overflow on the right/bottom,
    // anchor the OPPOSITE corner of the menu to the cursor instead of shifting
    // the whole thing. The cursor always sits at one of the menu's four corners.
    const MENU_W = 260
    const MENU_H = 220
    const PAD = 8
    const flipX = e.clientX + MENU_W + PAD > window.innerWidth
    const flipY = e.clientY + MENU_H + PAD > window.innerHeight
    setCtx({ x: e.clientX, y: e.clientY, path, flipX, flipY })
  }

  function statusToneClass(tone: 'ok' | 'error' | 'info'): string {
    return tone === 'error' ? 'text-error' : tone === 'ok' ? 'text-green-400' : 'text-on-surface-variant/60'
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const placeholder = platform === 'win32'
    ? '输入绝对路径，例如 C:\\Users\\Yuming\\Videos'
    : '输入绝对路径，例如 /Users/mac/Downloads'

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <TopBar placeholder="" titleSlot={TITLE_SLOT} />

      {/* Address bar */}
      <section className="px-8 pb-3 bg-background border-b border-white/5" style={{ paddingTop: '5rem' }}>
        <div className="flex items-center gap-2 mb-3">
          <div className="flex items-center gap-1">
            <button
              onClick={back}
              disabled={hIdx <= 0}
              title="后退"
              className="w-8 h-8 rounded-md hover:bg-surface-container-high disabled:opacity-30 disabled:hover:bg-transparent transition-colors flex items-center justify-center"
            >
              <span className="material-symbols-outlined text-[18px]">arrow_back</span>
            </button>
            <button
              onClick={forward}
              disabled={hIdx >= history.length - 1}
              title="前进"
              className="w-8 h-8 rounded-md hover:bg-surface-container-high disabled:opacity-30 disabled:hover:bg-transparent transition-colors flex items-center justify-center"
            >
              <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
            </button>
            <button
              onClick={up}
              disabled={platform === 'win32' ? cwd === VIRTUAL_ROOT : cwd === homeDir}
              title="根目录"
              className="w-8 h-8 rounded-md hover:bg-surface-container-high disabled:opacity-30 disabled:hover:bg-transparent transition-colors flex items-center justify-center"
            >
              <span className="material-symbols-outlined text-[18px]">arrow_upward</span>
            </button>
          </div>

          <div className="flex-1 flex items-stretch bg-surface-container-lowest rounded-lg border border-white/5 focus-within:border-primary/50 transition-colors overflow-hidden">
            <button
              onClick={async () => {
                const picked = await window.systemApi.pickFolder()
                if (picked) doNavTo(picked, false)
              }}
              title="浏览文件夹"
              className="flex items-center pl-3 pr-2 text-on-surface-variant/60 hover:text-primary transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-[18px]">folder_open</span>
            </button>
            <input
              value={addressInput}
              onChange={(e) => setAddressInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') tryOpenInput() }}
              placeholder={placeholder}
              spellCheck={false}
              className="flex-1 bg-transparent border-0 focus:ring-0 py-2.5 px-1 text-sm font-mono tracking-tight text-on-surface placeholder:text-on-surface-variant/40 outline-none"
            />
            {pathStatus && (
              <span className={`flex items-center gap-1 px-3 font-label text-[10px] uppercase tracking-widest whitespace-nowrap ${statusToneClass(pathStatus.tone)}`}>
                {pathStatus.msg}
              </span>
            )}
          </div>

          <button
            onClick={tryOpenInput}
            className="flex items-center gap-1.5 px-4 h-10 rounded-lg bg-primary text-on-primary font-label text-[11px] font-bold uppercase tracking-widest hover:opacity-90 active:scale-95 transition-all"
            title="打开输入框中的路径"
          >
            <span className="material-symbols-outlined text-[16px]">arrow_outward</span>
            <span>Open</span>
          </button>
          <div className="relative inline-flex" ref={deleteMenuRef}>
            <button
              onClick={() => tryDeleteInput(false)}
              className="flex items-center gap-1.5 px-4 h-10 rounded-l-lg bg-surface-container-high border border-error/30 border-r-0 text-error font-label text-[11px] font-bold uppercase tracking-widest hover:bg-error/10 active:scale-95 transition-all"
              title="移到回收站（默认）"
            >
              <span className="material-symbols-outlined text-[16px]">delete</span>
              <span>Delete</span>
            </button>
            <button
              onClick={() => setDeleteMenuOpen((o) => !o)}
              className="flex items-center justify-center w-7 h-10 rounded-r-lg bg-surface-container-high border border-error/30 text-error hover:bg-error/10 active:scale-95 transition-all"
              title="更多删除选项"
            >
              <span className={`material-symbols-outlined text-[18px] transition-transform duration-200 ${deleteMenuOpen ? 'rotate-180' : ''}`}>expand_more</span>
            </button>
            {deleteMenuOpen && (
              <div className="absolute top-full right-0 mt-1.5 w-full bg-surface-container-highest border border-outline-variant/30 rounded-lg overflow-hidden shadow-lg z-50">
                <button
                  type="button"
                  onClick={() => { setDeleteMenuOpen(false); tryDeleteInput(false) }}
                  className="w-full flex items-center gap-1.5 px-3 py-2.5 text-xs font-label text-on-surface hover:bg-surface-container-high transition-colors text-left whitespace-nowrap"
                >
                  <span className="material-symbols-outlined text-[15px] text-on-surface-variant/70 shrink-0">delete</span>
                  <span>移到回收站</span>
                </button>
                <button
                  type="button"
                  onClick={() => { setDeleteMenuOpen(false); tryDeleteInput(true) }}
                  className="w-full flex items-center gap-1.5 px-3 py-2.5 text-xs font-label text-error hover:bg-error/10 transition-colors text-left whitespace-nowrap border-t border-outline-variant/15"
                >
                  <span className="material-symbols-outlined text-[15px] shrink-0">delete_forever</span>
                  <span>永久删除</span>
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-3">
          {/* Sort selector */}
          <div className="relative w-40" ref={sortDropdownRef}>
            <button
              type="button"
              onClick={() => setSortDropdownOpen((o) => !o)}
              className="w-full flex items-center justify-between gap-2 bg-surface-container-highest border border-outline-variant/30 text-on-surface text-xs font-label rounded-lg px-3 py-2 outline-none cursor-pointer hover:border-primary/40 transition-colors select-none"
            >
              <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/60">Sort</span>
              <span className="text-on-surface flex-1 text-left">{SORT_LABELS[sort]}</span>
              <span className={`material-symbols-outlined text-on-surface-variant/60 text-base leading-none transition-transform duration-200 ${sortDropdownOpen ? 'rotate-180' : ''}`}>
                expand_more
              </span>
            </button>
            {sortDropdownOpen && (
              <div className="absolute top-full right-0 mt-1.5 w-full bg-surface-container-highest border border-outline-variant/30 rounded-lg overflow-hidden shadow-lg z-50">
                {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => { setSort(key); setSortDropdownOpen(false) }}
                    className={`w-full text-left px-4 py-2 text-xs font-label transition-colors select-none ${sort === key ? 'text-primary bg-primary/8' : 'text-on-surface hover:bg-surface-container-high'}`}
                  >
                    {SORT_LABELS[key]}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* View switcher */}
          <div className="flex items-center bg-surface-container-low rounded-md p-0.5">
            {(['list', 'grid'] as ViewMode[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                title={v === 'list' ? '详细列表' : '大图标'}
                className={`p-1.5 rounded-sm transition-colors ${view === v ? 'bg-primary text-on-primary' : 'text-on-surface-variant/70 hover:bg-white/5 hover:text-on-surface'}`}
              >
                <span className="material-symbols-outlined text-[16px]">{v === 'list' ? 'view_list' : 'grid_view'}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* File list area */}
      <section className="flex-1 overflow-y-auto px-8 py-6 select-none" tabIndex={0}>
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-on-surface-variant/40">
              <span className="material-symbols-outlined text-[36px] animate-spin" style={{ animationDuration: '1.4s' }}>progress_activity</span>
              <p className="font-label text-xs uppercase tracking-widest">加载中...</p>
            </div>
          </div>
        ) : sortedItems.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center py-24">
            <div className="w-16 h-16 rounded-2xl border border-white/5 flex items-center justify-center mb-4 bg-gradient-to-br from-surface-container-high/50 to-surface-container-lowest">
              <span className="material-symbols-outlined text-on-surface-variant/40 text-[28px]">folder_open</span>
            </div>
            <p className="font-label text-sm uppercase tracking-widest text-on-surface-variant/60">空文件夹</p>
            <p className="text-xs text-on-surface-variant/40 mt-2">此目录下没有项目</p>
          </div>
        ) : view === 'list' ? (
          /* List view */
          <div className="bg-surface-container-lowest border border-white/5 rounded-lg overflow-hidden">
            <div className="grid grid-cols-12 gap-4 px-4 py-2.5 bg-surface-container-low rounded-t-lg border-b border-white/5 font-label text-[10px] uppercase tracking-[0.15em] text-outline">
              <div className="col-span-6">名称</div>
              <div className="col-span-2">修改时间</div>
              <div className="col-span-2">类型</div>
              <div className="col-span-2 text-right">大小</div>
            </div>
            <div>
              {sortedItems.map((item) => {
                const sel = selected.has(item.path)
                return (
                  <div
                    key={item.path}
                    onClick={(e) => onRowClick(e, item.path)}
                    onDoubleClick={() => onRowDoubleClick(item)}
                    onContextMenu={(e) => onRowContextMenu(e, item.path)}
                    className={`grid grid-cols-12 gap-4 px-4 py-2.5 items-center cursor-pointer border-b border-white/[0.03] hover:bg-surface-container-low/60 ${sel ? 'bg-primary/10 hover:bg-primary/15' : ''}`}
                  >
                    <div className="col-span-6 flex items-center gap-3 min-w-0">
                      <span
                        className={`material-symbols-outlined ${colorFor(item)} text-[20px] flex-shrink-0`}
                        style={item.type === 'folder' ? { fontVariationSettings: '"FILL" 1' } : undefined}
                      >
                        {iconFor(item)}
                      </span>
                      <span className={`text-sm ${item.type === 'folder' ? 'font-bold' : 'font-medium'} text-on-surface truncate`}>{item.name}</span>
                    </div>
                    <div className="col-span-2 font-label text-[11px] text-on-surface-variant/70">{item.mtime ?? '—'}</div>
                    <div className="col-span-2">
                      <span className="font-label text-[10px] uppercase tracking-wider text-on-surface-variant/60">{kindLabel(item)}</span>
                    </div>
                    <div className="col-span-2 text-right font-label text-[11px] text-on-surface-variant/70">{item.type === 'folder' ? '—' : fmtSize(item.size)}</div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          /* Grid view */
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {sortedItems.map((item) => {
              const sel = selected.has(item.path)
              return (
                <div
                  key={item.path}
                  onClick={(e) => onRowClick(e, item.path)}
                  onDoubleClick={() => onRowDoubleClick(item)}
                  onContextMenu={(e) => onRowContextMenu(e, item.path)}
                  className={`cursor-pointer flex flex-col gap-2 p-2 rounded-lg ${sel ? 'bg-primary/10 ring-1 ring-primary/40' : 'hover:bg-surface-container-low/60'}`}
                >
                  <div className="relative aspect-[4/3] rounded-md overflow-hidden border border-white/5">
                    <div className="absolute inset-0 bg-gradient-to-b from-surface-container-high/40 to-surface-container-lowest flex items-center justify-center">
                      <span
                        className={`material-symbols-outlined ${colorFor(item)} text-[44px]`}
                        style={item.type === 'folder' ? { fontVariationSettings: '"FILL" 1' } : undefined}
                      >
                        {item.kind === 'video' ? 'movie' : iconFor(item)}
                      </span>
                    </div>
                    {item.kind === 'video' && (
                      <div className="absolute bottom-1.5 right-1.5 bg-black/60 backdrop-blur-sm rounded px-1.5 py-0.5 font-label text-[9px] text-white/90 uppercase tracking-wider">
                        {item.ext?.replace('.', '') ?? 'video'}
                      </div>
                    )}
                  </div>
                  <div className="px-1">
                    <p className={`text-xs ${item.type === 'folder' ? 'font-bold' : 'font-medium'} text-on-surface truncate`}>{item.name}</p>
                    <p className="font-label text-[10px] text-on-surface-variant/50 truncate">
                      {item.type === 'folder' ? kindLabel(item) : fmtSize(item.size)}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Status bar */}
      <footer className="bg-surface-container-lowest border-t border-white/5 px-8 py-2.5 flex items-center justify-between text-[10px] font-label uppercase tracking-widest text-on-surface-variant/60">
        <div className="flex items-center gap-6">
          <span>{sortedItems.length} 项</span>
          <span className="h-3 w-px bg-outline-variant/20" />
          <span>{totalSize ? `${fmtSize(totalSize)} 总大小` : '—'}</span>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            <span>Filesystem · Live</span>
          </div>
          <span className="font-mono normal-case tracking-tight text-on-surface-variant/40 truncate max-w-md">
            {isVirtualRoot ? '我的电脑' : cwd}
          </span>
        </div>
      </footer>

      {/* Context menu */}
      {ctx && (
        <div
          data-ctx-menu
          style={{
            ...(ctx.flipX ? { right: window.innerWidth - ctx.x } : { left: ctx.x }),
            ...(ctx.flipY ? { bottom: window.innerHeight - ctx.y } : { top: ctx.y }),
          }}
          className="fixed z-50 rounded-lg border border-white/10 shadow-2xl py-1.5 min-w-[220px] bg-surface-container/95 backdrop-blur"
        >
          <button
            onClick={() => {
              const p = ctx.path; setCtx(null)
              const item = itemsRef.current.find((i) => i.path === p)
              if (!item) return
              if (item.type === 'folder') doNavTo(p, false)
              else window.fileExplorerApi.open(p)
            }}
            className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/5 text-sm text-left"
          >
            <span className="material-symbols-outlined text-[18px] text-primary">play_arrow</span>
            <span className="flex-1">打开</span>
            <span className="font-label text-[10px] text-on-surface-variant/40 tracking-widest">Enter</span>
          </button>
          <button
            onClick={() => {
              const p = ctx.path; setCtx(null)
              window.fileExplorerApi.reveal(p)
            }}
            className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/5 text-sm text-left"
          >
            <span className="material-symbols-outlined text-[18px] text-on-surface-variant">folder_open</span>
            <span className="flex-1">打开所在位置</span>
          </button>
          {/* Delete options hidden for drive roots / virtual root — see isProtectedPath */}
          {!isProtectedPath(ctx.path, platform) && (
            <>
              <div className="h-px bg-white/5 my-1" />
              <button
                onClick={() => { const p = ctx.path; setCtx(null); openDeleteDialog([p], false) }}
                className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/5 text-sm text-left"
              >
                <span className="material-symbols-outlined text-[18px] text-on-surface-variant">delete</span>
                <span className="flex-1">删除(到回收站)</span>
                <span className="font-label text-[10px] text-on-surface-variant/40 tracking-widest">Del</span>
              </button>
              <button
                onClick={() => { const p = ctx.path; setCtx(null); openDeleteDialog([p], true) }}
                className="w-full flex items-center gap-3 px-3 py-2 hover:bg-error/10 text-sm text-error text-left"
              >
                <span className="material-symbols-outlined text-[18px]">delete_forever</span>
                <span className="flex-1">永久删除</span>
                <span className="font-label text-[10px] tracking-widest opacity-60">Shift+Del</span>
              </button>
            </>
          )}
        </div>
      )}

      {/* Delete confirmation overlay */}
      {pendingDelete && (() => {
        const isOne = pendingDelete.targets.length === 1
        const t = pendingDelete.targets[0]
        const isFolder = isOne && t.type === 'folder'
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setPendingDelete(null)} />
            <div className="relative bg-surface-container/95 backdrop-blur rounded-xl border border-white/10 shadow-2xl w-[520px] max-w-[92vw]">
              <div className="p-7 pb-5">
                <div className="flex items-start gap-4 mb-5">
                  <div className={`w-12 h-12 rounded-xl ${pendingDelete.permanent ? 'bg-error/20 border-error/50' : 'bg-error/15 border-error/30'} border flex items-center justify-center flex-shrink-0`}>
                    <span className="material-symbols-outlined text-error text-[24px]">{pendingDelete.permanent ? 'delete_forever' : 'delete'}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-lg font-black tracking-tight mb-1">{pendingDelete.permanent ? '永久删除?' : '删除到回收站?'}</h3>
                    <p className="text-xs text-on-surface-variant/70">
                      {pendingDelete.permanent
                        ? '此操作不可撤销。所选项目将被永久从磁盘移除。'
                        : '选中项目将被移动到系统回收站，你可以稍后还原。'}
                    </p>
                  </div>
                </div>

                <div className="bg-surface-container-lowest border border-white/5 rounded-lg p-4 space-y-2.5">
                  {isOne ? (
                    <>
                      <div className="flex items-start gap-3">
                        <div className="w-10 h-10 rounded-lg border border-white/5 flex items-center justify-center flex-shrink-0 bg-gradient-to-b from-surface-container-high/50 to-surface-container-lowest">
                          <span
                            className={`material-symbols-outlined ${colorFor(t)} text-[22px]`}
                            style={isFolder ? { fontVariationSettings: '"FILL" 1' } : undefined}
                          >{iconFor(t)}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold truncate">{t.name}</p>
                          <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/60 mt-0.5">{kindLabel(t)}</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3 pt-3 border-t border-white/5 mt-3">
                        <div>
                          <p className="font-label text-[9px] uppercase tracking-widest text-on-surface-variant/50 mb-0.5">大小</p>
                          <p className="text-xs font-mono">{isFolder ? '—' : fmtSize(t.size)}</p>
                        </div>
                        <div>
                          <p className="font-label text-[9px] uppercase tracking-widest text-on-surface-variant/50 mb-0.5">修改时间</p>
                          <p className="text-xs font-mono">{t.mtime ?? '—'}</p>
                        </div>
                        <div className="col-span-2">
                          <p className="font-label text-[9px] uppercase tracking-widest text-on-surface-variant/50 mb-0.5">完整路径</p>
                          <p className="text-[11px] font-mono text-on-surface-variant/80 break-all">{t.path}</p>
                        </div>
                      </div>
                    </>
                  ) : (
                    <p className="text-sm font-bold">{pendingDelete.targets.length} 个项目</p>
                  )}
                </div>

                {pendingDelete.permanent && (
                  <div className="mt-3 flex items-start gap-2 text-[11px] text-error font-label uppercase tracking-widest">
                    <span className="material-symbols-outlined text-[14px] mt-px">warning</span>
                    <span>永久删除后无法恢复，请谨慎操作。</span>
                  </div>
                )}
              </div>

              <div className="px-7 py-4 bg-surface-container-lowest/40 border-t border-white/5 rounded-b-xl flex items-center justify-end gap-3">
                <button
                  onClick={() => setPendingDelete(null)}
                  className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={confirmDeleteStable}
                  className="flex-1 py-3 rounded-xl border border-error/40 bg-error/10 text-sm font-bold text-error hover:bg-error/20 transition-colors flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-base leading-none">{pendingDelete.permanent ? 'delete_forever' : 'delete'}</span>
                  <span>{pendingDelete.permanent ? '永久删除' : '移到回收站'}</span>
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Stage 2 分片回收确认弹窗 —— Stage 1（5s 整体送回收站）失败时弹。
          解释接下来「逐个文件 / 子目录单独送回收站」的行为，让用户决定继续 / 取消。
          取消不会自动 fallback 到永久删除 —— 用户要永久删得回去自己点。 */}
      {pendingStage2 && (
        <Stage2ConfirmModal
          state={pendingStage2}
          onCancel={cancelStage2}
          onConfirm={confirmStage2}
        />
      )}

      {/* 删除进行中加载层 —— 用户点确认后到 toast 出现之间这段时间盖在所有
          UI 上，避免"卡死"假象。z-index 比所有 modal 都高（z-[70]），因为
          删除可能在 Stage 2 modal 关闭后立刻开始，要确保加载层叠在上层；
          backdrop 不可点（删除一旦发出无法取消）。 */}
      {deleteInProgress && (
        <DeleteProgressOverlay state={deleteInProgress} />
      )}

      {/* Delete result modal — shown when one or more items failed to delete.
          Read-only on purpose: trashItem and permanentDelete each already do
          everything they can (kill processes, takeown, swap APIs). When they
          still fail, the failure is a root cause the user must fix themselves
          (path too long, system protected, disk corruption, etc.) — so the
          modal explains causes + solutions instead of offering more buttons. */}
      {deleteResult && (
        <DeleteResultModal
          state={deleteResult}
          onClose={() => setDeleteResult(null)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-surface-container/95 backdrop-blur rounded-xl border border-white/10 shadow-2xl px-5 py-3.5 flex items-center gap-3 max-w-md">
          <span className="material-symbols-outlined text-primary">{toast.icon}</span>
          <div className="min-w-0">
            <p className="text-sm font-bold">{toast.title}</p>
            <p className="text-[11px] text-on-surface-variant/70 truncate">{toast.msg}</p>
          </div>
          <button onClick={() => setToast(null)} className="p-1 rounded hover:bg-white/5 ml-2 flex-shrink-0">
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>
      )}
    </div>
  )
}

export default FileExplorer

// ── 删除进行中加载层 ─────────────────────────────────────────────────────
//
// 不可关闭（backdrop 没绑 onClick），spinner + 模式标题 + 当前目标 + 进度。
// 多目标时显示 `(2/5) foo.txt`，单目标时只显示目标名。模式 → 中文标题映射：
//   - trash-stage1：「正在送入回收站…」（每个目标 5s 整体窗口）
//   - trash-stage2：「正在分片回收…」（文件多时分钟级）
//   - permanent  ：「正在永久删除…」（三级 fallback，几乎一次必成）
//
// 对 stage2 额外加一行提示"文件多时可能需要一两分钟"——Stage 2 是用户在
// Stage 2 confirm modal 主动选的，需要管理预期，不然用户等几十秒会以为卡了。
function DeleteProgressOverlay({ state }: { state: DeleteInProgress }): JSX.Element {
  const titleMap: Record<DeleteInProgress['mode'], string> = {
    'trash-stage1': '正在送入回收站…',
    'trash-stage2': '正在分片回收…',
    'permanent':    '正在永久删除…',
  }
  const isMulti = state.total > 1
  const isStage2 = state.mode === 'trash-stage2'
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="relative bg-surface-container/95 backdrop-blur rounded-xl border border-white/10 shadow-2xl px-8 py-7 min-w-[380px] max-w-[92vw]">
        <div className="flex flex-col items-center gap-4">
          <span
            className="material-symbols-outlined text-primary animate-spin"
            style={{ fontSize: 36 }}
          >
            progress_activity
          </span>
          <p className="text-base font-bold tracking-tight">{titleMap[state.mode]}</p>
          <div className="flex flex-col items-center gap-1 max-w-[440px]">
            {isMulti && (
              <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/60">
                {state.currentIndex} / {state.total}
              </p>
            )}
            <p className="text-xs text-on-surface-variant/75 truncate max-w-full font-mono">
              {state.currentTarget}
            </p>
          </div>
          {isStage2 && (
            <p className="text-[11px] text-on-surface-variant/55 leading-relaxed text-center max-w-[300px]">
              逐个文件 / 子目录送回收站，文件数多时可能需要一两分钟，请勿关闭窗口。
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Stage 2 分片回收确认弹窗 ───────────────────────────────────────────────
//
// Stage 1（整体送回收站 5s 窗口）失败时弹。解释 Stage 2 会做什么、回收站里会
// 看到什么、内容能不能恢复、不接受的话还有什么办法 —— 然后让用户拍板。
//
// 设计取舍：不强制把所有信息塞进单一弹窗。文案分两段：① 主提示讲清楚行为
// 和最佳预期（"散件可还原"）；② 折叠在底下的"如果不接受"提示三条 fallback
// （重启 / 永久删除 / 取消）。同时保持只有「继续走分片回收」和「取消」
// 两个 action 按钮，跟项目里其它确认弹窗的两按钮节奏对齐。
//
// 取消按钮**不**触发任何自动 fallback —— 这是用户在 idea 文档 001 里反复
// 强调的：「就算用户点击取消也不要自动调用永久删除，最终还是由用户来手动
// 点击永久删除来做处理」。
function Stage2ConfirmModal({
  state, onCancel, onConfirm,
}: {
  state: PendingStage2
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  const count = state.targets.length
  const isOne = count === 1
  const t = state.targets[0]
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-surface-container/95 backdrop-blur rounded-xl border border-white/10 shadow-2xl w-[560px] max-w-[92vw]">
        <div className="p-7 pb-5">
          <div className="flex items-start gap-4 mb-5">
            <div className="w-12 h-12 rounded-xl bg-tertiary/15 border border-tertiary/40 flex items-center justify-center flex-shrink-0">
              <span className="material-symbols-outlined text-tertiary text-[24px]">splitscreen</span>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-black tracking-tight mb-1">无法整体送入回收站，是否分片回收?</h3>
              <p className="text-xs text-on-surface-variant/75 leading-relaxed">
                整体送入失败通常是被安全软件 / 系统进程拦住"整目录移动"。继续将逐个文件、
                逐个子目录单独送进回收站，最后送空根目录 —— 杀软通常不拦单点操作，成功率
                显著更高。
              </p>
            </div>
          </div>

          <div className="bg-surface-container-lowest border border-white/5 rounded-lg p-4 space-y-2.5">
            {isOne ? (
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg border border-white/5 flex items-center justify-center flex-shrink-0 bg-gradient-to-b from-surface-container-high/50 to-surface-container-lowest">
                  <span
                    className={`material-symbols-outlined ${colorFor(t)} text-[22px]`}
                    style={t.type === 'folder' ? { fontVariationSettings: '"FILL" 1' } : undefined}
                  >{iconFor(t)}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold truncate">{t.name}</p>
                  <p className="text-[11px] font-mono text-on-surface-variant/70 truncate mt-0.5">{t.path}</p>
                </div>
              </div>
            ) : (
              <p className="text-sm font-bold">{count} 个项目无法整体送入回收站</p>
            )}
          </div>

          {/* 后果说明：散件 + 还原方法。Tertiary 色块跟弹窗主题图标对齐,
              视觉上是"提醒注意" 不是"警告危险"。 */}
          <div className="mt-4 rounded-lg border border-tertiary/25 bg-tertiary/[0.08] p-3.5 space-y-2">
            <div className="flex items-start gap-2.5">
              <span className="material-symbols-outlined text-tertiary text-[18px] mt-px">info</span>
              <p className="text-xs text-tertiary/90 leading-relaxed font-bold">
                回收站里看到的会是散开的条目（不是一个完整文件夹），但内容仍完整可还原。
              </p>
            </div>
            <p className="text-[11px] text-on-surface-variant/70 leading-relaxed pl-7">
              打开回收站，选中相关条目 → 右键「还原」即可重建原目录结构。
            </p>
          </div>

          {/* 替代方案 hint：取消不会自动 fallback，告诉用户还有什么路可以走。 */}
          <div className="mt-3 rounded-lg border border-white/5 bg-surface-container-lowest/60 p-3.5">
            <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-1.5">
              不接受分片可以
            </p>
            <ul className="text-[11px] text-on-surface-variant/75 leading-relaxed space-y-0.5">
              <li>· 重启电脑后再删（释放占用句柄，通常能整体回收）</li>
              <li>· 取消后改用「永久删除」（不进回收站，不可恢复）</li>
            </ul>
          </div>
        </div>

        <div className="px-7 py-4 bg-surface-container-lowest/40 border-t border-white/5 rounded-b-xl flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-3 rounded-xl border border-tertiary/40 bg-tertiary/10 text-sm font-bold text-tertiary hover:bg-tertiary/20 transition-colors flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-base leading-none">splitscreen</span>
            <span>继续走分片回收</span>
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Delete result modal ────────────────────────────────────────────────────
//
// Read-only. trashItem / permanentDelete already attempted everything in
// their power (kill processes, takeown, swap APIs). Anything that still
// reaches this modal is a root cause the user must fix themselves, so the
// modal explains *why* it failed and *how* to fix it — no extra buttons.
function DeleteResultModal({
  state, onClose,
}: {
  state: DeleteResultState
  onClose: () => void
}): JSX.Element {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const toggle = (i: number) =>
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })
  const { permanent, succeededCount, failures } = state
  const totalCount = succeededCount + failures.length
  const partial = succeededCount > 0 && failures.length > 0
  const allFailed = succeededCount === 0 && failures.length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-surface-container/95 backdrop-blur rounded-xl border border-white/10 shadow-2xl w-[560px] max-w-[92vw] max-h-[80vh] flex flex-col">
        <div className="flex items-start gap-4 px-7 pt-6 pb-5 border-b border-outline-variant/10">
          <div className="w-12 h-12 rounded-xl bg-error/15 border border-error/30 flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-error text-[24px]">error</span>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-black tracking-tight mb-1">
              {allFailed
                ? (permanent ? '永久删除失败' : '移到回收站失败')
                : (permanent ? '永久删除部分失败' : '移到回收站部分失败')}
            </h3>
            <p className="text-xs text-on-surface-variant/70 leading-relaxed">
              {partial
                ? `共 ${totalCount} 项：成功 ${succeededCount}，失败 ${failures.length}。失败项见下方，可展开查看详情。`
                : `${failures.length} 项无法删除，可展开查看详情。`}
            </p>
          </div>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-2">
          {failures.map((f, i) => {
            const fe = friendlyError(f.error)
            const open = expanded.has(i)
            return (
              <div key={f.path} className="rounded-lg border border-error/20 bg-error/[0.04] overflow-hidden">
                <button
                  onClick={() => toggle(i)}
                  className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-error/[0.06] transition-colors"
                >
                  <span className="material-symbols-outlined text-error/80 text-[18px] mt-0.5 shrink-0">
                    {permanent ? 'delete_forever' : 'delete'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-on-surface truncate">{f.name}</p>
                    <p className="text-[11px] text-error font-label uppercase tracking-widest mt-0.5">{fe.title}</p>
                    <p className="text-[11px] text-on-surface-variant/70 mt-1 leading-relaxed">{fe.hint}</p>
                  </div>
                  <span className={`material-symbols-outlined text-on-surface-variant/40 text-[18px] mt-0.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
                    expand_more
                  </span>
                </button>
                {open && (
                  <div className="px-4 pb-3 pt-1 space-y-2">
                    <div>
                      <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-1">路径</p>
                      <p className="text-[11px] font-mono text-on-surface-variant/80 break-all">{f.path}</p>
                    </div>
                    <div>
                      <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-1">原始错误</p>
                      <pre className="text-[11px] font-mono text-on-surface-variant/70 whitespace-pre-wrap break-all bg-surface-container-lowest/60 rounded-md px-3 py-2 border border-outline-variant/10 max-h-60 overflow-auto">{fe.raw}</pre>
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {/* Common-cause cheatsheet for this operation type. Shown unconditionally
              so the user can scan it and identify their case rather than having to
              guess from a generic error message. Recycle-bin and permanent-delete
              have largely DIFFERENT failure modes — listing them separately keeps
              the guidance actionable. */}
          <CausesPanel permanent={permanent} />
        </div>

        <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-lg border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Common-cause cheatsheet for delete failures ────────────────────────────

interface CauseItem {
  cause: string
  fix: string
}

// Recycle-bin failure causes. The app already auto-handles "被进程占用" and
// "ACL 受限" internally (kill processes + takeown), so those don't appear
// here — the only failures that reach the user are root causes they need
// to fix themselves OR cases where the recycle bin fundamentally can't be
// used (then switch to 永久删除 manually from the main delete UI).
const RECYCLE_CAUSES: readonly CauseItem[] = [
  {
    cause: '文件系统不支持回收站',
    fix: 'FAT32 / exFAT 格式的 U 盘 / SD 卡、部分网络盘没有回收站 — 改用"永久删除"',
  },
  {
    cause: '回收站满了或被该盘禁用',
    fix: '清空回收站；或右键回收站 → 属性 检查配额 / 是否勾了"不将文件移到回收站"',
  },
  {
    cause: '路径过长 (> 260 字符)',
    fix: '把外层目录名改短，或在 Windows 设置里启用长路径支持',
  },
  {
    cause: '当前账号没 DELETE 权限（已尝试自动 takeown 仍失败）',
    fix: '右键 Maple Tools 选"以管理员身份运行"再试',
  },
  {
    cause: '占用进程顽固（已尝试自动杀进程仍失败）',
    fix: '通常是杀软驱动 / 内核占用 — 重启 Windows 后再删；或关掉占用源头程序',
  },
  {
    cause: '杀毒软件实时拦截',
    fix: '临时关闭杀软实时防护，或把目标路径加白名单',
  },
]

// Permanent-delete failure causes. Same principle — process locks and ACL
// are auto-handled; what reaches the user is the genuinely unfixable-from-
// inside category.
const PERMANENT_CAUSES: readonly CauseItem[] = [
  {
    cause: 'Windows 系统保护文件',
    fix: 'pagefile.sys / hiberfil.sys / WindowsApps / System Volume Information 等 — Windows 自己也不让删，请勿尝试',
  },
  {
    cause: '介质物理写保护',
    fix: 'SD 卡 / U 盘侧边的写保护开关拨到关闭位',
  },
  {
    cause: '父目录是只读 / 系统目录',
    fix: '右键父目录 → 属性 取消"只读"和"系统"标记',
  },
  {
    cause: '占用进程顽固（已尝试自动杀进程仍失败）',
    fix: '通常是杀软驱动 / 内核占用 — 重启 Windows 后再删；或关掉占用源头程序',
  },
  {
    cause: '当前账号没 DELETE 权限（已尝试自动 takeown 仍失败）',
    fix: '右键 Maple Tools 选"以管理员身份运行"再试',
  },
  {
    cause: '杀毒软件实时拦截',
    fix: '临时关闭杀软实时防护，或把目标路径加白名单',
  },
  {
    cause: '磁盘损坏 / 坏扇区',
    fix: '管理员 cmd 里跑 `chkdsk X: /f`（X 换成实际盘符）修复后再试',
  },
]

function CausesPanel({ permanent }: { permanent: boolean }): JSX.Element {
  const causes = permanent ? PERMANENT_CAUSES : RECYCLE_CAUSES
  const title = permanent ? '永久删除可能失败的原因 + 解决方法' : '移到回收站可能失败的原因 + 解决方法'
  return (
    <div className="mt-2 rounded-lg border border-outline-variant/15 bg-surface-container-lowest/40 px-4 py-3">
      <div className="flex items-center gap-2 mb-2.5">
        <span className="material-symbols-outlined text-on-surface-variant/60 text-[15px]">help_outline</span>
        <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/60">{title}</p>
      </div>
      <ul className="space-y-1.5">
        {causes.map((c, i) => (
          <li key={i} className="flex gap-2 text-[11px] leading-relaxed">
            <span className="text-on-surface-variant/40 shrink-0 mt-px">•</span>
            <div className="flex-1 min-w-0">
              <span className="text-on-surface font-medium">{c.cause}</span>
              <span className="text-on-surface-variant/50"> — </span>
              <span className="text-on-surface-variant/80">{c.fix}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
