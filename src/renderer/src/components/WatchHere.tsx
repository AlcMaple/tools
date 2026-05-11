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

import type { AnimeBinding, AnimeTrack } from '../stores/animeTrackStore'
import { useAnimeTrack } from '../stores/animeTrackStore'

interface Props {
  bgmId: number
  variant?: 'row' | 'inline'
  /** When true, show the "no bindings yet" placeholder instead of returning null. */
  showEmpty?: boolean
  /** When provided, each chip grows a hover-✕ button that calls this. */
  onRemove?: (binding: AnimeBinding) => void
}

export function WatchHere({ bgmId, variant = 'row', showEmpty = false, onRemove }: Props): JSX.Element | null {
  const track = useAnimeTrack(bgmId)
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
          onRemove={onRemove ? () => onRemove(b) : undefined}
        />
      ))}
    </div>
  )
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
  binding, track, variant, onRemove,
}: {
  binding: AnimeBinding
  track: AnimeTrack
  variant: 'row' | 'inline'
  onRemove?: () => void
}): JSX.Element {
  // Prefer the explicit sourceUrl when provided; fall back to the per-source
  // computation. For Aowu/Xifan/Girigiri the sourceKey IS the watch URL.
  const url = resolveUrl(binding)
  const epText = track.episode > 0
    ? track.totalEpisodes
      ? `ep ${track.episode}/${track.totalEpisodes}`
      : `ep ${track.episode}`
    : '从头开始'
  const label = chipLabel(binding)

  // Wrap chip + ✕ in a single flex container when removable. Container has
  // group-hover scoping so ✕ stays hidden until the row is hovered.
  if (variant === 'inline') {
    return (
      <span className="group inline-flex items-stretch overflow-hidden rounded-md border border-primary/30 bg-primary/8 hover:bg-primary/15 transition-colors">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          title={`${label} · ${binding.sourceTitle || ''}\n${url}`}
          className="inline-flex items-center gap-1 px-2 py-0.5 text-primary font-label text-[10px] tracking-wider"
        >
          <span className="material-symbols-outlined leading-none" style={{ fontSize: 11 }}>play_arrow</span>
          <span className="font-bold">{label}</span>
          <span className="text-primary/60">{epText}</span>
        </a>
        {onRemove && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove() }}
            tabIndex={-1}
            title="移除此链接"
            className="px-1 flex items-center text-primary/45 hover:text-error hover:bg-error/12 opacity-0 group-hover:opacity-100 transition-all border-l border-primary/20"
          >
            <span className="material-symbols-outlined leading-none" style={{ fontSize: 11 }}>close</span>
          </button>
        )}
      </span>
    )
  }

  return (
    <span className="group inline-flex items-stretch overflow-hidden rounded-lg border border-primary/25 bg-primary/8 hover:bg-primary/15 hover:border-primary/45 transition-colors">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={`${binding.sourceTitle || label}\n${url}`}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-primary font-label text-[11px] uppercase tracking-widest"
      >
        <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>play_arrow</span>
        <span className="font-bold">{label}</span>
        <span className="text-primary/55">·</span>
        <span className="text-primary/75 tracking-wider">{epText}</span>
      </a>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          tabIndex={-1}
          title="移除此链接"
          className="px-1.5 flex items-center text-primary/45 hover:text-error hover:bg-error/12 opacity-0 group-hover:opacity-100 transition-all border-l border-primary/20"
        >
          <span className="material-symbols-outlined leading-none" style={{ fontSize: 13 }}>close</span>
        </button>
      )}
    </span>
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
