// 网页版账号追番同步 —— 网页服务器是实时真相源，app 只做用户明确触发的
// 整包上传 / 拉取。坚果云的应急备份仍由 AnimeSyncBar 独立保留，两条通道
// 不共享 rev，避免把一个云端的版本号误拿去判断另一个云端。
import { useEffect, useState } from 'react'
import {
  animeTrackStore,
  useAnimeTrackList,
  type AnimeTrack,
} from '../stores/animeTrackStore'
import { ipcErrMsg, ModalShell } from '../pages/homework/shared'
import { fromWebSyncTracks, toWebSyncTracks } from '../utils/webTrackSync'

type SyncState = 'idle' | 'syncing' | 'synced' | 'error'
type Direction = 'push' | 'pull'

interface RemoteTracks {
  rev: number
  tracks: AnimeTrack[]
}

interface ConfirmState {
  direction: Direction
  remote: RemoteTracks
  forceArmed: boolean
}

const revKey = (username: string): string => `maple-web-tracks-rev:${username.toLowerCase()}`
const snapshotKey = (username: string): string => `maple-web-tracks-snapshot:${username.toLowerCase()}`
const timeKey = (username: string): string => `maple-web-tracks-time:${username.toLowerCase()}`
const snapshotOf = (tracks: AnimeTrack[]): string => JSON.stringify(tracks)

