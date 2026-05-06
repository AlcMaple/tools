import { useEffect, useMemo, useRef, useState } from 'react'
import TopBar from '../components/TopBar'
import HomeworkView, { HomeworkViewHandle } from './homework/HomeworkView'
import ClassicView, { ClassicViewHandle } from './homework/ClassicView'
import {
  ClassicGroup, DefenseGroup,
  ipcErrMsg, normalizeClassic, normalizeHomework,
  ModalShell,
} from './homework/shared'

type Tab = 'homework' | 'classic'
type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error'
type SyncDirection = 'push' | 'pull'

interface SyncRemoteMeta {
  rev: number
  ts: string
  homework: DefenseGroup[]
  classic: ClassicGroup[]
}

interface SyncConfirmState {
  direction: SyncDirection
  loading: boolean
  remote: SyncRemoteMeta | null
  loadError?: string
  forceArmed: boolean
}

const HOMEWORK_KEY = 'maple-homework-data-v2'
const CLASSIC_KEY = 'maple-classic-data-v1'
const TAB_KEY = 'maple-knowledge-active-tab'
const LAST_SYNC_KEY = 'maple-homework-last-sync'
const LAST_REV_KEY = 'maple-knowledge-last-rev'
const SNAPSHOT_KEY = 'maple-knowledge-last-snapshot'

function snapshotOf(homework: DefenseGroup[], classic: ClassicGroup[]): string {
  return JSON.stringify({ homework, classic })
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? JSON.parse(v) as T : fallback
  } catch { return fallback }
}

function parseRemoteBlob(jsonStr: string): SyncRemoteMeta {
  const remote = JSON.parse(jsonStr)
  if (Array.isArray(remote)) {
    // Legacy: array = homework only, no embedded rev/ts
    return { rev: 0, ts: '', homework: remote as DefenseGroup[], classic: [] }
  }
  if (remote && typeof remote === 'object') {
    return {
      rev: typeof remote._rev === 'number' ? remote._rev : 0,
      ts: typeof remote._ts === 'string' ? remote._ts : '',
      homework: Array.isArray(remote.homework) ? remote.homework : [],
      classic: Array.isArray(remote.classic) ? remote.classic : [],
    }
  }
  throw new Error('远端数据格式不识别')
}

function homeworkStats(data: DefenseGroup[]): { defense: number; attacks: number } {
  return {
    defense: data.length,
    attacks: data.reduce((s, d) => s + d.attacks.length, 0),
  }
}

function classicStats(data: ClassicGroup[]): { themes: number; teams: number } {
  return {
    themes: data.length,
    teams: data.reduce((s, d) => s + d.teams.length, 0),
  }
}

