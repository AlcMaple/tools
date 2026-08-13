import { useEffect, useMemo, useRef, useState } from 'react'
import TopBar from '../components/TopBar'
import { probe, probeToPaint } from '../utils/probe'
import HomeworkView, { HomeworkViewHandle } from './homework/HomeworkView'
import ClassicView, { ClassicViewHandle } from './homework/ClassicView'
import LogView, { LogViewHandle } from './homework/LogView'
import PjjcView, { PjjcViewHandle } from './homework/PjjcView'
import { CleanupModal } from './homework/CleanupModal'
import {
  ClassicGroup, DefenseGroup, LogEntry, PjjcGroup,
  ipcErrMsg, normalizeClassic, normalizeHomework, normalizeLog, normalizePjjc,
  ModalShell,
} from './homework/shared'

type Tab = 'homework' | 'jjc' | 'pjjc' | 'classic' | 'log'
type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error'
type SyncDirection = 'push' | 'pull'

// 五个分类的元数据 —— 桌面分段 tab 与手机下拉共用同一份,避免标签/图标两处维护。
type TabMeta = { key: Tab; label: string; icon: string; accent: 'primary' | 'tertiary' | 'secondary' }
const TABS: TabMeta[] = [
  { key: 'homework', label: '作业查询', icon: 'shield', accent: 'primary' },
  { key: 'jjc', label: 'JJC 换防', icon: 'military_tech', accent: 'primary' },
  { key: 'pjjc', label: 'PJJC 换防', icon: 'swap_horiz', accent: 'primary' },
  { key: 'classic', label: '经典阵容', icon: 'auto_awesome', accent: 'tertiary' },
  { key: 'log', label: '记录', icon: 'edit_note', accent: 'secondary' },
]
// 选中态配色写成完整类名(不拼接),保证 Tailwind JIT 扫得到、不被清掉。
const TAB_ACTIVE_CLS: Record<TabMeta['accent'], string> = {
  primary: 'border border-primary/20 bg-primary/15 text-primary',
  tertiary: 'border border-tertiary/20 bg-tertiary/15 text-tertiary',
  secondary: 'border border-secondary/20 bg-secondary/15 text-secondary',
}

/**
 * 锦囊妙计(阵容/作业速查)的云端 blob。
 *
 * 这里**不再写 tracks** —— 追番已经拆出去走独立的 anime.json。读到老数据里的 tracks 字段
 * 直接忽略;追番的迁移由 MyAnime 那边接管(它 pull anime.json 拿到 404 时会回退读这份的 tracks)。
 */
interface SyncRemoteMeta {
  rev: number
  ts: string
  homework: DefenseGroup[]
  jjc: DefenseGroup[]
  pjjc: PjjcGroup[]
  classic: ClassicGroup[]
  log: LogEntry[]
}

interface SyncConfirmState {
  direction: SyncDirection
  loading: boolean
  remote: SyncRemoteMeta | null
  loadError?: string
  forceArmed: boolean
}

const HOMEWORK_KEY = 'maple-homework-data-v2'
const JJC_KEY = 'maple-jjc-data-v1'
const PJJC_KEY = 'maple-pjjc-data-v1'
const CLASSIC_KEY = 'maple-classic-data-v1'
const LOG_KEY = 'maple-log-data-v1'
const TAB_KEY = 'maple-knowledge-active-tab'
const LAST_SYNC_KEY = 'maple-homework-last-sync'
const LAST_REV_KEY = 'maple-knowledge-last-rev'
const SNAPSHOT_KEY = 'maple-knowledge-last-snapshot'

function snapshotOf(
  homework: DefenseGroup[],
  jjc: DefenseGroup[],
  pjjc: PjjcGroup[],
  classic: ClassicGroup[],
  log: LogEntry[],
): string {
  return JSON.stringify({ homework, jjc, pjjc, classic, log })
}

