// 编辑用户手动添加的观看链接 —— **只管 Custom 一类**,内置四源(Xifan/Girigiri/Aowu/
// Bilibili)不出现在这里,它们都靠搜索流程绑定/改绑,是结构性数据,没有用户能手改的字段。
//
// 进来先把当前所有用户添加的 binding 拷一份到本地 state,每行可改标题 / URL、可标记删除
// 点保存才一次性 diff 回 store,取消或关弹窗则全部丢弃。
// 显式保存而不是 blur 自动保存:用户会在表单里反复改,边改边写会让外面的 chip 不停重渲跳动。

import { useState } from 'react'
import { ModalShell } from '../pages/homework/shared'
import type { AnimeBinding } from '../stores/animeTrackStore'

/**
 * 算作「用户手动添加、可在这里改标题/URL」的来源。**不含 'Bilibili'**——它现在靠搜索
 * 关联,想换视频走 MyAnime 行内的「换 B 站视频」重新搜一遍,不是在这改 URL(避免手滑改出
 * 一个不合法的 BV 链接)。老数据里若真存在 source:'Bilibili' 的 binding,不在这里编辑,
 * 但仍会正常显示/播放,只是改不了——用户可以在 MyAnime 上用「换 B 站视频」重新搜索覆盖。
 */
const USER_ADDED_SOURCES = new Set<AnimeBinding['source']>(['Custom'])

export function isUserAddedBinding(b: AnimeBinding): boolean {
  return USER_ADDED_SOURCES.has(b.source)
}

interface Props {
  animeTitle: string
  bindings: AnimeBinding[]
  onClose: () => void
  /** 把编辑结果应用回 store,具体怎么分发由调用方决定。 */
  onSave: (changes: BindingEdit[]) => void
}

/** 单条 binding 的编辑结果。弹窗关闭时调用方拿到一份列表,自己去调 store 的增删改。 */
export interface BindingEdit {
  /** 用 (source, sourceKey) 在 store 里定位原 binding。 */
  originalSource: AnimeBinding['source']
  originalSourceKey: string
  /** 'delete' 标记删除,'update' 标记字段变更。弹窗不发「无变化」的 update,减少噪声。 */
  kind: 'update' | 'delete'
  /** kind=update 时的新字段值。 */
  patch?: Partial<Pick<AnimeBinding, 'sourceTitle' | 'sourceKey' | 'sourceUrl'>>
}

/** 单行的本地编辑状态。 */
interface RowDraft {
  /** Frozen at modal open — used as the diff anchor / store key. */
  original: AnimeBinding
  /** Mutable form values. */
  title: string
  url: string
  deleted: boolean
}

