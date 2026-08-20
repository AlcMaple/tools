import { useEffect, useMemo, useRef, useState } from 'react'
import type { CalendarItem, CalendarResult } from './api'
import { coverUrl, fetchCalendar, putTrack, deleteTrack } from './api'
import { useAuth } from './auth'
import { cacheGet, cacheSet } from './dataCache'
import { loadTracks, runTracksMutation } from './tracksSync'
import { Ic, Spinner } from './SketchIcon'
import { toast } from './Toast'
import { useIsWide } from './useMediaQuery'

// 皮肤 = 原型稿 index.html（番剧周历）：日期章横滑选天 + 单日海报胶片 + 立绘驻场。
// 布局单一（桌面/手机同构，响应式全交给 CSS）；数据流与旧版一致：
// 14 天缓存窗口 + 刷新绕过缓存；追番角标常驻（不依赖 hover），乐观更新后由 tracksSync 校正。

// 周历数据信 14 天的缓存窗口——跟桌面端、跟服务端自己的 14 天缓存一致。BGM 是外部接口，
// 缓存没过期就没必要发请求（唯一主动绕过缓存的入口是「刷新」按钮）。
const CALENDAR_CACHE_KEY = 'calendar'
const CALENDAR_TTL = 14 * 24 * 60 * 60_000

function todayBgmId(): number {
  const d = new Date().getDay() // 0=周日..6=周六
  return d === 0 ? 7 : d
}

// 本周（含今天的自然周）周一到周日的月/日 —— 日期章上的手写数字。
function weekDates(): Record<number, { m: number; d: number }> {
  const now = new Date()
  const monday = new Date(now)
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7))
  const out: Record<number, { m: number; d: number }> = {}
  for (let i = 1; i <= 7; i++) {
    const dt = new Date(monday)
    dt.setDate(monday.getDate() + (i - 1))
    out[i] = { m: dt.getMonth() + 1, d: dt.getDate() }
  }
  return out
}

// Windows 上原生 overflow-x 容器左键拖拽不滚动（会变成文本/元素选区），右键拖拽又因为
// scroll-snap 冲过头 —— 这里用 pointer 事件接管左键拖拽，直接改 scrollLeft，两侧都跟手，
// 松手后按最近几帧的速度做惯性滑行（配合 CSS 关掉 scroll-snap），才是触控板/触屏那种
// "跟手 + 滑一段再停" 的手感，而不是原来那种松手就一整张地对齐跳过去。
// 卡片标题（.poster-title）要能正常拖蓝选字，所以按下时若落在它上面就整个放弃接管，
// 交还给浏览器原生的文字选区。
const NO_DRAG_SELECTOR = '.poster-title'
const FRICTION = 0.95
const MIN_VELOCITY = 0.05

