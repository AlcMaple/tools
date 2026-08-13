// 「添加观看源」弹窗 —— 自由粘贴任意 URL 作为额外的跳转链接。
//
// 三个内置源已经由搜索关联流程覆盖,这里给的是真正自由格式的入口:一个标题(chip 上的显示文字)
// + 一个 URL,就这两个字段。
// 写出的 binding 固定 `source: 'Custom'`,`sourceTitle` 兼任 chip 的显示标签。

import { useState } from 'react'
import { ModalShell } from '../pages/homework/shared'
import type { AnimeBinding } from '../stores/animeTrackStore'

interface Props {
  /** 显示在标题栏,让用户知道正在给哪部番加链接。 */
  animeTitle: string
  /** 已有的 binding,只用于保存时按 URL 去重。 */
  existing: AnimeBinding[]
  onClose: () => void
  onConfirm: (binding: AnimeBinding) => void
}

export function AddBindingModal({ animeTitle, existing, onClose, onConfirm }: Props): JSX.Element {
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  const trimmedLabel = label.trim()
  const trimmedUrl = url.trim()
  const canSave = trimmedLabel.length > 0 && trimmedUrl.length > 0

  const submit = (): void => {
    if (!canSave) return

    // 只接受 http/https —— 否则会打开 `about:` / `file:` 这类 URL,既是隐私泄漏,也几乎总是笔误。
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      setError('链接必须以 http:// 或 https:// 开头')
      return
    }

    // 只按 sourceKey 去重:同一个 URL 不会被绑两次
    if (existing.some(b => b.sourceKey.trim() === trimmedUrl)) {
      setError('已经添加过这个链接了')
      return
    }

    onConfirm({
      source: 'Custom',
      sourceTitle: trimmedLabel,
      sourceKey: trimmedUrl,
      sourceUrl: trimmedUrl,
    })
  }

  return (
    <ModalShell onBackdrop={onClose}>
      {/* Header */}
      <div className="flex items-center gap-4 px-7 pt-6 pb-5 border-b border-outline-variant/10">
        <div className="w-11 h-11 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center flex-shrink-0">
          <span
            className="material-symbols-outlined text-primary text-[22px]"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            add_link
          </span>
        </div>
        <div className="min-w-0">
          <h3 className="text-base font-black tracking-tight">添加观看源</h3>
          <p className="text-[11px] text-on-surface-variant/60 mt-0.5 font-label truncate" title={animeTitle}>
            为「{animeTitle}」绑定一个外部播放链接
          </p>
        </div>
      </div>

      <div className="px-7 py-5 space-y-4">
        {/* 标题 */}
        <div>
          <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-2 block">
            标题 <span className="text-primary/60 normal-case tracking-normal">（显示在 chip 上，例：B 站 / AGE 动漫）</span>
          </label>
          <input
            type="text"
            value={label}
            onChange={e => { setLabel(e.target.value); setError(null) }}
            placeholder="例: B 站 / AGE 动漫 / 我的网盘"
            maxLength={20}
            autoFocus
            spellCheck={false}
            className="w-full bg-surface-container border border-outline-variant/20 rounded-lg px-4 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/35 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30 transition-all"
          />
        </div>

        {/* URL */}
        <div>
          <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-2 block">
            链接
          </label>
          <input
            type="url"
            value={url}
            onChange={e => { setUrl(e.target.value); setError(null) }}
            onKeyDown={e => { if (e.key === 'Enter' && canSave) submit() }}
            placeholder="https://..."
            spellCheck={false}
            className="w-full bg-surface-container border border-outline-variant/20 rounded-lg px-4 py-2.5 text-sm font-mono text-on-surface placeholder:text-on-surface-variant/35 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30 transition-all"
          />
          <p className="mt-1.5 font-label text-[10px] text-on-surface-variant/40">
            把番剧播放页的网址复制过来。加好后可在「在线观看」里应用内直接播放,用站点自己的播放器和剧集列表;卡片上的 chip 仍在浏览器打开。
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg border border-error/30 bg-error/[0.08] px-3 py-2 flex items-start gap-2">
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
          onClick={submit}
          disabled={!canSave}
          className="flex-1 py-3 rounded-xl border border-primary/40 bg-primary/10 text-primary font-bold text-sm hover:bg-primary/20 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span className="material-symbols-outlined text-base leading-none">add_link</span>
          添加
        </button>
      </div>
    </ModalShell>
  )
}
