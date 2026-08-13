// 追番列表(anime.json)的 WebDAV 同步入口 —— 与锦囊妙计(homework.json)各管各的 rev /
// 冲突检测 / 确认弹窗。一个 chip + 上传/下载两个按钮,点开弹 SyncConfirmModal 让用户在
// 「本地 vs 远端」的对比里二次确认,避免一键覆盖。
//
// 迁移兜底:远端还没有 anime.json(404)时,pull 会回退去读 homework.json 里的老 `tracks` 字段
// 升级前的数据不丢;一旦 push 过一次 anime.json,之后就只走 anime.json。
//
// 所有存储键带 `maple-anime-` 前缀,与 homework 那套独立。

import { useEffect, useState } from 'react'
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
import { buildAnimeReportHtml } from '../utils/animeReport'
import { probe, probeToPaint } from '../utils/probe'

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
   * 推荐记录。老 blob 里这里是 []。与 tracks 共用同一份 rev/ts —— 它们语义同源,拆成两个文件
   * 反而会带来「改了 tracks 但 recommendations 没变,要不要 push」的纠结。
   */
  recommendations: Recommendation[]
  /** 为 true 表示数据来自老 homework.json 的 tracks 字段(迁移兜底)。 */
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
 * 解析 anime.json。v1 没有 recommendations 字段,读到时回落成 [];老版本读到 v2 会直接忽略
 * 新字段。两边都无害,所以可以渐进升级,不需要单独的迁移步骤。
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
 * 兜底解析老的 homework.json,把 `tracks` 抽出来当初始数据。rev 标 0 让「远端比本地新」的
 * 冲突判定永远倒向本地;用户拉取一次再 push,才算建立起 anime.json 自己的 rev 链。
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
 * 5 个状态 + 3 个类目全都统计。只显示 watching / completed 会让用户怀疑「想看 / 观望」
 * 是不是没传(其实传了,只是没列出来);类目维度同理 —— 数据层本来就一起传,不显示就让人
 * 怀疑漫画小说没上去。全列出来,用户对比本地和远端时一眼看清每个桶各多少。
 */
