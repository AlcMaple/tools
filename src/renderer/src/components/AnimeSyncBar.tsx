// 追番列表 (anime.json) 的独立 WebDAV 同步入口 —— 跟阵容知识库
// (homework.json) 各管各的 rev / 冲突检测 / 确认弹窗。
//
// 整页面就一个 chip + 两个按钮（上传 / 下载）；点开后弹出 SyncConfirmModal
// 让用户在「本地 vs 远端」对比里二次确认，避免一键覆盖。
//
// 迁移兜底：anime.json 在远端还不存在（404）时，pull 会回退去读
// homework.json 的老 `tracks` 字段 —— 升级前的数据不丢。一旦用户在新版
// 里 push 过一次 anime.json，之后的 pull 都走 anime.json，homework.json
// 里残留的老 tracks 字段就被忽略掉了。
//
// 储存键全部加 `maple-anime-` 前缀，跟 homework 那套独立。

import { useEffect, useMemo, useState } from 'react'
import {
  animeTrackStore,
  normalizeTracks,
  useAnimeTrackList,
  type AnimeTrack,
} from '../stores/animeTrackStore'
import {
  recommendationStore,
  normalizeRecommendations,
  useRecommendationList,
  type Recommendation,
} from '../stores/recommendationStore'
import { ipcErrMsg, ModalShell } from '../pages/homework/shared'

// ── Storage keys ────────────────────────────────────────────────────────────

const LAST_SYNC_KEY = 'maple-anime-last-sync'
const LAST_REV_KEY = 'maple-anime-last-rev'
const SNAPSHOT_KEY = 'maple-anime-last-snapshot'

// ── Types ────────────────────────────────────────────────────────────────────

type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error'
type SyncDirection = 'push' | 'pull'

interface RemoteAnimeBlob {
  rev: number
  ts: string
  tracks: AnimeTrack[]
  /**
   * 推荐记录 —— blob v2 加入。老 blob（v1 或 homework.json 迁移）这里是 []。
   * 跟 tracks 共用同一份 rev/ts，因为它们语义同源（都是「我的追番相关」数据），
   * 拆成两个文件 sync 反而会带来"改了 tracks 但 recommendations 不变要不要
   * push"的纠结。
   */
  recommendations: Recommendation[]
  /** True = 数据来自老的 homework.json 的 tracks 字段（迁移兜底）。 */
  fromLegacyHomework: boolean
}