/**
 * 识别快照的「结构漂移」并在纯结构差异时重建。
 *
 * `lastSyncedSnapshot` 是一个 JSON 字符串,逐字节和当前数据比。任何影响 JSON 形状的代码改动
 * (加一个键、把 `note: string` 迁成 `notes: string[]`)都会让每台设备冷启动时的快照「看起来脏」
 * 哪怕用户什么都没动。这个假脏再叠加后台的远端 rev 探测,就会在刚启动的设备上误报
 * 「本地与云端都有变化」的红色 chip。
 *
 * 办法:把存下来的快照重新过一遍**当前**的归一化管线,再和当前数据比 —— 相等说明差异纯粹是
 * 结构漂移,直接重建;不等才是真有本地改动,保留原快照让 localDirty 正常触发。
 */
function rebuildIfSchemaDrift(stored: string, current: string): string {
  if (stored === current) return stored
  try {
    const parsed = JSON.parse(stored) as {
      homework?: unknown
      jjc?: unknown
      pjjc?: unknown
      classic?: unknown
      log?: unknown
    }
    const renormalized = snapshotOf(
      normalizeHomework(Array.isArray(parsed.homework) ? (parsed.homework as DefenseGroup[]) : []),
      normalizeHomework(Array.isArray(parsed.jjc) ? (parsed.jjc as DefenseGroup[]) : []),
      normalizePjjc(parsed.pjjc),
      normalizeClassic(Array.isArray(parsed.classic) ? (parsed.classic as ClassicGroup[]) : []),
      normalizeLog(parsed.log),
    )
    if (renormalized === current) return current
  } catch { /* malformed stored snapshot — fall through, keep it */ }
  return stored
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
    // 老格式:数组 = 只有作业数据,没有内嵌的 rev/ts
    return { rev: 0, ts: '', homework: remote as DefenseGroup[], jjc: [], pjjc: [], classic: [], log: [] }
  }
  if (remote && typeof remote === 'object') {
    // 老 blob 里可能还有 `tracks` 字段,这里**故意忽略** —— 追番走 anime.json
    return {
      rev: typeof remote._rev === 'number' ? remote._rev : 0,
      ts: typeof remote._ts === 'string' ? remote._ts : '',
      homework: Array.isArray(remote.homework) ? remote.homework : [],
      jjc: Array.isArray(remote.jjc) ? remote.jjc : [],
      pjjc: Array.isArray(remote.pjjc) ? remote.pjjc : [],
      classic: Array.isArray(remote.classic) ? remote.classic : [],
      log: Array.isArray(remote.log) ? remote.log : [],
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

function pjjcStats(data: PjjcGroup[]): { groups: number; attacks: number } {
  return {
    groups: data.length,
    attacks: data.reduce((s, d) => s + d.attacks.length, 0),
  }
}

function logStats(data: LogEntry[]): { count: number } {
  return { count: data.length }
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
    if (v === 'classic' || v === 'log' || v === 'jjc' || v === 'pjjc') return v
    return 'homework'
  })

  // 先算好初始数据,让快照初始化能复用同一份值。
  const initialHomework = (() => normalizeHomework(readJson(HOMEWORK_KEY, [])))()
  const initialJjc = (() => normalizeHomework(readJson(JJC_KEY, [])))()
  const initialPjjc = (() => normalizePjjc(readJson(PJJC_KEY, [])))()
  const initialClassic = (() => normalizeClassic(readJson(CLASSIC_KEY, [])))()
  const initialLog = (() => normalizeLog(readJson(LOG_KEY, [])))()

  const [homeworkData, setHomeworkData] = useState<DefenseGroup[]>(initialHomework)
  const [jjcData, setJjcData] = useState<DefenseGroup[]>(initialJjc)
  const [pjjcData, setPjjcData] = useState<PjjcGroup[]>(initialPjjc)
  const [classicData, setClassicData] = useState<ClassicGroup[]>(initialClassic)
  const [logData, setLogData] = useState<LogEntry[]>(initialLog)

  const [cleanupOpen, setCleanupOpen] = useState(false)

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

  // 冲突检测状态
  const [lastSyncedRev, setLastSyncedRev] = useState<number>(() => {
    const v = localStorage.getItem(LAST_REV_KEY)
    return v ? Number(v) : 0
  })
  // 上次同步成功时的数据快照,靠 diff 驱动「本地有未同步改动」。
  // 没有快照时视为当前状态已同步(升级时一次性遗忘之前的脏状态)。
  // 结构漂移的处理见 rebuildIfSchemaDrift()。
  const [lastSyncedSnapshot, setLastSyncedSnapshot] = useState<string>(() => {
    const initialSnapshot = snapshotOf(initialHomework, initialJjc, initialPjjc, initialClassic, initialLog)
    const stored = localStorage.getItem(SNAPSHOT_KEY)
    if (!stored) return initialSnapshot
    return rebuildIfSchemaDrift(stored, initialSnapshot)
  })
  // 后台探测 / 上次同步看到的远端 rev,null = 未知。
  const [remoteRev, setRemoteRev] = useState<number | null>(null)
  const [syncConfirm, setSyncConfirm] = useState<SyncConfirmState | null>(null)

  // 本地是否有改动由快照 diff 得出,用户撤销编辑后会自动回到干净态。
  // 必须 memo —— 否则搜索按键、切 tab、同步状态变化这些无关的重渲染都会把整份数据重新序列化一遍。
  const currentSnapshot = useMemo(
    () => snapshotOf(homeworkData, jjcData, pjjcData, classicData, logData),
    [homeworkData, jjcData, pjjcData, classicData, logData]
  )
  const localDirty = currentSnapshot !== lastSyncedSnapshot
  const cloudNewer = remoteRev !== null && remoteRev > lastSyncedRev

  const homeworkRef = useRef<HomeworkViewHandle>(null)
  const jjcRef = useRef<HomeworkViewHandle>(null)
  const pjjcRef = useRef<PjjcViewHandle>(null)
  const classicRef = useRef<ClassicViewHandle>(null)
  const logRef = useRef<LogViewHandle>(null)

  // Persistence
  useEffect(() => { localStorage.setItem(HOMEWORK_KEY, JSON.stringify(homeworkData)) }, [homeworkData])
  useEffect(() => { localStorage.setItem(JJC_KEY, JSON.stringify(jjcData)) }, [jjcData])
  useEffect(() => { localStorage.setItem(PJJC_KEY, JSON.stringify(pjjcData)) }, [pjjcData])
  useEffect(() => { localStorage.setItem(CLASSIC_KEY, JSON.stringify(classicData)) }, [classicData])
  useEffect(() => { localStorage.setItem(LOG_KEY, JSON.stringify(logData)) }, [logData])
  useEffect(() => { localStorage.setItem(TAB_KEY, activeTab) }, [activeTab])
  useEffect(() => { localStorage.setItem(LAST_REV_KEY, String(lastSyncedRev)) }, [lastSyncedRev])
  useEffect(() => { localStorage.setItem(SNAPSHOT_KEY, lastSyncedSnapshot) }, [lastSyncedSnapshot])

  // 挂载时后台探一次远端 rev,让 chip 能主动提示「云端有更新」,不用用户先点什么。
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const jsonStr = await window.webdavApi.pull('homework')
        if (cancelled) return
        const parsed = parseRemoteBlob(jsonStr)
        setRemoteRev(parsed.rev)
      } catch {
        // 没网 / 远端没有 / 未配置 —— 静默忽略。
      }
    })()
    return () => { cancelled = true }
  }, [])

  // 切 tab 时清空搜索词,避免上一档的防抖残影
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
    else if (activeTab === 'jjc') jjcRef.current?.openAdd()
    else if (activeTab === 'pjjc') pjjcRef.current?.openAdd()
    else if (activeTab === 'classic') classicRef.current?.openAdd()
    else logRef.current?.openAdd()
  }

  const syncSettle = (status: SyncStatus, msg: string) => {
    setSyncStatus(status)
    setSyncMsg(msg)
    if (status === 'synced' || status === 'error') {
      setTimeout(() => { setSyncStatus('idle'); setSyncMsg('') }, 3500)
    }
  }

  // 各视图直接调 setter 即可:「本地有改动」是每次渲染由快照 diff 算出来的,不用手动打标记。

  // ── Sync intent: open confirmation modal, fetch remote in background ─────
  const openSyncConfirm = async (direction: SyncDirection) => {
    if (syncStatus === 'syncing' || syncConfirm) return
    setSyncConfirm({ direction, loading: true, remote: null, forceArmed: false })
    try {
      const end = probe('webdav:homework-pull-fetch')
      const jsonStr = await window.webdavApi.pull('homework')
      end(`${jsonStr.length}B`)
      const parsed = parseRemoteBlob(jsonStr)
      setSyncConfirm({ direction, loading: false, remote: parsed, forceArmed: false })
    } catch (e: unknown) {
      // 拉取失败(404 / 网络 / 解析)一律当作远端没有数据。
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
      // v6 起 tracks 不再出现在这个 blob —— 追番走 anime.json 独立同步
      const blob = JSON.stringify({
        _v: 6,
        _rev: newRev,
        _ts: new Date().toISOString(),
        homework: homeworkData,
        jjc: jjcData,
        pjjc: pjjcData,
        classic: classicData,
        log: logData,
      })
      const end = probe(`webdav:homework-push(${blob.length}B)`)
      await window.webdavApi.push('homework', blob)
      end()
      const now = Date.now()
      setLastSyncTime(now)
      setLastSyncedRev(newRev)
      setRemoteRev(newRev)
      setLastSyncedSnapshot(snapshotOf(homeworkData, jjcData, pjjcData, classicData, logData))
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
      const newJjc = normalizeHomework(remote.jjc)
      const newPjjc = normalizePjjc(remote.pjjc)
      const newClassic = normalizeClassic(remote.classic)
      const newLog = normalizeLog(remote.log)
      setHomeworkData(newHomework)
      setJjcData(newJjc)
      setPjjcData(newPjjc)
      setClassicData(newClassic)
      setLogData(newLog)
      probeToPaint('webdav:homework-pull-apply')
      const now = Date.now()
      setLastSyncTime(now)
      setLastSyncedRev(remote.rev)
      setRemoteRev(remote.rev)
      setLastSyncedSnapshot(snapshotOf(newHomework, newJjc, newPjjc, newClassic, newLog))
      localStorage.setItem(LAST_SYNC_KEY, String(now))
      syncSettle('synced', '拉取成功')
    } catch (e: unknown) {
      syncSettle('error', ipcErrMsg(e, '拉取失败'))
    }
  }

  const searchPlaceholder =
    activeTab === 'homework' ? '模糊搜索防守方角色…' :
    activeTab === 'jjc' ? '模糊搜索 JJC 换防角色…' :
    activeTab === 'pjjc' ? '模糊搜索三防角色…' :
    activeTab === 'classic' ? '模糊搜索主题标题…' :
    '搜索记录标题、备注…'

  const addLabel =
    activeTab === 'homework' ? '添加作业' :
    activeTab === 'jjc' ? '添加 JJC 换防' :
    activeTab === 'pjjc' ? '添加换防' :
    activeTab === 'classic' ? '添加经典阵容' :
    '添加记录'

  return (
    <div className="relative min-h-full bg-background">
      {/* 顶栏搜索框删掉（本就没接 onSearch、纯摆设）—— 页内已有「模糊搜索防守方角色」。 */}
      <TopBar placeholder="" titleSlot={
        <div className="flex items-center gap-4">
          <h2 className="text-2xl font-bold tracking-tighter text-primary">锦囊妙计</h2>
          <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/60 hidden lg:inline">Homework · Lineups</span>
        </div>
      } />
      <div className="pt-16">
        {/* Sticky page header —— top-16 让 sticky 卡在 fixed TopBar（64px）下面，
            top-0 会让标题被 TopBar 压住露出一半。同 MyAnime / AnimeCalendar 的修法。 */}
        <div className="sticky top-16 z-30 bg-surface-container-lowest border-b border-outline-variant/10 px-4 md:px-8 py-4 md:py-5">
          <div className="flex items-end justify-between gap-4 md:gap-6 flex-wrap">
            <div>
              {/* 面包屑 / 副标题在手机档隐藏（窄屏只留主标题），对齐蓝图 .crumb/.subttl 收起 */}
              <div className="hidden md:flex items-center gap-2 mb-2 text-xs font-label text-outline uppercase tracking-widest">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>menu_book</span>
                <span>Tools</span>
                <span className="text-outline-variant">/</span>
                <span className="text-on-surface font-bold">锦囊妙计</span>
              </div>
              <h1 className="text-2xl md:text-3xl font-black tracking-tighter text-on-surface">锦囊妙计</h1>
              <p className="hidden md:block text-sm text-on-surface-variant/80 mt-1 font-label">
                查询作业 · 浏览经典阵容 · 流水账记录
              </p>
            </div>

            {/* 手机档整组通栏（w-full）落到标题下方一行；搜索框占满、添加按钮收成图标。 */}
            <div className="flex items-center gap-2 md:gap-3 w-full md:w-auto">
              <div className="relative flex-1 md:flex-none">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-base">search</span>
                <input
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  className="w-full md:w-[380px] bg-surface-container-high border border-outline-variant/20 rounded-xl py-2.5 pl-10 pr-20 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/40 focus:bg-surface-bright transition-all placeholder:text-on-surface-variant/40"
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
                title={addLabel}
                className="shrink-0 flex items-center gap-2 px-3.5 sm:px-5 py-2.5 rounded-xl bg-primary text-on-primary font-label text-xs uppercase tracking-widest hover:bg-primary-fixed transition-all active:scale-95 shadow-lg shadow-primary/10 whitespace-nowrap"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}>add</span>
                <span className="hidden sm:inline">{addLabel}</span>
              </button>
            </div>
          </div>

          {/* Tabs + Sync chip row */}
          <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
            {/* 桌面/平板：分段 tab（≥md）。手机：收成下拉选择器（见下方 TabSelect），
                对齐蓝图 .modeseg→.modedd —— 5 个 tab 在 390 窄屏一排放不下。 */}
            <div className="hidden md:inline-flex bg-surface-container rounded-lg p-1 border border-outline-variant/15 gap-1">
              {TABS.map(t => {
                const active = activeTab === t.key
                return (
                  <button
                    key={t.key}
                    onClick={() => setActiveTab(t.key)}
                    className={`px-4 py-1.5 rounded-md font-label text-xs uppercase tracking-widest transition-colors flex items-center gap-1.5 ${
                      active
                        ? TAB_ACTIVE_CLS[t.accent]
                        : 'text-on-surface-variant/60 hover:text-on-surface hover:bg-surface-container-high border border-transparent'
                    }`}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 14, fontVariationSettings: active ? "'FILL' 1" : "'FILL' 0" }}>{t.icon}</span>
                    {t.label}
                  </button>
                )
              })}
            </div>
            <div className="md:hidden">
              <TabSelect tabs={TABS} value={activeTab} onChange={setActiveTab} />
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
        {activeTab === 'homework' && (
          <HomeworkView
            ref={homeworkRef}
            data={homeworkData}
            setData={setHomeworkData}
            query={debouncedQuery}
            onClearQuery={clearQuery}
            onCleanup={() => setCleanupOpen(true)}
          />
        )}
        {activeTab === 'jjc' && (
          <HomeworkView
            ref={jjcRef}
            data={jjcData}
            setData={setJjcData}
            query={debouncedQuery}
            onClearQuery={clearQuery}
            hideImport
            attackOptional
            onCleanup={() => setCleanupOpen(true)}
          />
        )}
        {activeTab === 'pjjc' && (
          <PjjcView
            ref={pjjcRef}
            data={pjjcData}
            setData={setPjjcData}
            query={debouncedQuery}
            onClearQuery={clearQuery}
            onCleanup={() => setCleanupOpen(true)}
          />
        )}
        {activeTab === 'classic' && (
          <ClassicView
            ref={classicRef}
            data={classicData}
            setData={setClassicData}
            query={debouncedQuery}
            onClearQuery={clearQuery}
            onCleanup={() => setCleanupOpen(true)}
          />
        )}
        {activeTab === 'log' && (
          <LogView
            ref={logRef}
            data={logData}
            setData={setLogData}
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
            localJjc={jjcData}
            localPjjc={pjjcData}
            localClassic={classicData}
            localLog={logData}
            localDirty={localDirty}
            lastSyncedRev={lastSyncedRev}
            onConfirmPush={executePush}
            onConfirmPull={executePull}
          />
        )}

        {/* 清理旧数据 modal —— 删除各类里 updatedAt 早于 cutoff 的整组。删完
            localStorage 经现有 useEffect 落盘，sync chip 自动变「本地未上传」。 */}
        {cleanupOpen && (
          <CleanupModal
            data={{ homework: homeworkData, jjc: jjcData, pjjc: pjjcData, classic: classicData }}
            onClose={() => setCleanupOpen(false)}
            onConfirm={(cutoff) => {
              setHomeworkData(prev => prev.filter(g => g.updatedAt >= cutoff))
              setJjcData(prev => prev.filter(g => g.updatedAt >= cutoff))
              setPjjcData(prev => prev.filter(g => g.updatedAt >= cutoff))
              setClassicData(prev => prev.filter(g => g.updatedAt >= cutoff))
              setCleanupOpen(false)
            }}
          />
        )}
      </div>
    </div>
  )
}