function trackStats(data: AnimeTrack[]): {
  total: number
  watching: number
  plan: number
  considering: number
  completed: number
  anime: number
  manga: number
  novel: number
  other: number
} {
  return {
    total: data.length,
    watching: data.filter(t => t.status === 'watching').length,
    plan: data.filter(t => t.status === 'plan').length,
    considering: data.filter(t => t.status === 'considering').length,
    completed: data.filter(t => t.status === 'completed').length,
    anime: data.filter(t => t.subjectType === 'anime').length,
    manga: data.filter(t => t.subjectType === 'manga').length,
    novel: data.filter(t => t.subjectType === 'novel').length,
    other: data.filter(t => t.subjectType === 'other').length,
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

  // 同步状态镜像落盘
  useEffect(() => { localStorage.setItem(LAST_REV_KEY, String(lastSyncedRev)) }, [lastSyncedRev])
  useEffect(() => { localStorage.setItem(SNAPSHOT_KEY, lastSyncedSnapshot) }, [lastSyncedSnapshot])

  // 后台探测远端 rev。拉不到 anime.json 时看一眼 homework.json,只为判断「远端有尚未迁移的
  // 数据」。**不写任何东西**,纯信息性,供 chip 决定要不要提示云端更新。
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
            // 让 cloudNewer 恒为 true,chip 提示有可迁移的老数据。真正拉取时会重走一遍 fetchRemote
            // 再次命中这条迁移分支。
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

  // 本地是否有未同步改动:把当前 tracks + recommendations 序列化后与上次同步的快照比。
  // 序列化整张表(追番多时几百 KB)**不能放在 useMemo 里** —— store hook 每次都返回新数组引用
  // memo 根本不命中,于是每次 mutate / 重渲染都在渲染线程上卡一次序列化。改成 200ms 防抖的
  // effect 里算、结果写进 state;这个值只驱动「未同步」chip 的启用态,延迟 200ms 用户无感。
  const [localDirty, setLocalDirty] = useState(false)
  useEffect(() => {
    const h = window.setTimeout(() => {
      setLocalDirty(snapshotOf(tracks, recommendations) !== lastSyncedSnapshot)
    }, 200)
    return () => window.clearTimeout(h)
  }, [tracks, recommendations, lastSyncedSnapshot])
  const cloudNewer = remoteRev !== null && remoteRev > lastSyncedRev

  const syncSettle = (status: SyncStatus, msg: string): void => {
    setSyncStatus(status)
    setSyncMsg(msg)
    if (status === 'synced' || status === 'error') {
      setTimeout(() => { setSyncStatus('idle'); setSyncMsg('') }, 3500)
    }
  }

  // 拉远端:先试 anime.json,404 时回落到老 homework.json 里的 tracks。
  const fetchRemote = async (): Promise<RemoteAnimeBlob | null> => {
    try {
      const end = probe('webdav:anime-pull-fetch')
      const jsonStr = await window.webdavApi.pull('anime')
      end(`${jsonStr.length}B`)
      return parseAnimeBlob(jsonStr)
    } catch {
      try {
        const homeworkStr = await window.webdavApi.pull('homework')
        const parsed = parseLegacyHomeworkBlobForTracks(homeworkStr)
        // homework.json 存在但 tracks 为空 → 视作远端没有追番数据,返回 null 走「远端不存在」分支。
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
      const end = probe(`webdav:anime-push(${blob.length}B)`)
      await window.webdavApi.push('anime', blob)
      end()
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

  // 发送极简报告到 QQ 邮箱 —— 跟 push/pull 不同：不需要二次确认弹窗
  // （邮件是单向的、不会覆盖任何数据），点了就发，发完用 syncMsg 通道显示
  // 「报告已发送 / 未启用 / 配置不全 / 错误」。reason 字符串映射成中文。
  const sendReport = async (): Promise<void> => {
    if (syncStatus === 'syncing' || syncConfirm) return
    setSyncStatus('syncing')
    setSyncMsg('发送报告中…')
    try {
      const html = buildAnimeReportHtml({ tracks, recommendations })
      const result = await window.mailApi.sendAnimeReport(html)
      if (result.sent) {
        syncSettle('synced', '报告已发送')
        return
      }
      const reasonText =
        result.reason === 'disabled' ? '请先到设置开启邮件功能' :
        result.reason === 'incomplete-config' ? '请先到设置填邮箱与授权码' :
        result.reason || '发送失败'
      syncSettle('error', reasonText)
    } catch (e: unknown) {
      syncSettle('error', ipcErrMsg(e, '发送失败'))
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
      // 应用数据 → 列表重渲染 → 绘制 的耗时(跟 fetch 分开,看慢在网络还是渲染)。
      probeToPaint(`webdav:anime-pull-apply(${newTracks.length}+${newRecs.length})`)
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
        onSendReport={sendReport}
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
  syncStatus, syncMsg, lastSyncTime, localDirty, cloudNewer, disabled, onPush, onPull, onSendReport,
}: {
  syncStatus: SyncStatus
  syncMsg: string
  lastSyncTime: number | null
  localDirty: boolean
  cloudNewer: boolean
  disabled: boolean
  onPush: () => void
  onPull: () => void
  /** 触发"发送极简报告到 QQ 邮箱"。复用 syncStatus 通道做进度/反馈展示。 */
  onSendReport: () => void
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
      // 复用 syncMsg 当自定义文案 —— sendReport 流程用 "发送报告中…",
      // 默认 sync 流程用 "同步中…"。
      text: syncMsg || '同步中…',
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
        <button
          onClick={onSendReport}
          disabled={disabled}
          title="发送极简报告到 QQ 邮箱（手机扫读）"
          className="p-1 rounded text-on-surface-variant/50 hover:text-tertiary hover:bg-tertiary/10 transition-colors disabled:opacity-30"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 13 }}>mail</span>
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
                <p className="text-xs font-mono">动画 {localTr.anime} · 漫画 {localTr.manga} · 小说 {localTr.novel}{localTr.other > 0 ? ` · 其他 ${localTr.other}` : ''}</p>
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
                  <p className="text-xs font-mono">动画 {remoteTr!.anime} · 漫画 {remoteTr!.manga} · 小说 {remoteTr!.novel}{remoteTr!.other > 0 ? ` · 其他 ${remoteTr!.other}` : ''}</p>
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
