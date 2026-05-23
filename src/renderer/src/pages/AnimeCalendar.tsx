// 番剧周历 — week-at-a-glance of what's currently airing, fetched from BGM.
//
// Layout: 7-day grid (Mon-Sun in BGM order), one column per weekday, anime
// cards stacked inside. Each card shows cover + title + a "Track" hover
// affordance so the user can fold this week's interesting shows into their
// list without leaving the page.
//
// The main process owns the 24h disk cache; this page just renders whatever
// it gets back. Calling refresh forces an update path via `update=true`.

import { useEffect, useMemo, useState } from 'react'
import TopBar from '../components/TopBar'
import ErrorPanel from '../components/ErrorPanel'
import type { BgmCalendarItem, BgmCalendarResult } from '../types/bgm'
import {
  animeTrackStore,
  useAnimeTrack,
} from '../stores/animeTrackStore'
import { WatchHere } from '../components/WatchHere'
import { useCover } from '../hooks/useCover'
import { friendlyError } from '../utils/errorMessage'

type State =
  | { status: 'loading' }
  | { status: 'ready'; result: BgmCalendarResult }
  | { status: 'error'; message: string }

// ── Module-level cache so navigating away and back doesn't re-spin ──────────

let _cachedState: State = { status: 'loading' }

// localStorage 水印：记录最后一次"自动触发邮件发送"对应的 updatedAt。
// 同一份缓存数据在一次进程生命周期内可能被多次 setState（比如热重载、
// 路由进出 Calendar），靠这个水印保证只发一次。
const MAIL_SENT_WATERMARK_KEY = 'maple_mail_sent_for_calendar'

/**
 * 触发周历邮件自动发送的全部判断 + 副作用。
 * 仅当满足"update=false（不是用户手点刷新）且 fromCache=false（确实是新拉取）"
 * 时才进入下游逻辑；主进程那边还会再判一次 enabled / 配置完整性，所以这里
 * 只做最便宜的去重水印检查就够了。
 */
function maybeTriggerMail(update: boolean, result: BgmCalendarResult): void {
  if (update) return                 // 用户手点刷新，不发
  if (result.fromCache) return       // 缓存命中，不发

  const watermark = String(result.updatedAt)
  if (localStorage.getItem(MAIL_SENT_WATERMARK_KEY) === watermark) return

  // 先写水印再调，避免极端情况下并发触发两次 IPC
  localStorage.setItem(MAIL_SENT_WATERMARK_KEY, watermark)
  window.mailApi
    .sendCalendar()
    .then(res => {
      if (!res.sent) {
        // 不是真正失败的情况（用户未启用 / 未配置）不清水印；真正失败则清掉
        // 让下次还有机会重试（虽然得等下一次 14d 过期）。
        if (res.reason && res.reason !== 'disabled' && res.reason !== 'incomplete-config') {
          localStorage.removeItem(MAIL_SENT_WATERMARK_KEY)
        }
        console.warn('[calendar mail] 未发送：', res.reason)
      }
    })
    .catch(err => {
      localStorage.removeItem(MAIL_SENT_WATERMARK_KEY)
      console.warn('[calendar mail] IPC 异常', err)
    })
}