export function EditBindingsModal({ animeTitle, bindings, onClose, onSave }: Props): JSX.Element {
  // 只有用户手动添加的 binding 可编辑;内置三源直接滤掉 —— 它们由搜索流程管理。
  const [rows, setRows] = useState<RowDraft[]>(() =>
    bindings
      .filter(isUserAddedBinding)
      .map(b => ({
        original: b,
        title: b.sourceTitle,
        url: b.sourceUrl || b.sourceKey,
        deleted: false,
      })),
  )
  const [error, setError] = useState<string | null>(null)

  const updateRow = (i: number, patch: Partial<RowDraft>): void => {
    setRows(prev => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
    setError(null)
  }

  const handleSave = (): void => {
    // 校验未标记删除那些行的 URL
    for (const r of rows) {
      if (r.deleted) continue
      if (!r.title.trim()) {
        setError(`「${r.original.sourceTitle || r.original.sourceKey}」的标题不能为空`)
        return
      }
      if (!/^https?:\/\//i.test(r.url.trim())) {
        setError(`「${r.title.trim()}」的链接必须以 http:// 或 https:// 开头`)
        return
      }
    }

    // 检出重复 URL,否则更新时会悄悄丢掉一条
    const seen = new Set<string>()
    for (const r of rows) {
      if (r.deleted) continue
      const k = r.url.trim()
      if (seen.has(k)) {
        setError(`链接「${k}」重复了，请合并或删除其中一条`)
        return
      }
      seen.add(k)
    }

    const changes: BindingEdit[] = []
    for (const r of rows) {
      const ref = {
        originalSource: r.original.source,
        originalSourceKey: r.original.sourceKey,
      }
      if (r.deleted) {
        changes.push({ ...ref, kind: 'delete' })
        continue
      }
      const newTitle = r.title.trim()
      const newUrl = r.url.trim()
      const titleChanged = newTitle !== r.original.sourceTitle
      const urlChanged = newUrl !== (r.original.sourceUrl || r.original.sourceKey)
      if (!titleChanged && !urlChanged) continue // noop
      const patch: BindingEdit['patch'] = {}
      if (titleChanged) patch.sourceTitle = newTitle
      if (urlChanged) {
        // Custom-source: sourceKey IS the URL; keep them in sync. Internal
        // 内置源不走这个弹窗,不用操心它们 sourceKey 的语义(那是站内 id、不是 URL)。
        patch.sourceKey = newUrl
        patch.sourceUrl = newUrl
      }
      changes.push({ ...ref, kind: 'update', patch })
    }
    onSave(changes)
  }

  const visibleRows = rows.filter(r => !r.deleted)

  return (
    <ModalShell onBackdrop={onClose}>
      {/* Header */}
      <div className="flex items-center gap-4 px-7 pt-6 pb-5 border-b border-outline-variant/10">
        <div className="w-11 h-11 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center flex-shrink-0">
          <span
            className="material-symbols-outlined text-primary text-[22px]"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            edit
          </span>
        </div>
        <div className="min-w-0">
          <h3 className="text-base font-black tracking-tight">编辑观看源</h3>
          <p className="text-[11px] text-on-surface-variant/60 mt-0.5 font-label truncate" title={animeTitle}>
            「{animeTitle}」的自定义播放链接
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="custom-scrollbar px-7 py-5 max-h-[60vh] overflow-y-auto">
        {visibleRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 gap-2 text-on-surface-variant/40">
            <span className="material-symbols-outlined text-3xl">link_off</span>
            <p className="font-label text-xs">没有可编辑的自定义链接</p>
            <p className="font-label text-[10px] text-on-surface-variant/30">
              内置三源（Aowu / Xifan / Girigiri）的绑定不在这里编辑
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {rows.map((r, i) => {
              if (r.deleted) return null
              return (
                <div
                  key={`${r.original.source}-${r.original.sourceKey}`}
                  className="rounded-lg border border-outline-variant/15 bg-surface-container/60 p-3 space-y-2"
                >
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0 space-y-2">
                      <div>
                        <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-1 block">
                          标题
                        </label>
                        <input
                          type="text"
                          value={r.title}
                          onChange={e => updateRow(i, { title: e.target.value })}
                          maxLength={20}
                          spellCheck={false}
                          className="w-full bg-surface-container border border-outline-variant/20 rounded-md px-3 py-1.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30 transition-all"
                        />
                      </div>
                      <div>
                        <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-1 block">
                          链接
                        </label>
                        <input
                          type="url"
                          value={r.url}
                          onChange={e => updateRow(i, { url: e.target.value })}
                          spellCheck={false}
                          className="w-full bg-surface-container border border-outline-variant/20 rounded-md px-3 py-1.5 text-xs font-mono text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30 transition-all"
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => updateRow(i, { deleted: true })}
                      title="删除这条链接"
                      className="shrink-0 w-8 h-8 mt-5 rounded-md flex items-center justify-center text-on-surface-variant/40 hover:text-error hover:bg-error/10 transition-colors"
                    >
                      <span className="material-symbols-outlined text-[16px] leading-none">delete</span>
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-lg border border-error/30 bg-error/[0.08] px-3 py-2 flex items-start gap-2">
            <span className="material-symbols-outlined text-error text-[16px] leading-none mt-px">error</span>
            <p className="font-label text-xs text-error flex-1">{error}</p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <button
          onClick={onClose}
          className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors"
        >
          取消
        </button>
        <button
          onClick={handleSave}
          disabled={visibleRows.length === 0 && rows.every(r => !r.deleted)}
          className="flex-1 py-3 rounded-xl border border-primary/40 bg-primary/10 text-primary font-bold text-sm hover:bg-primary/20 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span className="material-symbols-outlined text-base leading-none">check</span>
          保存
        </button>
      </div>
    </ModalShell>
  )
}
