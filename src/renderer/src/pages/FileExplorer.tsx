/**
 * File Explorer — visual port of docs/design-mockups/File_Explorer.html.
 *
 * NOT WIRED to real filesystem. The page renders a Windows-style explorer over
 * an in-memory mock FS for layout / interaction preview only:
 *   - back / forward / up navigation works (within the mock graph)
 *   - view switcher (list / grid) and sort selector are live
 *   - context menu, selection, address-bar Open/Delete all show the visual flow
 *     but Delete only mutates the in-memory mock (no IPC to main, no fs touched)
 *
 * To make this real later: lift FS reads behind window.* IPC, replace the mock
 * dictionary with on-demand calls, wire delete through Electron's shell.trashItem
 * or fs.rm. The component shape shouldn't need to change much.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import TopBar from '../components/TopBar'

// ── Mock filesystem ──────────────────────────────────────────────────────────

interface FsNode {
  type: 'folder' | 'file'
  name: string
  mtime?: string
  ext?: string
  size?: number
  kind?: 'video' | 'image' | 'archive' | 'text' | 'shortcut'
  children?: string[]
}

const FS: Record<string, FsNode> = {
  'C:\\': { type: 'folder', name: '本地磁盘 (C:)', mtime: '2026-04-20 09:14',
    children: ['C:\\Users', 'C:\\Program Files', 'C:\\Windows', 'C:\\Anime'] },
  'C:\\Users': { type: 'folder', name: 'Users', mtime: '2026-04-22 11:02',
    children: ['C:\\Users\\Yuming', 'C:\\Users\\Public'] },
  'C:\\Users\\Public': { type: 'folder', name: 'Public', mtime: '2026-01-08 10:00', children: [] },
  'C:\\Users\\Yuming': { type: 'folder', name: 'Yuming', mtime: '2026-04-25 22:48',
    children: [
      'C:\\Users\\Yuming\\Desktop', 'C:\\Users\\Yuming\\Documents',
      'C:\\Users\\Yuming\\Downloads', 'C:\\Users\\Yuming\\Videos',
      'C:\\Users\\Yuming\\Pictures', 'C:\\Users\\Yuming\\Music',
    ] },
  'C:\\Program Files': { type: 'folder', name: 'Program Files', mtime: '2026-04-01 18:30', children: [] },
  'C:\\Windows': { type: 'folder', name: 'Windows', mtime: '2026-04-23 03:12', children: [] },
  'C:\\Anime': { type: 'folder', name: 'Anime', mtime: '2026-04-20 18:00',
    children: ['C:\\Anime\\Movies', 'C:\\Anime\\OVAs'] },
  'C:\\Anime\\Movies': { type: 'folder', name: 'Movies', mtime: '2026-04-20 18:00', children: [] },
  'C:\\Anime\\OVAs': { type: 'folder', name: 'OVAs', mtime: '2026-04-20 18:00', children: [] },
  'C:\\Users\\Yuming\\Desktop': { type: 'folder', name: 'Desktop', mtime: '2026-04-26 19:01',
    children: ['C:\\Users\\Yuming\\Desktop\\SoraIndex.lnk', 'C:\\Users\\Yuming\\Desktop\\readme.txt'] },
  'C:\\Users\\Yuming\\Desktop\\SoraIndex.lnk': { type: 'file', name: 'SoraIndex.lnk', ext: 'lnk', size: 1862, mtime: '2026-04-12 10:22', kind: 'shortcut' },
  'C:\\Users\\Yuming\\Desktop\\readme.txt': { type: 'file', name: 'readme.txt', ext: 'txt', size: 412, mtime: '2026-04-26 18:55', kind: 'text' },
  'C:\\Users\\Yuming\\Documents': { type: 'folder', name: 'Documents', mtime: '2026-04-22 14:08', children: [] },
  'C:\\Users\\Yuming\\Pictures': { type: 'folder', name: 'Pictures', mtime: '2026-03-30 09:00', children: [] },
  'C:\\Users\\Yuming\\Music': { type: 'folder', name: 'Music', mtime: '2026-04-18 21:45', children: [] },
  'C:\\Users\\Yuming\\Downloads': { type: 'folder', name: 'Downloads', mtime: '2026-04-26 20:31',
    children: [
      'C:\\Users\\Yuming\\Downloads\\[SoraIndex] Frieren - 17.mkv',
      'C:\\Users\\Yuming\\Downloads\\[SoraIndex] Frieren - 18.mkv',
      'C:\\Users\\Yuming\\Downloads\\subtitles.zip',
      'C:\\Users\\Yuming\\Downloads\\poster_collection',
    ] },
  'C:\\Users\\Yuming\\Downloads\\[SoraIndex] Frieren - 17.mkv': { type: 'file', name: '[SoraIndex] Frieren - 17.mkv', ext: 'mkv', size: 1342177280, mtime: '2026-04-26 20:31', kind: 'video' },
  'C:\\Users\\Yuming\\Downloads\\[SoraIndex] Frieren - 18.mkv': { type: 'file', name: '[SoraIndex] Frieren - 18.mkv', ext: 'mkv', size: 1289748480, mtime: '2026-04-26 20:31', kind: 'video' },
  'C:\\Users\\Yuming\\Downloads\\subtitles.zip': { type: 'file', name: 'subtitles.zip', ext: 'zip', size: 4823422, mtime: '2026-04-25 14:08', kind: 'archive' },
  'C:\\Users\\Yuming\\Downloads\\poster_collection': { type: 'folder', name: 'poster_collection', mtime: '2026-04-20 11:18', children: [] },
  'C:\\Users\\Yuming\\Videos': { type: 'folder', name: 'Videos', mtime: '2026-04-25 22:14',
    children: [
      'C:\\Users\\Yuming\\Videos\\Cyberpunk Edgerunners',
      'C:\\Users\\Yuming\\Videos\\Cowboy Bebop',
      'C:\\Users\\Yuming\\Videos\\Sousou no Frieren',
      'C:\\Users\\Yuming\\Videos\\Vinland Saga',
      'C:\\Users\\Yuming\\Videos\\screen_capture.mp4',
    ] },
  'C:\\Users\\Yuming\\Videos\\Cyberpunk Edgerunners': { type: 'folder', name: 'Cyberpunk Edgerunners', mtime: '2026-04-22 23:11',
    children: [
      'C:\\Users\\Yuming\\Videos\\Cyberpunk Edgerunners\\E01.mkv',
      'C:\\Users\\Yuming\\Videos\\Cyberpunk Edgerunners\\E02.mkv',
      'C:\\Users\\Yuming\\Videos\\Cyberpunk Edgerunners\\E03.mkv',
      'C:\\Users\\Yuming\\Videos\\Cyberpunk Edgerunners\\poster.jpg',
    ] },
  'C:\\Users\\Yuming\\Videos\\Cyberpunk Edgerunners\\E01.mkv': { type: 'file', name: '[SoraIndex] Cyberpunk Edgerunners - 01.mkv', ext: 'mkv', size: 1431655765, mtime: '2026-04-22 22:48', kind: 'video' },
  'C:\\Users\\Yuming\\Videos\\Cyberpunk Edgerunners\\E02.mkv': { type: 'file', name: '[SoraIndex] Cyberpunk Edgerunners - 02.mkv', ext: 'mkv', size: 1395864371, mtime: '2026-04-22 22:50', kind: 'video' },
  'C:\\Users\\Yuming\\Videos\\Cyberpunk Edgerunners\\E03.mkv': { type: 'file', name: '[SoraIndex] Cyberpunk Edgerunners - 03.mkv', ext: 'mkv', size: 1502468608, mtime: '2026-04-22 22:54', kind: 'video' },
  'C:\\Users\\Yuming\\Videos\\Cyberpunk Edgerunners\\poster.jpg': { type: 'file', name: 'poster.jpg', ext: 'jpg', size: 482718, mtime: '2026-04-21 09:20', kind: 'image' },
  'C:\\Users\\Yuming\\Videos\\Cowboy Bebop': { type: 'folder', name: 'Cowboy Bebop', mtime: '2026-04-19 14:00', children: [] },
  'C:\\Users\\Yuming\\Videos\\Sousou no Frieren': { type: 'folder', name: 'Sousou no Frieren', mtime: '2026-04-25 19:40', children: [] },
  'C:\\Users\\Yuming\\Videos\\Vinland Saga': { type: 'folder', name: 'Vinland Saga', mtime: '2026-04-15 11:22', children: [] },
  'C:\\Users\\Yuming\\Videos\\screen_capture.mp4': { type: 'file', name: 'screen_capture.mp4', ext: 'mp4', size: 286331153, mtime: '2026-04-24 16:18', kind: 'video' },
  'D:\\': { type: 'folder', name: '媒体库 (D:)', mtime: '2026-04-26 20:00', children: ['D:\\Anime', 'D:\\Movies', 'D:\\Backup'] },
  'D:\\Anime': { type: 'folder', name: 'Anime', mtime: '2026-04-26 19:55', children: [] },
  'D:\\Movies': { type: 'folder', name: 'Movies', mtime: '2026-04-15 22:14', children: [] },
  'D:\\Backup': { type: 'folder', name: 'Backup', mtime: '2026-04-01 03:00', children: [] },
  'E:\\': { type: 'folder', name: '工作 (E:)', mtime: '2026-04-26 17:00', children: [] },
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normPath(input: string): string {
  if (!input) return ''
  let p = input.trim().replace(/\//g, '\\').replace(/\\+/g, '\\')
  if (/^[a-z]:$/i.test(p)) p += '\\'
  if (p.length > 3 && p.endsWith('\\')) p = p.slice(0, -1)
  if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1)
  return p
}

function isRoot(p: string): boolean { return /^[A-Z]:\\?$/.test(p) }

function parentOf(p: string): string | null {
  p = normPath(p)
  if (isRoot(p) || !p) return null
  const idx = p.lastIndexOf('\\')
  if (idx <= 2) return p.slice(0, 3)
  return p.slice(0, idx)
}

interface FsItem extends FsNode { path: string }

function listChildren(p: string): FsItem[] {
  const node = FS[normPath(p)]
  if (!node || node.type !== 'folder') return []
  return (node.children ?? [])
    .map((c) => ({ path: c, ...FS[c] }))
    .filter((x): x is FsItem => Boolean(x.type))
}

function fmtSize(b: number | undefined): string {
  if (b == null) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, n = b
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n < 10 && i > 0 ? n.toFixed(2) : n < 100 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`
}

function kindLabel(node: FsNode): string {
  if (node.type === 'folder') return '文件夹'
  const m: Record<string, string> = { video: '视频文件', image: '图像文件', archive: '压缩文件', text: '文本文档', shortcut: '快捷方式' }
  return m[node.kind ?? ''] ?? (node.ext ? `${node.ext.toUpperCase()} 文件` : '文件')
}

function iconFor(node: FsNode): string {
  if (node.type === 'folder') return 'folder'
  return ({ video: 'movie', image: 'image', archive: 'folder_zip', text: 'description', shortcut: 'link' } as Record<string, string>)[node.kind ?? ''] ?? 'draft'
}

function colorFor(node: FsNode): string {
  if (node.type === 'folder') return 'text-primary'
  return ({ video: 'text-primary/80', image: 'text-secondary', archive: 'text-[#c8c6c6]', text: 'text-[#d9c1c1]', shortcut: 'text-secondary' } as Record<string, string>)[node.kind ?? ''] ?? 'text-on-surface-variant'
}

function basename(p: string): string {
  p = normPath(p)
  if (isRoot(p)) return FS[p]?.name ?? p
  return p.slice(p.lastIndexOf('\\') + 1)
}

// ── Page ─────────────────────────────────────────────────────────────────────

type ViewMode = 'list' | 'grid'
type SortKey = 'name' | 'size' | 'mtime' | 'kind'

// Order matters — keys are iterated to render the dropdown options.
const SORT_LABELS: Record<SortKey, string> = {
  name: 'Name',
  size: 'Size',
  mtime: 'Modified',
  kind: 'Type',
}

interface DeletePending { targets: FsItem[]; permanent: boolean }
interface CtxState { x: number; y: number; path: string }

const TITLE_SLOT = (
  <div className="flex items-center gap-4">
    <h2 className="text-2xl font-bold tracking-tighter text-primary">File Explorer</h2>
    <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/60 hidden lg:inline">
      Windows / macOS — like file system
    </span>
  </div>
)

function FileExplorer(): JSX.Element {
  const [cwd, setCwd] = useState('C:\\Users\\Yuming\\Videos')
  const [history, setHistory] = useState<string[]>(['C:\\Users\\Yuming\\Videos'])
  const [hIdx, setHIdx] = useState(0)
  const [view, setView] = useState<ViewMode>('list')
  const [sort, setSort] = useState<SortKey>('name')
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false)
  const sortDropdownRef = useRef<HTMLDivElement | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [addressInput, setAddressInput] = useState('C:\\Users\\Yuming\\Videos')
  const [pathStatus, setPathStatus] = useState<{ msg: string; tone: 'ok' | 'error' | 'info' } | null>(null)
  const [ctx, setCtx] = useState<CtxState | null>(null)
  const [pendingDelete, setPendingDelete] = useState<DeletePending | null>(null)
  const [toast, setToast] = useState<{ title: string; msg: string; icon: string } | null>(null)

  // Mock FS mutates in-place when we delete; bump this to force a re-render.
  const [fsTick, setFsTick] = useState(0)
  const fileAreaRef = useRef<HTMLDivElement | null>(null)

  // Keep address input in sync when cwd changes (programmatic navigations).
  useEffect(() => { setAddressInput(cwd) }, [cwd])

  // ── Status flash + toast auto-dismiss ──
  useEffect(() => {
    if (!pathStatus) return
    const t = setTimeout(() => setPathStatus(null), 2200)
    return () => clearTimeout(t)
  }, [pathStatus])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(t)
  }, [toast])

  // ── Sort dropdown click-away ──
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

  // ── Context menu dismissal ──
  useEffect(() => {
    if (!ctx) return
    const onClickAway = (e: MouseEvent): void => {
      const tgt = e.target as HTMLElement
      if (!tgt.closest('[data-ctx-menu]')) setCtx(null)
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

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (pendingDelete) {
        if (e.key === 'Escape') setPendingDelete(null)
        else if (e.key === 'Enter') performDelete()
        return
      }
      if (e.key === 'Backspace') { e.preventDefault(); up() }
      else if (e.key === 'Enter' && selected.size === 1) {
        const p = [...selected][0]
        const node = FS[p]
        if (node?.type === 'folder') navTo(p)
      }
      else if (e.key === 'Delete' && selected.size) openDeleteDialog([...selected], e.shiftKey)
      else if (e.key === 'Escape') setSelected(new Set())
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDelete, selected])

  // ── Navigation ──
  function navTo(path: string, fromHistory = false): void {
    const p = normPath(path)
    if (!FS[p] || FS[p].type !== 'folder') {
      setPathStatus({ msg: '路径不存在或不是文件夹', tone: 'error' })
      return
    }
    setCwd(p)
    setSelected(new Set())
    if (!fromHistory) {
      const next = history.slice(0, hIdx + 1).concat(p)
      setHistory(next)
      setHIdx(next.length - 1)
    }
  }
  function back(): void {
    if (hIdx > 0) {
      const i = hIdx - 1
      setHIdx(i)
      navTo(history[i], true)
    }
  }
  function forward(): void {
    if (hIdx < history.length - 1) {
      const i = hIdx + 1
      setHIdx(i)
      navTo(history[i], true)
    }
  }
  function up(): void {
    const p = parentOf(cwd)
    if (p) navTo(p)
  }

  // ── Address bar actions ──
  function tryOpenInput(): void {
    const raw = addressInput
    if (!raw.trim()) { setPathStatus({ msg: '请输入路径', tone: 'error' }); return }
    const p = normPath(raw)
    const node = FS[p]
    if (!node) { setPathStatus({ msg: '路径不存在', tone: 'error' }); return }
    if (node.type === 'folder') {
      navTo(p)
      setPathStatus({ msg: '已打开', tone: 'ok' })
    } else {
      const parent = parentOf(p)
      if (parent) {
        navTo(parent)
        setSelected(new Set([p]))
        setPathStatus({ msg: '已定位文件', tone: 'ok' })
      }
    }
  }
  function tryDeleteInput(): void {
    const raw = addressInput
    if (!raw.trim()) { setPathStatus({ msg: '请输入要删除的路径', tone: 'error' }); return }
    const p = normPath(raw)
    if (!FS[p]) { setPathStatus({ msg: '路径不存在,无法删除', tone: 'error' }); return }
    openDeleteDialog([p], false)
  }

  // ── Selection / context-menu actions ──
  function openDeleteDialog(paths: string[], permanent: boolean): void {
    const targets = paths.map((p) => ({ path: p, ...FS[p] })).filter((x): x is FsItem => Boolean(x.type))
    if (!targets.length) return
    setPendingDelete({ targets, permanent })
  }
  function performDelete(): void {
    if (!pendingDelete) return
    const removed: FsItem[] = []
    for (const t of pendingDelete.targets) {
      const stack = [t.path]
      while (stack.length) {
        const cur = stack.pop()!
        const node = FS[cur]
        if (!node) continue
        if (node.type === 'folder') for (const c of node.children ?? []) stack.push(c)
        delete FS[cur]
      }
      const parent = parentOf(t.path)
      if (parent && FS[parent]) {
        FS[parent].children = (FS[parent].children ?? []).filter((x) => x !== t.path)
      }
      removed.push(t)
    }
    setPendingDelete(null)
    setSelected(new Set())
    setFsTick((n) => n + 1)
    setToast({
      title: pendingDelete.permanent ? '已永久删除' : '已移到回收站',
      msg: removed.length === 1 ? removed[0].name : `${removed.length} 个项目`,
      icon: pendingDelete.permanent ? 'delete_forever' : 'delete',
    })
  }

  // ── Derived view data ──
  const items = useMemo(() => {
    const list = listChildren(cwd)
    const folders = list.filter((i) => i.type === 'folder')
    const files = list.filter((i) => i.type !== 'folder')
    const cmp = (a: FsItem, b: FsItem): number => {
      if (sort === 'size') return (b.size ?? 0) - (a.size ?? 0)
      if (sort === 'mtime') return String(b.mtime).localeCompare(String(a.mtime))
      if (sort === 'kind') return (a.kind ?? a.ext ?? '').localeCompare(b.kind ?? b.ext ?? '')
      return a.name.localeCompare(b.name, 'zh')
    }
    folders.sort(cmp); files.sort(cmp)
    return [...folders, ...files]
  // fsTick re-runs when mock FS mutates after delete.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, sort, fsTick])

  const totalSize = items.reduce((s, i) => s + (i.size ?? 0), 0)

  function onRowClick(e: React.MouseEvent, path: string): void {
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(selected)
      if (next.has(path)) next.delete(path); else next.add(path)
      setSelected(next)
    } else {
      setSelected(new Set([path]))
    }
  }
  function onRowDoubleClick(path: string): void {
    const node = FS[path]
    if (!node) return
    if (node.type === 'folder') navTo(path)
    else setPathStatus({ msg: `已请求播放: ${node.name}`, tone: 'ok' })
  }
  function onRowContextMenu(e: React.MouseEvent, path: string): void {
    e.preventDefault()
    if (!selected.has(path)) setSelected(new Set([path]))
    setCtx({ x: e.clientX, y: e.clientY, path })
  }

  function statusToneClass(tone: 'ok' | 'error' | 'info'): string {
    return tone === 'error' ? 'text-error' : tone === 'ok' ? 'text-green-400' : 'text-on-surface-variant/60'
  }

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <TopBar placeholder="" titleSlot={TITLE_SLOT} />

      {/* Address bar */}
      <section className="pt-16 px-8 pt-22 pb-3 bg-background border-b border-white/5" style={{ paddingTop: '5rem' }}>
        <div className="flex items-center gap-2 mb-3">
          <div className="flex items-center gap-1">
            <button
              onClick={back}
              disabled={hIdx === 0}
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
          </div>

          <div className="flex-1 flex items-stretch bg-surface-container-lowest rounded-lg border border-white/5 focus-within:border-primary/50 transition-colors overflow-hidden">
            <div className="flex items-center pl-3 pr-2 text-on-surface-variant/60">
              <span className="material-symbols-outlined text-[18px]">folder_open</span>
            </div>
            <input
              value={addressInput}
              onChange={(e) => setAddressInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') tryOpenInput() }}
              placeholder={'输入绝对路径,例如 C:\\Users\\Yuming\\Videos'}
              spellCheck={false}
              className="flex-1 bg-transparent border-0 focus:ring-0 py-2.5 px-1 text-sm font-mono tracking-tight text-on-surface placeholder:text-on-surface-variant/40 outline-none"
            />
            {pathStatus && (
              <span className={`flex items-center gap-1 px-3 font-label text-[10px] uppercase tracking-widest ${statusToneClass(pathStatus.tone)}`}>
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
          <button
            onClick={tryDeleteInput}
            className="flex items-center gap-1.5 px-4 h-10 rounded-lg bg-surface-container-high border border-error/30 text-error font-label text-[11px] font-bold uppercase tracking-widest hover:bg-error/10 active:scale-95 transition-all"
            title="删除输入框中的路径所指文件/文件夹"
          >
            <span className="material-symbols-outlined text-[16px]">delete</span>
            <span>Delete</span>
          </button>
        </div>

        <div className="flex items-center justify-end gap-3">
          {/* Sort selector — same custom dropdown pattern as SearchDownload's source selector.
              Trigger has a fixed width and the dropdown panel uses w-full so they align. */}
          <div className="relative w-40" ref={sortDropdownRef}>
            <button
              type="button"
              onClick={() => setSortDropdownOpen((o) => !o)}
              className="w-full flex items-center justify-between gap-2 bg-surface-container-highest border border-outline-variant/30 text-on-surface text-xs font-label rounded-lg px-3 py-2 outline-none cursor-pointer hover:border-primary/40 transition-colors"
            >
              <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/60">Sort</span>
              <span className="text-on-surface flex-1 text-left">{SORT_LABELS[sort]}</span>
              <span
                className={`material-symbols-outlined text-on-surface-variant/60 text-base leading-none transition-transform duration-200 ${sortDropdownOpen ? 'rotate-180' : ''}`}
              >
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
                    className={`w-full text-left px-4 py-2 text-xs font-label transition-colors ${
                      sort === key
                        ? 'text-primary bg-primary/8'
                        : 'text-on-surface hover:bg-surface-container-high'
                    }`}
                  >
                    {SORT_LABELS[key]}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center bg-surface-container-low rounded-md p-0.5">
            {(['list', 'grid'] as ViewMode[]).map((v) => {
              const active = view === v
              return (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  title={v === 'list' ? '详细列表' : '大图标'}
                  className={`p-1.5 rounded-sm transition-colors ${active ? 'bg-primary text-on-primary' : 'text-on-surface-variant/70 hover:bg-white/5 hover:text-on-surface'}`}
                >
                  <span className="material-symbols-outlined text-[16px]">{v === 'list' ? 'view_list' : 'grid_view'}</span>
                </button>
              )
            })}
          </div>
        </div>
      </section>

      {/* File list area */}
      <section ref={fileAreaRef} className="flex-1 overflow-y-auto px-8 py-6 select-none" tabIndex={0}>
        {items.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center py-24">
            <div className="w-16 h-16 rounded-2xl border border-white/5 flex items-center justify-center mb-4 bg-gradient-to-br from-surface-container-high/50 to-surface-container-lowest">
              <span className="material-symbols-outlined text-on-surface-variant/40 text-[28px]">folder_open</span>
            </div>
            <p className="font-label text-sm uppercase tracking-widest text-on-surface-variant/60">空文件夹</p>
            <p className="text-xs text-on-surface-variant/40 mt-2">此目录下没有项目</p>
          </div>
        ) : view === 'list' ? (
          <div className="bg-surface-container-lowest border border-white/5 rounded-lg overflow-hidden">
            <div className="grid grid-cols-12 gap-4 px-4 py-2.5 bg-surface-container-low rounded-t-lg border-b border-white/5 font-label text-[10px] uppercase tracking-[0.15em] text-outline">
              <div className="col-span-6">名称</div>
              <div className="col-span-2">修改时间</div>
              <div className="col-span-2">类型</div>
              <div className="col-span-2 text-right">大小</div>
            </div>
            <div>
              {items.map((item) => {
                const sel = selected.has(item.path)
                return (
                  <div
                    key={item.path}
                    onClick={(e) => onRowClick(e, item.path)}
                    onDoubleClick={() => onRowDoubleClick(item.path)}
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
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {items.map((item) => {
              const sel = selected.has(item.path)
              return (
                <div
                  key={item.path}
                  onClick={(e) => onRowClick(e, item.path)}
                  onDoubleClick={() => onRowDoubleClick(item.path)}
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
                        {item.ext ?? 'video'}
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
          <span>{items.length} 项</span>
          <span className="h-3 w-px bg-outline-variant/20" />
          <span>{totalSize ? `${fmtSize(totalSize)} 总大小` : '—'}</span>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            <span>Filesystem · Mock</span>
          </div>
          <span className="font-mono normal-case tracking-tight text-on-surface-variant/40 truncate max-w-md">{cwd}</span>
        </div>
      </footer>

      {/* Context menu */}
      {ctx && (
        <div
          data-ctx-menu
          style={{ left: ctx.x, top: ctx.y }}
          className="fixed z-50 rounded-lg border border-white/10 shadow-2xl py-1.5 min-w-[220px] bg-surface-container/95 backdrop-blur"
        >
          {[
            { action: 'open', icon: 'play_arrow', iconClass: 'text-primary', label: '打开', kbd: 'Enter' },
            { action: 'reveal', icon: 'folder_open', iconClass: 'text-on-surface-variant', label: '打开所在位置' },
          ].map((item) => (
            <button
              key={item.action}
              onClick={() => {
                const target = ctx.path
                setCtx(null)
                const node = FS[target]
                if (!node) return
                if (item.action === 'open') {
                  if (node.type === 'folder') navTo(target)
                  else setPathStatus({ msg: `已请求播放: ${node.name}`, tone: 'ok' })
                } else if (item.action === 'reveal') {
                  const parent = parentOf(target)
                  if (parent) {
                    navTo(parent)
                    setSelected(new Set([target]))
                    setPathStatus({ msg: `已定位到: ${basename(target)}`, tone: 'ok' })
                  } else setPathStatus({ msg: '此项没有上级位置', tone: 'error' })
                }
              }}
              className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/5 text-sm text-left"
            >
              <span className={`material-symbols-outlined text-[18px] ${item.iconClass}`}>{item.icon}</span>
              <span className="flex-1">{item.label}</span>
              {item.kbd && <span className="font-label text-[10px] text-on-surface-variant/40 tracking-widest">{item.kbd}</span>}
            </button>
          ))}
          <div className="h-px bg-white/5 my-1" />
          <button
            onClick={() => { const t = ctx.path; setCtx(null); openDeleteDialog([t], false) }}
            className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/5 text-sm text-left"
          >
            <span className="material-symbols-outlined text-[18px] text-on-surface-variant">delete</span>
            <span className="flex-1">删除(到回收站)</span>
            <span className="font-label text-[10px] text-on-surface-variant/40 tracking-widest">Del</span>
          </button>
          <button
            onClick={() => { const t = ctx.path; setCtx(null); openDeleteDialog([t], true) }}
            className="w-full flex items-center gap-3 px-3 py-2 hover:bg-error/10 text-sm text-error text-left"
          >
            <span className="material-symbols-outlined text-[18px]">delete_forever</span>
            <span className="flex-1">永久删除</span>
            <span className="font-label text-[10px] tracking-widest opacity-60">Shift+Del</span>
          </button>
        </div>
      )}

      {/* Delete confirmation overlay */}
      {pendingDelete && (() => {
        const isOne = pendingDelete.targets.length === 1
        const t = pendingDelete.targets[0]
        const isFolder = isOne && t.type === 'folder'
        const childCount = isFolder ? listChildren(t.path).length : 0
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
                        : '选中项目将被移动到系统回收站,你可以稍后还原。'}
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
                          <p className="font-label text-[9px] uppercase tracking-widest text-on-surface-variant/50 mb-0.5">{isFolder ? '子项' : '修改时间'}</p>
                          <p className="text-xs font-mono">{isFolder ? `${childCount} 项` : t.mtime}</p>
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
                    <span>永久删除后无法恢复,请谨慎操作。</span>
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
                  onClick={performDelete}
                  className="flex-1 py-3 rounded-xl border border-error/40 bg-error/10 text-sm font-bold text-error hover:bg-error/20 transition-colors flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-base leading-none">delete</span>
                  <span>{pendingDelete.permanent ? '永久删除' : '移到回收站'}</span>
                </button>
              </div>
            </div>
          </div>
        )
      })()}

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
