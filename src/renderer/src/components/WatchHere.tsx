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
}

export function WatchHere({ bgmId, variant = 'row', showEmpty = false }: Props): JSX.Element | null {
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
          variant={variant}
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
  binding, variant,
}: {
  binding: AnimeBinding
  variant: 'row' | 'inline'
}): JSX.Element {
  // Prefer the explicit sourceUrl when provided; fall back to the per-source
  // computation. For Aowu/Xifan/Girigiri the sourceKey IS the watch URL.
  const url = resolveUrl(binding)
  // Chip 不再挂 ep 进度信息。所有源（内置三源 + 用户加的 Bilibili / Custom）
  // 点击跳转的都是**番剧主页**，永远不会自动定位到 ep N 的播放页 ——
  // 在 chip 上挂"ep 16/23"会让用户误以为点了能直接跳到第 16 集播放，
  // 是错的预期。进度显示统一交给 MyAnime 行里的 EpisodeCounter（那里才有
  // 编辑能力 + ±1 按钮），chip 自己只做"打开源"这一件事。
  const label = chipLabel(binding)

  // Chip 永远是纯跳转 <a>，没有删除按钮。删除入口集中在 MyAnime 的
  // EditBindingsModal 里（点行尾「编辑」按钮打开），物理隔离避免误删。
  if (variant === 'inline') {
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
      </a>
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
