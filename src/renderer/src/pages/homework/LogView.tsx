import {
  forwardRef, useEffect, useImperativeHandle, useRef, useState,
} from 'react'
import { Highlight, LogEntry, matchesLog } from './shared'

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

const LogView = forwardRef<LogViewHandle, Props>(function LogView(
  { data, setData, query, onClearQuery }, ref
) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const [recentlyAddedId, setRecentlyAddedId] = useState<number | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const v = localStorage.getItem(VIEW_KEY)
    return v === 'wrap' ? 'wrap' : 'dense'
  })

  useImperativeHandle(ref, () => ({
    focusInput: () => inputRef.current?.focus(),
  }))

  useEffect(() => { localStorage.setItem(VIEW_KEY, viewMode) }, [viewMode])

  // Auto-clear add error after a beat
  useEffect(() => {
    if (!addError) return
    const t = setTimeout(() => setAddError(null), 2200)
    return () => clearTimeout(t)
  }, [addError])

  // Clear recently-added highlight after the fade-in finishes
  useEffect(() => {
    if (recentlyAddedId === null) return
    const t = setTimeout(() => setRecentlyAddedId(null), 1200)
    return () => clearTimeout(t)
  }, [recentlyAddedId])

  const handleAdd = (): void => {
    const t = draft.trim()
    if (!t) return
    if (data.some(e => e.text === t)) {
      setAddError('已经记过了，不重复添加')
      return
    }
    const newId = Date.now()
    setData([{ id: newId, text: t }, ...data])
    setDraft('')
    setAddError(null)
    setRecentlyAddedId(newId)
    inputRef.current?.focus()
  }

  const startEdit = (entry: LogEntry): void => {
    setEditingId(entry.id)
    setEditDraft(entry.text)
    setConfirmId(null)
  }

  // Enter / blur both call this. Empty input cancels (no save, no remove).
  // Duplicate input is allowed on edit — user can curate after.
  const commitEdit = (): void => {
    if (editingId === null) return
    const id = editingId
    const t = editDraft.trim()
    setEditingId(null)
    setEditDraft('')
    if (!t) return
    setData(data.map(e => e.id === id ? { ...e, text: t } : e))
  }

  const cancelEdit = (): void => {
    setEditingId(null)
    setEditDraft('')
  }

  const remove = (id: number): void => {
    setData(data.filter(e => e.id !== id))
    setConfirmId(null)
    if (editingId === id) cancelEdit()
  }

  const visible = query ? data.filter(e => matchesLog(e, query)) : data
  const total = data.length
  const matched = visible.length

  return (
    <div className="px-8 py-6">
      {/* Add bar */}
      <div className={`flex items-center gap-3 bg-surface-container/60 rounded-xl px-4 h-12 border transition-colors ${
        addError
          ? 'border-error/50 ring-2 ring-error/20'
          : 'border-outline-variant/15 focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/20'
      }`}>
        <span className="material-symbols-outlined text-on-surface-variant/50" style={{ fontSize: 18 }}>edit_note</span>
        <input
          ref={inputRef}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          value={draft}
          onChange={e => { setDraft(e.target.value); if (addError) setAddError(null) }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleAdd() }}
          placeholder="记一笔，回车保存…"
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

      {/* Add error (fixed-height slot to avoid layout jumps) */}
      <div className="h-5 mt-2 mb-3 flex items-center gap-1.5 px-1 text-[11px] font-label">
        {addError && (
          <>
            <span className="material-symbols-outlined text-error" style={{ fontSize: 13 }}>error</span>
            <span className="text-error">{addError}</span>
          </>
        )}
      </div>

      {/* Toolbar — count + view toggle. Search lives in the page header upstream. */}
      <div className="flex items-center gap-3 mb-3">
        <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 flex items-center gap-2">
          <span className="material-symbols-outlined" style={{ fontSize: 12 }}>format_list_bulleted</span>
          {query ? `${matched} / ${total} 条匹配` : `${total} 条记录`}
        </span>
        <span className="flex-1" />
        {query && (
          <button
            onClick={onClearQuery}
            className="font-label text-[10px] uppercase tracking-widest text-secondary hover:text-secondary/80"
          >
            清除搜索
          </button>
        )}
        <span className="font-label text-[9px] uppercase tracking-widest text-on-surface-variant/30 hidden sm:inline normal-case tracking-normal">
          双击编辑 · 回车 / 失焦保存 · Esc 取消
        </span>
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
          <button
            onClick={onClearQuery}
            className="mt-2 text-[11px] font-label text-secondary hover:text-secondary/80"
          >
            清除搜索
          </button>
        </div>
      ) : viewMode === 'dense' ? (
        <div className="bg-surface-container/30 rounded-lg border border-outline-variant/10 overflow-hidden">
          {visible.map((entry, i) => (
            <DenseRow
              key={entry.id}
              entry={entry}
              idx={i + 1}
              query={query}
              isNew={recentlyAddedId === entry.id}
              isEditing={editingId === entry.id}
              isConfirming={confirmId === entry.id}
              editDraft={editDraft}
              setEditDraft={setEditDraft}
              onStartEdit={() => startEdit(entry)}
              onCommit={commitEdit}
              onCancel={cancelEdit}
              onAskDelete={() => setConfirmId(entry.id)}
              onConfirmDelete={() => remove(entry.id)}
              onCancelConfirm={() => setConfirmId(null)}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {visible.map((entry) => (
            <ChipRow
              key={entry.id}
              entry={entry}
              query={query}
              isNew={recentlyAddedId === entry.id}
              isEditing={editingId === entry.id}
              isConfirming={confirmId === entry.id}
              editDraft={editDraft}
              setEditDraft={setEditDraft}
              onStartEdit={() => startEdit(entry)}
              onCommit={commitEdit}
              onCancel={cancelEdit}
              onAskDelete={() => setConfirmId(entry.id)}
              onConfirmDelete={() => remove(entry.id)}
              onCancelConfirm={() => setConfirmId(null)}
            />
          ))}
        </div>
      )}
    </div>
  )
})