export default function AnimeCalendar(): JSX.Element {
  const [state, setState] = useState<State>(_cachedState)
  const [refreshing, setRefreshing] = useState(false)
  // 已经有 ready 数据时刷新失败的错误。和 state.status='error' 不同：
  // 这条不替换主视图，只在刷新按钮旁边显示一条小提示，让用户知道
  // "本次刷新失败、显示的还是缓存数据"，不至于丢失已有的页面状态。
  const [refreshError, setRefreshError] = useState<string | null>(null)
  // 限流时显示倒计时 —— 仅作提示，**不**禁用刷新按钮。用户想提前试就提前试,
  // 后果就是再被限一次。用绝对时间戳而不是每秒 -1 的 number —— 绝对值
  // 不受 setInterval 漂移影响，tab 后台时也仍是真实剩余秒数。
  const [cooldownEndAt, setCooldownEndAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // 跟踪用户在 cooldown 期间提前点击的次数。一旦 > 0，倒计时切到"已加重"
  // 视觉态（warning 图标 + amber 色 + "约"前缀 + tooltip 解释），告诉用户
  // 显示的秒数已不可信。每次成功刷新后清零。
  const [prematureClickCount, setPrematureClickCount] = useState(0)
  const cooldownRemainingSec = cooldownEndAt
    ? Math.max(0, Math.ceil((cooldownEndAt - now) / 1000))
    : 0
  const cooldownAggravated = prematureClickCount > 0

  // 倒计时驱动 —— 仅当 cooldown 激活时跑，节省渲染
  useEffect(() => {
    if (!cooldownEndAt) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [cooldownEndAt])
  // cooldown 走完后自动清掉 refreshError + cooldownEndAt，UI 回到"无错误"
  // 状态。但 prematureClickCount 保留 —— 用户如果再次点 → 又限流，新的
  // cooldown 视觉仍然标记"已加重"。只有成功刷新才完全清零。
  useEffect(() => {
    if (cooldownEndAt && cooldownRemainingSec === 0) {
      setCooldownEndAt(null)
      setRefreshError(null)
    }
  }, [cooldownEndAt, cooldownRemainingSec])

  useEffect(() => {
    _cachedState = state
  }, [state])

  const load = async (update = false): Promise<void> => {
    // 在 cooldown 中点击 = 提前重试，计数 +1，让倒计时切换到"已加重"视觉
    if (update && cooldownEndAt && Date.now() < cooldownEndAt) {
      setPrematureClickCount((c) => c + 1)
    }
    if (update) setRefreshing(true)
    else if (state.status !== 'ready') setState({ status: 'loading' })
    setRefreshError(null)
    setCooldownEndAt(null)
    try {
      const result = await window.bgmApi.calendar(update)
      setState({ status: 'ready', result })
      maybeTriggerMail(update, result)
      // 成功一次 → 之前的"提前点击警告"清零，下次再触发限流是干净的初始态
      setPrematureClickCount(0)
    } catch (err) {
      // 区分两种失败：
      // - 首次加载失败（state 还不是 ready）→ 整页面 ErrorPanel（自带倒计时）
      // - 刷新失败但已有 ready 数据 → 行内小提示 + 按钮 cooldown，主视图保留
      if (update && state.status === 'ready') {
        setRefreshError(String(err))
        const fe = friendlyError(err)
        if (fe.retryAfterSec) {
          setCooldownEndAt(Date.now() + fe.retryAfterSec * 1000)
        }
      } else {
        setState({ status: 'error', message: String(err) })
      }
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    if (state.status !== 'ready') void load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="relative min-h-full bg-background">
      <TopBar placeholder="搜索本周番剧..." />
      <div className="pt-16">
        {/* Hero — 标题块随内容滚走，不 sticky。 */}
        <div className="px-8 pt-5 pb-3">
          <div className="flex items-center gap-2 mb-2 text-xs font-label text-outline uppercase tracking-widest">
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>calendar_month</span>
            <span>Anime</span>
            <span className="text-outline-variant">/</span>
            <span className="text-on-surface font-bold">番剧周历</span>
          </div>
          <h1 className="text-3xl font-black tracking-tighter text-on-surface">番剧周历</h1>
          <p className="text-sm text-on-surface-variant/80 mt-1 font-label">
            本季正在播出，按星期排列。来源 Bangumi · 14 天缓存。
          </p>
        </div>

        {/* 真正的置顶栏：周一-周日 chip 行 + 缓存/刷新小工具栏。
            top-16 紧贴 TopBar；用户滚下去能始终看到周几对应哪列以及刷新。

            两行结构：
              Row 1: 缓存时间 + 刷新按钮，右对齐，紧凑（高度约 22px）
              Row 2: 7 chip grid-cols-7，和下方 cards grid-cols-7 共享同一份
                     容器宽度（都是 px-6 + 完整宽度），column 对 column 严丝
                     合缝。一行结构（刷新挤在右侧）会让 chip flex-1 比 cards
                     窄出一截，造成"周日 chip 在卡片的左边"的视觉错位。 */}
        {state.status === 'ready' && (
          <div className="sticky top-16 z-30 bg-surface-container-lowest border-y border-outline-variant/10 px-6 pt-1.5 pb-2">
            <div className="flex items-center justify-end gap-2 mb-1.5 h-5">
              {/* 刷新失败的行内提示。限流时显示倒计时秒数，提前点击过则补充
                 "已加重"警告。非限流错误就只显示 friendly title。
                 hover 见完整 hint。 */}
              {refreshError && !refreshing && (
                <span
                  className="font-label text-[10px] text-error tracking-wider whitespace-nowrap"
                  title={
                    cooldownAggravated
                      ? `你已提前点过 ${prematureClickCount} 次，BGM 可能加重了限流时长。下面显示的秒数已不可信，实际等待可能更长。`
                      : friendlyError(refreshError).hint
                  }
                >
                  ⚠ {friendlyError(refreshError).title}
                  {cooldownRemainingSec > 0 &&
                    (cooldownAggravated
                      ? `（约 ${cooldownRemainingSec}s 后可重试 · 已加重）`
                      : `（${cooldownRemainingSec}s 后可重试）`)}
                </span>
              )}
              <span className="font-label text-[10px] text-on-surface-variant/50 tracking-wider whitespace-nowrap">
                {state.result.fromCache ? '缓存：' : '刚拉取：'}
                {formatRelTime(state.result.updatedAt)}
              </span>
              <button
                onClick={() => void load(true)}
                disabled={refreshing}
                title={
                  cooldownRemainingSec > 0
                    ? cooldownAggravated
                      ? `你已提前点过 ${prematureClickCount} 次。BGM 可能已加重限流，按钮上的倒计时仅供参考，实际等待可能更长。`
                      : `BGM 仍在限流冷却中，建议 ${cooldownRemainingSec} 秒后再试。提前点击可能加重限流。`
                    : '强制刷新（绕过 14 天缓存）'
                }
                className="flex items-center gap-1 px-2 py-0.5 rounded bg-surface-container-high border border-outline-variant/20 hover:bg-primary/10 hover:border-primary/30 hover:text-primary font-label text-[10px] uppercase tracking-widest transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <span
                  className={`material-symbols-outlined leading-none ${refreshing ? 'animate-spin' : ''} ${
                    cooldownRemainingSec > 0 && cooldownAggravated ? 'text-amber-500' : ''
                  }`}
                  style={{
                    fontSize: 12,
                    fontVariationSettings:
                      cooldownRemainingSec > 0 && cooldownAggravated ? "'FILL' 1" : undefined,
                  }}
                >
                  {cooldownRemainingSec > 0
                    ? cooldownAggravated
                      ? 'warning'
                      : 'schedule'
                    : 'refresh'}
                </span>
                {cooldownRemainingSec > 0 && !refreshing && (
                  <span
                    className={`font-mono tabular-nums normal-case tracking-normal ${
                      cooldownAggravated ? 'text-amber-600' : ''
                    }`}
                  >
                    {cooldownAggravated && '约'}
                    {cooldownRemainingSec}s
                  </span>
                )}
                <span>{refreshing ? '更新中' : '刷新'}</span>
              </button>
            </div>
            <DayChipsBar result={state.result} />
          </div>
        )}

        {state.status === 'loading' && <LoadingState />}
        {state.status === 'error' && (
          <ErrorPanel error={state.message} onRetry={() => void load(true)} />
        )}
        {state.status === 'ready' && <CalendarGrid result={state.result} />}
      </div>
    </div>
  )
}

// ── Day chips bar ────────────────────────────────────────────────────────────
// 7 day chips on a single grid row. Sticks at top-16 with the refresh cluster.
// Uses grid-cols-7 to align column-by-column with the cards grid below.

function DayChipsBar({ result }: { result: BgmCalendarResult }): JSX.Element {
  const todayBgmId = useMemo(() => {
    const d = new Date().getDay() // 0..6
    return d === 0 ? 7 : d
  }, [])
  return (
    // grid-cols-7 + gap-3，和 CalendarGrid 完全同结构；外层 px-6 也一致,
    // 所以 chip N 的左右边和 card column N 的左右边逐像素对齐。
    <div className="grid grid-cols-7 gap-3 min-w-0">
      {result.data.map(day => {
        const active = day.id === todayBgmId
        return (
          <div
            key={day.id}
            className={`px-2.5 py-1.5 rounded-md border flex items-baseline justify-between gap-2 ${
              active
                ? 'bg-primary/12 border-primary/30 text-primary'
                : 'bg-surface-container border-outline-variant/15 text-on-surface-variant/80'
            }`}
          >
            <span className="font-headline text-xs font-black tracking-tight">{day.label}</span>
            <span className="font-label text-[10px] uppercase tracking-widest opacity-60">
              {day.items.length} 部
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Grid ─────────────────────────────────────────────────────────────────────

function CalendarGrid({ result }: { result: BgmCalendarResult }): JSX.Element {
  if (result.data.every(d => d.items.length === 0)) {
    return (
      <div className="flex flex-col items-center justify-center py-32 gap-4 text-on-surface-variant/30">
        <span className="material-symbols-outlined text-6xl">event_busy</span>
        <p className="font-label text-xs uppercase tracking-widest">本周没有数据</p>
      </div>
    )
  }

  return (
    // grid-cols-7 自适应容器宽度 —— 默认 1280px 窗口（content ≈ 1024px）能
    // 完整装下 7 列；用户调小窗口卡片随之变小，不会出现横向滚动。
    // 周一-周日 chip 行已经移到上方 sticky bar 里，DayColumn 只保留卡片堆。
    <div className="px-6 py-3 grid grid-cols-7 gap-3">
      {result.data.map(day => (
        <DayColumn key={day.id} day={day} />
      ))}
    </div>
  )
}

function DayColumn({
  day,
}: { day: { id: number; label: string; items: BgmCalendarItem[] } }): JSX.Element {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      {day.items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-outline-variant/20 px-3 py-6 text-center font-label text-[10px] text-on-surface-variant/30 uppercase tracking-widest">
          空
        </div>
      ) : (
        day.items.map(item => <CalendarCard key={item.id} item={item} />)
      )}
    </div>
  )
}

// ── Card ─────────────────────────────────────────────────────────────────────

function CalendarCard({ item }: { item: BgmCalendarItem }): JSX.Element {
  const track = useAnimeTrack(item.id)
  const displayTitle = item.name_cn || item.name
  const coverSrc = useCover(String(item.id), item.cover)
  const sub = item.name_cn && item.name && item.name !== item.name_cn ? item.name : ''

  const toggleTrack = (): void => {
    if (track) {
      animeTrackStore.delete(item.id)
    } else {
      // 立即 upsert，UI 即时响应（按钮立刻翻成"已追番"状态）。
      // BgmCalendarItem 不带 tags 字段，所以 bgmTags 会落成 [] —— 紧接着
      // 后台异步 fetch detail 把 BGM 标签快照补上（lock-on-first-content
      // 保证补写不会污染用户已看过的快照）。
      animeTrackStore.upsert({
        bgmId: item.id,
        // BGM 周历只放动画（cat=2 入口），所以 subjectType 显式写 'anime',
        // 防御任何"calendar 漏了非动画条目"的边缘情况。
        subjectType: 'anime',
        title: item.name,
        titleCn: item.name_cn || undefined,
        cover: item.cover || undefined,
        totalEpisodes: item.episodes > 0 ? item.episodes : undefined,
        status: 'watching',
        episode: 0,
      })
      void animeTrackStore.ensureBgmTagsFilled(item.id)
    }
  }

  return (
    <div className="group relative bg-surface-container rounded-lg border border-outline-variant/15 overflow-hidden hover:border-primary/30 transition-colors">
      <div className="aspect-[3/4] relative">
        {/* useCover 把封面 URL 解析成本地 archivist://（首次后台下载，下次
            走本地、离线可看）。没封面回落占位图标。 */}
        {item.cover ? (
          <img
            src={coverSrc || item.cover}
            alt={displayTitle}
            className="w-full h-full object-cover"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-surface-container-high text-on-surface-variant/20">
            <span className="material-symbols-outlined text-3xl">image</span>
          </div>
        )}

        {/* Tracking badge — visible always when bound. */}
        {track && (
          <div
            className="absolute top-1.5 left-1.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-primary-container/85 backdrop-blur-sm border border-primary/30 text-on-primary-container shadow-sm"
            title={`${track.status} · ep ${track.episode}${track.totalEpisodes ? `/${track.totalEpisodes}` : ''}`}
          >
            <span
              className="material-symbols-outlined leading-none"
              style={{ fontSize: 10, fontVariationSettings: "'FILL' 1" }}
            >
              bookmark
            </span>
            <span className="font-label text-[9px] font-bold tracking-wider">
              {track.episode > 0 ? `EP ${track.episode}` : '在追'}
            </span>
          </div>
        )}

        {/* Hover overlay —— 渐变整体压暗（via 也给 black/75），让坐在上半区的
            播放源 chip / 按钮在亮色封面上也读得清，不再糊成一团。 */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/75 to-black/25 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-2 gap-1.5">
          {/* 已绑播放源 —— 单个「▶ 播放」按钮（无绑定时 WatchHere 返回 null
              不占位）。1 源直接打开，多源弹窗挑选，所以无论几个源遮罩高度
              恒定、跟下面追番/BGM 按钮同尺寸，最坏 4 个源也不溢出。 */}
          <WatchHere bgmId={item.id} variant="play-menu" />
          <button
            onClick={toggleTrack}
            className={`w-full text-[10px] font-label tracking-widest uppercase py-1.5 rounded-md flex items-center justify-center gap-1 transition-colors ${
              track
                ? 'bg-error/85 hover:bg-error text-white border border-error'
                : 'bg-primary hover:bg-primary/90 text-on-primary border border-primary'
            }`}
          >
            <span
              className="material-symbols-outlined leading-none"
              style={{ fontSize: 12, fontVariationSettings: track ? "'FILL' 1" : "'FILL' 0" }}
            >
              {track ? 'bookmark_remove' : 'bookmark_add'}
            </span>
            <span>{track ? '取消' : '追番'}</span>
          </button>
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            onClick={e => e.stopPropagation()}
            title="在 Bangumi 查看"
            className="w-full text-[10px] font-label tracking-widest uppercase py-1.5 rounded-md flex items-center justify-center gap-1 bg-black/55 backdrop-blur-sm hover:bg-black/70 text-white/90 border border-white/20 transition-colors"
          >
            <span className="material-symbols-outlined leading-none" style={{ fontSize: 12 }}>open_in_new</span>
            <span>BGM</span>
          </a>
        </div>
      </div>

      {/* 信息区精确固定高度（用 h-* 而非 min-h-*），保证所有卡片高度一致：
          - 标题 h-[30px] = text-xs 12px × leading-tight 1.25 × 2 行
          - sub h-[14px] ≈ 10px × 1.25 × 1 行（无 sub 时空格占位防塌陷）
          - meta 行 h-[12px] 始终渲染，score/eps 缺值时占位空字符串
          播放源跳转挪进了封面 hover 遮罩（不占静态高度），所以这里每张卡
          高度严格一致，不再因"已绑源"而参差。 */}
      <div className="px-2 py-2 flex flex-col gap-0.5">
        <h3
          className="text-xs font-bold text-on-surface line-clamp-2 leading-tight h-[30px]"
          title={displayTitle}
        >
          {displayTitle}
        </h3>
        <p
          className="text-[10px] text-on-surface-variant/40 line-clamp-1 leading-tight h-[14px]"
          title={sub || undefined}
        >
          {sub || ' '}
        </p>
        <div className="flex items-center justify-between gap-1 h-[12px]">
          <span className="font-label text-[9px] text-primary/70 leading-none">
            {item.score > 0 ? `★ ${item.score.toFixed(1)}` : ''}
          </span>
          <span className="font-label text-[9px] text-on-surface-variant/40 tracking-wider leading-none">
            {item.episodes > 0 ? `${item.episodes} eps` : ''}
          </span>
        </div>
      </div>
    </div>
  )
}

// ── Loading ──────────────────────────────────────────────────────────────────

function LoadingState(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-32 gap-4">
      <span
        className="material-symbols-outlined text-primary/60 text-4xl animate-spin"
        style={{ animationDuration: '1.2s' }}
      >
        progress_activity
      </span>
      <p className="font-label text-xs text-on-surface-variant/40 tracking-widest uppercase">
        Loading calendar...
      </p>
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatRelTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
