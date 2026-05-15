// 追番列表的"按类型过滤"组件 —— 一个 button + anchored popover。
//
// 设计目标：替代 BGM 站点上那种原生 `<select>` 的丑下拉，提供：
//   - **多选**（BGM 只能单选 7 个站点级类型）
//   - **可搜**（番剧多了 tag 也多，几十上百个时打字过滤一下）
//   - **命中数显示**（每个 tag 旁标"有几部番带这个 tag"，决定要不要选）
//   - **AND 语义**（外层 filter pipeline 实现；本组件只管选择，传 selected 数组）
//
// 不用 ModalShell —— 那个是全屏 backdrop 弹窗，按钮旁边一个小过滤器走不到那种
// 量级。这里手写 anchored dropdown：fixed backdrop 截点击 + absolute 浮层挂在
// 触发按钮的相对父容器下。
//
// 高频 tag 沉底排序 —— 命中数最多的排在最上面，用户日常用的就那几个，常用项
// 不需要每次都搜。

import { useMemo, useRef, useState, useEffect } from 'react'

interface TagWithCount {
  tag: string
  /** 这个 tag 出现在多少个 track 里（bgmTags + userTags 合并去重后计数）。 */
  count: number
}

interface Props {
  /** 已经按命中数排好序的全部 tag 列表。 */
  allTags: TagWithCount[]
  /** 当前选中的 tag（外层 filter pipeline 用 AND 逻辑过滤）。 */
  selected: string[]
  onChange: (next: string[]) => void
}

export function TagFilter({ allTags, selected, onChange }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      // 打开 popover 自动 focus 搜索框 —— 用户大概率是想"找某个 tag"才点开
      setTimeout(() => searchRef.current?.focus(), 0)
    } else {
      setQuery('')
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return allTags
    return allTags.filter(({ tag }) => tag.toLowerCase().includes(q))
  }, [allTags, query])

  // 已选 tag 放到列表顶部 —— 用户打开 popover 主要是 "看看选了啥 / 加 / 减"，
  // 把选中项沉到底找起来累。这里 reorder 不动外面的 sorted 数组。
  const ordered = useMemo(() => {
    const selSet = new Set(selected)
    const pinned: TagWithCount[] = []
    const rest: TagWithCount[] = []
    for (const t of filtered) {
      if (selSet.has(t.tag)) pinned.push(t)
      else rest.push(t)
    }
    return [...pinned, ...rest]
  }, [filtered, selected])

  const toggle = (tag: string): void => {
    if (selected.includes(tag)) onChange(selected.filter(t => t !== tag))
    else onChange([...selected, tag])
  }

  const clearAll = (): void => {
    onChange([])
  }

  const hasSelection = selected.length > 0

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title={hasSelection ? `按 ${selected.length} 个类型过滤（AND）` : '按动漫类型过滤'}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border font-label text-[10px] uppercase tracking-widest transition-colors ${
          hasSelection
            ? 'bg-primary/15 text-primary border-primary/30 font-bold'
            : 'bg-surface-container text-on-surface-variant/70 border-outline-variant/20 hover:text-on-surface hover:bg-surface-container-high'
        }`}
      >
        <span
          className="material-symbols-outlined leading-none"
          style={{ fontSize: 14, fontVariationSettings: hasSelection ? "'FILL' 1" : "'FILL' 0" }}
        >
          tune
        </span>
        <span>类型</span>
        {hasSelection && (
          <span className="font-mono text-[10px] bg-primary/20 text-primary px-1 rounded">
            {selected.length}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Click-outside backdrop —— fixed 覆盖整个 viewport 但完全透明,
              点任意位置（除 popover 内部）即关闭。 */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          {/* Popover panel —— absolute 挂在按钮下方右对齐 */}
          <div className="absolute right-0 top-full mt-2 z-50 w-[320px] bg-surface-container-high border border-outline-variant/20 rounded-xl shadow-2xl shadow-black/30 overflow-hidden">
            {/* Header: 搜索 tag */}
            <div className="p-3 border-b border-outline-variant/15 bg-surface-container-low">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-container rounded-md border border-outline-variant/15 focus-within:border-primary/40 transition-colors">
                <span className="material-symbols-outlined text-on-surface-variant/45" style={{ fontSize: 14 }}>search</span>
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}
                  placeholder="搜动漫类型…"
                  spellCheck={false}
                  className="flex-1 bg-transparent outline-none text-xs text-on-surface placeholder:text-on-surface-variant/35"
                />
                {query && (
                  <button
                    onClick={() => setQuery('')}
                    className="text-on-surface-variant/40 hover:text-on-surface"
                  >
                    <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>close</span>
                  </button>
                )}
              </div>
            </div>

            {/* Tag list */}
            <div className="overflow-y-auto max-h-[360px] py-1">
              {allTags.length === 0 ? (
                <div className="px-4 py-8 text-center text-on-surface-variant/40 font-label text-[11px]">
                  追番列表里还没有任何标签
                </div>
              ) : ordered.length === 0 ? (
                <div className="px-4 py-8 text-center text-on-surface-variant/40 font-label text-[11px]">
                  没匹配到「{query}」
                </div>
              ) : (
                ordered.map(({ tag, count }) => {
                  const checked = selected.includes(tag)
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggle(tag)}
                      className={`w-full flex items-center gap-2.5 px-4 py-2 text-left transition-colors ${
                        checked
                          ? 'bg-primary/10 hover:bg-primary/15'
                          : 'hover:bg-surface-container-highest'
                      }`}
                    >
                      <span
                        className={`material-symbols-outlined leading-none shrink-0 ${
                          checked ? 'text-primary' : 'text-on-surface-variant/30'
                        }`}
                        style={{ fontSize: 16, fontVariationSettings: checked ? "'FILL' 1" : "'FILL' 0" }}
                      >
                        {checked ? 'check_box' : 'check_box_outline_blank'}
                      </span>
                      <span
                        className={`flex-1 min-w-0 text-xs truncate ${
                          checked ? 'text-primary font-bold' : 'text-on-surface'
                        }`}
                      >
                        {tag}
                      </span>
                      <span className="font-mono text-[10px] text-on-surface-variant/40 shrink-0">
                        {count}
                      </span>
                    </button>
                  )
                })
              )}
            </div>

            {/* Footer: clear all */}
            {hasSelection && (
              <div className="p-2 border-t border-outline-variant/15 bg-surface-container-low flex items-center justify-between">
                <span className="font-label text-[10px] text-on-surface-variant/55 px-2">
                  已选 {selected.length} 个 · AND 匹配
                </span>
                <button
                  type="button"
                  onClick={clearAll}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-on-surface-variant/60 hover:text-error hover:bg-error/10 font-label text-[10px] uppercase tracking-widest transition-colors"
                >
                  <span className="material-symbols-outlined leading-none" style={{ fontSize: 12 }}>backspace</span>
                  <span>清空</span>
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
