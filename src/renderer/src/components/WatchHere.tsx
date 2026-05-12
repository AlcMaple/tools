// 跳转按钮组件 — 给定 BGM id，列出此番已绑定的源，每个源一个按钮，
// 点击即在外部浏览器打开对应详情页。
//
// 设计取舍：
// - 不为每个源调 API 算「ep N+1」的具体播放页 URL —— 那会需要 watchInfo 全量
//   抓取一遍，重得离谱。直接打开源详情页（已绑定的 sourceKey/sourceUrl），
//   用户在那里手动选下一集。组件用 chip 上的 "ep N" 提醒用户进度。
// - 没有绑定时 (bindings 空) 返回 null —— 让父组件来决定是否显示「先去关联」。
//
// 三个变种：
// - 默认 `variant="row"` 横向 chips，适合 AnimeInfo 左栏 / Calendar 卡 hover。
// - `variant="inline"` 紧凑横排，适合 MyAnime 行尾。

import { useEffect, useRef } from 'react'
import type { AnimeBinding, AnimeTrack } from '../stores/animeTrackStore'
import { animeTrackStore, useAnimeTrack } from '../stores/animeTrackStore'

interface Props {
  bgmId: number
  variant?: 'row' | 'inline'
  /** When true, show the "no bindings yet" placeholder instead of returning null. */
  showEmpty?: boolean
  /**
   * When true, switch all chips into "edit mode":
   *   - chip body becomes non-clickable (no navigation on click)
   *   - a prominent ✕ button is added per chip
   * 配合外部的「编辑 / 完成」开关使用 —— 默认状态下用户点 chip 就跳转,
   * 想删除必须先主动进入编辑模式，杜绝跳转和删除按钮挨着误点的风险。
   */
  editing?: boolean
  /** Called when ✕ is clicked (only in edit mode). */
  onRemove?: (binding: AnimeBinding) => void
}

export function WatchHere({ bgmId, variant = 'row', showEmpty = false, editing = false, onRemove }: Props): JSX.Element | null {
  const track = useAnimeTrack(bgmId)
  useAowuShareUrlBackfill(bgmId, track)
  if (!track || track.bindings.length === 0) {
    return showEmpty ? <EmptyPlaceholder /> : null
  }
  return (
    <div className={variant === 'inline'
      ? 'inline-flex flex-wrap items-center gap-1.5'
      : 'flex flex-wrap items-center gap-2'}
    >
      {track.bindings.map((b, i) => (
        <SourceButton
          key={`${b.source}-${i}`}
          binding={b}
          track={track}
          variant={variant}
          editing={editing}
          onRemove={editing && onRemove ? () => onRemove(b) : undefined}
        />
      ))}
    </div>
  )
}

/**
 * Lazy migration: bindings created before the Aowu URL resolver landed store
 * the synthetic /v/{id} URL as sourceKey with no sourceUrl. On first render
 * of any WatchHere with such a binding, we silently call resolveShareUrl
 * once per (bgmId, sourceKey) and patch the binding via the store. The
 * `attemptedRef` guard prevents re-trying within the same session if the
 * backfill failed (e.g. network down) — next app restart will try again.
 *
 * After backfill, sourceUrl points at /w/{token} and the chip's `<a href>`
 * lands the user on the real watch page. No flicker since the patch happens
 * via store.subscribe — the chip re-renders with the new href in place.
 */
const attemptedAowuBackfill = new Set<string>()

function useAowuShareUrlBackfill(bgmId: number, track: AnimeTrack | null): void {
  const attemptedRef = useRef(false)
  useEffect(() => {
    if (attemptedRef.current) return
    if (!track) return
    const needsFix = track.bindings.filter(b =>
      b.source === 'Aowu' && !b.sourceUrl && /\/v\/\d+/.test(b.sourceKey)
    )
    if (needsFix.length === 0) return
    attemptedRef.current = true

    for (const b of needsFix) {
      const guardKey = `${bgmId}:${b.sourceKey}`
      if (attemptedAowuBackfill.has(guardKey)) continue
      attemptedAowuBackfill.add(guardKey)
      void window.aowuApi.resolveShareUrl(b.sourceKey)
        .then(url => {
          if (url) animeTrackStore.setBindingSourceUrl(bgmId, b.source, b.sourceKey, url)
        })
        .catch(err => {
          // Leave it broken for this session — next launch will retry. Logging
          // here keeps the failure debuggable without spamming a toast.
          console.warn(`[WatchHere] aowu sourceUrl backfill failed for ${b.sourceKey}:`, err)
        })
    }
  }, [bgmId, track])
}