function formatRemoteTs(ts: string): string {
  if (!ts) return '未知'
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function HomeworkLookup(): JSX.Element {
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const v = localStorage.getItem(TAB_KEY)
    return v === 'classic' ? 'classic' : 'homework'
  })

  // Eagerly compute initial data so the snapshot init can reuse the same values.
  const initialHomework = (() => normalizeHomework(readJson(HOMEWORK_KEY, [])))()
  const initialClassic = (() => normalizeClassic(readJson(CLASSIC_KEY, [])))()

  const [homeworkData, setHomeworkData] = useState<DefenseGroup[]>(initialHomework)
  const [classicData, setClassicData] = useState<ClassicGroup[]>(initialClassic)

  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [isDebouncing, setIsDebouncing] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [syncMsg, setSyncMsg] = useState('')
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(() => {
    const v = localStorage.getItem(LAST_SYNC_KEY)
    return v ? Number(v) : null
  })

  // Conflict-detection state (C scheme)
  const [lastSyncedRev, setLastSyncedRev] = useState<number>(() => {
    const v = localStorage.getItem(LAST_REV_KEY)
    return v ? Number(v) : 0
  })
  // Snapshot of data at last successful sync — drives `localDirty` via diff.
  // Migration: if no snapshot stored, assume current state is already in sync
  // (previously-dirty state is forgotten — one-time cost of upgrading).
  const [lastSyncedSnapshot, setLastSyncedSnapshot] = useState<string>(() => {
    const stored = localStorage.getItem(SNAPSHOT_KEY)
    return stored ?? snapshotOf(initialHomework, initialClassic)
  })
  // Remote rev seen by background probe / last sync. null = unknown.
  const [remoteRev, setRemoteRev] = useState<number | null>(null)
  const [syncConfirm, setSyncConfirm] = useState<SyncConfirmState | null>(null)

  // localDirty derived from snapshot diff — auto-clears when user reverts edits.
  // Memoized so unrelated re-renders (search keystrokes, tab switches, sync
  // status changes) don't re-stringify the entire dataset.
  const currentSnapshot = useMemo(
    () => snapshotOf(homeworkData, classicData),
    [homeworkData, classicData]
  )
  const localDirty = currentSnapshot !== lastSyncedSnapshot
  const cloudNewer = remoteRev !== null && remoteRev > lastSyncedRev

  const homeworkRef = useRef<HomeworkViewHandle>(null)
  const classicRef = useRef<ClassicViewHandle>(null)

  // Persistence
  useEffect(() => { localStorage.setItem(HOMEWORK_KEY, JSON.stringify(homeworkData)) }, [homeworkData])
  useEffect(() => { localStorage.setItem(CLASSIC_KEY, JSON.stringify(classicData)) }, [classicData])
  useEffect(() => { localStorage.setItem(TAB_KEY, activeTab) }, [activeTab])
  useEffect(() => { localStorage.setItem(LAST_REV_KEY, String(lastSyncedRev)) }, [lastSyncedRev])
  useEffect(() => { localStorage.setItem(SNAPSHOT_KEY, lastSyncedSnapshot) }, [lastSyncedSnapshot])

  // Background probe on mount: query remote rev so the chip can show
  // "云端有更新" without requiring the user to click anything.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const jsonStr = await window.webdavApi.pull()
        if (cancelled) return
        const parsed = parseRemoteBlob(jsonStr)
        setRemoteRev(parsed.rev)
      } catch {
        // No network / no remote / WebDAV unconfigured — silently fall back.
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Reset query when switching tabs (avoids stale debounce ghost dot)
  useEffect(() => {
    setQuery('')
    setDebouncedQuery('')
    setIsDebouncing(false)
    if (debounceRef.current) clearTimeout(debounceRef.current)
  }, [activeTab])

  const handleQueryChange = (v: string) => {
    setQuery(v)
    setIsDebouncing(true)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(v.trim())
      setIsDebouncing(false)
    }, 220)
  }

  const clearQuery = () => {
    setQuery('')
    setDebouncedQuery('')
    setIsDebouncing(false)
    if (debounceRef.current) clearTimeout(debounceRef.current)
  }

  const handleAdd = () => {
    if (activeTab === 'homework') homeworkRef.current?.openAdd()
    else classicRef.current?.openAdd()
  }

  const syncSettle = (status: SyncStatus, msg: string) => {
    setSyncStatus(status)
    setSyncMsg(msg)
    if (status === 'synced' || status === 'error') {
      setTimeout(() => { setSyncStatus('idle'); setSyncMsg('') }, 3500)
    }
  }

  // Views just call the raw setters — `localDirty` is recomputed from the
  // snapshot diff each render, so no manual flagging is needed.

  // ── Sync intent: open confirmation modal, fetch remote in background ─────
  const openSyncConfirm = async (direction: SyncDirection) => {
    if (syncStatus === 'syncing' || syncConfirm) return
    setSyncConfirm({ direction, loading: true, remote: null, forceArmed: false })
    try {
      const jsonStr = await window.webdavApi.pull()
      const parsed = parseRemoteBlob(jsonStr)
      setSyncConfirm({ direction, loading: false, remote: parsed, forceArmed: false })
    } catch (e: unknown) {
      // Pull failure (404 / network / parse): treat as no remote yet.
      // Push can still proceed (cold start); pull cannot.
      setSyncConfirm({
        direction,
        loading: false,
        remote: null,
        loadError: ipcErrMsg(e, '读取远端失败'),
        forceArmed: false,
      })
    }
  }

  const executePush = async () => {
    if (!syncConfirm) return
    const remoteRev = syncConfirm.remote?.rev ?? 0
    const newRev = Math.max(lastSyncedRev, remoteRev) + 1
    setSyncConfirm(null)
    setSyncStatus('syncing')
    setSyncMsg('')
    try {
      const blob = JSON.stringify({
        _v: 2,
        _rev: newRev,
        _ts: new Date().toISOString(),
        homework: homeworkData,
        classic: classicData,
      })
      await window.webdavApi.push(blob)
      const now = Date.now()
      setLastSyncTime(now)
      setLastSyncedRev(newRev)
      setRemoteRev(newRev)
      setLastSyncedSnapshot(snapshotOf(homeworkData, classicData))
      localStorage.setItem(LAST_SYNC_KEY, String(now))
      syncSettle('synced', '上传成功')
    } catch (e: unknown) {
      syncSettle('error', ipcErrMsg(e, '上传失败'))
    }
  }

  const executePull = async () => {
    if (!syncConfirm?.remote) {
      setSyncConfirm(null)
      return
    }
    const remote = syncConfirm.remote
    setSyncConfirm(null)
    setSyncStatus('syncing')
    setSyncMsg('')
    try {
      const newHomework = normalizeHomework(remote.homework)
      const newClassic = normalizeClassic(remote.classic)
      setHomeworkData(newHomework)
      setClassicData(newClassic)
      const now = Date.now()
      setLastSyncTime(now)
      setLastSyncedRev(remote.rev)
      setRemoteRev(remote.rev)
      setLastSyncedSnapshot(snapshotOf(newHomework, newClassic))
      localStorage.setItem(LAST_SYNC_KEY, String(now))
      syncSettle('synced', '拉取成功')
    } catch (e: unknown) {
      syncSettle('error', ipcErrMsg(e, '拉取失败'))
    }
  }

  const searchPlaceholder = activeTab === 'homework'
    ? '模糊搜索防守方角色…'
    : '模糊搜索主题标题…'

  const addLabel = activeTab === 'homework' ? '添加作业' : '添加经典阵容'

  return (
    <div className="relative min-h-full bg-background">
      <TopBar placeholder="搜索阵容、角色名…" />
      <div className="pt-16">
        {/* Sticky page header */}
        <div className="sticky top-0 z-30 bg-surface-container-lowest border-b border-outline-variant/10 px-8 py-5">
          <div className="flex items-end justify-between gap-6 flex-wrap">
            <div>
              <div className="flex items-center gap-2 mb-2 text-xs font-label text-outline uppercase tracking-widest">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>menu_book</span>
                <span>Tools</span>
                <span className="text-outline-variant">/</span>
                <span className="text-on-surface font-bold">阵容知识库</span>
              </div>
              <h1 className="text-3xl font-black tracking-tighter text-on-surface">阵容知识库</h1>
              <p className="text-sm text-on-surface-variant/80 mt-1 font-label">
                查询作业 · 浏览经典阵容 · 一站式阵容工具
              </p>
            </div>

            <div className="flex items-center gap-3">
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-base">search</span>
                <input
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  className="w-[380px] bg-surface-container-high border border-outline-variant/20 rounded-xl py-2.5 pl-10 pr-20 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/40 focus:bg-surface-bright transition-all placeholder:text-on-surface-variant/40"
                  placeholder={searchPlaceholder}
                  value={query}
                  onChange={e => handleQueryChange(e.target.value)}
                />
                {isDebouncing && (
                  <div className="absolute right-10 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-primary pulse-dot" />
                )}
                {query && !isDebouncing && (
                  <button
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant/60 hover:text-primary p-1"
                    onClick={clearQuery}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
                  </button>
                )}
              </div>
              <button
                onClick={handleAdd}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary font-label text-xs uppercase tracking-widest hover:bg-primary-fixed transition-all active:scale-95 shadow-lg shadow-primary/10 whitespace-nowrap"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}>add</span>
                {addLabel}
              </button>
            </div>
          </div>

          {/* Tabs + Sync chip row */}
          <div className="mt-4 flex items-center justify-between gap-4 flex-wrap">
            <div className="inline-flex bg-surface-container rounded-lg p-1 border border-outline-variant/15 gap-1">
              <button
                onClick={() => setActiveTab('homework')}
                className={`px-4 py-1.5 rounded-md font-label text-xs uppercase tracking-widest transition-colors flex items-center gap-1.5 ${
                  activeTab === 'homework'
                    ? 'bg-primary/15 text-primary border border-primary/20 font-bold'
                    : 'text-on-surface-variant/60 hover:text-on-surface hover:bg-surface-container-high border border-transparent'
                }`}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 14, fontVariationSettings: activeTab === 'homework' ? "'FILL' 1" : "'FILL' 0" }}>shield</span>
                作业查询
              </button>
              <button
                onClick={() => setActiveTab('classic')}
                className={`px-4 py-1.5 rounded-md font-label text-xs uppercase tracking-widest transition-colors flex items-center gap-1.5 ${
                  activeTab === 'classic'
                    ? 'bg-tertiary/15 text-tertiary border border-tertiary/20 font-bold'
                    : 'text-on-surface-variant/60 hover:text-on-surface hover:bg-surface-container-high border border-transparent'
                }`}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 14, fontVariationSettings: activeTab === 'classic' ? "'FILL' 1" : "'FILL' 0" }}>auto_awesome</span>
                经典阵容
              </button>
            </div>

            {/* Sync chip (shared, sends combined blob) */}
            {(() => {
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
                return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`
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
                      onClick={() => openSyncConfirm('push')}
                      disabled={syncStatus === 'syncing' || !!syncConfirm}
                      title="上传到坚果云"
                      className="p-1 rounded text-on-surface-variant/50 hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-30"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 13 }}>upload</span>
                    </button>
                    <button
                      onClick={() => openSyncConfirm('pull')}
                      disabled={syncStatus === 'syncing' || !!syncConfirm}
                      title="从坚果云拉取"
                      className="p-1 rounded text-on-surface-variant/50 hover:text-secondary hover:bg-secondary/10 transition-colors disabled:opacity-30"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 13 }}>download</span>
                    </button>
                  </div>
                </div>
              )
            })()}
          </div>
        </div>

        {/* View content */}
        {activeTab === 'homework' ? (
          <HomeworkView
            ref={homeworkRef}
            data={homeworkData}
            setData={setHomeworkData}
            query={debouncedQuery}
            onClearQuery={clearQuery}
          />
        ) : (
          <ClassicView
            ref={classicRef}
            data={classicData}
            setData={setClassicData}
            query={debouncedQuery}
            onClearQuery={clearQuery}
          />
        )}

        {/* Sync confirm modal */}
        {syncConfirm && (
          <SyncConfirmModal
            state={syncConfirm}
            setState={setSyncConfirm}
            localHomework={homeworkData}
            localClassic={classicData}
            localDirty={localDirty}
            lastSyncedRev={lastSyncedRev}
            onConfirmPush={executePush}
            onConfirmPull={executePull}
          />
        )}
      </div>
    </div>
  )
}

// ── Sync confirm modal ─────────────────────────────────────────────────────
function SyncConfirmModal({
  state, setState,
  localHomework, localClassic, localDirty, lastSyncedRev,
  onConfirmPush, onConfirmPull,
}: {
  state: SyncConfirmState
  setState: React.Dispatch<React.SetStateAction<SyncConfirmState | null>>
  localHomework: DefenseGroup[]
  localClassic: ClassicGroup[]
  localDirty: boolean
  lastSyncedRev: number
  onConfirmPush: () => void
  onConfirmPull: () => void
}): JSX.Element {
  const { direction, loading, remote, loadError, forceArmed } = state
  const isPush = direction === 'push'

  const localHw = homeworkStats(localHomework)
  const localCl = classicStats(localClassic)
  const remoteHw = remote ? homeworkStats(remote.homework) : null
  const remoteCl = remote ? classicStats(remote.classic) : null

  // Conflict logic:
  // - push: remote exists with rev > lastSyncedRev (someone updated cloud after our last sync)
  // - pull: localDirty=true (we have unsynced local changes that pull would overwrite)
  const hasConflict = !loading && (
    isPush
      ? !!remote && remote.rev > lastSyncedRev
      : localDirty
  )

  // Pull is impossible when remote is missing.
  const pullImpossible = !isPush && !loading && !remote

  const close = () => setState(null)

  const onConfirmClick = () => {
    if (hasConflict && !forceArmed) {
      // First click on the destructive button: arm it.
      setState({ ...state, forceArmed: true })
      return
    }
    if (isPush) onConfirmPush()
    else onConfirmPull()
  }

  // Reset arm if the user clicks anywhere else (cancel button etc.) — handled
  // implicitly by close()/state transitions.

  return (
    <ModalShell onBackdrop={close}>
      {/* Header */}
      <div className="flex items-center gap-4 px-7 pt-6 pb-5 border-b border-outline-variant/10">
        <div className={`w-11 h-11 rounded-xl ${isPush ? 'bg-primary/15 border-primary/25' : 'bg-secondary/15 border-secondary/25'} border flex items-center justify-center flex-shrink-0`}>
          <span className={`material-symbols-outlined ${isPush ? 'text-primary' : 'text-secondary'} text-[22px]`}>{isPush ? 'upload' : 'download'}</span>
        </div>
        <div>
          <h3 className="text-base font-black tracking-tight">{isPush ? '上传到云端' : '从云端拉取'}</h3>
          <p className="text-[11px] text-on-surface-variant/60 mt-0.5 font-label">
            {isPush ? '把本地数据推送到坚果云' : '把云端数据应用到本地'}
          </p>
        </div>
      </div>

      <div className="px-7 py-5 space-y-3">
        {/* Loading */}
        {loading && (
          <div className="rounded-xl border border-outline-variant/15 bg-surface-container px-4 py-6 flex items-center justify-center gap-3 text-on-surface-variant/70">
            <span className="material-symbols-outlined text-primary animate-spin" style={{ fontSize: 18 }}>progress_activity</span>
            <span className="text-sm font-label">读取远端状态…</span>
          </div>
        )}

        {/* Conflict banner */}
        {!loading && hasConflict && (
          <div className="rounded-xl border border-error/40 bg-error/[0.08] px-4 py-3 flex items-start gap-2.5">
            <span className="material-symbols-outlined text-error text-[18px] mt-px">warning</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-error">
                {isPush ? '云端比你的最后同步新' : '本地有未同步的改动'}
              </p>
              <p className="text-[11px] text-error/85 mt-0.5 font-label leading-relaxed">
                {isPush
                  ? `云端 rev=${remote!.rev}，你的最后同步 rev=${lastSyncedRev}。继续上传将覆盖其他设备在此期间的所有改动。建议先点拉取。`
                  : '当前本地数据含有未推送到云端的修改。继续拉取将丢失这些改动。建议先点上传。'}
              </p>
            </div>
          </div>
        )}

        {/* Pull impossible (remote missing) */}
        {!loading && pullImpossible && (
          <div className="rounded-xl border border-outline-variant/30 bg-surface-container px-4 py-3 flex items-start gap-2.5">
            <span className="material-symbols-outlined text-on-surface-variant text-[18px] mt-px">cloud_off</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-on-surface-variant">远端不存在数据</p>
              <p className="text-[11px] text-on-surface-variant/70 mt-0.5 font-label">
                {loadError ? `读取远端失败：${loadError}` : '坚果云上还没有数据，无需拉取。请先在某台设备上传一次。'}
              </p>
            </div>
          </div>
        )}

        {/* Comparison */}
        {!loading && (
          <div className="rounded-xl border border-outline-variant/15 bg-surface-container px-4 py-3 grid grid-cols-[1fr_auto_1fr] gap-3 items-start">
            {/* Local side */}
            <div>
              <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-2">本地</p>
              <div className="space-y-1">
                <p className="text-xs font-mono">
                  {localHw.defense} 防 / {localHw.attacks} 进
                </p>
                <p className="text-xs font-mono">
                  {localCl.themes} 主题 / {localCl.teams} 阵容
                </p>
                <p className="text-[10px] font-label text-on-surface-variant/50 mt-1.5">
                  rev={lastSyncedRev}
                  {localDirty && <span className="ml-1 text-tertiary">+ 未同步改动</span>}
                </p>
              </div>
            </div>

            {/* Arrow */}
            <div className="flex items-center justify-center pt-5">
              <span className={`material-symbols-outlined ${isPush ? 'text-primary' : 'text-secondary'}`} style={{ fontSize: 20 }}>
                {isPush ? 'arrow_forward' : 'arrow_back'}
              </span>
            </div>

            {/* Remote side */}
            <div>
              <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-2">远端</p>
              {remote ? (
                <div className="space-y-1">
                  <p className="text-xs font-mono">
                    {remoteHw!.defense} 防 / {remoteHw!.attacks} 进
                  </p>
                  <p className="text-xs font-mono">
                    {remoteCl!.themes} 主题 / {remoteCl!.teams} 阵容
                  </p>
                  <p className="text-[10px] font-label text-on-surface-variant/50 mt-1.5">
                    rev={remote.rev}{remote.ts && ` · ${formatRemoteTs(remote.ts)}`}
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
