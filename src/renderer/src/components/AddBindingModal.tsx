// 「添加观看源」弹窗 — 自由粘贴任意 URL 作为额外的跳转链接。
//
// 触发场景：用户在 MyAnime 行尾点「+ 添加观看源」时打开。SearchDownload 的
// 关联追番只能选 Aowu/Xifan/Girigiri 三个内置源；这里覆盖剩下的：
//   - B 站番剧链接 (https://www.bilibili.com/bangumi/play/ssXXXXX/)
//   - AGE / 漫域 / 其他网站
//   - 任意自定义 URL
//
// 写出的 binding：
//   { source: 'Bilibili' | 'Custom', sourceKey: url, sourceUrl: url, sourceTitle: label }
// 其中 sourceTitle 双重身份兼任 chip 显示标签 —— WatchHere 看到 Custom 来源
// 时优先用 sourceTitle 渲染 chip 名称，因为 'Custom' 本身没有可读含义。

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

// 来源 preset。'Custom' 让用户自己取名。
type Preset = 'Bilibili' | 'Custom'

const PRESETS: ReadonlyArray<{ key: Preset; label: string; hint: string; icon: string }> = [
  { key: 'Bilibili', label: 'B 站', hint: 'bilibili.com/bangumi/play/...', icon: 'smart_display' },
  { key: 'Custom',   label: '自定义', hint: '其他网站任意链接', icon: 'link' },
]

export function AddBindingModal({ animeTitle, existing, onClose, onConfirm }: Props): JSX.Element {
  const [preset, setPreset] = useState<Preset>('Bilibili')
  const [url, setUrl] = useState('')
  const [customLabel, setCustomLabel] = useState('')
  const [error, setError] = useState<string | null>(null)

  const trimmedUrl = url.trim()
  const trimmedLabel = customLabel.trim()
  // For Custom we require both a label and a URL; Bilibili uses a fixed label.
  const canSave =
    trimmedUrl.length > 0 &&
    (preset !== 'Custom' || trimmedLabel.length > 0)

  const submit = (): void => {
    if (!canSave) return

    // URL hygiene — `http://`/`https://` only; otherwise we'd open `about:` /
    // `file:` URLs which is a privacy leak (and 99% of the time it's a typo).
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      setError('链接必须以 http:// 或 https:// 开头')
      return
    }

    const source: AnimeBinding['source'] = preset
    const label = preset === 'Bilibili' ? 'B 站' : trimmedLabel

    // Dedup on (source, sourceKey) — prevents double-paste of the same URL.
    if (existing.some(b => b.source === source && b.sourceKey.trim() === trimmedUrl)) {
      setError('已经添加过这个链接了')
      return
    }

    onConfirm({
      source,
      sourceTitle: label,
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
        {/* Source preset */}
        <div>
          <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-2 block">
            来源类型
          </label>
          <div className="grid grid-cols-2 gap-2">
            {PRESETS.map(p => {
              const active = preset === p.key
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => { setPreset(p.key); setError(null) }}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border transition-colors text-left ${
                    active
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-outline-variant/20 bg-surface-container text-on-surface-variant/70 hover:bg-surface-container-high'
                  }`}
                >
                  <span
                    className="material-symbols-outlined leading-none"
                    style={{ fontSize: 18, fontVariationSettings: active ? "'FILL' 1" : "'FILL' 0" }}
                  >
                    {p.icon}
                  </span>
                  <div className="min-w-0">
                    <p className="font-bold text-sm">{p.label}</p>
                    <p className={`font-label text-[10px] truncate ${active ? 'text-primary/60' : 'text-on-surface-variant/40'}`}>
                      {p.hint}
                    </p>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Custom label — only shown for the 自定义 preset */}
        {preset === 'Custom' && (
          <div>
            <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-2 block">
              标签 <span className="text-primary/60 normal-case tracking-normal">（显示在 chip 上）</span>
            </label>
            <input
              type="text"
              value={customLabel}
              onChange={e => { setCustomLabel(e.target.value); setError(null) }}
              placeholder="例: AGE 动漫 / 漫域 / 我的网盘"
              maxLength={20}
              autoFocus
              spellCheck={false}
              className="w-full bg-surface-container border border-outline-variant/20 rounded-lg px-4 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/35 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30 transition-all"
            />
          </div>
        )}

        {/* URL */}
        <div>
          <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-2 block">
            链接 <span className="text-error/80 normal-case tracking-normal">必填</span>
          </label>
          <input
            type="url"
            value={url}
            onChange={e => { setUrl(e.target.value); setError(null) }}
            onKeyDown={e => { if (e.key === 'Enter' && canSave) submit() }}
            placeholder={preset === 'Bilibili' ? 'https://www.bilibili.com/bangumi/play/ss12345' : 'https://...'}
            autoFocus={preset !== 'Custom'}
            spellCheck={false}
            className="w-full bg-surface-container border border-outline-variant/20 rounded-lg px-4 py-2.5 text-sm font-mono text-on-surface placeholder:text-on-surface-variant/35 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30 transition-all"
          />
          <p className="mt-1.5 font-label text-[10px] text-on-surface-variant/40">
            就把网址栏复制过来即可。chip 点击会在外部浏览器打开这个链接。
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
