import { useEffect, useMemo, useState } from 'react'
import {
  coverUrl,
  fetchAnimeReviews,
  fetchCommunityProfile,
  fetchCommunityReviewAnime,
  fetchCommunityUsers,
  type AnimeReviewsResult,
  type CommunityProfile,
  type CommunityReviewAnime,
  type CommunityUserSummary,
  type PublicTrack,
  type TrackStatus,
} from './api'
import { Ic, Spinner } from './SketchIcon'
import { PosterModal } from './reviews/PosterModal'
import type { PosterInput } from './reviews/poster'
import type { PosterScoreSignals } from '../shared/poster-score'
import type { ReviewMode } from './reviews/reviewsApi'

function posterInputFrom(opts: {
  bgmId: number
  title: string
  titleCn: string
  cover: string
  airDate: string
  mode: ReviewMode
  body: string
  spoiler: 'none' | 'aired' | 'all'
  score: number | null
  bgmScore?: number | null
  scoreSignals?: PosterScoreSignals
  tags: string[]
  publishedAt: number | null
  username: string
}): PosterInput {
  const titleCn = opts.titleCn || opts.title
  return {
    cover: opts.cover,
    titleCn,
    titleAlt: opts.title && opts.title !== titleCn ? opts.title : undefined,
    mode: opts.mode,
    body: opts.body,
    spoiler: opts.spoiler,
    userScore: opts.score != null && opts.score > 0 ? opts.score : undefined,
    scoreSignals: opts.scoreSignals,
    bgmScore: opts.bgmScore != null && opts.bgmScore > 0 ? opts.bgmScore : undefined,
    airDate: opts.airDate || undefined,
    tags: opts.tags,
    publishedAt: opts.publishedAt ?? undefined,
    serial: opts.bgmId,
    qrUrl: `${window.location.origin}/u/${encodeURIComponent(opts.username)}`,
    username: opts.username,
  }
}

type PublicFilter = 'all' | TrackStatus

const STATUS_LABEL: Record<TrackStatus, string> = {
  watching: '在追',
  plan: '想看',
  considering: '观望',
  done: '看完',
}

type CommunityRoute =
  | { kind: 'users' }
  | { kind: 'anime-list' }
  | { kind: 'anime'; bgmId: number }
  | { kind: 'profile'; username: string }

function parseCommunityRoute(): CommunityRoute {
  const hash = window.location.hash.replace(/^#\/?/, '').replace(/\/$/, '')
  if (hash === 'community/reviews') return { kind: 'anime-list' }
  const m = /^community\/reviews\/(\d+)$/.exec(hash)
  if (m) return { kind: 'anime', bgmId: Number(m[1]) }
  if (hash === 'community' || hash === 'community/') return { kind: 'users' }
  if (hash.startsWith('community/')) {
    const raw = hash.slice('community/'.length)
    if (raw) {
      try {
        return { kind: 'profile', username: decodeURIComponent(raw) }
      } catch {
        return { kind: 'users' }
      }
    }
  }
  if (!hash && (window.location.pathname === '/u' || window.location.pathname.startsWith('/u/'))) {
    const raw = window.location.pathname.slice('/u/'.length).replace(/\/$/, '')
    if (raw) {
      try {
        return { kind: 'profile', username: decodeURIComponent(raw) }
      } catch {
        return { kind: 'users' }
      }
    }
  }
  return { kind: 'users' }
}

function profileHref(username: string): string {
  return `/u/${encodeURIComponent(username)}`
}

export function CommunityPage(): JSX.Element {
  const [route, setRoute] = useState<CommunityRoute>(parseCommunityRoute)
  const [users, setUsers] = useState<CommunityUserSummary[] | null>(null)
  const [profile, setProfile] = useState<CommunityProfile | null>(null)
  const [animeList, setAnimeList] = useState<CommunityReviewAnime[] | null>(null)
  const [animeReviews, setAnimeReviews] = useState<AnimeReviewsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const sync = (): void => setRoute(parseCommunityRoute())
    window.addEventListener('hashchange', sync)
    window.addEventListener('popstate', sync)
    return () => {
      window.removeEventListener('hashchange', sync)
      window.removeEventListener('popstate', sync)
    }
  }, [])

  const routeKey = route.kind === 'profile' ? `p:${route.username}` : route.kind === 'anime' ? `a:${route.bgmId}` : route.kind

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    const fail = (fallback: string) => (err: unknown) => {
      if (alive) setError(err instanceof Error ? err.message : fallback)
    }
    const done = () => {
      if (alive) setLoading(false)
    }
    if (route.kind === 'profile') {
      setProfile(null)
      void fetchCommunityProfile(route.username).then((n) => alive && setProfile(n)).catch(fail('公开追番读取失败')).finally(done)
    } else if (route.kind === 'anime-list') {
      void fetchCommunityReviewAnime().then((n) => alive && setAnimeList(n)).catch(fail('点评列表读取失败')).finally(done)
    } else if (route.kind === 'anime') {
      setAnimeReviews(null)
      void fetchAnimeReviews(route.bgmId).then((n) => alive && setAnimeReviews(n)).catch(fail('这部番的点评读取失败')).finally(done)
    } else {
      void fetchCommunityUsers().then((r) => alive && setUsers(r.data)).catch(fail('追番大厅读取失败')).finally(done)
    }
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey])

  if (route.kind === 'profile') {
    return <ProfileView username={route.username} profile={profile} loading={loading} error={error} />
  }
  if (route.kind === 'anime') {
    return <AnimeReviewsView data={animeReviews} loading={loading} error={error} />
  }
  return (
    <HallView
      tab={route.kind === 'anime-list' ? 'anime' : 'users'}
      users={users}
      animeList={animeList}
      loading={loading}
      error={error}
    />
  )
}

