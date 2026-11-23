import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { CatalogItem } from './api'
import { CATALOG_POSITION_IDS } from '../shared/catalog-position'

const TOP = 4
const BOTTOM = 28

class RowSizes {
  private sums = new Float64Array(2)
  private measured = new Map<number, number>()

  constructor(readonly estimate: number) {}

  reserve(count: number): void {
    const size = this.sums.length - 1
    if (count <= size) return
    const next = new Float64Array(2 ** Math.ceil(Math.log2(count)) + 1)
    next.set(this.sums)
    for (let i = size * 2; i < next.length; i *= 2) next[i] = this.sums[size]
    this.sums = next
  }

  size(row: number): number {
    return this.measured.get(row) ?? this.estimate
  }

  set(row: number, size: number): void {
    const diff = size - this.size(row)
    if (Math.abs(diff) < 0.01) return
    if (size === this.estimate) this.measured.delete(row)
    else this.measured.set(row, size)
    for (let i = row + 1; i < this.sums.length; i += i & -i) this.sums[i] += diff
  }

  offset(row: number): number {
    let y = row * this.estimate
    for (let i = row; i > 0; i -= i & -i) y += this.sums[i]
    return y
  }

  rowAt(y: number, count: number): number {
    if (y <= 0 || count <= 1) return 0
    let row = 0, offset = 0
    // 未经过的行用估高，Fenwick 树只累加实测偏差，滚动时不从头扫描目录
    for (let step = this.sums.length - 1; step >= 1; step /= 2) {
      const next = row + step
      if (next >= count) continue
      const bottom = offset + step * this.estimate + this.sums[next]
      if (bottom <= y) { row = next; offset = bottom }
    }
    return row
  }
}

type Frame = { columns: number; start: number; end: number; before: number; after: number }
const FIRST: Frame = { columns: 2, start: 0, end: 4, before: 0, after: 0 }
type Anchor = { id: number; index: number; top: number }
type Layout = { columns: number; width: number; gap: number; rows: RowSizes; items: CatalogItem[]; anchor: Anchor | null; firstTop: number }

function anchorAt(layout: Layout, y: number): Anchor | null {
  if (y < 0) return null
  const { columns, rows, items, gap } = layout
  const count = Math.ceil(items.length / columns)
  if (y >= rows.offset(count)) return null
  let row = rows.rowAt(y, count)
  if (row + 1 < count && rows.offset(row + 1) - gap <= y) row++
  const index = row * columns
  return { id: items[index].bgmId, index, top: rows.offset(row) - y }
}

function sameFrame(a: Frame, b: Frame): boolean {
  return a.columns === b.columns && a.start === b.start && a.end === b.end
    && Math.abs(a.before - b.before) < 0.1 && Math.abs(a.after - b.after) < 0.1
}

