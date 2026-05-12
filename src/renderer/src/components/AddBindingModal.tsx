// 「添加观看源」弹窗 —— 自由粘贴任意 URL 作为额外的跳转链接。
//
// 触发场景：用户在 MyAnime 行尾点「+ 添加链接」时打开。SearchDownload 的
// 关联追番 + MyAnime 的「+ 搜 X」入口已经覆盖三个内置源；这里给的是真正
// "自由格式"的入口 —— 用户填一个标题（chip 显示文字）+ URL，就这两个字段。
//
// 写出的 binding：
//   { source: 'Custom', sourceKey: url, sourceUrl: url, sourceTitle: label }
// 始终 source='Custom'，sourceTitle 兼任 chip 显示标签 —— WatchHere 看到
// Custom 来源会优先用 sourceTitle 渲染 chip 名称。

import { useState } from 'react'
import { ModalShell } from '../pages/homework/shared'
import type { AnimeBinding } from '../stores/animeTrackStore'

interface Props {
  /** Shown in the header so the user knows which anime they're binding to. */
  animeTitle: string
  /** Existing bindings — used only to dedup by URL on save. */
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

    // URL hygiene — `http://`/`https://` only; otherwise we'd open `about:` /
    // `file:` URLs which is a privacy leak (and 99% of the time it's a typo).
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      setError('链接必须以 http:// 或 https:// 开头')
      return
    }

    // Dedup on sourceKey only — same URL is never linked twice regardless
    // of label. (Different labels pointing at same URL would be confusing.)
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
            把网址栏复制过来即可。chip 点击会在外部浏览器打开这个链接。
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
