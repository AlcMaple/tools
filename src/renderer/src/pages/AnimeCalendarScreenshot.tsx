// 隐藏 BrowserWindow 里专门跑的"截图模式"周历视图。
//
// 触发链：主进程 calendar-mailer.ts 开 BrowserWindow 加 ?screenshot=calendar
// → App.tsx 走 query 分支挂这个组件 → 这里 fetch 周历数据 + 渲染 →
// 等所有 <img> load 或 timeout → 调 window.screenshotApi.reportCalendarReady(height)
// → 主进程 resize 隐藏窗口 + capturePage → PNG 走邮件。
//
// 跟 AnimeCalendar.tsx 的差异：
//   1. 不渲染 Sidebar / TopBar / sticky 刷新栏（这些在邮件里都是噪音）
//   2. 卡片去掉 "已追番" 角标 + hover overlay（截图里看不到 hover，但 track
//      badge 是常驻状态，对邮件收件人无意义）
//   3. 没有任何交互逻辑（点击、refresh 按钮、url 跳转 onClick）
//   4. 用 max-w-screen-xl + mx-auto 控制总宽度上限，跟主窗口默认显示的视觉
//      区域一致，避免 1280px BrowserWindow 里 grid 被拉伸成奇怪比例
//
// 触发 ready 信号的时机：当数据 ready 且所有渲染出来的 <img> 都已经 fire
// load 事件（成功或失败都算）后立刻上报。最多等 12s 然后强制上报，防止
// 个别 BGM 封面被墙拖死整封邮件。

import { useEffect, useMemo, useRef, useState } from 'react'
import type { BgmCalendarItem, BgmCalendarResult } from '../types/bgm'

const MAX_IMG_WAIT_MS = 12_000

type State =
  | { status: 'loading' }
  | { status: 'ready'; result: BgmCalendarResult }
  | { status: 'error'; message: string }

export default function AnimeCalendarScreenshot(): JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' })
  const rootRef = useRef<HTMLDivElement | null>(null)
  const reportedRef = useRef(false)

  // 拉数据 —— 主进程那边一般是 cache hit（fromCache=true）秒返回。
  useEffect(() => {
    window.bgmApi
      .calendar(false)
      .then(result => setState({ status: 'ready', result }))
      .catch(err => setState({ status: 'error', message: String(err) }))
  }, [])

  // 数据 ready 后：等所有 <img> 加载完（成功/失败都算），然后上报高度。
  // 12s timeout 兜底，防止个别图卡死。
  useEffect(() => {
    if (state.status !== 'ready') return
    if (reportedRef.current) return

    const root = rootRef.current
    if (!root) return

    const report = (): void => {
      if (reportedRef.current) return
      reportedRef.current = true
      // 用 scrollHeight 而不是 offsetHeight —— 防止内部 overflow 让我们少截
      const height = Math.max(root.scrollHeight, document.documentElement.scrollHeight)
      void window.screenshotApi.reportCalendarReady(height)
    }

    // requestAnimationFrame 等 layout 落定再查图
    requestAnimationFrame(() => {
      const imgs = Array.from(root.querySelectorAll('img'))
      if (imgs.length === 0) { report(); return }

      let remaining = imgs.length
      const onOne = (): void => {
        remaining -= 1
        if (remaining <= 0) report()
      }
      imgs.forEach(img => {
        if (img.complete) { onOne(); return }
        img.addEventListener('load', onOne, { once: true })
        img.addEventListener('error', onOne, { once: true })
      })
      // 总超时
      setTimeout(report, MAX_IMG_WAIT_MS)
    })
  }, [state])

  if (state.status === 'loading') {
    return <div className="p-8 font-body text-sm text-on-surface-variant">加载周历中…</div>
  }
  if (state.status === 'error') {
    return <div className="p-8 font-body text-sm text-error">加载失败：{state.message}</div>
  }
  return (
    <div ref={rootRef} className="bg-background text-on-surface font-body min-h-screen">
      <CalendarBody result={state.result} />
    </div>
  )
}

// ── 主体 ─────────────────────────────────────────────────────────────────────

function CalendarBody({ result }: { result: BgmCalendarResult }): JSX.Element {
  const total = useMemo(
    () => result.data.reduce((sum, d) => sum + d.items.length, 0),
    [result],
  )
  return (
    <div className="px-6 pt-6 pb-8">
      {/* 标题 + meta */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2 text-xs font-label text-outline uppercase tracking-widest">
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>calendar_month</span>
          <span>Anime</span>
          <span className="text-outline-variant">/</span>
          <span className="text-on-surface font-bold">番剧周历</span>
        </div>
        <h1 className="text-3xl font-black tracking-tighter text-on-surface">番剧周历</h1>
        <p className="text-sm text-on-surface-variant/80 mt-1 font-label">
          本季正在播出，按星期排列 · 共 {total} 部 · 来源 Bangumi
        </p>
      </div>

      {/* 7 day chips —— 不要 sticky，渲染成一条静态横排 */}
      <div className="grid grid-cols-7 gap-3 min-w-0 mb-3">
        {result.data.map(day => (
          <div
            key={day.id}
            className="px-2.5 py-1.5 rounded-md border bg-surface-container border-outline-variant/15 text-on-surface-variant/80 flex items-baseline justify-between gap-2"
          >
            <span className="font-headline text-xs font-black tracking-tight">{day.label}</span>
            <span className="font-label text-[10px] uppercase tracking-widest opacity-60">
              {day.items.length} 部
            </span>
          </div>
        ))}
      </div>

      {/* 7 列 grid —— 跟正式页面同结构 */}
      <div className="grid grid-cols-7 gap-3">
        {result.data.map(day => (
          <DayColumn key={day.id} items={day.items} />
        ))}
      </div>
    </div>
  )
}

function DayColumn({ items }: { items: BgmCalendarItem[] }): JSX.Element {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-outline-variant/20 px-3 py-6 text-center font-label text-[10px] text-on-surface-variant/30 uppercase tracking-widest">
          空
        </div>
      ) : (
        items.map(it => <PrintCard key={it.id} item={it} />)
      )}
    </div>
  )
}

function PrintCard({ item }: { item: BgmCalendarItem }): JSX.Element {
  const displayTitle = item.name_cn || item.name
  const sub = item.name_cn && item.name && item.name !== item.name_cn ? item.name : ''

  return (
    <div className="bg-surface-container rounded-lg border border-outline-variant/15 overflow-hidden">
      <div className="aspect-[3/4] relative bg-surface-container-high">
        {item.cover ? (
          <img
            src={item.cover}
            alt={displayTitle}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-on-surface-variant/20">
            <span className="material-symbols-outlined text-3xl">image</span>
          </div>
        )}
      </div>
      <div className="px-2 py-2 flex flex-col gap-0.5">
        <h3 className="text-xs font-bold text-on-surface line-clamp-2 leading-tight h-[30px]">
          {displayTitle}
        </h3>
        <p className="text-[10px] text-on-surface-variant/40 line-clamp-1 leading-tight h-[14px]">
          {sub || ' '}
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