/**
 * Chip display label. For built-in scraped sources (Aowu/Xifan/Girigiri) we
 * trust the source enum. For Bilibili/Custom — where the binding came from
 * AddBindingModal — `sourceTitle` is the user-chosen label and gets priority
 * because "Custom" alone is meaningless on screen.
 */
function chipLabel(b: AnimeBinding): string {
  if (b.source === 'Custom') return b.sourceTitle || '自定义'
  if (b.source === 'Bilibili') return b.sourceTitle || 'B 站'
  return b.source
}

// ── Per-source button ───────────────────────────────────────────────────────

function SourceButton({
  binding, track, variant, editing = false, onRemove,
}: {
  binding: AnimeBinding
  track: AnimeTrack
  variant: 'row' | 'inline'
  editing?: boolean
  onRemove?: () => void
}): JSX.Element {
  // Prefer the explicit sourceUrl when provided; fall back to the per-source
  // computation. For Aowu/Xifan/Girigiri the sourceKey IS the watch URL.
  const url = resolveUrl(binding)
  // 只在 episode > 0 时显示集数；尚未开始看（episode = 0）就不显示
  // 任何额外文字，避免 "从头开始" 这种冗余 chip 字段。
  const epText =
    track.episode > 0
      ? track.totalEpisodes
        ? `ep ${track.episode}/${track.totalEpisodes}`
        : `ep ${track.episode}`
      : ''
  const label = chipLabel(binding)

  // Inline variant (MyAnime / Calendar) - 紧凑款。
  if (variant === 'inline') {
    if (editing && onRemove) {
      // 编辑模式：chip body 不再是 <a>，整体改色调成 error，强制
      // 移除是显式动作（点 chip 任何地方都触发删除，要求用户先点
      // 上方的"编辑"显式进入这个状态）。
      return (
        <button
          type="button"
          onClick={onRemove}
          title={`移除：${binding.sourceTitle || label}`}
          className="inline-flex items-stretch overflow-hidden rounded-md border border-error/40 bg-error/10 hover:bg-error/20 transition-colors"
        >
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-error font-label text-[10px] tracking-wider">
            <span className="material-symbols-outlined leading-none" style={{ fontSize: 11 }}>delete</span>
            <span className="font-bold">{label}</span>
            {epText && <span className="text-error/70">{epText}</span>}
          </span>
        </button>
      )
    }
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={`${label} · ${binding.sourceTitle || ''}\n${url}`}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-primary/30 bg-primary/8 hover:bg-primary/15 text-primary font-label text-[10px] tracking-wider transition-colors"
      >
        <span className="material-symbols-outlined leading-none" style={{ fontSize: 11 }}>play_arrow</span>
        <span className="font-bold">{label}</span>
        {epText && <span className="text-primary/60">{epText}</span>}
      </a>
    )
  }

  // Row variant (AnimeInfo) - 大款。
  if (editing && onRemove) {
    return (
      <button
        type="button"
        onClick={onRemove}
        title={`移除：${binding.sourceTitle || label}`}
        className="inline-flex items-stretch overflow-hidden rounded-lg border border-error/40 bg-error/10 hover:bg-error/20 transition-colors"
      >
        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-error font-label text-[11px] uppercase tracking-widest">
          <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>delete</span>
          <span className="font-bold">{label}</span>
          {epText && (
            <>
              <span className="text-error/55">·</span>
              <span className="text-error/75 tracking-wider">{epText}</span>
            </>
          )}
        </span>
      </button>
    )
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`${binding.sourceTitle || label}\n${url}`}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/25 bg-primary/8 hover:bg-primary/15 hover:border-primary/45 text-primary font-label text-[11px] uppercase tracking-widest transition-colors"
    >
      <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>play_arrow</span>
      <span className="font-bold">{label}</span>
      {epText && (
        <>
          <span className="text-primary/55">·</span>
          <span className="text-primary/75 tracking-wider">{epText}</span>
        </>
      )}
    </a>
  )
}

// ── Placeholder when track has no bindings ───────────────────────────────────

function EmptyPlaceholder(): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-on-surface-variant/40 font-label text-[10px] uppercase tracking-widest">
      <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>link_off</span>
      <span>未关联源 · 去 Search 关联</span>
    </div>
  )
}

// ── URL resolver ─────────────────────────────────────────────────────────────

function resolveUrl(b: AnimeBinding): string {
  if (b.sourceUrl) return b.sourceUrl
  const k = b.sourceKey.trim()
  if (!k) return ''
  // Aowu / Xifan / Girigiri — sourceKey is the show URL (watch_url / play_url).
  // SearchDownload writes these as full URLs starting with https://.
  if (/^https?:\/\//.test(k)) return k
  // Bilibili / Custom — assume the user pasted a partial path; let it through
  // verbatim and trust the browser to error if it's malformed.
  return k
}