function useDragScroll<T extends HTMLElement>(): {
  ref: React.RefObject<T>
  onPointerDown: (e: React.PointerEvent<T>) => void
  onPointerMove: (e: React.PointerEvent<T>) => void
  onPointerUp: (e: React.PointerEvent<T>) => void
  onClickCapture: (e: React.MouseEvent<T>) => void
} {
  const ref = useRef<T>(null)
  const drag = useRef<{
    startX: number
    startScroll: number
    moved: boolean
    lastX: number
    lastT: number
    velocity: number
  } | null>(null)
  const suppressClick = useRef(false)
  const momentumFrame = useRef<number | null>(null)

  const stopMomentum = (): void => {
    if (momentumFrame.current !== null) {
      cancelAnimationFrame(momentumFrame.current)
      momentumFrame.current = null
    }
  }

  const runMomentum = (velocity: number): void => {
    const el = ref.current
    if (!el) return
    let v = velocity
    const step = (): void => {
      if (!el || Math.abs(v) < MIN_VELOCITY) {
        momentumFrame.current = null
        return
      }
      el.scrollLeft -= v * 16
      v *= FRICTION
      momentumFrame.current = requestAnimationFrame(step)
    }
    momentumFrame.current = requestAnimationFrame(step)
  }

  const onPointerDown = (e: React.PointerEvent<T>): void => {
    if (e.button !== 0 || !ref.current) return
    if ((e.target as HTMLElement).closest?.(NO_DRAG_SELECTOR)) return
    stopMomentum()
    const now = performance.now()
    drag.current = {
      startX: e.clientX,
      startScroll: ref.current.scrollLeft,
      moved: false,
      lastX: e.clientX,
      lastT: now,
      velocity: 0,
    }
  }

  const onPointerMove = (e: React.PointerEvent<T>): void => {
    const d = drag.current
    const el = ref.current
    if (!d || !el) return
    const dx = e.clientX - d.startX
    if (!d.moved && Math.abs(dx) < 4) return
    if (!d.moved) {
      d.moved = true
      el.setPointerCapture(e.pointerId)
    }
    e.preventDefault()
    el.scrollLeft = d.startScroll - dx

    const now = performance.now()
    const dt = now - d.lastT
    if (dt > 0) {
      // 瞬时速度，指数平滑一下避免抖动被最后一帧的噪声带偏
      const instant = (e.clientX - d.lastX) / dt
      d.velocity = d.velocity * 0.7 + instant * 0.3
    }
    d.lastX = e.clientX
    d.lastT = now
  }

  const onPointerUp = (e: React.PointerEvent<T>): void => {
    const d = drag.current
    if (d?.moved) {
      suppressClick.current = true
      if (ref.current?.hasPointerCapture(e.pointerId)) {
        ref.current.releasePointerCapture(e.pointerId)
      }
      if (Math.abs(d.velocity) > MIN_VELOCITY) runMomentum(d.velocity)
    }
    drag.current = null
  }

  // 拖拽结束时松手落在按钮（日期章）上会顺带触发一次 click —— 拖过了就吞掉这次点击。
  const onClickCapture = (e: React.MouseEvent<T>): void => {
    if (suppressClick.current) {
      suppressClick.current = false
      e.preventDefault()
      e.stopPropagation()
    }
  }

  return { ref, onPointerDown, onPointerMove, onPointerUp, onClickCapture }
}