function HallView({
  tab,
  users,
  animeList,
  loading,
  error,
}: {
  tab: 'users' | 'anime'
  users: CommunityUserSummary[] | null
  animeList: CommunityReviewAnime[] | null
  loading: boolean
  error: string | null
}): JSX.Element {
  return (
    <>
      <div className="spread" style={{ alignItems: 'flex-end' }}>
        <div>
          <h1 className="title-sketch" style={{ fontSize: 34 }}>追番大厅</h1>
          <p className="muted small mt8">哼，来看看大家的追番手帐吧，说不定能捡到下一部想看的番。</p>
        </div>
        <span className="tagx mine"><Ic name="eye" cls="ic ic-sm" /> 纱雾只翻公开的手帐</span>
      </div>

      <div className="tabf-row community-tabs mt16">
        <a className={`tabf${tab === 'users' ? ' on' : ''}`} href="/#/community">谁在追</a>
        <a className={`tabf${tab === 'anime' ? ' on' : ''}`} href="/#/community/reviews">大家聊过的番</a>
      </div>

      {error && <p className="form-note err mt16" aria-live="polite">⚠ {error}</p>}

      {tab === 'anime' ? (
        loading && animeList === null ? (
          <div className="page-state"><Spinner size={36} /><p className="faint small">正在数谁写了点评…</p></div>
        ) : animeList && animeList.length === 0 ? (
          <div className="empty panel mt16"><div className="empty-say"><div className="bubble empty-bubble">还没有人公开点评过番……第一个会是你吗？</div></div></div>
        ) : (
          <div className="community-track-grid mt16">
            {(animeList ?? []).map((a) => <ReviewAnimeCard key={a.bgmId} anime={a} />)}
          </div>
        )
      ) : loading && users === null ? (
        <div className="page-state"><Spinner size={36} /><p className="faint small">正在翻看大家的追番手帐…</p></div>
      ) : users && users.length === 0 ? (
        <div className="empty panel mt16">
          <img className="mascot" src="/assets/sagiri-mascot.webp" alt="" />
          <div className="empty-say"><div className="bubble empty-bubble">这里还安安静静的……谁来先摊开一页？</div></div>
        </div>
      ) : (
        <div className="community-users mt16">
          {(users ?? []).map((user) => (
            <a className="community-user-card" key={user.username} href={profileHref(user.username)}>
              <span className="avatar-init" style={{ width: 48, height: 48, fontSize: 22 }} aria-hidden="true">
                {user.username.charAt(0).toUpperCase()}
              </span>
              <span className="community-user-main">
                <b>{user.username}</b>
                <span className="muted small">
                  摊开了 {user.trackCount} 部番
                  {(user.review || 0) > 0 && `，写了 ${user.review} 篇点评`}
                  {(user.recommend || 0) > 0 && `，${user.recommend} 篇推荐`}
                </span>
              </span>
              <Ic name="chev" cls="ic community-user-arrow" />
            </a>
          ))}
        </div>
      )}
    </>
  )
}