export function WebTrackSyncBar(): JSX.Element | null {
  const tracks = useAnimeTrackList()
  const [account, setAccount] = useState<{ loggedIn: boolean; username: string } | null>(null)
  const [state, setState] = useState<SyncState>('idle')
  const [message, setMessage] = useState('')
  const [remoteRev, setRemoteRev] = useState<number | null>(null)
  const [lastRev, setLastRev] = useState(0)
  const [lastSnapshot, setLastSnapshot] = useState('')
  const [lastTime, setLastTime] = useState<number | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)

  useEffect(() => {
    window.webAccountApi.status()
      .then(setAccount)
      .catch(() => setAccount({ loggedIn: false, username: '' }))
  }, [])

  useEffect(() => {
    if (!account?.loggedIn) return
    setLastRev(Number(localStorage.getItem(revKey(account.username))) || 0)
    setLastSnapshot(localStorage.getItem(snapshotKey(account.username)) || '')
    setLastTime(Number(localStorage.getItem(timeKey(account.username))) || null)

    let cancelled = false
    window.webAccountApi.pullTracks()
      .then((remote) => {
        if (!cancelled) setRemoteRev(remote.rev)
      })
      .catch(() => {
        // 这里只做状态提示，失败不重试、不改变本地数据，也不把登录态擅自判掉。
      })
    return () => { cancelled = true }
  }, [account])

  if (!account?.loggedIn) return null

  const localDirty = snapshotOf(tracks) !== lastSnapshot
  const cloudNewer = remoteRev !== null && remoteRev !== lastRev
  const busy = state === 'syncing' || !!confirm

  const settle = (next: SyncState, text: string): void => {
    setState(next)
    setMessage(text)
    if (next === 'synced' || next === 'error') {
      window.setTimeout(() => {
        setState('idle')
        setMessage('')
      }, 3500)
    }
  }

  const remember = (rev: number, nextTracks: AnimeTrack[]): void => {
    const now = Date.now()
    const snapshot = snapshotOf(nextTracks)
    setLastRev(rev)
    setRemoteRev(rev)
    setLastSnapshot(snapshot)
    setLastTime(now)
    localStorage.setItem(revKey(account.username), String(rev))
    localStorage.setItem(snapshotKey(account.username), snapshot)
    localStorage.setItem(timeKey(account.username), String(now))
  }

  const openConfirm = async (direction: Direction): Promise<void> => {
    if (busy) return
    setState('syncing')
    setMessage('读取网页版…')
    try {
      const result = await window.webAccountApi.pullTracks()
      const remote = { rev: result.rev, tracks: fromWebSyncTracks(result.data) }
      setRemoteRev(result.rev)
      setConfirm({ direction, remote, forceArmed: false })
      setState('idle')
      setMessage('')
    } catch (error: unknown) {
      settle('error', ipcErrMsg(error, '读取网页版失败'))
    }
  }

  const executePush = async (): Promise<void> => {
    if (!confirm) return
    const force = confirm.forceArmed
    setConfirm(null)
    setState('syncing')
    setMessage('上传到网页版…')
    try {
      const result = await window.webAccountApi.pushTracks({
        baseRev: lastRev,
        force,
        data: toWebSyncTracks(tracks),
      })
      if (!result.ok) {
        setRemoteRev(result.rev)
        settle('error', '网页版刚有新改动，请先拉取或重新确认强制覆盖')
        return
      }
      remember(result.rev, tracks)
      settle('synced', '网页版上传成功')
    } catch (error: unknown) {
      settle('error', ipcErrMsg(error, '上传网页版失败'))
    }
  }

  const executePull = (): void => {
    if (!confirm) return
    const remote = confirm.remote
    setConfirm(null)
    setState('syncing')
    setMessage('应用网页版数据…')
    try {
      animeTrackStore.replaceAll(remote.tracks)
      remember(remote.rev, remote.tracks)
      settle('synced', '网页版拉取成功')
    } catch (error: unknown) {
      settle('error', ipcErrMsg(error, '应用网页版数据失败'))
    }
  }

  const statusText =
    state !== 'idle' ? message :
    localDirty && cloudNewer ? '两端都有变化' :
    cloudNewer ? '网页版有更新' :
    localDirty ? '本地未上传' :
    lastTime ? '已同步' : `已登录 ${account.username}`

  const statusClass =
    state === 'error' || (localDirty && cloudNewer) ? 'text-error' :
    state === 'synced' || cloudNewer ? 'text-secondary' :
    localDirty ? 'text-tertiary' :
    'text-on-surface-variant/50'

  return (
    <>
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-container-high border border-outline-variant/15">
        {state === 'syncing' ? (
          <span className="material-symbols-outlined text-primary animate-spin" style={{ fontSize: 13 }}>progress_activity</span>
        ) : (
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
            state === 'error' || (localDirty && cloudNewer) ? 'bg-error' :
            state === 'synced' || cloudNewer ? 'bg-secondary' :
            localDirty ? 'bg-tertiary' : 'bg-outline/40'
          }`} />
        )}
        <span className={`font-label text-[10px] uppercase tracking-widest ${statusClass}`}>{statusText}</span>
        <div className="flex items-center gap-0.5 ml-0.5 border-l border-outline-variant/20 pl-1">
          <button
            type="button"
            onClick={() => void openConfirm('push')}
            disabled={busy}
            title="上传追番到 MapleTools 网页版"
            className="p-1 rounded text-on-surface-variant/50 hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-30"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 13 }}>cloud_upload</span>
          </button>
          <button
            type="button"
            onClick={() => void openConfirm('pull')}
            disabled={busy}
            title="从 MapleTools 网页版拉取追番"
            className="p-1 rounded text-on-surface-variant/50 hover:text-secondary hover:bg-secondary/10 transition-colors disabled:opacity-30"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 13 }}>cloud_download</span>
          </button>
        </div>
      </div>

      {confirm && (
        <WebSyncConfirmModal
          state={confirm}
          localTracks={tracks}
          localDirty={localDirty}
          lastRev={lastRev}
          setState={setConfirm}
          onPush={executePush}
          onPull={executePull}
        />
      )}
    </>
  )
}

function WebSyncConfirmModal({
  state,
  localTracks,
  localDirty,
  lastRev,
  setState,
  onPush,
  onPull,
}: {
  state: ConfirmState
  localTracks: AnimeTrack[]
  localDirty: boolean
  lastRev: number
  setState: React.Dispatch<React.SetStateAction<ConfirmState | null>>
  onPush: () => void
  onPull: () => void
}): JSX.Element {
  const push = state.direction === 'push'
  const hasConflict = push ? state.remote.rev !== lastRev : localDirty

  const confirmAction = (): void => {
    if (hasConflict && !state.forceArmed) {
      setState({ ...state, forceArmed: true })
      return
    }
    if (push) void onPush()
    else onPull()
  }

  return (
    <ModalShell onBackdrop={() => setState(null)}>
      <div className="flex items-center gap-4 px-7 pt-6 pb-5 border-b border-outline-variant/10">
        <div className={`w-11 h-11 rounded-xl border flex items-center justify-center ${
          push ? 'bg-primary/15 border-primary/25 text-primary' : 'bg-secondary/15 border-secondary/25 text-secondary'
        }`}>
          <span className="material-symbols-outlined text-[22px]">{push ? 'cloud_upload' : 'cloud_download'}</span>
        </div>
        <div>
          <h3 className="text-base font-black tracking-tight">{push ? '上传到网页版' : '从网页版拉取'}</h3>
          <p className="text-[11px] text-on-surface-variant/60 mt-0.5 font-label">
            {push ? '网页版追番将按这份本地列表覆盖' : '本地追番将按网页版列表覆盖'}
          </p>
        </div>
      </div>

      <div className="px-7 py-5 space-y-3">
        {hasConflict && (
          <div className="rounded-xl border border-error/40 bg-error/[0.08] px-4 py-3 flex items-start gap-2.5">
            <span className="material-symbols-outlined text-error text-[18px] mt-px">warning</span>
            <div>
              <p className="text-xs font-bold text-error">
                {push ? '网页版有尚未拉取的改动' : '本地有尚未上传的改动'}
              </p>
              <p className="text-[11px] text-error/85 mt-0.5 font-label leading-relaxed">
                {push
                  ? `网页版 rev=${state.remote.rev}，本地最后同步 rev=${lastRev}。建议取消并先拉取。`
                  : '继续拉取会覆盖当前本地修改。建议取消并先上传。'}
              </p>
            </div>
          </div>
        )}

        <div className="rounded-xl border border-outline-variant/15 bg-surface-container px-4 py-4 grid grid-cols-[1fr_auto_1fr] gap-3 items-center">
          <div>
            <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50">本地</p>
            <p className="text-sm font-mono mt-1">追番 {localTracks.length} 部</p>
            <p className="text-[10px] text-on-surface-variant/50 mt-1">rev={lastRev}</p>
          </div>
          <span className={`material-symbols-outlined ${push ? 'text-primary' : 'text-secondary'}`}>
            {push ? 'arrow_forward' : 'arrow_back'}
          </span>
          <div>
            <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50">网页版</p>
            <p className="text-sm font-mono mt-1">追番 {state.remote.tracks.length} 部</p>
            <p className="text-[10px] text-on-surface-variant/50 mt-1">rev={state.remote.rev}</p>
          </div>
        </div>
      </div>

      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <button
          type="button"
          onClick={() => setState(null)}
          className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors"
        >
          取消
        </button>
        <button
          type="button"
          onClick={confirmAction}
          className={`flex-1 py-3 rounded-xl border text-sm font-bold transition-colors ${
            hasConflict
              ? 'border-error/50 bg-error/15 text-error hover:bg-error/25'
              : push
                ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
                : 'border-secondary/40 bg-secondary/10 text-secondary hover:bg-secondary/20'
          }`}
        >
          {hasConflict
            ? state.forceArmed ? '再次确认覆盖' : '我知道风险，强制覆盖'
            : push ? '确认上传' : '确认拉取'}
        </button>
      </div>
    </ModalShell>
  )
}