export default LogView

// ── Dense row ─────────────────────────────────────────────────────────────────

interface RowProps {
  entry: LogEntry
  query: string
  isNew: boolean
  isEditing: boolean
  isConfirming: boolean
  editDraft: string
  setEditDraft: (s: string) => void
  onStartEdit: () => void
  onCommit: () => void
  onCancel: () => void
  onAskDelete: () => void
  onConfirmDelete: () => void
  onCancelConfirm: () => void
}

function DenseRow({
  entry, idx, query, isNew, isEditing, isConfirming,
  editDraft, setEditDraft,
  onStartEdit, onCommit, onCancel, onAskDelete, onConfirmDelete, onCancelConfirm,
}: RowProps & { idx: number }): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  // Suppress blur-commit when the cause was Esc — Esc already triggered cancel.
  const cancellingRef = useRef(false)

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditing])

  const handleBlur = (): void => {
    if (cancellingRef.current) {
      cancellingRef.current = false
      return
    }
    onCommit()
  }

  return (
    <div
      className={`group flex items-center gap-2 h-9 px-3 border-b border-outline-variant/10 last:border-b-0 transition-colors
        ${isEditing ? 'bg-surface-container-high/60' : 'hover:bg-surface-container-high/30'}
        ${isNew ? 'log-fade-up' : ''}`}
    >
      <span className="font-label text-[9px] uppercase tracking-widest text-on-surface-variant/30 tabular-nums w-6 flex-shrink-0">
        {String(idx).padStart(2, '0')}
      </span>

      {isEditing ? (
        <input
          ref={inputRef}
          value={editDraft}
          onChange={e => setEditDraft(e.target.value)}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') { e.preventDefault(); onCommit() }
            else if (e.key === 'Escape') { e.preventDefault(); cancellingRef.current = true; onCancel() }
          }}
          onBlur={handleBlur}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          className="flex-1 bg-transparent outline-none text-[13px] text-on-surface min-w-0"
        />
      ) : (
        <p
          onDoubleClick={onStartEdit}
          title="双击编辑"
          className="flex-1 text-[13px] text-on-surface truncate min-w-0 cursor-text select-none"
        >
          <Highlight text={entry.text} query={query} />
        </p>
      )}

      {isEditing ? null : isConfirming ? (
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={onCancelConfirm}
            className="px-2 h-6 text-[10px] font-label uppercase tracking-widest text-on-surface-variant/60 hover:text-on-surface"
          >
            取消
          </button>
          <button
            onClick={onConfirmDelete}
            className="px-2 h-6 rounded bg-error/20 text-error text-[10px] font-label uppercase tracking-widest font-bold hover:bg-error/30"
          >
            确认删除
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={onAskDelete}
            title="删除"
            className="w-6 h-6 rounded hover:bg-error/15 text-on-surface-variant/60 hover:text-error flex items-center justify-center"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>delete</span>
          </button>
        </div>
      )}
    </div>
  )
}