export function CatalogGrid({ items, stale, restoreId, atStart, onBrowse, render }: {
  items: CatalogItem[]
  stale: boolean
  restoreId?: number
  atStart: boolean
  onBrowse?: (ids: number[]) => void
  render: (item: CatalogItem) => JSX.Element
}): JSX.Element {
  const grid = useRef<HTMLDivElement>(null)
  const [frame, setFrame] = useState(FIRST)
  const requested = useRef(FIRST)
  const committed = useRef({ frame, items, start: 0, end: 0 })
  const layout = useRef<Layout | null>(null)
  const pendingAlignment = useRef<number | null>(null)
  const pendingRestore = useRef(restoreId)
  const lastRecorded = useRef(restoreId)
  const internalScroll = useRef<number | null>(null)
  const count = Math.ceil(items.length / frame.columns)
  const start = Math.max(0, Math.min(frame.start, count - 1))
  const end = Math.min(count, Math.max(start + 1, frame.end))

  const align = useCallback((el: HTMLElement, y: number): void => {
    const delta = el.getBoundingClientRect().top + TOP + y
    const before = window.scrollY
    if (Math.abs(delta) <= 0.5) return
    window.scrollTo({ top: before + delta, behavior: 'instant' })
    if (window.scrollY !== before) internalScroll.current = window.scrollY
  }, [])

  const refresh = useCallback((measure: boolean): void => {
    const el = grid.current
    const current = committed.current
    if (!el || !current.items.length || requested.current !== current.frame) return
    const rect = el.getBoundingClientRect()
    const y = -rect.top - TOP
    const previous = layout.current
    let active = previous
    let targetY = y
    let focus: HTMLElement | null = null
    if (measure || !previous) {
      const style = getComputedStyle(el)
      const columns = style.gridTemplateColumns.trim().split(/\s+/).length
      const gap = parseFloat(style.rowGap) || 0
      const sizes = style.gridTemplateRows.trim().split(/\s+/).map(size => parseFloat(size) + gap)
      const measurable = sizes.length > 0 && sizes.every(size => Number.isFinite(size) && size > gap)
      const prepended = previous && current.items.length > previous.items.length && current.items[0].bgmId !== previous.items[0].bgmId
      const changed = !previous || previous.columns !== columns || Math.abs(previous.width - rect.width) > 0.25 || previous.gap !== gap
        || prepended || (current.items !== previous.items && current.items.length <= previous.items.length)
      // 向上续载会改掉原卡片的行号，最后一批还会撤掉上方加载按钮，必须从前一帧的作品和屏内位置补回来
      const anchor = previous && (prepended
        ? previous.anchor ?? { id: previous.items[0].bgmId, index: 0, top: previous.firstTop }
        : changed ? previous.anchor : anchorAt(previous, y))
      if (!previous || changed) {
        const estimate = measurable ? sizes.reduce((sum, size) => sum + size, 0) / sizes.length : 400
        active = { columns, width: rect.width, gap, rows: new RowSizes(estimate), items: current.items, anchor: null, firstTop: -y }
      } else {
        if (previous.items !== current.items && previous.items.length % columns) {
          previous.rows.set(Math.floor(previous.items.length / columns), previous.rows.estimate)
        }
        previous.items = current.items
      }
      layout.current = active
      if (!active) return
      const { rows } = active
      rows.reserve(Math.ceil(current.items.length / columns))
      // CSS 网格行高是未旋转的实际高度，海报倾斜和标签折行都不会污染占位
      const measured = columns === current.frame.columns && measurable && sizes.length === current.end - current.start
      if (measured) {
        sizes.forEach((size, i) => rows.set(current.start + i, size))
      }
      if (anchor) {
        const sameId = changed ? current.items.findIndex(item => item.bgmId === anchor.id) : anchor.index
        const index = sameId < 0 ? Math.min(anchor.index, current.items.length - 1) : sameId
        const row = Math.floor(index / columns)
        const top = Math.max(anchor.top, -Math.max(0, rows.size(row) - gap - 1))
        targetY = rows.offset(row) - top
      }
      if (pendingRestore.current !== undefined) {
        const index = current.items.findIndex(item => item.bgmId === pendingRestore.current)
        if (index >= 0) {
          const row = Math.floor(index / columns)
          targetY = rows.offset(row) - (document.querySelector<HTMLElement>('.m-top')?.offsetHeight ?? 0) - 8
          // 要等目标行真正量过，避免先按估高跳过去，又被后续补位推开
          if (measured && row >= current.start && row < current.end) {
            focus = el.children[index - current.start * columns]?.querySelector<HTMLElement>('.poster-title')
            pendingRestore.current = undefined
          }
        } else pendingRestore.current = undefined
      }
    }
    if (!active) return
    const { rows, columns } = active
    const total = Math.ceil(current.items.length / columns)
    const overscan = window.innerHeight * 1.5
    // 从整组四张的边界开始，离屏卡片卸载后仍沿用原来的海报倾斜顺序
    const first = Math.floor(rows.rowAt(targetY - overscan, total) / 4) * 4
    const last = rows.rowAt(targetY + window.innerHeight + overscan, total) + 1
    const next = { columns, start: first, end: last, before: rows.offset(first), after: rows.offset(total) - rows.offset(last) }
    active.anchor = anchorAt(active, targetY)
    active.firstTop = -targetY
    focus?.focus({ preventScroll: true })
    const aligned = Math.abs(targetY - y) > 0.5
    if (sameFrame(next, current.frame)) {
      if (aligned) align(el, targetY)
      return
    }
    pendingAlignment.current = aligned ? targetY : null
    requested.current = next
    // 拖滚动条或瞬间回顶部时可能跨出整个预渲染区，只有这类跳转才要赶在当前帧补上卡片
    const jumped = !measure && (targetY >= rows.offset(current.end) || targetY + window.innerHeight <= rows.offset(current.start))
    if (jumped) flushSync(() => setFrame(next))
    else setFrame(next)
  }, [align])

  useLayoutEffect(() => {
    committed.current = { frame, items, start, end }
    if (requested.current === frame && pendingAlignment.current !== null && grid.current) {
      align(grid.current, pendingAlignment.current)
      pendingAlignment.current = null
    }
    refresh(true)
  }, [frame, items, start, end, refresh, align])

  const browsing = useRef({ atStart, onBrowse })
  useLayoutEffect(() => { browsing.current = { atStart, onBrowse } }, [atStart, onBrowse])

  useLayoutEffect(() => {
    let scheduled = 0, measure = false
    const schedule = (remeasure: boolean): void => {
      measure ||= remeasure
      if (scheduled) return
      scheduled = requestAnimationFrame(() => {
        scheduled = 0
        const needed = measure
        measure = false
        refresh(needed)
      })
    }
    let browseUntil = 0
    // scroll 也会由焦点、旋转和程序补位触发；只把真实滚动手势带来的新行记成书签
    const arm = (event: Event): void => {
      if (event.isTrusted) browseUntil = performance.now() + 500
    }
    const touch = (event: TouchEvent): void => {
      if (event.touches.length === 1) arm(event)
    }
    const wheel = (event: WheelEvent): void => {
      if (event.deltaY !== 0 && !event.ctrlKey) arm(event)
    }
    const keydown = (event: KeyboardEvent): void => {
      if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
        || event.defaultPrevented || (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable]'))) return
      arm(event)
    }
    const scroll = (): void => {
      schedule(false)
      const aligned = internalScroll.current === window.scrollY
      internalScroll.current = null
      const el = grid.current, active = layout.current
      const { atStart, onBrowse } = browsing.current
      if (aligned || pendingRestore.current !== undefined || !onBrowse || !el || !active
        || document.visibilityState !== 'visible' || performance.now() >= browseUntil) return
      browseUntil = performance.now() + 500
      const gridTop = el.getBoundingClientRect().top + TOP
      const top = document.querySelector<HTMLElement>('.m-top')?.offsetHeight ?? 0
      const anchor = anchorAt(active, top - gridTop)
      if (!anchor || (atStart && anchor.index === 0)) return
      const { columns, rows, items, gap } = active
      const currentRow = items.slice(anchor.index, anchor.index + columns)
      if (currentRow.some(item => item.bgmId === lastRecorded.current)) return
      const bar = document.querySelector<HTMLElement>('.m-bm')?.getBoundingClientRect()
      const bottom = (bar?.height ? bar.top : window.innerHeight) - gridTop
      const ids: number[] = []
      for (let index = anchor.index; index < items.length && ids.length < CATALOG_POSITION_IDS; index++) {
        if (rows.offset(Math.floor(index / columns)) >= bottom) break
        ids.push(items[index].bgmId)
      }
      if (ids.length && rows.offset(Math.floor(anchor.index / columns) + 1) - gap > top - gridTop) {
        onBrowse(ids)
        lastRecorded.current = ids[0]
      }
    }
    const resize = (): void => schedule(true)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    if (grid.current) observer?.observe(grid.current)
    window.addEventListener('scroll', scroll, { passive: true })
    window.addEventListener('touchmove', touch, { passive: true })
    window.addEventListener('wheel', wheel, { passive: true })
    window.addEventListener('keydown', keydown)
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('scroll', scroll)
      window.removeEventListener('touchmove', touch)
      window.removeEventListener('wheel', wheel)
      window.removeEventListener('keydown', keydown)
      window.removeEventListener('resize', resize)
      observer?.disconnect()
      if (scheduled) cancelAnimationFrame(scheduled)
    }
  }, [refresh])

  return <div ref={grid} className={`film is-vertical catalog-grid${stale ? ' is-stale' : ''}`} aria-busy={stale}
    style={{ paddingTop: TOP + frame.before, paddingBottom: BOTTOM + frame.after }}>
    {items.slice(start * frame.columns, end * frame.columns).map(render)}
  </div>
}