interface SyncConfirmState {
  direction: SyncDirection
  loading: boolean
  remote: RemoteAnimeBlob | null
  loadError?: string
  forceArmed: boolean
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function snapshotOf(tracks: AnimeTrack[], recommendations: Recommendation[]): string {
  return JSON.stringify({ tracks, recommendations })
}

/**
 * 解析 anime.json blob。
 *
 * - v1: `{ _v: 1, _rev, _ts, tracks }` —— 没有 recommendations 字段
 * - v2: `{ _v: 2, _rev, _ts, tracks, recommendations }`
 *
 * 新版本读 v1 时 recommendations fallback 为 []，老版本读 v2 时直接忽略
 * 新字段（无害）。所以可以渐进升级，不需要单独的 migration step。
 */
function parseAnimeBlob(jsonStr: string): RemoteAnimeBlob {
  const raw = JSON.parse(jsonStr)
  if (raw && typeof raw === 'object') {
    return {
      rev: typeof raw._rev === 'number' ? raw._rev : 0,
      ts: typeof raw._ts === 'string' ? raw._ts : '',
      tracks: normalizeTracks(raw.tracks),
      recommendations: normalizeRecommendations(raw.recommendations),
      fromLegacyHomework: false,
    }
  }
  throw new Error('远端数据格式不识别')
}

/**
 * 兜底解析 homework.json 的老 blob，把 `tracks` 字段抽出来当作初始 anime
 * 数据用。rev 标 0（让"远端比本地新"的冲突判定永远倒向本地数据），ts
 * 也清空 —— 用户拉取一次后再 push，才算建立 anime.json 的真正 rev 链。
 *
 * recommendations 这条迁移路径下永远是 []（老 homework.json 从来不带这字段）。
 */
function parseLegacyHomeworkBlobForTracks(jsonStr: string): RemoteAnimeBlob {
  const raw = JSON.parse(jsonStr)
  if (Array.isArray(raw)) {
    return { rev: 0, ts: '', tracks: [], recommendations: [], fromLegacyHomework: true }
  }
  return {
    rev: 0,
    ts: '',
    tracks: normalizeTracks((raw as { tracks?: unknown })?.tracks),
    recommendations: [],
    fromLegacyHomework: true,
  }
}

// ── Stats ────────────────────────────────────────────────────────────────────

/**
 * 5 个状态都统计 —— 早期只有 watching / completed，但确认弹窗里只显示
 * 这俩会让用户怀疑「想看 / 暂停 / 弃番」是不是没传（实际是传了，total 已
 * 经体现）。把所有状态都列出来透明化，让用户对比 local vs remote 时一眼
 * 看清楚每个桶分别多少。
 */
function trackStats(data: AnimeTrack[]): {
  total: number
  watching: number
  plan: number
  considering: number
  completed: number
} {
  return {
    total: data.length,
    watching: data.filter(t => t.status === 'watching').length,
    plan: data.filter(t => t.status === 'plan').length,
    considering: data.filter(t => t.status === 'considering').length,
    completed: data.filter(t => t.status === 'completed').length,
  }
}

function formatRemoteTs(ts: string): string {
  if (!ts) return '未知'
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ── Main component ───────────────────────────────────────────────────────────

export function AnimeSyncBar(): JSX.Element {
  const tracks = useAnimeTrackList()
  const recommendations = useRecommendationList()

  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [syncMsg, setSyncMsg] = useState('')
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(() => {
    const v = localStorage.getItem(LAST_SYNC_KEY)
    return v ? Number(v) : null
  })
  const [lastSyncedRev, setLastSyncedRev] = useState<number>(() => {
    const v = localStorage.getItem(LAST_REV_KEY)
    return v ? Number(v) : 0
  })
  const [lastSyncedSnapshot, setLastSyncedSnapshot] = useState<string>(() => {
    const stored = localStorage.getItem(SNAPSHOT_KEY)
    if (stored) return stored
    return snapshotOf(animeTrackStore.list(), recommendationStore.list())
  })
  const [remoteRev, setRemoteRev] = useState<number | null>(null)
  const [syncConfirm, setSyncConfirm] = useState<SyncConfirmState | null>(null)

  // Persist sync state mirrors
  useEffect(() => { localStorage.setItem(LAST_REV_KEY, String(lastSyncedRev)) }, [lastSyncedRev])
  useEffect(() => { localStorage.setItem(SNAPSHOT_KEY, lastSyncedSnapshot) }, [lastSyncedSnapshot])

  // Background probe: try anime.json's rev; fall back to homework.json's tracks
  // only to detect "remote has data we haven't migrated yet". Doesn't write
  // anything — purely informational so the chip can decide if cloudNewer.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const jsonStr = await window.webdavApi.pull('anime')
        if (cancelled) return
        const parsed = parseAnimeBlob(jsonStr)
        setRemoteRev(parsed.rev)
      } catch {
        // 没拉到 anime.json 时试一下 homework.json —— 还在用老 blob 的设备
        // 升级到新版后第一次开 MyAnime，让 chip 能提示有云端数据待迁移
        try {
          const homeworkStr = await window.webdavApi.pull('homework')
          if (cancelled) return
          const parsed = parseLegacyHomeworkBlobForTracks(homeworkStr)
          if (parsed.tracks.length > 0) {
            // 让 cloudNewer 永远为 true → chip 显示「云端有更新」，提示用户
            // 这边其实有可迁移的老数据。实际拉取时 openSyncConfirm 会重走
            // fetchRemote，再次命中这条迁移分支。
            setRemoteRev(Math.max(lastSyncedRev + 1, 1))
          }
        } catch {
          // ignore — network / no remote / not configured
        }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Local dirty: stringify current tracks + recommendations vs last synced snapshot.
  const currentSnapshot = useMemo(() => snapshotOf(tracks, recommendations), [tracks, recommendations])
  const localDirty = currentSnapshot !== lastSyncedSnapshot
  const cloudNewer = remoteRev !== null && remoteRev > lastSyncedRev

  const syncSettle = (status: SyncStatus, msg: string): void => {
    setSyncStatus(status)
    setSyncMsg(msg)
    if (status === 'synced' || status === 'error') {
      setTimeout(() => { setSyncStatus('idle'); setSyncMsg('') }, 3500)
    }
  }

  // Pull remote: try anime.json, fall back to homework.json tracks on 404.
  const fetchRemote = async (): Promise<RemoteAnimeBlob | null> => {
    try {
      const jsonStr = await window.webdavApi.pull('anime')
      return parseAnimeBlob(jsonStr)
    } catch {
      try {
        const homeworkStr = await window.webdavApi.pull('homework')
        const parsed = parseLegacyHomeworkBlobForTracks(homeworkStr)
        // 当 homework.json 也存在但 tracks 字段是空 / 不存在，视作"远端没有
        // 追番数据"——返回 null，触发 confirm 弹窗的"远端不存在"分支。
        return parsed.tracks.length > 0 ? parsed : null
      } catch {
        return null
      }
    }
  }

  const openSyncConfirm = async (direction: SyncDirection): Promise<void> => {
    if (syncStatus === 'syncing' || syncConfirm) return
    setSyncConfirm({ direction, loading: true, remote: null, forceArmed: false })
    try {
      const remote = await fetchRemote()
      setSyncConfirm({ direction, loading: false, remote, forceArmed: false })
    } catch (e: unknown) {
      setSyncConfirm({
        direction,
        loading: false,
        remote: null,
        loadError: ipcErrMsg(e, '读取远端失败'),
        forceArmed: false,
      })
    }
  }

  const executePush = async (): Promise<void> => {
    if (!syncConfirm) return
    const remoteRevNow = syncConfirm.remote?.rev ?? 0
    const newRev = Math.max(lastSyncedRev, remoteRevNow) + 1
    setSyncConfirm(null)
    setSyncStatus('syncing')
    setSyncMsg('')
    try {
      // blob v2：tracks + recommendations 一起打包。老 v1 reader 读到这份会
      // 忽略 recommendations 字段（数据不丢，只是不解析），新 reader 读老 v1
      // 时 recommendations 落地为 []，渐进升级。
      const blob = JSON.stringify({
        _v: 2,
        _rev: newRev,
        _ts: new Date().toISOString(),
        tracks,
        recommendations,
      })
      await window.webdavApi.push('anime', blob)
      const now = Date.now()
      setLastSyncTime(now)
      setLastSyncedRev(newRev)
      setRemoteRev(newRev)
      setLastSyncedSnapshot(snapshotOf(tracks, recommendations))
      localStorage.setItem(LAST_SYNC_KEY, String(now))
      syncSettle('synced', '上传成功')
    } catch (e: unknown) {
      syncSettle('error', ipcErrMsg(e, '上传失败'))
    }
  }

  const executePull = async (): Promise<void> => {
    if (!syncConfirm?.remote) {
      setSyncConfirm(null)
      return
    }
    const remote = syncConfirm.remote
    setSyncConfirm(null)
    setSyncStatus('syncing')
    setSyncMsg('')
    try {
      const newTracks = remote.tracks
      const newRecs = remote.recommendations
      animeTrackStore.replaceAll(newTracks)
      recommendationStore.replaceAll(newRecs)
      const now = Date.now()
      setLastSyncTime(now)
      // 兜底拉来的是老 homework.json 的 tracks 字段 → rev=0；这种数据
      // 没有真正的 anime.json rev 链，本地保留 0 即可，下次 push 就会
      // 从 max(0, 0) + 1 = 1 开始建立 anime.json 自己的 rev 序列。
      setLastSyncedRev(remote.rev)
      setRemoteRev(remote.rev)
      setLastSyncedSnapshot(snapshotOf(newTracks, newRecs))
      localStorage.setItem(LAST_SYNC_KEY, String(now))
      syncSettle(
        'synced',
        remote.fromLegacyHomework ? '已从老数据迁移' : '拉取成功'
      )
    } catch (e: unknown) {
      syncSettle('error', ipcErrMsg(e, '拉取失败'))
    }
  }

  return (
    <>
      <SyncChip
        syncStatus={syncStatus}
        syncMsg={syncMsg}
        lastSyncTime={lastSyncTime}
        localDirty={localDirty}
        cloudNewer={cloudNewer}
        disabled={syncStatus === 'syncing' || !!syncConfirm}
        onPush={() => openSyncConfirm('push')}
        onPull={() => openSyncConfirm('pull')}
      />
      {syncConfirm && (
        <SyncConfirmModal
          state={syncConfirm}
          setState={setSyncConfirm}
          localTracks={tracks}
          localRecommendations={recommendations}
          localDirty={localDirty}
          lastSyncedRev={lastSyncedRev}
          onConfirmPush={executePush}
          onConfirmPull={executePull}
        />
      )}
    </>
  )
}

// ── Chip ─────────────────────────────────────────────────────────────────────

function SyncChip({
  syncStatus, syncMsg, lastSyncTime, localDirty, cloudNewer, disabled, onPush, onPull,
}: {
  syncStatus: SyncStatus
  syncMsg: string
  lastSyncTime: number | null
  localDirty: boolean
  cloudNewer: boolean
  disabled: boolean
  onPush: () => void
  onPull: () => void
}): JSX.Element {
  type ChipKind = 'syncing' | 'synced' | 'error' | 'both' | 'remote' | 'local' | 'idle'
  const kind: ChipKind =
    syncStatus === 'syncing' ? 'syncing' :
    syncStatus === 'synced' ? 'synced' :
    syncStatus === 'error' ? 'error' :
    (localDirty && cloudNewer) ? 'both' :
    cloudNewer ? 'remote' :
    localDirty ? 'local' :
    'idle'
  const idleText = lastSyncTime ? (() => {
    const diff = Date.now() - lastSyncTime
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
    const d = new Date(lastSyncTime)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  })() : '未同步'
  const config: Record<ChipKind, { dot: JSX.Element; text: string; cls: string }> = {
    syncing: {
      dot: <span className="material-symbols-outlined text-primary animate-spin" style={{ fontSize: 13 }}>progress_activity</span>,
      text: '同步中…',
      cls: 'text-primary',
    },
    synced: {
      dot: <span className="w-1.5 h-1.5 rounded-full bg-secondary flex-shrink-0" />,
      text: syncMsg,
      cls: 'text-secondary',
    },
    error: {
      dot: <span className="w-1.5 h-1.5 rounded-full bg-error flex-shrink-0" />,
      text: syncMsg,
      cls: 'text-error',
    },
    both: {
      dot: <span className="w-1.5 h-1.5 rounded-full bg-error flex-shrink-0" />,
      text: '本地与云端都有变化',
      cls: 'text-error',
    },
    remote: {
      dot: <span className="w-1.5 h-1.5 rounded-full bg-secondary flex-shrink-0" />,
      text: '云端有更新',
      cls: 'text-secondary',
    },
    local: {
      dot: <span className="w-1.5 h-1.5 rounded-full bg-tertiary flex-shrink-0" />,
      text: '本地未上传',
      cls: 'text-tertiary',
    },
    idle: {
      dot: <span className="w-1.5 h-1.5 rounded-full bg-outline/40 flex-shrink-0" />,
      text: idleText,
      cls: lastSyncTime ? 'text-on-surface-variant/50' : 'text-on-surface-variant/30',
    },
  }
  const c = config[kind]
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-container-high border border-outline-variant/15">
      {c.dot}
      <span className={`font-label text-[10px] uppercase tracking-widest ${c.cls}`}>{c.text}</span>
      <div className="flex items-center gap-0.5 ml-0.5 border-l border-outline-variant/20 pl-1">
        <button
          onClick={onPush}
          disabled={disabled}
          title="上传追番到坚果云"
          className="p-1 rounded text-on-surface-variant/50 hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-30"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 13 }}>upload</span>
        </button>
        <button
          onClick={onPull}
          disabled={disabled}
          title="从坚果云拉取追番"
          className="p-1 rounded text-on-surface-variant/50 hover:text-secondary hover:bg-secondary/10 transition-colors disabled:opacity-30"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 13 }}>download</span>
        </button>
      </div>
    </div>
  )
}

