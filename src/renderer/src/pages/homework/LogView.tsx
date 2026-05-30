import {
  forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react'
import { Highlight, LogEntry, matchesLog, ModalShell } from './shared'
import { TagFilter } from '../../components/TagFilter'

export interface LogViewHandle {
  focusInput: () => void
}

interface Props {
  data: LogEntry[]
  setData: (next: LogEntry[]) => void
  query: string
  onClearQuery: () => void
}

type ViewMode = 'dense' | 'wrap'
const VIEW_KEY = 'maple-log-view-mode'

// 类型配色：一组**字面**完整类名（Tailwind JIT 只收录源码里字面出现的类名，
// 动态拼 `bg-${c}-400` 不会被打进 CSS），按类型名 hash 取一档 —— 任意新类型
// 都有稳定颜色。用 400 档：浅深主题下都还算能读。
const TYPE_PALETTE = [
  'text-rose-400 bg-rose-400/15 border-rose-400/30',
  'text-orange-400 bg-orange-400/15 border-orange-400/30',
  'text-amber-400 bg-amber-400/15 border-amber-400/30',
  'text-lime-400 bg-lime-400/15 border-lime-400/30',
  'text-emerald-400 bg-emerald-400/15 border-emerald-400/30',
  'text-teal-400 bg-teal-400/15 border-teal-400/30',
  'text-sky-400 bg-sky-400/15 border-sky-400/30',
  'text-indigo-400 bg-indigo-400/15 border-indigo-400/30',
  'text-violet-400 bg-violet-400/15 border-violet-400/30',
  'text-fuchsia-400 bg-fuchsia-400/15 border-fuchsia-400/30',
]
function typeColor(t: string): string {
  let h = 0
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0
  return TYPE_PALETTE[h % TYPE_PALETTE.length]
}

function TypeChip({ t, small }: { t: string; small?: boolean }): JSX.Element {
  return (
    <span className={`inline-flex items-center rounded border font-label font-bold tracking-wider ${typeColor(t)} ${small ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'}`}>
      {t}
    </span>
  )
}

const hasMeta = (e: LogEntry): boolean => Boolean((e.types && e.types.length) || e.note)

const LogView = forwardRef<LogViewHandle, Props>(function LogView(
  { data, setData, query, onClearQuery }, ref
) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [recentlyAddedId, setRecentlyAddedId] = useState<number | null>(null)
  const [selectedTypes, setSelectedTypes] = useState<string[]>([])
  const [detailId, setDetailId] = useState<number | null>(null)
  // 单条 hover 浮层：fixed 定位，避开滚动容器把绝对定位的卡片裁掉的问题
  const [hover, setHover] = useState<{ entry: LogEntry; x: number; y: number } | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const v = localStorage.getItem(VIEW_KEY)
    return v === 'wrap' ? 'wrap' : 'dense'
  })

  useImperativeHandle(ref, () => ({ focusInput: () => inputRef.current?.focus() }))
  useEffect(() => { localStorage.setItem(VIEW_KEY, viewMode) }, [viewMode])

  useEffect(() => {
    if (!addError) return
    const t = setTimeout(() => setAddError(null), 2200)
    return () => clearTimeout(t)
  }, [addError])
  useEffect(() => {
    if (recentlyAddedId === null) return
    const t = setTimeout(() => setRecentlyAddedId(null), 1200)
    return () => clearTimeout(t)
  }, [recentlyAddedId])

  // 所有类型 + 命中数（给 TagFilter）—— 按命中数降序，跟 MyAnime 一致
  const allTypes = useMemo(() => {
    const m = new Map<string, number>()
    data.forEach(e => e.types?.forEach(t => m.set(t, (m.get(t) || 0) + 1)))
    return [...m.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }, [data])

  const visible = useMemo(() => data.filter(e => {
    // 类型 OR：命中所选任一类型即显示
    if (selectedTypes.length && !selectedTypes.some(t => e.types?.includes(t))) return false
    return matchesLog(e, query)
  }), [data, query, selectedTypes])

  const total = data.length
  const matched = visible.length
  const filtering = Boolean(query) || selectedTypes.length > 0
  const detail = detailId !== null ? data.find(e => e.id === detailId) ?? null : null

  const handleAdd = (): void => {
    const t = draft.trim()
    if (!t) return
    if (data.some(e => e.title === t)) {
      setAddError('已经记过了，不重复添加')
      return
    }
    const newId = Date.now()
    setData([{ id: newId, title: t }, ...data])
    setDraft('')
    setAddError(null)
    setRecentlyAddedId(newId)
    inputRef.current?.focus()
  }

  const saveEntry = (next: LogEntry): void => {
    setData(data.map(e => e.id === next.id ? next : e))
    setDetailId(null)
  }
  const removeEntry = (id: number): void => {
    setData(data.filter(e => e.id !== id))
    setDetailId(null)
  }

  const openDetail = (e: LogEntry): void => { setHover(null); setDetailId(e.id) }
  const onEnterRow = (e: React.MouseEvent, entry: LogEntry): void => {
    if (!hasMeta(entry)) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setHover({ entry, x: r.left, y: r.bottom })
  }

  return (
    <div className="px-8 py-6">
      {/* 快速记一笔：只填标题，类型/备注点开补 */}
      <div className={`flex items-center gap-3 bg-surface-container/60 rounded-xl px-4 h-12 border transition-colors ${
        addError
          ? 'border-error/50 ring-2 ring-error/20'
          : 'border-outline-variant/15 focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/20'
      }`}>
        <span className="material-symbols-outlined text-on-surface-variant/50" style={{ fontSize: 18 }}>edit_note</span>
        <input
          ref={inputRef}
          spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off"
          value={draft}
          onChange={e => { setDraft(e.target.value); if (addError) setAddError(null) }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleAdd() }}
          placeholder="记一笔（先填标题，类型 / 备注点开补）… 回车保存"
          className="flex-1 bg-transparent text-sm text-on-surface placeholder:text-on-surface-variant/35 focus:outline-none"
        />
        <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/30 hidden sm:inline">↵ Enter</span>
        <button
          onClick={handleAdd}
          disabled={!draft.trim()}
          className="px-4 h-8 rounded-md bg-primary/15 text-primary font-label text-[10px] uppercase tracking-widest hover:bg-primary/25 disabled:opacity-30 disabled:cursor-not-allowed transition-all flex items-center gap-1.5"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 13 }}>add</span>
          添加
        </button>
      </div>

      {/* 错误槽（固定高度避免跳动） */}
      <div className="h-5 mt-2 mb-3 flex items-center gap-1.5 px-1 text-[11px] font-label">
        {addError && (
          <>
            <span className="material-symbols-outlined text-error" style={{ fontSize: 13 }}>error</span>
            <span className="text-error">{addError}</span>
          </>
        )}
      </div>

      {/* 工具条：计数 + 类型筛选（TagFilter）+ 视图切换。文本搜索在页头上游。 */}
      <div className="flex items-center gap-3 mb-3">
        <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 flex items-center gap-2">
          <span className="material-symbols-outlined" style={{ fontSize: 12 }}>format_list_bulleted</span>
          {filtering ? `${matched} / ${total} 条匹配` : `${total} 条记录`}
        </span>
        {query && (
          <button onClick={onClearQuery} className="font-label text-[10px] uppercase tracking-widest text-secondary hover:text-secondary/80">
            清除搜索
          </button>
        )}
        <span className="flex-1" />
        <span className="font-label text-[9px] text-on-surface-variant/30 hidden md:inline">hover 看类型 / 备注 · 单击编辑</span>
        <TagFilter allTags={allTypes} selected={selectedTypes} onChange={setSelectedTypes} matchMode="OR" pinSelected={false} />
        <div className="inline-flex bg-surface-container/60 rounded-md p-0.5 border border-outline-variant/15">
          {([
            ['view_agenda', 'dense', '紧凑列表'],
            ['grid_view', 'wrap', '流式标签'],
          ] as const).map(([icon, v, t]) => (
            <button
              key={v}
              onClick={() => setViewMode(v)}
              className={`px-2 h-6 rounded flex items-center justify-center transition-all ${
                viewMode === v ? 'bg-surface-container-highest text-on-surface' : 'text-on-surface-variant/50 hover:text-on-surface'
              }`}
              title={t}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 13 }}>{icon}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      {total === 0 ? (
        <div className="rounded-xl border border-dashed border-outline-variant/30 bg-surface-container/40 px-6 py-16 text-center">
          <span className="material-symbols-outlined text-on-surface-variant/30" style={{ fontSize: 48 }}>edit_note</span>
          <p className="mt-3 text-sm font-label text-on-surface-variant/60">还没有记录</p>
          <p className="mt-1 text-[11px] font-label text-on-surface-variant/40">在上方输入框记一笔，回车保存</p>
        </div>
      ) : matched === 0 ? (
        <div className="rounded-xl border border-dashed border-outline-variant/30 bg-surface-container/40 px-6 py-12 text-center">
          <p className="text-sm font-label text-on-surface-variant/60">没有匹配的记录</p>
          <button onClick={() => { onClearQuery(); setSelectedTypes([]) }} className="mt-2 text-[11px] font-label text-secondary hover:text-secondary/80">
            清除筛选
          </button>
        </div>
      ) : viewMode === 'dense' ? (
        <div className="bg-surface-container/30 rounded-lg border border-outline-variant/10 overflow-hidden">
          {visible.map((entry, i) => (
            <div
              key={entry.id}
              onClick={() => openDetail(entry)}
              onMouseEnter={e => onEnterRow(e, entry)}
              onMouseLeave={() => setHover(null)}
              className={`group flex items-center gap-2.5 h-9 px-3 border-b border-outline-variant/10 last:border-b-0 hover:bg-surface-container-high/40 cursor-pointer transition-colors ${recentlyAddedId === entry.id ? 'animate-fade-up' : ''}`}
            >
              <span className="font-label text-[9px] tabular-nums text-on-surface-variant/30 w-6 flex-shrink-0">{String(i + 1).padStart(2, '0')}</span>
              <Dot entry={entry} />
              <span className="flex-1 text-[13px] text-on-surface truncate min-w-0"><Highlight text={entry.title} query={query} /></span>
              {entry.types && entry.types.length > 0 && (
                <span className="flex-shrink-0 flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                  <TypeChip t={entry.types[0]} small />
                  {entry.types.length > 1 && <span className="text-[9px] text-on-surface-variant/40">+{entry.types.length - 1}</span>}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {visible.map((entry) => (
            <div
              key={entry.id}
              onClick={() => openDetail(entry)}
              onMouseEnter={e => onEnterRow(e, entry)}
              onMouseLeave={() => setHover(null)}
              className={`group inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-surface-container/60 border border-outline-variant/15 hover:border-primary/30 cursor-pointer transition-colors ${recentlyAddedId === entry.id ? 'animate-fade-up ring-1 ring-primary/40' : ''}`}
            >
              <Dot entry={entry} />
              <span className="text-[12px] text-on-surface max-w-[260px] truncate"><Highlight text={entry.title} query={query} /></span>
            </div>
          ))}
        </div>
      )}

      {/* hover 浮层（fixed，不被滚动容器裁切） */}
      {hover && <HoverCard entry={hover.entry} x={hover.x} y={hover.y} />}

      {/* 详情 / 编辑弹窗 */}
      {detail && (
        <DetailModal
          key={detail.id}
          entry={detail}
          existingTitles={data.filter(e => e.id !== detail.id).map(e => e.title)}
          onClose={() => setDetailId(null)}
          onSave={saveEntry}
          onDelete={removeEntry}
        />
      )}
    </div>
  )
})

export default LogView

// 「有类型/备注」小圆点 —— 提示这条标题背后还有东西，引导 hover / 点开。
// 没有就占位等宽，保持标题左缘对齐。
function Dot({ entry }: { entry: LogEntry }): JSX.Element {
  return hasMeta(entry)
    ? <span className="w-1.5 h-1.5 rounded-full bg-primary/70 flex-shrink-0" title="有类型 / 备注" />
    : <span className="w-1.5 h-1.5 flex-shrink-0" />
}

// ── hover 浮层 ────────────────────────────────────────────────────────────────

function HoverCard({ entry, x, y }: { entry: LogEntry; x: number; y: number }): JSX.Element {
  // 简单防右溢出：卡片宽 288，靠右时左移
  const left = Math.min(x, window.innerWidth - 288 - 12)
  const top = Math.min(y + 4, window.innerHeight - 160)
  return (
    <div
      style={{ position: 'fixed', left: Math.max(8, left), top, width: 288, zIndex: 60 }}
      className="pointer-events-none rounded-lg bg-surface-container-high border border-outline-variant/30 shadow-2xl shadow-black/40 p-3 animate-fade-up"
    >
      <p className="text-[13px] font-bold text-on-surface mb-1.5 break-words">{entry.title}</p>
      {entry.types && entry.types.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">{entry.types.map(t => <TypeChip key={t} t={t} small />)}</div>
      )}
      {entry.note
        ? <p className="text-[11px] leading-relaxed text-on-surface-variant/80 break-words whitespace-pre-wrap">{entry.note}</p>
        : <p className="text-[11px] text-on-surface-variant/35 italic">无备注</p>}
    </div>
  )
}

// ── 详情 / 编辑弹窗 ───────────────────────────────────────────────────────────

function DetailModal({
  entry, existingTitles, onClose, onSave, onDelete,
}: {
  entry: LogEntry
  existingTitles: string[]
  onClose: () => void
  onSave: (next: LogEntry) => void
  onDelete: (id: number) => void
}): JSX.Element {
  const [title, setTitle] = useState(entry.title)
  const [types, setTypes] = useState<string[]>(entry.types ?? [])
  const [note, setNote] = useState(entry.note ?? '')
  const [typeDraft, setTypeDraft] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const addType = (): void => {
    const t = typeDraft.trim()
    if (t && !types.includes(t)) setTypes([...types, t])
    setTypeDraft('')
  }

  const save = (): void => {
    const t = title.trim()
    if (!t) { setErr('标题不能为空'); return }
    if (existingTitles.includes(t)) { setErr('已有同名标题'); return }
    const next: LogEntry = {
      id: entry.id,
      title: t,
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(types.length ? { types } : {}),
    }
    onSave(next)
  }

  return (
    <ModalShell onBackdrop={onClose}>
      <div>
        <div className="flex items-center justify-between px-5 py-4 border-b border-outline-variant/15">
          <span className="font-label text-[10px] uppercase tracking-[0.2em] text-on-surface-variant/50">编辑记录</span>
          <button onClick={onClose} className="text-on-surface-variant/60 hover:text-on-surface">
            <span className="material-symbols-outlined leading-none">close</span>
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-1.5 block">标题</label>
            <input
              value={title}
              autoFocus
              spellCheck={false}
              onChange={e => { setTitle(e.target.value); if (err) setErr(null) }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) save() }}
              className="w-full bg-surface-container-high border border-outline-variant/20 rounded-lg px-3.5 py-2.5 text-sm text-on-surface outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/20"
            />
          </div>

          <div>
            <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-1.5 block">类型</label>
            <div className="flex flex-wrap gap-1.5 items-center bg-surface-container-high border border-outline-variant/20 rounded-lg px-2.5 py-2 focus-within:border-primary/40">
              {types.map(t => (
                <span key={t} className={`inline-flex items-center gap-0.5 rounded border px-2 py-0.5 text-[10px] font-label font-bold tracking-wider ${typeColor(t)}`}>
                  {t}
                  <button onClick={() => setTypes(types.filter(x => x !== t))} className="ml-0.5 opacity-50 hover:opacity-100" title="移除">
                    <span className="material-symbols-outlined leading-none" style={{ fontSize: 11 }}>close</span>
                  </button>
                </span>
              ))}
              <input
                value={typeDraft}
                spellCheck={false}
                onChange={e => setTypeDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.nativeEvent.isComposing) return
                  if (e.key === 'Enter') { e.preventDefault(); addType() }
                  else if (e.key === 'Backspace' && !typeDraft && types.length) setTypes(types.slice(0, -1))
                }}
                onBlur={addType}
                placeholder={types.length ? '' : '加类型，回车…'}
                className="flex-1 min-w-[80px] bg-transparent outline-none text-[12px] text-on-surface py-0.5 placeholder:text-on-surface-variant/35"
              />
            </div>
          </div>

          <div>
            <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-1.5 block">备注</label>
            <textarea
              value={note}
              rows={3}
              spellCheck={false}
              onChange={e => setNote(e.target.value)}
              placeholder="随便记点什么…"
              className="w-full bg-surface-container-high border border-outline-variant/20 rounded-lg px-3.5 py-2.5 text-sm text-on-surface outline-none focus:border-primary/40 resize-none placeholder:text-on-surface-variant/35"
            />
          </div>

          {err && (
            <p className="font-label text-[11px] text-error flex items-center gap-1.5">
              <span className="material-symbols-outlined" style={{ fontSize: 13 }}>error</span>{err}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t border-outline-variant/15">
          <button onClick={() => onDelete(entry.id)} className="px-3 py-2 rounded-lg text-on-surface-variant/60 hover:text-error hover:bg-error/10 font-label text-xs flex items-center gap-1.5 transition-colors">
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>删除
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-lg border border-outline-variant/20 text-on-surface-variant/70 hover:bg-surface-container-high font-label text-xs">取消</button>
            <button onClick={save} className="px-5 py-2 rounded-lg bg-primary text-on-primary font-bold font-label text-xs hover:brightness-110 active:scale-95 transition-all">保存</button>
          </div>
        </div>
      </div>
    </ModalShell>
  )
}