// ── Mobile tab select ───────────────────────────────────────────────────────

/**
 * 手机档（<md）把分段 tab 收成下拉选择器 —— 5 个分类一排在 390 窄屏放不下，
 * 一排 chip 横向挤压/换行会抖。平板 + 桌面仍用分段条，本组件只在 `md:hidden`
 * 容器里渲染。结构对齐 MyAnime 的 SelectMenu：absolute 定位（sticky header 无
 * overflow-hidden，向下溢出不被裁），点外面 / Esc 关。
 */
function TabSelect({
  tabs, value, onChange,
}: {
  tabs: TabMeta[]
  value: Tab
  onChange: (k: Tab) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const current = tabs.find(t => t.key === value) ?? tabs[0]
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label="切换分类"
        className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-surface-container border border-outline-variant/20"
      >
        <span className="material-symbols-outlined leading-none text-primary" style={{ fontSize: 16, fontVariationSettings: "'FILL' 1" }}>{current.icon}</span>
        <span className="text-sm font-bold text-on-surface">{current.label}</span>
        <span className="material-symbols-outlined leading-none text-on-surface-variant/55" style={{ fontSize: 18 }}>
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>
      {open && (
        <div className="absolute top-[calc(100%+6px)] left-0 z-50 min-w-[176px] bg-surface-container-high border border-outline-variant/20 rounded-xl shadow-2xl shadow-black/40 p-1.5">
          {tabs.map(t => {
            const active = t.key === value
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => { onChange(t.key); setOpen(false) }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors ${
                  active ? 'bg-primary/12 text-primary' : 'text-on-surface-variant/75 hover:bg-surface-container-highest hover:text-on-surface'
                }`}
              >
                <span className="material-symbols-outlined leading-none" style={{ fontSize: 16, fontVariationSettings: active ? "'FILL' 1" : "'FILL' 0" }}>{t.icon}</span>
                <span className="flex-1 text-sm font-medium">{t.label}</span>
                {active && (
                  <span className="material-symbols-outlined leading-none text-primary" style={{ fontSize: 16 }}>check</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Sync confirm modal ─────────────────────────────────────────────────────
function SyncConfirmModal({
  state, setState,
  localHomework, localJjc, localPjjc, localClassic, localLog, localDirty, lastSyncedRev,
  onConfirmPush, onConfirmPull,
}: {
  state: SyncConfirmState
  setState: React.Dispatch<React.SetStateAction<SyncConfirmState | null>>
  localHomework: DefenseGroup[]
  localJjc: DefenseGroup[]
  localPjjc: PjjcGroup[]
  localClassic: ClassicGroup[]
  localLog: LogEntry[]
  localDirty: boolean
  lastSyncedRev: number
  onConfirmPush: () => void
  onConfirmPull: () => void
}): JSX.Element {
  const { direction, loading, remote, loadError, forceArmed } = state
  const isPush = direction === 'push'

  const localHw = homeworkStats(localHomework)
  const localJjcStats = homeworkStats(localJjc)
  const localPj = pjjcStats(localPjjc)
  const localCl = classicStats(localClassic)
  const localLg = logStats(localLog)
  const remoteHw = remote ? homeworkStats(remote.homework) : null
  const remoteJjcStats = remote ? homeworkStats(remote.jjc) : null
  const remotePj = remote ? pjjcStats(remote.pjjc) : null
  const remoteCl = remote ? classicStats(remote.classic) : null
  const remoteLg = remote ? logStats(remote.log) : null

  // 冲突判定:
  // - push: remote exists with rev > lastSyncedRev (someone updated cloud after our last sync)
  // - pull: localDirty=true (we have unsynced local changes that pull would overwrite)
  const hasConflict = !loading && (
    isPush
      ? !!remote && remote.rev > lastSyncedRev
      : localDirty
  )

  // 远端没有数据时无法拉取。
  const pullImpossible = !isPush && !loading && !remote

  const close = () => setState(null)

  const onConfirmClick = () => {
    if (hasConflict && !forceArmed) {
      // 危险按钮的第一次点击:先进入待确认态。
      setState({ ...state, forceArmed: true })
      return
    }
    if (isPush) onConfirmPush()
    else onConfirmPull()
  }

  // 用户点别处(取消等)时的复位,由关闭 / 状态迁移隐式处理。

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
                  作业 {localHw.defense} 防 / {localHw.attacks} 进
                </p>
                <p className="text-xs font-mono">
                  JJC {localJjcStats.defense} 防 / {localJjcStats.attacks} 进
                </p>
                <p className="text-xs font-mono">
                  换防 {localPj.groups} 组 / {localPj.attacks} 进
                </p>
                <p className="text-xs font-mono">
                  {localCl.themes} 主题 / {localCl.teams} 阵容
                </p>
                <p className="text-xs font-mono">
                  {localLg.count} 条记录
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
                    作业 {remoteHw!.defense} 防 / {remoteHw!.attacks} 进
                  </p>
                  <p className="text-xs font-mono">
                    JJC {remoteJjcStats!.defense} 防 / {remoteJjcStats!.attacks} 进
                  </p>
                  <p className="text-xs font-mono">
                    换防 {remotePj!.groups} 组 / {remotePj!.attacks} 进
                  </p>
                  <p className="text-xs font-mono">
                    {remoteCl!.themes} 主题 / {remoteCl!.teams} 阵容
                  </p>
                  <p className="text-xs font-mono">
                    {remoteLg!.count} 条记录
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