export function CalendarPage(): JSX.Element {
  const [result, setResult] = useState<CalendarResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tracksError, setTracksError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedDay, setSelectedDay] = useState(todayBgmId)
  const { user } = useAuth()
  // 已追的 bgmId —— 用来给海报画「已收藏」描边 / 切圆章按钮图标。未登录就是空集（按钮不显示）。
  const [tracked, setTracked] = useState<Set<number>>(new Set())
  const dates = useMemo(weekDates, [])
  const todayId = useMemo(todayBgmId, [])
  // 桌面 = 整周纵览（七天的胶片竖着排，一眼看全一季）；手机 = 日期章选天 + 单日胶片
  const wide = useIsWide()

  // 复用 TracksPage 同一套「秒开缓存 + 后台校验」逻辑（tracksSync.ts）——两页共享
  // 同一份 tracks:<username> 缓存，谁先加载过谁就替对方省一次请求。
  useEffect(() => {
    if (!user) {
      setTracked(new Set())
      setTracksError(null)
      return
    }
    return loadTracks(
      user.username,
      (ts) => setTracked(new Set(ts.map((t) => t.bgmId))),
      setTracksError,
    )
  }, [user])

  // 先改本地再发请求 —— 点了要立刻有反馈。单条响应不直接落页面；最后一个并行写结束后
  // tracksSync 会拉权威全量列表，成功和失败都据此校正角标。
  const toggleTrack = (item: CalendarItem, weekday: number): void => {
    if (!user) return
    setError(null)
    const on = tracked.has(item.id)
    const title = item.name_cn || item.name
    setTracked((prev) => {
      const next = new Set(prev)
      on ? next.delete(item.id) : next.add(item.id)
      return next
    })
    toast(on ? '已取消追番' : `已把『${title}』加入追番`)
    void runTracksMutation(user.username, async () => {
      if (on) {
        await deleteTrack(item.id)
      } else {
        await putTrack(item.id, {
          status: 'watching',
          title: item.name,
          titleCn: item.name_cn,
          cover: item.cover,
          airWeekday: weekday,
          score: item.score,
        })
      }
    }).catch((e: Error) => setError(e.message))
  }

  const load = (force = false): void => {
    if (force) setRefreshing(true)
    else if (!result) setLoading(true)
    setError(null)
    fetchCalendar(force)
      .then((r) => {
        setResult(r)
        cacheSet(CALENDAR_CACHE_KEY, r)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }

  useEffect(() => {
    const cached = cacheGet<CalendarResult>(CALENDAR_CACHE_KEY, CALENDAR_TTL)
    if (cached) {
      setResult(cached)
      setLoading(false)
      return
    }
    load()
  }, [])

  const selected = result?.data.find((d) => d.id === selectedDay)
  const range = result
    ? `${dates[1].m}/${dates[1].d} – ${dates[7].m}/${dates[7].d}`
    : ''

  return (
    <>
      <div className="spread" style={{ alignItems: 'flex-end' }}>
        <div>
          <h1 className="title-sketch" style={{ fontSize: 34 }}>
            番剧周历
          </h1>
          <p className="muted small mt8">
            {range && <>本季 · {range} · 点日期章，翻到想看的那一天</>}
            {result && (
              <>
                {' '}
                <span className="faint">
                  （{result.fromCache ? '缓存' : '刚拉取'}：{formatRelTime(result.updatedAt)}）
                </span>
              </>
            )}
          </p>
        </div>
        <div className="row">
          <button
            className="icon-btn"
            onClick={() => load(true)}
            disabled={refreshing}
            title="刷新周历（绕过缓存）"
            aria-label="刷新周历"
          >
            <Ic name="refresh" cls={refreshing ? 'ic animate-spin' : 'ic'} />
          </button>
          <button
            className="btn btn-sm"
            type="button"
            onClick={() => {
              if (wide) {
                document.getElementById(`day-sec-${todayId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              } else {
                setSelectedDay(todayId)
              }
              toast('已回到今天')
            }}
          >
            <Ic name="calendar" cls="ic ic-sm" />
            回到今天
          </button>
        </div>
      </div>

      {(error || tracksError) && (
        <p className="form-note err mt8" aria-live="polite">
          ⚠ {error ?? tracksError}
        </p>
      )}

      {/* 手机：立绘内联（桌面在右侧驻场，CSS 切换） */}
      <div className="rig-inline mt16">
        <img className="rig" src="/assets/sagiri-full.webp" alt="和泉纱雾 · 官方立绘" />
        <div className="bubble rig-bubble">
          <span>点下面的日期章，翻到想看的那一天～</span>
        </div>
      </div>

      <div className="hero-split mt16">
        <div style={{ flex: 1, minWidth: 0 }}>
          {wide ? (
            // 桌面：整周纵览 —— 一季番剧不少，横滑选天翻起来太累；
            // 七天的「章头 + 胶片」竖排，昨天/前天补番、按周几找番都一眼可查
            result?.data.map((day) => (
              <section key={day.id} id={`day-sec-${day.id}`} className="day-sec">
                <DayHead day={day} date={dates[day.id]} today={day.id === todayId} />
                <FilmRow label={`${day.label}在播番剧`}>
                  <DayFilm
                    day={day}
                    canTrack={!!user}
                    tracked={tracked}
                    onToggle={toggleTrack}
                  />
                </FilmRow>
              </section>
            ))
          ) : (
            <>
              <DateStrip>
                {result?.data.map((day) => (
                  <button
                    key={day.id}
                    type="button"
                    className={`dstamp${day.id === selectedDay ? ' on' : ''}${day.id === todayId ? ' today' : ''}`}
                    onClick={() => setSelectedDay(day.id)}
                    title={`${day.label} · ${day.items.length} 部`}
                  >
                    <span className="dw">{day.label}</span>
                    <span className="dnum">{dates[day.id]?.d ?? ''}</span>
                    <span className="dc">{day.items.length} 部</span>
                    {day.id === todayId && (
                      <svg className="clip-today" aria-hidden="true">
                        <use href="#i-clip" />
                      </svg>
                    )}
                  </button>
                ))}
              </DateStrip>

              {selected && (
                <>
                  <DayHead day={selected} date={dates[selected.id]} today={selected.id === todayId} />
                  <FilmRow label="当日在播番剧">
                    <DayFilm
                      day={selected}
                      canTrack={!!user}
                      tracked={tracked}
                      onToggle={toggleTrack}
                    />
                  </FilmRow>
                </>
              )}
            </>
          )}
        </div>

        <div className="rig-box">
          <img className="rig" src="/assets/sagiri-full.webp" alt="和泉纱雾 · 官方立绘（全身）" />
          <div className="bubble rig-bubble">
            <span>{wide ? '一周的排片都在这页上，慢慢挑吧～' : '点日期章，翻到想看的那一天～'}</span>
          </div>
          <span className="kira" style={{ bottom: 78, right: -10, transform: 'rotate(6deg)' }}>
            サラサラ
          </span>
        </div>
      </div>

      {loading && !result && (
        <div className="page-state">
          <Spinner size={36} />
          <p className="faint small">正在翻开这周的画稿…</p>
        </div>
      )}
      {error && !result && (
        <div className="page-state">
          <Ic name="alert" cls="ic" />
          <p className="small">周历加载失败：{error}</p>
          <button className="btn btn-sm" type="button" onClick={() => load(true)}>
            重试
          </button>
        </div>
      )}
    </>
  )
}

function FilmRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  const drag = useDragScroll<HTMLDivElement>()
  return (
    <div
      className="film"
      aria-label={label}
      ref={drag.ref}
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      onPointerCancel={drag.onPointerUp}
      onClickCapture={drag.onClickCapture}
    >
      {children}
    </div>
  )
}

function DateStrip({ children }: { children: React.ReactNode }): JSX.Element {
  const drag = useDragScroll<HTMLDivElement>()
  return (
    <div
      className="date-strip"
      role="tablist"
      aria-label="选择日期"
      ref={drag.ref}
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      onPointerCancel={drag.onPointerUp}
      onClickCapture={drag.onClickCapture}
    >
      {children}
    </div>
  )
}

// ── 日节头（缎带 + 日期 + 部数），整周纵览与手机选天共用 ────────────────────────
function DayHead({ day, date, today }: { day: { id: number; label: string; items: CalendarItem[] }; date: { m: number; d: number }; today: boolean }): JSX.Element {
  return (
    <div className="day-head">
      <span className={`ribbon${today ? ' sakura' : ''}`}>
        {today ? (
          <>
            <Ic name="star" cls="ic ic-sm" />
            今天
          </>
        ) : (
          day.label
        )}
      </span>
      <span className="font-hand muted">
        {date.m}/{date.d} · {day.items.length} 部在播
      </span>
      <hr className="hr-dash" />
      <span className="sparkle">✦</span>
    </div>
  )
}

function DayFilm({
  day,
  canTrack,
  tracked,
  onToggle,
}: {
  day: { id: number; items: CalendarItem[] }
  canTrack: boolean
  tracked: Set<number>
  onToggle: (item: CalendarItem, weekday: number) => void
}): JSX.Element {
  if (day.items.length === 0) {
    return <div className="film-empty faint">这一天没有排片</div>
  }
  return (
    <>
      {day.items.map((item) => (
        <Poster
          key={item.id}
          item={item}
          weekday={day.id}
          canTrack={canTrack}
          tracked={tracked.has(item.id)}
          onToggle={onToggle}
        />
      ))}
    </>
  )
}

// ── 拍立得海报卡（追番圆章 / BGM 详情常驻，无 hover 依赖） ──────────────────────
function Poster({
  item,
  weekday,
  canTrack,
  tracked,
  onToggle,
}: {
  item: CalendarItem
  weekday: number
  canTrack: boolean
  tracked: boolean
  onToggle: (item: CalendarItem, weekday: number) => void
}): JSX.Element {
  const displayTitle = item.name_cn || item.name
  const on = tracked

  return (
    <article className={`poster${on ? ' tracked' : ''}`}>
      <div className="cover">
        {item.cover ? (
          <img
            className="cover-img"
            src={coverUrl(item.cover)}
            alt={`${displayTitle} 封面`}
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        ) : (
          <div className="cover-ph">☆</div>
        )}
        {canTrack && (
          <button
            type="button"
            className={`track-btn${on ? ' on' : ''}`}
            onClick={() => onToggle(item, weekday)}
            aria-label={on ? '取消追番' : '追番'}
            title={on ? '取消追番' : '加入我的追番'}
          >
            <Ic name={on ? 'check' : 'plus'} cls="ic" />
          </button>
        )}
        {item.id > 0 && (
          <a
            className="bgm-link"
            href={`https://bgm.tv/subject/${item.id}`}
            target="_blank"
            rel="noreferrer"
            title="在 Bangumi 查看"
          >
            <Ic name="external" cls="ic ic-sm" />
            详情
          </a>
        )}
      </div>
      <div className="poster-title" title={displayTitle}>
        {displayTitle}
      </div>
      <div className="poster-ep">{item.episodes > 0 ? `全 ${item.episodes} 集` : '连载中'}</div>
    </article>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatRelTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
