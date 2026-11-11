import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AnimeHit, CalendarItem, SourceBinding, SourceId, Track } from './api'
import { SOURCES, putTrack, sourceById } from './api'
import { useAuth } from './auth'
import { toast } from './Toast'
import { loadTracks, reloadTracks, runTrackMutation } from './tracksSync'
import { ContinueWatchAction, WatchSourceDialog } from './tracks/TrackCard'
import { AddSearchModal } from './tracks/addSearchModal'
import { watchEp } from './tracks/common'
import { useSourceWatch } from './tracks/useSourceWatch'
import { clearWatchIntent, readWatchIntent, rememberWatchIntent } from './watchIntent'
import { Ic, Spinner } from './SketchIcon'

// 新用户还没有追番列表，不会想到去「我的追番」里找加番；很多人也只是想搜到就看。
// 所以找番挂在全站壳上，任何页面都能打开，结果行同时给「试看」和「追番」。
const OPEN_EVENT = 'maple-find-anime'
const WATCH_EVENT = 'maple-watch-anime'
const CANCEL_WATCH_EVENT = 'maple-cancel-watch-login'

export function openFindAnime(): void {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

export function requestAnimeWatch(item: CalendarItem): void {
  window.dispatchEvent(new CustomEvent(WATCH_EVENT, { detail: item }))
}

export function cancelWatchLogin(): void {
  clearWatchIntent()
  window.dispatchEvent(new Event(CANCEL_WATCH_EVENT))
}

// 与周历「试看」同一口径：没有进度按第 1 话开，绑定仍按 bgmId 落库，之后追上直接沿用
function trialTrack(hit: AnimeHit): Track {
  const now = Date.now()
  return {
    bgmId: hit.bgmId, status: 'considering', episode: 1, totalEpisodes: null,
    title: hit.name, titleCn: hit.nameCn, cover: '', airWeekday: 0, airDate: hit.date, score: hit.score,
    bgmTags: [], userTags: [], aliases: [], observeCount: 0, subjectType: 'anime',
    goodEpisodes: [], goodEpisodeNotes: {}, favorite: 0, createdAt: now, updatedAt: now,
  }
}

export function FindAnime({ onLogin }: { onLogin: () => void }): JSX.Element | null {
  const { user, ready } = useAuth()
  const [open, setOpen] = useState(false)
  const [pendingWatch, setPendingWatch] = useState<CalendarItem | null>(readWatchIntent)
  const [tracksReady, setTracksReady] = useState(false)
  const [tracksError, setTracksError] = useState<string | null>(null)
  const [tracksById, setTracksById] = useState<Map<number, Track>>(new Map())
  const { bindings, locating, continueWatch, modals } = useSourceWatch((message) => toast(message, { err: true }))

  const closePending = (): void => { setPendingWatch(null); clearWatchIntent() }
  useEffect(() => {
    if (pendingWatch && ready && !user) onLogin()
  }, [pendingWatch, ready, user, onLogin])

  useEffect(() => {
    const onWatch = (event: Event): void => {
      const anime = rememberWatchIntent((event as CustomEvent<CalendarItem>).detail)
      if (!anime) return
      setOpen(false); setTracksReady(false); setTracksError(null); setPendingWatch(anime)
    }
    const onCancel = (): void => { setPendingWatch(null); clearWatchIntent() }
    window.addEventListener(WATCH_EVENT, onWatch)
    window.addEventListener(CANCEL_WATCH_EVENT, onCancel)
    return () => {
      window.removeEventListener(WATCH_EVENT, onWatch)
      window.removeEventListener(CANCEL_WATCH_EVENT, onCancel)
    }
  }, [])

  useEffect(() => {
    const onOpen = (): void => (user ? setOpen(true) : onLogin())
    // 试看开播会换页，弹窗不能留在播放页上
    const onLeave = (): void => { setOpen(false); setPendingWatch(null); clearWatchIntent() }
    window.addEventListener(OPEN_EVENT, onOpen)
    window.addEventListener('hashchange', onLeave)
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen)
      window.removeEventListener('hashchange', onLeave)
    }
  }, [user, onLogin])

  useEffect(() => {
    if (!user) {
      setOpen(false)
      setTracksById(new Map())
      setTracksReady(false)
      return
    }
    if (!open && !pendingWatch) return
    setTracksReady(false); setTracksError(null)
    return loadTracks(user.username, (ts) => {
      setTracksById(new Map(ts.map((t) => [t.bgmId, t]))); setTracksReady(true)
    }, (e) => { setTracksError(e); if (e && !pendingWatch) toast(e, { err: true }) })
  }, [user, open, pendingWatch])

  const want = (hit: AnimeHit): void => {
    if (!user) return
    void runTrackMutation(user.username, hit.bgmId, () =>
      putTrack(hit.bgmId, { title: hit.name, titleCn: hit.nameCn, status: 'plan', airDate: hit.date, score: hit.score }, { searchAdditionToken: hit.searchAdditionToken }),
    ).then(() => toast(`『${hit.nameCn || hit.name}』已加入追番`))
      .catch((e: Error) => toast(e.message, { err: true }))
  }

  const renderTry = (hit: AnimeHit): JSX.Element => {
    const t = tracksById.get(hit.bgmId) ?? trialTrack(hit)
    const bound: Partial<Record<SourceId, SourceBinding>> = {}
    for (const s of SOURCES) {
      const b = bindings[s.id][hit.bgmId]
      if (b) bound[s.id] = b
    }
    return (
      <ContinueWatchAction
        className="btn btn-sm btn-ghost find-try"
        label={tracksById.has(hit.bgmId) ? '继续看' : '试看'}
        ep={watchEp(t)}
        bound={bound}
        locating={locating?.bgmId === hit.bgmId}
        onPick={(source, mode, rebind) => continueWatch(sourceById(source), t, mode, rebind)}
      />
    )
  }

  const pendingTrack = pendingWatch ? tracksById.get(pendingWatch.id) ?? trialTrack({ bgmId: pendingWatch.id, name: pendingWatch.name, nameCn: pendingWatch.name_cn, date: pendingWatch.airDate, score: pendingWatch.score }) : null
  const pendingBound: Partial<Record<SourceId, SourceBinding>> = {}
  if (pendingWatch) for (const source of SOURCES) {
    const binding = bindings[source.id][pendingWatch.id]
    if (binding) pendingBound[source.id] = binding
  }
  if (!user) return null
  return (
    <>
      {open && (
        <AddSearchModal
          trackedIds={new Set(tracksById.keys())}
          onAdd={want}
          onAddCustom={() => Promise.resolve()}
          renderTry={renderTry}
          onClose={() => setOpen(false)}
        />
      )}
      {pendingWatch && pendingTrack && (tracksReady ? (
        <WatchSourceDialog title={pendingWatch.name_cn || pendingWatch.name} ep={watchEp(pendingTrack)} bound={pendingBound}
          onClose={closePending} onPick={(source, mode, rebind) => continueWatch(sourceById(source), pendingTrack, mode, rebind)} />
      ) : createPortal(
        <div className="dlg-backdrop open"><div className="dlg" role="dialog" aria-modal="true" aria-label="读取观看进度">
          <button type="button" className="dlg-close" aria-label="关闭" onClick={closePending}><Ic name="x" /></button>
          <h3 className="dlg-title">{pendingWatch.name_cn || pendingWatch.name}</h3>
          <p role="status">{tracksError || '正在读取观看进度…'}</p>
          {tracksError ? <button type="button" className="btn btn-sm" onClick={() => { setTracksError(null); reloadTracks(user.username) }}>重新读取</button> : <Spinner size={24} />}
        </div></div>, document.body
      ))}
      {modals}
    </>
  )
}
