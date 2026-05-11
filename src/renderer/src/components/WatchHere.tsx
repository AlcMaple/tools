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
}

export function WatchHere({ bgmId, variant = 'row', showEmpty = false }: Props): JSX.Element | null {
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
        <SourceButton key={`${b.source}-${i}`} binding={b} track={track} variant={variant} />
      ))}
    </div>
  )
}

// ── Per-source button ───────────────────────────────────────────────────────

function SourceButton({
  binding, track, variant,
}: {
  binding: AnimeBinding
  track: AnimeTrack
  variant: 'row' | 'inline'
}): JSX.Element {
  // Prefer the explicit sourceUrl when provided; fall back to the per-source
  // computation. For Aowu/Xifan/Girigiri the sourceKey IS the watch URL.
  const url = resolveUrl(binding)
  const epText = track.episode > 0
    ? track.totalEpisodes
      ? `ep ${track.episode}/${track.totalEpisodes}`
      : `ep ${track.episode}`
    : '从头开始'

  if (variant === 'inline') {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={`${binding.source} · ${binding.sourceTitle}\n${url}`}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-primary/30 bg-primary/8 hover:bg-primary/15 text-primary font-label text-[10px] tracking-wider transition-colors"
      >
        <span className="material-symbols-outlined leading-none" style={{ fontSize: 11 }}>play_arrow</span>
        <span className="font-bold">{binding.source}</span>
        <span className="text-primary/60">{epText}</span>
      </a>
    )
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`${binding.sourceTitle}\n${url}`}
      className="group inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/25 bg-primary/8 hover:bg-primary/15 hover:border-primary/45 text-primary font-label text-[11px] uppercase tracking-widest transition-colors"
    >
      <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>play_arrow</span>
      <span className="font-bold">{binding.source}</span>
      <span className="text-primary/55">·</span>
      <span className="text-primary/75 tracking-wider">{epText}</span>
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
