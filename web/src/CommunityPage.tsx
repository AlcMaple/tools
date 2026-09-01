import { useEffect, useMemo, useState } from 'react'
import {
  coverUrl,
  fetchCommunityProfile,
  fetchCommunityUsers,
  type CommunityProfile,
  type CommunityUserSummary,
  type PublicTrack,
  type TrackStatus,
} from './api'
import { Ic, Spinner } from './SketchIcon'

type PublicFilter = 'all' | TrackStatus

const STATUS_LABEL: Record<TrackStatus, string> = {
  watching: '在追',
  plan: '想看',
  considering: '观望',
  done: '看完',
}

function profileUsername(): string | null {
  const hash = window.location.hash.replace(/^#\/?/, '')
  // 规范用户页使用 `/u/:username`，但从用户页点回大厅会留下 `#/community`。
  // 只要 hash 明确指定了页面，就不能再用旧 pathname 把用户页识别回来。
  if (hash === 'community') return null
  if (hash.startsWith('community/')) {
    const raw = hash.slice('community/'.length).replace(/\/$/, '')
    if (raw) {
      try {
        return decodeURIComponent(raw)
      } catch {
        return null
      }
    }
  }
  if (hash) return null
  if (window.location.pathname === '/u' || window.location.pathname.startsWith('/u/')) {
    const raw = window.location.pathname.slice('/u/'.length).replace(/\/$/, '')
    if (raw) {
      try {
        return decodeURIComponent(raw)
      } catch {
        return null
      }
    }
  }
  return null
}

function profileHref(username: string): string {
  return `/u/${encodeURIComponent(username)}`
}

export function CommunityPage(): JSX.Element {
  const [username, setUsername] = useState<string | null>(profileUsername)
  const [users, setUsers] = useState<CommunityUserSummary[] | null>(null)
  const [profile, setProfile] = useState<CommunityProfile | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const syncLocation = (): void => setUsername(profileUsername())
    window.addEventListener('hashchange', syncLocation)
    window.addEventListener('popstate', syncLocation)
    return () => {
      window.removeEventListener('hashchange', syncLocation)
      window.removeEventListener('popstate', syncLocation)
    }
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    setProfile(null)
    if (username) {
      void fetchCommunityProfile(username)
        .then((next) => {
          if (alive) setProfile(next)
        })
        .catch((err: unknown) => {
          if (alive) setError(err instanceof Error ? err.message : '公开追番读取失败')
        })
        .finally(() => {
          if (alive) setLoading(false)
        })
    } else {
      void fetchCommunityUsers()
        .then((result) => {
          if (alive) setUsers(result.data)
        })
        .catch((err: unknown) => {
          if (alive) setError(err instanceof Error ? err.message : '追番大厅读取失败')
        })
        .finally(() => {
          if (alive) setLoading(false)
        })
    }
    return () => {
      alive = false
    }
  }, [username])

  return username
    ? <ProfileView username={username} profile={profile} loading={loading} error={error} />
    : <HallView users={users} loading={loading} error={error} />
}

function HallView({
  users,
  loading,
  error,
}: {
  users: CommunityUserSummary[] | null
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

      {error && <p className="form-note err mt16" aria-live="polite">⚠ {error}</p>}
      {loading && users === null ? (
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
                <span className="muted small">摊开了 {user.trackCount} 部番</span>
              </span>
              <Ic name="chev" cls="ic community-user-arrow" />
            </a>
          ))}
        </div>
      )}
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
            <p className="muted small mt8">这本手帐里有 {profile?.user.trackCount ?? '…'} 部番</p>
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
              {filtered.map((track) => <PublicTrackCard key={track.bgmId} track={track} />)}
            </div>
          )}
        </>
      )}
    </>
  )
}

function PublicTrackCard({ track }: { track: PublicTrack }): JSX.Element {
  const [coverFailed, setCoverFailed] = useState(false)
  const [highlightsOpen, setHighlightsOpen] = useState(false)
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
        <p className="community-track-progress">看到第 {progress}</p>
        <div className="community-track-tags-slot">
          {tags.length > 0 && (
            <div className="tagx-row community-track-tags">
              {tags.map((tag) => <span className={`tagx${tag.mine ? ' mine' : ''}`} key={tag.key}>{tag.value}</span>)}
            </div>
          )}
        </div>
        <div className="community-track-sharing-slot">
          {track.favorite > 0 && (
            <div className="community-track-sharing">
              <span aria-label={`收藏 ${track.favorite} 星`}>{'★'.repeat(track.favorite)}</span>
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
    </article>
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
