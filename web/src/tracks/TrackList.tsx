import type { SourceId, Track, WatchMode } from '../api'
import { Ic } from '../SketchIcon'
import { ContinueWatchAction } from './TrackCard'
import { watchEp } from './common'

// ── 列表行（只读速览）────────────────────────────────────────────────────────
// 列表只负责让用户快速扫过追番，不提供改集数 / 改状态 / 改最爱等编辑控件。
// 三个按钮仍沿用卡片上的入口：继续看、BGM、好看集。
export function TrackListRow({
  t,
  boundSources,
  locating,
  onContinue,
  onMarkGood,
}: {
  t: Track
  boundSources: Set<SourceId>
  locating: boolean
  onContinue: (source: SourceId, mode: WatchMode) => void
  onMarkGood: () => void
}): JSX.Element {
  const title = t.titleCn || t.title
  const ep = watchEp(t)
  const episodeLabel = t.status === 'considering'
    ? '还没开动'
    : t.totalEpisodes != null
      ? `EP ${ep} / ${t.totalEpisodes}`
      : `EP ${ep}`

  return (
    <article className={`trk-list-row${t.status === 'considering' ? ' is-considering' : ''}`}>
      <span className={`tape tr ${t.status === 'considering' ? 'lav' : 'teal'}`} aria-hidden="true" />
      <div className="trk-list-main">
        <div className="trk-list-title" title={title}>{title}</div>
        <div className="trk-list-meta">
          <span className="trk-list-ep">{episodeLabel}</span>
          <FavoriteDisplay value={t.favorite} />
        </div>
      </div>

      <div className="trk-list-actions">
        <ContinueWatchAction
          label={t.status === 'considering' ? '试看一集' : '继续看'}
          ep={ep}
          boundSources={boundSources}
          locating={locating}
          onPick={onContinue}
        />
        <a
          className="btn btn-sm btn-ghost"
          href={`https://bgm.tv/subject/${t.bgmId}`}
          target="_blank"
          rel="noreferrer"
          title="在 Bangumi 查看详情"
        >
          <Ic name="external" cls="ic ic-sm" />
          BGM
        </a>
        <button
          type="button"
          className={`btn btn-sm btn-ghost${t.goodEpisodes.length > 0 ? ' ge-trigger-on' : ''}`}
          onClick={onMarkGood}
          title={t.goodEpisodes.length > 0 ? `已标 ${t.goodEpisodes.length} 集好看` : '标记好看集'}
        >
          <Ic name="star" cls="ic ic-sm" />
          {t.goodEpisodes.length > 0 ? t.goodEpisodes.length : '好看集'}
        </button>
      </div>
    </article>
  )
}

function FavoriteDisplay({ value }: { value: number }): JSX.Element {
  const level = Number.isFinite(value) ? Math.min(6, Math.max(0, Math.floor(value))) : 0
  return (
    <span className="trk-list-favorite" role="img" aria-label={`最爱程度 ${level}/6`}>
      <span className="fav-hearts fav-hearts-readonly" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={`fav-heart${i < level ? ' on' : ''}`}>
            <Ic name="heart" cls="ic ic-sm" />
          </span>
        ))}
      </span>
      <span className="trk-list-favorite-value">{level}/6</span>
    </span>
  )
}
