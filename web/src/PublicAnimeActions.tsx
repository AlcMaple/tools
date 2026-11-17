import { useEffect, useRef, useState } from 'react'
import { fetchCommunityAnime, fetchTracks, saveCommunityPlan, type CommunityActionSource } from './api'
import { auth, useAuth } from './auth'
import { requestAnimeWatch } from './FindAnime'
import { runTrackMutation } from './tracksSync'
import { Ic } from './SketchIcon'

export function PublicAnimeActions({ bgmId, source }: { bgmId: number; source: CommunityActionSource }): JSX.Element | null {
  const { user } = useAuth()
  if (!Number.isSafeInteger(bgmId) || bgmId <= 0) return null
  return <ActionButtons key={`${user?.id ?? 0}:${bgmId}:${JSON.stringify(source)}`} bgmId={bgmId} source={source} user={user} />
}

function ActionButtons({ bgmId, source, user }: { bgmId: number; source: CommunityActionSource; user: ReturnType<typeof useAuth>['user'] }): JSX.Element {
  const [busy, setBusy] = useState<'watch' | 'plan' | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => { request.current?.abort() }, [])
  const run = async (action: 'watch' | 'plan'): Promise<void> => {
    if (request.current) {
      if (action === 'watch' && busy === 'watch') { request.current.abort(); request.current = null; setBusy(null) }
      return
    }
    const ctl = new AbortController()
    request.current = ctl
    setBusy(action); setError('')
    const owner = user?.id ?? 0
    const current = (): boolean => !ctl.signal.aborted && (auth.user?.id ?? 0) === owner
    try {
      const anime = await fetchCommunityAnime(bgmId, source, ctl.signal)
      if (!current()) return
      if (action === 'watch') { requestAnimeWatch(anime); return }
      if (!user) return
      // 先完整读取本人手帐，既不把加载中当未收藏，也不借用分享者的记录
      const own = await fetchTracks(undefined, ctl.signal)
      if (!current()) return
      if (!own.data.some(track => track.bgmId === bgmId)) {
        await runTrackMutation(user.username, bgmId, () => {
          if (!current()) throw new DOMException('操作已取消', 'AbortError')
          return saveCommunityPlan(bgmId, source, owner, ctl.signal)
        })
      }
      if (current()) setSaved(true)
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : '操作未完成，请稍后再试')
    } finally {
      if (request.current === ctl) { request.current = null; setBusy(null) }
    }
  }
  return <div className="public-anime-actions">
    <button type="button" className="btn btn-sm" disabled={busy === 'plan'} onClick={() => { void run('watch') }}><Ic name="play" cls="ic ic-sm" />{busy === 'watch' ? '取消' : user ? '观看' : '登录后观看'}</button>
    {user && <button type="button" className="btn btn-sm btn-ghost" disabled={saved || busy !== null} onClick={() => { void run('plan') }}>{busy === 'plan' ? '处理中' : saved ? '已在追番' : '加入想看'}</button>}
    {error && <p className="public-anime-action-error" role="alert">{error}</p>}
  </div>
}
