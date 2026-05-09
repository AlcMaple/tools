import { forwardRef, Fragment, useEffect, useImperativeHandle, useRef, useState } from 'react'
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

const LogView = forwardRef<LogViewHandle, Props>(function LogView(
  { data, setData, query, onClearQuery }, ref
) {
  const inputRef = useRef<HTMLInputElement>(null)
  const editRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)

  useImperativeHandle(ref, () => ({
    focusInput: () => inputRef.current?.focus(),
  }))

  // 自动清错误提示
  useEffect(() => {
    if (!addError) return
    const t = setTimeout(() => setAddError(null), 2200)
    return () => clearTimeout(t)
  }, [addError])

  const isDuplicate = (text: string, exceptId?: number): boolean => {
    return data.some(e => e.text === text && e.id !== exceptId)
  }

  const handleAdd = () => {
    const t = draft.trim()
    if (!t) return
    if (isDuplicate(t)) {
      setAddError('已经记过了，不重复添加')
      return
    }
    setData([...data, { id: Date.now(), text: t }])
    setDraft('')
    setAddError(null)
    inputRef.current?.focus()
  }

  const startEdit = (entry: LogEntry) => {
    setEditingId(entry.id)
    setEditDraft(entry.text)
    setEditError(null)
  }

  const commitEdit = () => {
    if (editingId == null) return
    const t = editDraft.trim()
    if (!t) {
      // 空内容 → 视为取消编辑（保留原值），用户要删需点 ✕ 按钮
      setEditingId(null)
      setEditDraft('')
      setEditError(null)
      return
    }
    if (isDuplicate(t, editingId)) {
      setEditError('已存在同名记录')
      // 保持编辑态，让用户改
      editRef.current?.focus()
      return
    }
    setData(data.map(e => e.id === editingId ? { ...e, text: t } : e))
    setEditingId(null)
    setEditDraft('')
    setEditError(null)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditDraft('')
    setEditError(null)
  }

  const deleteEntry = (id: number) => {
    setData(data.filter(e => e.id !== id))
    setEditingId(null)
    setEditDraft('')
    setEditError(null)
  }

  const visible = query ? data.filter(e => matchesLog(e, query)) : data
  const total = data.length
  const matched = visible.length

  return (
    <div className="px-8 py-6">
      {/* 顶部 inline 输入 — 始终可见，回车追加 */}
      <div className={`mb-2 flex items-center gap-3 bg-surface-container rounded-xl px-4 py-3 border transition-all ${
        addError
          ? 'border-error/50 ring-2 ring-error/20'
          : 'border-outline-variant/15 focus-within:border-secondary/50 focus-within:ring-2 focus-within:ring-secondary/20'
      }`}>
        <span className="material-symbols-outlined text-secondary/70" style={{ fontSize: 18 }}>edit_note</span>
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
          className="flex-1 bg-transparent text-sm text-on-surface placeholder:text-on-surface-variant/40 focus:outline-none"
        />
        <button
          onClick={handleAdd}
          disabled={!draft.trim()}
          className="px-3 py-1 rounded-md text-[10px] font-label uppercase tracking-widest bg-secondary/15 text-secondary hover:bg-secondary/25 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
        >
          添加
        </button>
      </div>
      {/* 添加错误提示（占位高度恒定，避免布局跳动） */}
      <div className="h-5 mb-3 flex items-center gap-1.5 px-1 text-[11px] font-label">
        {addError && (
          <>
            <span className="material-symbols-outlined text-error" style={{ fontSize: 13 }}>error</span>
            <span className="text-error">{addError}</span>
          </>
        )}
      </div>

      {/* 状态行 */}
      <div className="flex items-center gap-3 mb-3 text-[10px] font-label uppercase tracking-widest text-on-surface-variant/50">
        <span className="material-symbols-outlined" style={{ fontSize: 12 }}>format_list_bulleted</span>
        <span>{total} 条记录{query ? ` · ${matched} 条匹配` : ''}</span>
        <span className="ml-auto flex items-center gap-3 normal-case tracking-normal text-on-surface-variant/40">
          <span className="hidden sm:inline">点击文字编辑 · 编辑态可删除</span>
          {query && (
            <button onClick={onClearQuery} className="text-secondary hover:text-secondary/80">
              清除搜索
            </button>
          )}
        </span>
      </div>

      {/* 主体 */}
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
      ) : (
        <div className="rounded-xl bg-surface-container/60 border border-outline-variant/15 px-6 py-5 leading-[2] text-base text-on-surface">
          {visible.map((entry, i) => {
            const isEditing = editingId === entry.id
            return (
              <Fragment key={entry.id}>
                {isEditing ? (
                  <span className="inline-flex items-center gap-1 align-middle">
                    <input
                      ref={editRef}
                      autoFocus
                      spellCheck={false}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      value={editDraft}
                      onChange={e => { setEditDraft(e.target.value); if (editError) setEditError(null) }}
                      onKeyDown={e => {
                        if (e.nativeEvent.isComposing) return
                        if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
                        else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
                      }}
                      onBlur={commitEdit}
                      style={{ width: `${Math.min(Math.max(editDraft.length + 2, 6), 60)}ch` }}
                      className={`rounded px-1.5 py-0.5 text-base text-on-surface focus:outline-none ${
                        editError
                          ? 'bg-error/10 border border-error/50 focus:ring-1 focus:ring-error/40'
                          : 'bg-secondary/10 border border-secondary/40 focus:ring-1 focus:ring-secondary/40'
                      }`}
                      title={editError ?? undefined}
                    />
                    <button
                      type="button"
                      onMouseDown={e => e.preventDefault() /* 不让 input blur，否则 click 拿不到 */}
                      onClick={() => deleteEntry(entry.id)}
                      title="删除这条记录"
                      className="inline-flex items-center justify-center w-6 h-6 rounded-md text-on-surface-variant/60 hover:text-error hover:bg-error/15 transition-colors"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
                    </button>
                    {editError && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-label text-error align-middle">
                        <span className="material-symbols-outlined" style={{ fontSize: 12 }}>error</span>
                        {editError}
                      </span>
                    )}
                  </span>
                ) : (
                  <span
                    onClick={() => startEdit(entry)}
                    className="cursor-text rounded px-1 -mx-0.5 hover:bg-secondary/15 hover:ring-1 hover:ring-secondary/30 transition-colors"
                    title="点击编辑"
                  >
                    <Highlight text={entry.text} query={query} />
                  </span>
                )}
                {i < visible.length - 1 && (
                  // CSS-rendered vertical bar instead of a punctuation char —
                  // 顿号 / 中点 / 斜杠 等都可能出现在条目文本里（例如标题
                  // 「お兄ちゃん、朝までずっとギュッてして！」），用纯视觉
                  // 分隔符避免跟内容混淆。
                  <span
                    aria-hidden
                    className="inline-block w-px h-3.5 bg-secondary/40 mx-2.5 align-middle select-none"
                  />
                )}
              </Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
})

export default LogView
