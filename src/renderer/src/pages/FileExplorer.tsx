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

  async function confirmDelete(): Promise<void> {
    const pd = pendingDeleteRef.current
    if (!pd) return
    setPendingDelete(null)

    const failures: DeleteFailure[] = []
    let succeeded = 0
    for (const t of pd.targets) {
      try {
        if (pd.permanent) await window.fileExplorerApi.deletePermanent(t.path)
        else await window.fileExplorerApi.trash(t.path)
        succeeded += 1
      } catch (e: unknown) {
        failures.push({ name: t.name, path: t.path, error: e })
      }
    }

    setSelected(new Set())
    await refresh()

    if (failures.length) {
      // Open the rich result modal so the user can drill into per-item errors.
      setDeleteResult({ permanent: pd.permanent, succeededCount: succeeded, failures })
    } else {
      setToast({
        title: pd.permanent ? '已永久删除' : '已移到回收站',
        msg: pd.targets.length === 1 ? pd.targets[0].name : `${pd.targets.length} 个项目`,
        icon: pd.permanent ? 'delete_forever' : 'delete',
      })
    }
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

      {/* Delete result modal — shown when one or more items failed to delete */}
      {deleteResult && (
        <DeleteResultModal state={deleteResult} onClose={() => setDeleteResult(null)} />
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

// ── Delete result modal ────────────────────────────────────────────────────
function DeleteResultModal({
  state, onClose,
}: { state: DeleteResultState; onClose: () => void }): JSX.Element {
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