// ── Confirm modal ───────────────────────────────────────────────────────────

function SyncConfirmModal({
  state, setState, localTracks, localRecommendations, localDirty, lastSyncedRev,
  onConfirmPush, onConfirmPull,
}: {
  state: SyncConfirmState
  setState: React.Dispatch<React.SetStateAction<SyncConfirmState | null>>
  localTracks: AnimeTrack[]
  localRecommendations: Recommendation[]
  localDirty: boolean
  lastSyncedRev: number
  onConfirmPush: () => void
  onConfirmPull: () => void
}): JSX.Element {
  const { direction, loading, remote, loadError, forceArmed } = state
  const isPush = direction === 'push'
  const localTr = trackStats(localTracks)
  const remoteTr = remote ? trackStats(remote.tracks) : null
  const localRecCount = localRecommendations.length
  const remoteRecCount = remote ? remote.recommendations.length : 0

  // push 冲突：远端 rev > 我们上次同步的 rev → 别人已经更新过
  // pull 冲突：本地有未推送改动 → 拉会覆盖
  const hasConflict = !loading && (
    isPush
      ? !!remote && remote.rev > lastSyncedRev
      : localDirty
  )

  const pullImpossible = !isPush && !loading && !remote
  const close = (): void => setState(null)

  const onConfirmClick = (): void => {
    if (hasConflict && !forceArmed) {
      setState({ ...state, forceArmed: true })
      return
    }
    if (isPush) onConfirmPush()
    else onConfirmPull()
  }

  return (
    <ModalShell onBackdrop={close}>
      {/* Header */}
      <div className="flex items-center gap-4 px-7 pt-6 pb-5 border-b border-outline-variant/10">
        <div className={`w-11 h-11 rounded-xl ${isPush ? 'bg-primary/15 border-primary/25' : 'bg-secondary/15 border-secondary/25'} border flex items-center justify-center flex-shrink-0`}>
          <span className={`material-symbols-outlined ${isPush ? 'text-primary' : 'text-secondary'} text-[22px]`}>
            {isPush ? 'upload' : 'download'}
          </span>
        </div>
        <div>
          <h3 className="text-base font-black tracking-tight">{isPush ? '上传追番到云端' : '从云端拉取追番'}</h3>
          <p className="text-[11px] text-on-surface-variant/60 mt-0.5 font-label">
            {isPush ? '把本地追番列表推送到坚果云' : '把云端追番列表应用到本地'}
          </p>
        </div>
      </div>

      <div className="px-7 py-5 space-y-3">
        {loading && (
          <div className="rounded-xl border border-outline-variant/15 bg-surface-container px-4 py-6 flex items-center justify-center gap-3 text-on-surface-variant/70">
            <span className="material-symbols-outlined text-primary animate-spin" style={{ fontSize: 18 }}>progress_activity</span>
            <span className="text-sm font-label">读取远端状态…</span>
          </div>
        )}

        {!loading && remote?.fromLegacyHomework && (
          <div className="rounded-xl border border-tertiary/30 bg-tertiary/[0.08] px-4 py-3 flex items-start gap-2.5">
            <span className="material-symbols-outlined text-tertiary text-[18px] mt-px">restart_alt</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-tertiary">从老数据迁移</p>
              <p className="text-[11px] text-tertiary/85 mt-0.5 font-label leading-relaxed">
                远端还没有独立的 anime.json，但老版本的 homework.json 里有 {remote.tracks.length} 部追番。
                确认拉取后会把这些数据迁过来；下次再上传就会写到 anime.json，跟阵容数据彻底分开。
              </p>
            </div>
          </div>
        )}

        {!loading && hasConflict && (
          <div className="rounded-xl border border-error/40 bg-error/[0.08] px-4 py-3 flex items-start gap-2.5">
            <span className="material-symbols-outlined text-error text-[18px] mt-px">warning</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-error">
                {isPush ? '云端比你的最后同步新' : '本地有未同步的追番改动'}
              </p>
              <p className="text-[11px] text-error/85 mt-0.5 font-label leading-relaxed">
                {isPush
                  ? `云端 rev=${remote!.rev}，你的最后同步 rev=${lastSyncedRev}。继续上传将覆盖其他设备在此期间的所有改动。建议先点拉取。`
                  : '当前本地追番列表有未推送到云端的修改。继续拉取将丢失这些改动。建议先点上传。'}
              </p>
            </div>
          </div>
        )}

        {!loading && pullImpossible && (
          <div className="rounded-xl border border-outline-variant/30 bg-surface-container px-4 py-3 flex items-start gap-2.5">
            <span className="material-symbols-outlined text-on-surface-variant text-[18px] mt-px">cloud_off</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-on-surface-variant">远端不存在追番数据</p>
              <p className="text-[11px] text-on-surface-variant/70 mt-0.5 font-label">
                {loadError ? `读取远端失败：${loadError}` : '坚果云上还没有 anime.json，无需拉取。请先在某台设备上传一次。'}
              </p>
            </div>
          </div>
        )}

        {!loading && (
          <div className="rounded-xl border border-outline-variant/15 bg-surface-container px-4 py-3 grid grid-cols-[1fr_auto_1fr] gap-3 items-start">
            <div>
              <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-2">本地</p>
              <div className="space-y-1">
                <p className="text-xs font-mono">追番 {localTr.total} 部</p>
                <p className="text-xs font-mono">在追 {localTr.watching} · 想看 {localTr.plan}</p>
                <p className="text-xs font-mono">观望 {localTr.considering} · 看完 {localTr.completed}</p>
                <p className="text-xs font-mono">推荐 {localRecCount} 条</p>
                <p className="text-[10px] font-label text-on-surface-variant/50 mt-1.5">
                  rev={lastSyncedRev}
                  {localDirty && <span className="ml-1 text-tertiary">+ 未同步改动</span>}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-center pt-5">
              <span className={`material-symbols-outlined ${isPush ? 'text-primary' : 'text-secondary'}`} style={{ fontSize: 20 }}>
                {isPush ? 'arrow_forward' : 'arrow_back'}
              </span>
            </div>

            <div>
              <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-2">远端</p>
              {remote ? (
                <div className="space-y-1">
                  <p className="text-xs font-mono">追番 {remoteTr!.total} 部</p>
                  <p className="text-xs font-mono">在追 {remoteTr!.watching} · 想看 {remoteTr!.plan}</p>
                  <p className="text-xs font-mono">观望 {remoteTr!.considering} · 看完 {remoteTr!.completed}</p>
                  <p className="text-xs font-mono">推荐 {remoteRecCount} 条</p>
                  <p className="text-[10px] font-label text-on-surface-variant/50 mt-1.5">
                    {remote.fromLegacyHomework
                      ? '老 homework.json'
                      : `rev=${remote.rev}${remote.ts && ` · ${formatRemoteTs(remote.ts)}`}`}
                  </p>
                </div>
              ) : (
                <p className="text-xs font-mono text-on-surface-variant/50">空 / 不存在</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <button
          onClick={close}
          className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors"
        >
          {hasConflict ? (isPush ? '取消，先去拉取' : '取消，先去上传') : '取消'}
        </button>
        <button
          onClick={onConfirmClick}
          disabled={loading || pullImpossible}
          className={`flex-1 py-3 rounded-xl border text-sm font-bold transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed ${
            hasConflict
              ? 'border-error/50 bg-error/15 text-error hover:bg-error/25'
              : isPush
                ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
                : 'border-secondary/40 bg-secondary/10 text-secondary hover:bg-secondary/20'
          }`}
        >
          <span className="material-symbols-outlined text-base leading-none">
            {hasConflict ? 'warning' : isPush ? 'upload' : 'download'}
          </span>
          <span>
            {hasConflict
              ? (forceArmed ? '再次确认覆盖' : '我知道风险，强制覆盖')
              : isPush ? '确认上传' : '确认拉取'}
          </span>
        </button>
      </div>
    </ModalShell>
  )
}