// ── Chip layout ───────────────────────────────────────────────────────────────

function ChipRow({
  entry, query, isNew, isEditing, isConfirming,
  editDraft, setEditDraft,
  onStartEdit, onCommit, onCancel, onAskDelete, onConfirmDelete, onCancelConfirm,
}: RowProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const cancellingRef = useRef(false)

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditing])

  const handleBlur = (): void => {
    if (cancellingRef.current) {
      cancellingRef.current = false
      return
    }
    onCommit()
  }

  if (isEditing) {
    return (
      <div className="inline-flex items-center h-7 px-3 rounded-md bg-surface-container-high border border-primary/40 ring-1 ring-primary/20">
        <input
          ref={inputRef}
          value={editDraft}
          onChange={e => setEditDraft(e.target.value)}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') { e.preventDefault(); onCommit() }
            else if (e.key === 'Escape') { e.preventDefault(); cancellingRef.current = true; onCancel() }
          }}
          onBlur={handleBlur}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={{ width: `${Math.max(8, Math.min(60, editDraft.length + 2))}ch` }}
          className="bg-transparent outline-none text-[12px] text-on-surface min-w-[8ch]"
        />
      </div>
    )
  }

  if (isConfirming) {
    return (
      <div className="inline-flex items-center gap-1 h-7 pl-3 pr-1 rounded-md bg-error/10 border border-error/30">
        <span className="text-[12px] text-on-surface select-none">{entry.text}</span>
        <button
          onClick={onCancelConfirm}
          className="px-1.5 h-5 text-[10px] font-label uppercase text-on-surface-variant/60 hover:text-on-surface"
        >
          ×
        </button>
        <button
          onClick={onConfirmDelete}
          className="px-2 h-5 rounded bg-error/20 text-error text-[10px] font-label uppercase tracking-widest font-bold"
        >
          删除
        </button>
      </div>
    )
  }

  return (
    <div
      className={`group inline-flex items-center h-7 rounded-md bg-surface-container/60 border border-outline-variant/15 hover:border-outline-variant/30 transition-colors ${isNew ? 'log-fade-up ring-1 ring-primary/40' : ''}`}
    >
      <span
        onDoubleClick={onStartEdit}
        title="双击编辑"
        className="px-3 text-[12px] text-on-surface max-w-[260px] truncate cursor-text select-none"
      >
        <Highlight text={entry.text} query={query} />
      </span>
      <div className="flex items-center pr-1 gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity max-w-0 group-hover:max-w-[40px] overflow-hidden">
        <button
          onClick={onAskDelete}
          title="删除"
          className="w-5 h-5 rounded hover:bg-error/15 text-on-surface-variant/60 hover:text-error flex items-center justify-center"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 12 }}>delete</span>
        </button>
      </div>
    </div>
  )
}
