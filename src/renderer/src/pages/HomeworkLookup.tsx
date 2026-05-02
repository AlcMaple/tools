import { useEffect, useRef, useState } from 'react'
import TopBar from '../components/TopBar'
import HomeworkView, { HomeworkViewHandle } from './homework/HomeworkView'
import ClassicView, { ClassicViewHandle } from './homework/ClassicView'
import { ClassicGroup, DefenseGroup, ipcErrMsg, normalizeClassic, normalizeHomework } from './homework/shared'

type Tab = 'homework' | 'classic'
type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error'

const HOMEWORK_KEY = 'maple-homework-data-v2'
const CLASSIC_KEY = 'maple-classic-data-v1'
const TAB_KEY = 'maple-knowledge-active-tab'
const LAST_SYNC_KEY = 'maple-homework-last-sync'

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? JSON.parse(v) as T : fallback
  } catch { return fallback }
}

export default function HomeworkLookup(): JSX.Element {
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const v = localStorage.getItem(TAB_KEY)
    return v === 'classic' ? 'classic' : 'homework'
  })

  const [homeworkData, setHomeworkData] = useState<DefenseGroup[]>(() => normalizeHomework(readJson(HOMEWORK_KEY, [])))
  const [classicData, setClassicData] = useState<ClassicGroup[]>(() => normalizeClassic(readJson(CLASSIC_KEY, [])))

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

  const homeworkRef = useRef<HomeworkViewHandle>(null)
  const classicRef = useRef<ClassicViewHandle>(null)

  // Persistence
  useEffect(() => { localStorage.setItem(HOMEWORK_KEY, JSON.stringify(homeworkData)) }, [homeworkData])
  useEffect(() => { localStorage.setItem(CLASSIC_KEY, JSON.stringify(classicData)) }, [classicData])
  useEffect(() => { localStorage.setItem(TAB_KEY, activeTab) }, [activeTab])

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

  const handlePush = async () => {
    if (syncStatus === 'syncing') return
    setSyncStatus('syncing')
    setSyncMsg('')
    try {
      const blob = JSON.stringify({ _v: 2, homework: homeworkData, classic: classicData })
      await window.webdavApi.push(blob)
      const now = Date.now()
      setLastSyncTime(now)
      localStorage.setItem(LAST_SYNC_KEY, String(now))
      syncSettle('synced', '上传成功')
    } catch (e: unknown) {
      syncSettle('error', ipcErrMsg(e, '上传失败'))
    }
  }

  const handlePull = async () => {
    if (syncStatus === 'syncing') return
    setSyncStatus('syncing')
    setSyncMsg('')
    try {
      const jsonStr = await window.webdavApi.pull()
      const remote = JSON.parse(jsonStr)
      if (Array.isArray(remote)) {
        // Legacy schema: array of homework only
        setHomeworkData(normalizeHomework(remote as DefenseGroup[]))
      } else if (remote && typeof remote === 'object' && remote._v === 2) {
        setHomeworkData(normalizeHomework(Array.isArray(remote.homework) ? remote.homework : []))
        setClassicData(normalizeClassic(Array.isArray(remote.classic) ? remote.classic : []))
      } else {
        throw new Error('远端数据格式不识别')
      }
      const now = Date.now()
      setLastSyncTime(now)
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
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-container-high border border-outline-variant/15">
              {syncStatus === 'syncing' ? (
                <span className="material-symbols-outlined text-primary animate-spin" style={{ fontSize: 13 }}>progress_activity</span>
              ) : syncStatus === 'synced' ? (
                <span className="w-1.5 h-1.5 rounded-full bg-secondary flex-shrink-0" />
              ) : syncStatus === 'error' ? (
                <span className="w-1.5 h-1.5 rounded-full bg-error flex-shrink-0" />
              ) : (
                <span className="w-1.5 h-1.5 rounded-full bg-outline/40 flex-shrink-0" />
              )}
              <span className={`font-label text-[10px] uppercase tracking-widest ${
                syncStatus === 'synced' ? 'text-secondary' :
                syncStatus === 'error' ? 'text-error' :
                syncStatus === 'syncing' ? 'text-primary' :
                lastSyncTime ? 'text-on-surface-variant/50' : 'text-on-surface-variant/30'
              }`}>
                {syncStatus === 'syncing' ? '同步中…' :
                 syncStatus === 'synced' ? syncMsg :
                 syncStatus === 'error' ? syncMsg :
                 lastSyncTime ? (() => {
                   const diff = Date.now() - lastSyncTime
                   if (diff < 60000) return '刚刚'
                   if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
                   const d = new Date(lastSyncTime)
                   return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`
                 })() : '未同步'}
              </span>
              <div className="flex items-center gap-0.5 ml-0.5 border-l border-outline-variant/20 pl-1">
                <button
                  onClick={handlePush}
                  disabled={syncStatus === 'syncing'}
                  title="上传到坚果云（合并作业 + 经典阵容）"
                  className="p-1 rounded text-on-surface-variant/50 hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-30"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 13 }}>upload</span>
                </button>
                <button
                  onClick={handlePull}
                  disabled={syncStatus === 'syncing'}
                  title="从坚果云拉取（覆盖本地作业 + 经典阵容）"
                  className="p-1 rounded text-on-surface-variant/50 hover:text-secondary hover:bg-secondary/10 transition-colors disabled:opacity-30"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 13 }}>download</span>
                </button>
              </div>
            </div>
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
      </div>
    </div>
  )
}