function ReviewAnimeCard({ anime }: { anime: CommunityReviewAnime }): JSX.Element {
  const [coverFailed, setCoverFailed] = useState(false)
  const image = coverUrl(anime.cover)
  const title = anime.titleCn || anime.title || `BGM ${anime.bgmId}`
  return (
    <div className="community-track-card review-anime-card">
      <div className="community-track-cover">
        {image && !coverFailed
          ? <img src={image} alt="" loading="lazy" onError={() => setCoverFailed(true)} />
          : <span>NO<br />COVER</span>}
      </div>
      <div className="review-anime-body">
        <b title={title}>{title}</b>
        {anime.title && anime.title !== title && <p className="faint small community-track-subtitle">{anime.title}</p>}
        <p className="muted small community-review-count">
          {[anime.review > 0 && `${anime.review} 篇点评`, anime.recommend > 0 && `${anime.recommend} 篇推荐`]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {anime.tags.length > 0 && (
          <div className="tagx-row review-anime-tags">
            {anime.tags.map((t) => <span key={t} className="tagx">{t}</span>)}
          </div>
        )}
        {anime.excerpt && <p className="faint small review-anime-excerpt">「{anime.excerpt}」</p>}
        <a className="link small community-track-link" href={`/#/community/reviews/${anime.bgmId}`}>
          看看大家怎么评价 <Ic name="chev" cls="ic ic-sm" />
        </a>
      </div>
    </div>
  )
}

function AnimeReviewsView({
  data,
  loading,
  error,
}: {
  data: AnimeReviewsResult | null
  loading: boolean
  error: string | null
}): JSX.Element {
  const [tab, setTab] = useState<'review' | 'recommend'>('review')
  const [poster, setPoster] = useState<PosterInput | null>(null)
  const title = data ? data.anime.titleCn || data.anime.title || `BGM ${data.anime.bgmId}` : ''
  const list = data ? data[tab] : []
  // 有哪个就默认停在哪个
  useEffect(() => {
    if (data && data.review.length === 0 && data.recommend.length > 0) setTab('recommend')
  }, [data])

  return (
    <>
      <div className="community-profile-head">
        <a className="btn btn-sm btn-ghost" href="/#/community/reviews"><Ic name="back" cls="ic ic-sm" /> 返回列表</a>
        {data && (
          <div className="community-profile-identity">
            <img className="dlg-cover" src={coverUrl(data.anime.cover)} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} />
            <div>
              <h1 className="title-sketch" style={{ fontSize: 30 }}>{title}</h1>
              <p className="muted small mt8">大家聊过 {data.review.length + data.recommend.length} 篇</p>
            </div>
          </div>
        )}
      </div>

      {error && <p className="form-note err mt16" aria-live="polite">⚠ {error}</p>}
      {loading && !data ? (
        <div className="page-state"><Spinner size={36} /><p className="faint small">正在收集大家的点评…</p></div>
      ) : !data ? null : (
        <>
          <div className="tabf-row community-tabs mt16">
            <button type="button" className={`tabf${tab === 'review' ? ' on' : ''}`} onClick={() => setTab('review')}>
              点评 <span className="badge-num">{data.review.length}</span>
            </button>
            <button type="button" className={`tabf${tab === 'recommend' ? ' on' : ''}`} onClick={() => setTab('recommend')}>
              推荐 <span className="badge-num">{data.recommend.length}</span>
            </button>
          </div>
          {list.length === 0 ? (
            <div className="empty panel mt16"><div className="empty-say"><div className="bubble empty-bubble">这一栏还没有人写……</div></div></div>
          ) : (
            <div className="anime-review-list mt16">
              {list.map((entry, i) => (
                <article className="anime-review-item" key={`${entry.username}-${i}`}>
                  <div className="anime-review-head">
                    <a className="anime-review-author" href={profileHref(entry.username)}>
                      <span className="avatar-init" style={{ width: 32, height: 32, fontSize: 15 }} aria-hidden="true">
                        {entry.username.charAt(0).toUpperCase()}
                      </span>
                      <b>{entry.username}</b>
                    </a>
                    <span className="anime-review-meta">
                      {entry.score != null && <span className="anime-review-score">★ {entry.score}</span>}
                      <span className={`anime-review-spoiler${entry.spoiler === 'none' ? '' : ' warn'}`}>
                        {entry.spoiler === 'none' ? '无剧透' : '含剧透'}
                      </span>
                      {entry.publishedAt && <span>{new Date(entry.publishedAt).toLocaleDateString('zh-CN')}</span>}
                    </span>
                  </div>
                  <p className="anime-review-body">{entry.body}</p>
                  <div className="anime-review-foot">
                    {entry.tags.length > 0 && (
                      <div className="tagx-row">
                        {entry.tags.map((t) => <span className="tagx" key={t}>{t}</span>)}
                      </div>
                    )}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm anime-review-poster"
                      onClick={() =>
                        data &&
                        setPoster(
                          posterInputFrom({
                            bgmId: data.anime.bgmId,
                            title: data.anime.title,
                            titleCn: data.anime.titleCn,
                            cover: data.anime.cover,
                            airDate: data.anime.airDate,
                            mode: tab,
                            body: entry.body,
                            spoiler: entry.spoiler,
                            score: entry.score,
                            bgmScore: entry.bgmScore,
                            tags: entry.tags,
                            publishedAt: entry.publishedAt,
                            username: entry.username,
                          }),
                        )
                      }
                    >
                      <Ic name="star" cls="ic ic-sm" /> 生成分享图
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
      {poster && <PosterModal input={poster} fileTitle={title} onClose={() => setPoster(null)} />}
    </>
  )
}

function ProfileView({
  username,
  profile,
  loading,
  error,
}: {
  username: string
  profile: CommunityProfile | null
  loading: boolean
  error: string | null
}): JSX.Element {
  const [filter, setFilter] = useState<PublicFilter>('all')
  const [query, setQuery] = useState('')
  const tracks = profile?.data ?? []
  const counts = useMemo(() => {
    const result: Record<PublicFilter, number> = { all: tracks.length, watching: 0, plan: 0, considering: 0, done: 0 }
    for (const track of tracks) result[track.status]++
    return result
  }, [tracks])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return tracks.filter((track) => {
      if (filter !== 'all' && track.status !== filter) return false
      if (!q) return true
      return [track.title, track.titleCn, ...track.aliases].join(' ').toLowerCase().includes(q)
    })
  }, [filter, query, tracks])

  return (
    <>
      <div className="community-profile-head">
        <a className="btn btn-sm btn-ghost" href="/#/community"><Ic name="back" cls="ic ic-sm" /> 返回大厅</a>
        <div className="community-profile-identity">
          <span className="avatar-init" style={{ width: 54, height: 54, fontSize: 25 }} aria-hidden="true">
            {username.charAt(0).toUpperCase()}
          </span>
          <div>
            <h1 className="title-sketch" style={{ fontSize: 32 }}>{profile?.user.username ?? username} 的追番手帐</h1>
            <p className="muted small mt8">
              这本手帐里有 {profile?.user.trackCount ?? '…'} 部番
              {(profile?.user.review || 0) > 0 && `，写了 ${profile?.user.review} 篇点评`}
              {(profile?.user.recommend || 0) > 0 && `，${profile?.user.recommend} 篇推荐`}
            </p>
          </div>
        </div>
      </div>

      {error && <p className="form-note err mt16" aria-live="polite">⚠ {error}</p>}
      {loading && !profile ? (
        <div className="page-state"><Spinner size={36} /><p className="faint small">正在打开这本追番手帐…</p></div>
      ) : error && !profile ? (
        <div className="empty panel mt16"><div className="empty-say"><div className="bubble empty-bubble">这个用户没有公开追番，或页面已经设为私有。</div></div></div>
      ) : (
        <>
          <div className="row community-toolbar mt16" style={{ flexWrap: 'wrap' }}>
            <div className="searchbar">
              <Ic name="search" cls="ic" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="在这本手帐里搜番名…" spellCheck={false} />
              {query && <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="清空搜索"><Ic name="x" cls="ic ic-sm" /></button>}
            </div>
          </div>
          <div className="tabf-row community-tabs">
            {(['all', 'watching', 'plan', 'considering', 'done'] as PublicFilter[]).map((key) => (
              <button key={key} type="button" className={`tabf${filter === key ? ' on' : ''}`} onClick={() => setFilter(key)}>
                {key === 'all' ? '全部' : STATUS_LABEL[key]} <span className="badge-num">{counts[key]}</span>
              </button>
            ))}
          </div>
          {filtered.length === 0 ? (
            <div className="empty panel mt16"><div className="empty-say"><div className="bubble empty-bubble">这本手帐里暂时没有匹配的番。</div></div></div>
          ) : (
            <div className="community-track-grid mt16">
              {filtered.map((track) => <PublicTrackCard key={track.bgmId} track={track} username={username} />)}
            </div>
          )}
        </>
      )}
    </>
  )
}

const REVIEW_MODE_LABEL = { review: '点评', recommend: '推荐' } as const

function PublicTrackCard({ track, username }: { track: PublicTrack; username: string }): JSX.Element {
  const [coverFailed, setCoverFailed] = useState(false)
  const [highlightsOpen, setHighlightsOpen] = useState(false)
  const [openReview, setOpenReview] = useState<'review' | 'recommend' | null>(null)
  const image = coverUrl(track.cover)
  const highlightCount = track.goodEpisodes.length
  const subtitle = track.title && track.title !== (track.titleCn || track.title) ? track.title : ''
  const tags = [
    ...track.bgmTags.slice(0, 2).map((tag) => ({ key: `bgm:${tag}`, value: tag, mine: false })),
    ...track.userTags.slice(0, 2).map((tag) => ({ key: `user:${tag}`, value: tag, mine: true })),
  ]
  const progress = track.totalEpisodes != null && track.totalEpisodes > 0
    ? `${track.episode} / ${track.totalEpisodes} 集`
    : `${track.episode} 集`
  const title = track.titleCn || track.title || `BGM ${track.bgmId}`
  return (
    <article className="community-track-card">
      <div className="community-track-cover">
        {image && !coverFailed
          ? <img src={image} alt="" loading="lazy" onError={() => setCoverFailed(true)} />
          : <span>NO<br />COVER</span>}
      </div>
      <div className="community-track-body">
        <div className="community-track-title-row">
          <b title={title}>{title}</b>
          <span className={`community-status status-${track.status}`}>{STATUS_LABEL[track.status]}</span>
          {highlightCount > 0 && (
            <button
              type="button"
              className="community-highlight-trigger"
              title="查看好看集与手帐备注"
              aria-label={`查看好看集，共 ${highlightCount} 集`}
              onClick={() => setHighlightsOpen(true)}
            >
              <Ic name="star" cls="ic ic-sm" /> {highlightCount}
            </button>
          )}
        </div>
        <p className="faint small community-track-subtitle" title={subtitle || undefined} aria-hidden={!subtitle}>{subtitle || '\u00a0'}</p>
        <div className="community-track-meta-row">
          <span className="community-track-progress">看到第 {progress}</span>
          {track.favorite > 0 && (
            <span className="community-track-stars" aria-label={`收藏 ${track.favorite} 星`}>{'★'.repeat(track.favorite)}</span>
          )}
        </div>
        <div className="community-track-reviews">
          {(['review', 'recommend'] as const).map((m) =>
            track[m] ? (
              <button key={m} type="button" className="community-review-chip" onClick={() => setOpenReview(m)}>
                <Ic name="edit" cls="ic ic-sm" /> {REVIEW_MODE_LABEL[m]}
              </button>
            ) : null,
          )}
        </div>
        <div className="community-track-tags-slot">
          {tags.length > 0 && (
            <div className="tagx-row community-track-tags">
              {tags.map((tag) => <span className={`tagx${tag.mine ? ' mine' : ''}`} key={tag.key}>{tag.value}</span>)}
            </div>
          )}
        </div>
        {track.bgmId > 0 ? (
          <a className="link small community-track-link" href={`https://bgm.tv/subject/${track.bgmId}`} target="_blank" rel="noreferrer">
            去看看这部番 <Ic name="external" cls="ic ic-sm" />
          </a>
        ) : <span className="community-track-link-placeholder" aria-hidden="true" />}
      </div>
      {highlightsOpen && <PublicHighlightsModal track={track} onClose={() => setHighlightsOpen(false)} />}
      {openReview && track[openReview] && (
        <PublicReviewModal
          mode={openReview}
          title={title}
          text={track[openReview]!}
          onPoster={() =>
            posterInputFrom({
              bgmId: track.bgmId,
              title: track.title,
              titleCn: track.titleCn,
              cover: track.cover,
              airDate: track.airDate,
              mode: openReview,
              body: track[openReview]!.body,
              spoiler: track[openReview]!.spoiler,
              score: null,
              scoreSignals: {
                favorite: track.favorite,
                goodEpisodeCount: track.goodEpisodes.length,
                notedEpisodeCount: Object.values(track.goodEpisodeNotes).filter((note) => typeof note === 'string' && note.trim()).length,
                totalEpisodes: track.totalEpisodes,
                watchedEpisodes: track.episode,
              },
              bgmScore: track.score > 0 ? track.score : null,
              tags: track.userTags.slice(0, 6),
              publishedAt: track[openReview]!.publishedAt,
              username,
            })
          }
          onClose={() => setOpenReview(null)}
        />
      )}
    </article>
  )
}

function PublicReviewModal({
  mode,
  title,
  text,
  onPoster,
  onClose,
}: {
  mode: 'review' | 'recommend'
  title: string
  text: NonNullable<PublicTrack['review']>
  onPoster: () => PosterInput
  onClose: () => void
}): JSX.Element {
  const [poster, setPoster] = useState<PosterInput | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const when = text.publishedAt ? new Date(text.publishedAt).toLocaleDateString('zh-CN') : ''
  return (
    <div className="dlg-backdrop open" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={REVIEW_MODE_LABEL[mode]} className="dlg" style={{ maxWidth: 540 }}>
        <span className="tape tl teal" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭">
          <Ic name="x" cls="ic" />
        </button>
        <h3 className="dlg-title">{title} · {REVIEW_MODE_LABEL[mode]}</h3>
        <p className="dlg-sub">
          {text.spoiler === 'none' ? '这篇没剧透，放心看' : '这篇含剧透，别怪我没提醒'}
          {when && ` · ${when}`}
        </p>
        <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7, maxHeight: '52vh', overflowY: 'auto' }}>{text.body}</p>
        <div className="dlg-actions" style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPoster(onPoster())}>
            <Ic name="star" cls="ic ic-sm" /> 生成分享图
          </button>
        </div>
      </div>
      {poster && <PosterModal input={poster} fileTitle={title} onClose={() => setPoster(null)} />}
    </div>
  )
}

function PublicHighlightsModal({ track, onClose }: { track: PublicTrack; onClose: () => void }): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const notes = Object.entries(track.goodEpisodeNotes)
    .filter(([, note]) => note.trim())
    .sort(([a], [b]) => Number(a) - Number(b))
  const title = track.titleCn || track.title || `BGM ${track.bgmId}`

  return (
    <div
      className="dlg-backdrop open community-highlight-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="好看集与手帐备注" className="dlg community-highlights-dlg">
        <button type="button" className="dlg-close" onClick={onClose} aria-label="收起记录" title="收起记录">
          <Ic name="x" cls="ic" />
        </button>
        <h3 className="dlg-title"><Ic name="star" cls="ic ic-sm community-highlight-icon" /> 好看集</h3>
        <p className="dlg-sub">『{title}』里，纱雾点亮的集数都收在这里。</p>
        <div className="community-highlight-summary">
          <span>共 {track.goodEpisodes.length} 集</span>
          {track.favorite > 0 && <span aria-label={`收藏 ${track.favorite} 星`}>{'★'.repeat(track.favorite)}</span>}
        </div>
        <div className="community-episode-cloud">
          {track.goodEpisodes.map((episode) => <span className="community-episode-chip" key={episode}>{episode}</span>)}
        </div>
        {notes.length > 0 && <div className="community-note-list">
          <h4 className="community-notes-heading"><Ic name="clip" cls="ic ic-sm" /> 手帐备注</h4>
          {notes.map(([episode, note]) => (
            <article className="community-note-item" key={episode}>
              <span>第 {episode} 集</span>
              <p>{note}</p>
            </article>
          ))}
        </div>}
      </div>
    </div>
  )
}
