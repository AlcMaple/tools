import { useEffect, useState } from 'react'
import type { AnimeHit, SourceBinding, SourceId, Track } from './api'
import { SOURCES, putTrack, sourceById } from './api'
import { useAuth } from './auth'
import { toast } from './Toast'
import { loadTracks, runTrackMutation } from './tracksSync'
import { ContinueWatchAction } from './tracks/TrackCard'
import { AddSearchModal } from './tracks/addSearchModal'
import { watchEp } from './tracks/common'
import { useSourceWatch } from './tracks/useSourceWatch'

// 新用户还没有追番列表，不会想到去「我的追番」里找加番；很多人也只是想搜到就看。
// 所以找番挂在全站壳上，任何页面都能打开，结果行同时给「试看」和「追番」。
const OPEN_EVENT = 'maple-find-anime'

export function openFindAnime(): void {
  window.dispatchEvent(new Event(OPEN_EVENT))
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
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [tracksById, setTracksById] = useState<Map<number, Track>>(new Map())
  const { bindings, locating, continueWatch, modals } = useSourceWatch((message) => toast(message, { err: true }))

  useEffect(() => {
    const onOpen = (): void => (user ? setOpen(true) : onLogin())
    // 试看开播会换页，弹窗不能留在播放页上
    const onLeave = (): void => setOpen(false)
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
      return
    }
    if (!open) return
    return loadTracks(user.username, (ts) => setTracksById(new Map(ts.map((t) => [t.bgmId, t]))), (e) => { if (e) toast(e, { err: true }) })
  }, [user, open])

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
      {modals}
    </>
  )
}
