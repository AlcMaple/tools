// 功能拼接流程图：客户页可点击切换，开发者侧只读。连线要跟着节点真实位置走（换行、改字都会变），所以量 DOM 而不是算网格
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { flowChannels, flowLayout, flowOrderedLayers, flowRoute, scopeConflicts, type FlowPoint, type FlowRect, type ScopeLinks, type ScopeNode } from '../../shared/order-judge-scope'

type Axis = 'x' | 'y'
interface Edge { key: string; from: string; to: string; d: string; on: boolean; bad: boolean; sub: boolean; cx: number; cy: number; axis: Axis }
interface Edits { offsets: Record<string, { x: number; y: number }>; added: { from: string; to: string }[]; removed: string[]; bends: Record<string, number> }
interface Bounds { l: number; t: number; r: number; b: number }

const MIN_K = 0.3, MAX_K = 2.5, MAX_H = 720, TRACK = 10, PAD = 20, EDIT_MIN_H = 320, SNAP = 6, INLINE_MIN_K = 0.6
const NO_EDITS: Edits = { offsets: {}, added: [], removed: [], bends: {} }
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

function roundedPath(raw: FlowPoint[]): string {
  const pts = raw.filter((p, i) => !i || Math.abs(p.x - raw[i - 1].x) + Math.abs(p.y - raw[i - 1].y) > 0.5)
  let d = `M${pts[0].x} ${pts[0].y}`
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], prev = pts[i - 1], next = pts[i + 1]
    if (!next) { d += ` L${p.x} ${p.y}`; break }
    const inLen = Math.hypot(p.x - prev.x, p.y - prev.y), outLen = Math.hypot(next.x - p.x, next.y - p.y)
    const r = Math.min(6, inLen / 2, outLen / 2)
    d += ` L${p.x - ((p.x - prev.x) / inLen) * r} ${p.y - ((p.y - prev.y) / inLen) * r} Q${p.x} ${p.y} ${p.x + ((next.x - p.x) / outLen) * r} ${p.y + ((next.y - p.y) / outLen) * r}`
  }
  return d
}

// 被拖动过的功能不在原来那一行上，行间通道的走法对它不成立：改成从相对的两条边出发、中间一段折线，中段位置可以拖
function stepRoute(a: FlowRect, b: FlowRect, bend = 0): { pts: FlowPoint[]; axis: Axis } {
  const ax = (a.left + a.right) / 2, ay = (a.top + a.bottom) / 2, bx = (b.left + b.right) / 2, by = (b.top + b.bottom) / 2
  const mid = (lo: number, hi: number): number => (hi - lo < 16 ? (lo + hi) / 2 : clamp((lo + hi) / 2 + bend, lo + 8, hi - 8))
  if (b.top - a.bottom >= 16) { const y = mid(a.bottom, b.top); return { axis: 'y', pts: [{ x: ax, y: a.bottom }, { x: ax, y }, { x: bx, y }, { x: bx, y: b.top }] } }
  if (a.top - b.bottom >= 16) { const y = mid(b.bottom, a.top); return { axis: 'y', pts: [{ x: ax, y: a.top }, { x: ax, y }, { x: bx, y }, { x: bx, y: b.bottom }] } }
  if (b.left - a.right >= 16) { const x = mid(a.right, b.left); return { axis: 'x', pts: [{ x: a.right, y: ay }, { x, y: ay }, { x, y: by }, { x: b.left, y: by }] } }
  if (a.left - b.right >= 16) { const x = mid(b.right, a.left); return { axis: 'x', pts: [{ x: a.left, y: ay }, { x, y: ay }, { x, y: by }, { x: b.right, y: by }] } }
  return { axis: 'y', pts: [{ x: ax, y: ay }, { x: bx, y: by }] }
}

// 选中连线后的操作点放在最长的那一段中间，离两头的功能最远
function longest(pts: FlowPoint[]): { cx: number; cy: number; axis: Axis } {
  let best = 0
  for (let i = 1; i < pts.length - 1; i++) if (Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y) > Math.hypot(pts[best + 1].x - pts[best].x, pts[best + 1].y - pts[best].y)) best = i
  const p = pts[best], q = pts[best + 1]
  return { cx: (p.x + q.x) / 2, cy: (p.y + q.y) / 2, axis: Math.abs(q.x - p.x) >= Math.abs(q.y - p.y) ? 'y' : 'x' }
}

const typing = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

const reaches = (nodes: ScopeNode[], from: string, to: string): boolean => {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const seen = new Set<string>()
  const walk = (id: string): boolean => id === to || (!seen.has(id) && (seen.add(id), (byId.get(id)?.dependsOn ?? []).some(walk)))
  return walk(from)
}

// A→B→C 又画一条 A→C 只会多出一根线：中间的功能都选了，A→C 已经被这条路径表达，不再单画。
// 中间有没选的才保留，那是真正缺了东西的提示。只影响画线，冲突检查仍用完整依赖
const implied = (nodes: ScopeNode[], picked: ReadonlySet<string>, from: string, to: string): boolean => {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const seen = new Set<string>()
  const walk = (id: string): boolean => (byId.get(id)?.dependsOn ?? []).some(d => d === from || (picked.has(d) && !seen.has(d) && (seen.add(d), walk(d))))
  return (byId.get(to)?.dependsOn ?? []).some(m => m !== from && picked.has(m) && (seen.clear(), walk(m)))
}

// editable：功能可拖动（会吸附对齐），从底部圆点拖到另一个功能连一条「先有前者」；点连线选中后可拖中段或删除，支持撤销重做。改动只在这个页面里，刷新还原
// 页面里那一块只够看个大概，全屏后画布占满窗口：滚轮平移、Ctrl/⌘ + 滚轮或双指缩放
// onPick：连线或调换先后之后把两端勾上（页面会连前置一起勾）。onUnlock：点被方案锁住的功能，由页面决定要不要解除。initialLinks：上次提交时改过的连线，打开时接着显示
export function FlowPreview({ nodes: base0, picked, locked, onToggle, onPick, onUnlock, editable, onNodes, initialLinks }: { nodes: ScopeNode[]; picked: ReadonlySet<string>; locked?: ReadonlySet<string>; onToggle?: (id: string) => void; onPick?: (ids: string[]) => void; onUnlock?: (id: string) => void; editable?: boolean; onNodes?: (nodes: ScopeNode[]) => void; initialLinks?: ScopeLinks }): JSX.Element {
  const [ed, setEd] = useState<Edits>(() => (initialLinks ? { ...NO_EDITS, added: initialLinks.add.map(([from, to]) => ({ from, to })), removed: initialLinks.drop.map(([from, to]) => `${from}>${to}`) } : NO_EDITS))
  const edRef = useRef(ed)
  edRef.current = ed
  const [hist, setHist] = useState<{ past: Edits[]; future: Edits[] }>({ past: [], future: [] })
  const snapshot = (): void => setHist(h => ({ past: [...h.past.slice(-49), edRef.current], future: [] }))
  const commit = (next: Edits): void => { snapshot(); setEd(next) }
  const undo = (): void => { const prev = hist.past[hist.past.length - 1]; if (!prev) return; setHist({ past: hist.past.slice(0, -1), future: [ed, ...hist.future] }); setEd(prev); setSel(null) }
  const redo = (): void => { const next = hist.future[0]; if (!next) return; setHist({ past: [...hist.past, ed], future: hist.future.slice(1) }); setEd(next); setSel(null) }
  const { offsets, added, removed, bends } = ed
  const [drawing, setDrawing] = useState<{ from: string; x: number; y: number; to: string | null; ok: boolean } | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [guide, setGuide] = useState<{ x?: number; y?: number }>({})
  const [full, setFull] = useState(false)
  const moved = useRef(false)
  const inside = useRef(false)
  const nodes = useMemo(() => base0.map(n => ({ ...n, dependsOn: [...n.dependsOn.filter(d => !removed.includes(`${d}>${n.id}`)), ...added.filter(a => a.to === n.id && !n.dependsOn.includes(a.from)).map(a => a.from)] })), [base0, added, removed])
  const nodesKey = nodes.map(n => `${n.id}:${n.dependsOn.join()}`).join('|')
  useLayoutEffect(() => { if (editable) onNodes?.(nodes) }, [nodesKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const box = useRef<HTMLDivElement>(null)
  const port = useRef<HTMLDivElement>(null)
  // 手动缩放 / 平移过之后不再自动适应，点「适应」或双击空白回到整图
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const viewRef = useRef(view)
  viewRef.current = view
  const touched = useRef(false)
  const [edges, setEdges] = useState<Edge[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })
  // 页面里的高度按整图适应后的大小定下来，之后缩放不再改它，不推动下面的内容
  const [fitH, setFitH] = useState(editable ? EDIT_MIN_H : 80)
  const rects = useRef(new Map<string, FlowRect>())
  const bounds = useRef<Bounds | null>(null)
  const byId = new Map(nodes.map(n => [n.id, n]))
  const layers = flowOrderedLayers(base0)
  const [hover, setHover] = useState<string | null>(null)
  const layerOf = new Map(layers.flatMap((l, i) => l.map(id => [id, i] as const)))
  // 位置由上下级关系算出来（子节点在上级下方、上级在子节点中间），不再把每层排成居中的一行；宽高要先量出来
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({})
  // 每个来源在层间通道里占一条自己的横线，线多的通道相应拉高，不把几根横线挤成一团
  const drawn = nodes.flatMap(n => (picked.has(n.id) ? n.dependsOn.filter(d => byId.has(d) && !implied(nodes, picked, d, n.id)).map(d => ({ d, id: n.id })) : []))
  const passing = layers.map((_, r) => new Set(drawn.filter(l => (layerOf.get(l.d) ?? 0) <= r && (layerOf.get(l.id) ?? 0) > r).map(l => l.d)).size)
  const layout = flowLayout(layers, id => byId.get(id)?.dependsOn ?? [], id => sizes[id] ?? { w: 120, h: 32 }, 28, r => 34 + Math.max(0, passing[r] - 1) * TRACK)
  // 编辑时位置定下来就不再重排：勾选、连线都会改变算出来的布局，功能自己挪了位置客户就找不到了。后加的功能排到最下面
  const frozen = useRef<Map<string, FlowPoint> | null>(null)
  if (editable && layers.flat().every(id => sizes[id])) {
    if (!frozen.current) frozen.current = new Map(layout.pos)
    for (const id of layers.flat()) if (!frozen.current.has(id)) {
      const at = frozen.current
      const floor = Math.max(0, ...[...at].map(([n, p]) => p.y + (sizes[n]?.h ?? 32)))
      at.set(id, { x: at.get(byId.get(id)?.dependsOn.find(d => at.has(d)) ?? '')?.x ?? 0, y: floor + 34 })
    }
  }
  const posOf = (id: string): FlowPoint => (editable && frozen.current?.get(id)) || layout.pos.get(id)!
  const layoutKey = layers.flat().map(id => [id, posOf(id)] as const).map(([id, p]) => `${id}@${Math.round(p.x)},${Math.round(p.y)}`).join()
  const bad = new Set(scopeConflicts(nodes, picked).map(c => c.id))
  // 每个功能只常驻一条线连到上一层最近的前置，形成一棵清楚的树；其余前置（跨层或多个来源）画细一点
  const primaryOf = (n: ScopeNode): string | undefined => n.dependsOn.reduce<string | undefined>((best, d) => (best == null || (layerOf.get(d) ?? -1) > (layerOf.get(best) ?? -1) ? d : best), undefined)
  const signature = nodesKey + [...picked].join() + JSON.stringify(offsets) + JSON.stringify(bends) + layoutKey + full

  const fit = (): void => {
    const vp = port.current, b = bounds.current
    if (!vp || !b) return
    const vw = vp.clientWidth, W = b.r - b.l, H = b.b - b.t
    if (!vw || !W || !H) return
    const roomH = full ? vp.clientHeight : MAX_H
    // 全屏时小图可以放大到看得清，页面里不放大，免得几个功能撑出一大块
    // 页面里缩到看不清字不如只露出一部分：最小 0.6，放不下的从左上角起、拖动看其余部分
    const k = clamp(Math.min(full ? 1.6 : 1, (vw - PAD * 2) / W, (roomH - PAD * 2) / H), full ? MIN_K : INLINE_MIN_K, MAX_K)
    const h = full ? roomH : Math.max(editable ? EDIT_MIN_H : 0, Math.min(MAX_H, Math.ceil(H * k + PAD * 2)))
    const x = Math.max(PAD, (vw - W * k) / 2) - b.l * k, y = Math.max(PAD, (h - H * k) / 2) - b.t * k
    if (!full) setFitH(v => (v === h ? v : h))
    setView(v => (Math.abs(v.k - k) < 0.001 && Math.abs(v.x - x) < 0.5 && Math.abs(v.y - y) < 0.5 ? v : { k, x, y }))
    // 编辑时只在打开和进出全屏时适应一次，之后画面不自己动
    if (editable) touched.current = true
  }
  const refit = (): void => { touched.current = false; fit() }

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = (): void => {
      const got: Record<string, { w: number; h: number }> = {}
      el.querySelectorAll<HTMLElement>('[data-node]').forEach(n => { got[n.dataset.node!] = { w: n.offsetWidth, h: n.offsetHeight } })
      if (Object.keys(got).some(id => got[id].w !== sizes[id]?.w || got[id].h !== sizes[id]?.h)) { setSizes(got); return }
      const base = el.getBoundingClientRect()
      const k = viewRef.current.k
      const at = new Map<string, FlowRect>()
      el.querySelectorAll<HTMLElement>('[data-node]').forEach(n => {
        const r = n.getBoundingClientRect()
        at.set(n.dataset.node!, { left: (r.left - base.left) / k, right: (r.right - base.left) / k, top: (r.top - base.top) / k, bottom: (r.bottom - base.top) / k })
      })
      rects.current = at
      const all = [...at.values()]
      bounds.current = all.length ? { l: Math.min(...all.map(r => r.left)), t: Math.min(...all.map(r => r.top)), r: Math.max(...all.map(r => r.right)), b: Math.max(...all.map(r => r.bottom)) } : null
      // 行间通道只按还在原位的功能算，被拖走的不参与分行
      const free = (id: string): boolean => !!offsets[id]
      const grid = [...at].filter(([id]) => !free(id)).map(([, r]) => r)
      // 行间通道只会从上往下走；客户连出一条往上或同一行的线时也改走折线
      const loose = (d: string, id: string): boolean => free(d) || free(id) || bends[`${d}>${id}`] != null || at.get(d)!.bottom > at.get(id)!.top
      const next: Edge[] = []
      const links = nodes.flatMap(n => (picked.has(n.id) && at.has(n.id) ? n.dependsOn.filter(d => at.has(d) && !implied(nodes, picked, d, n.id)).map(d => ({ d, id: n.id })) : []))
      const tracked = links.filter(l => !loose(l.d, l.id))
      const sources = [...new Set(tracked.map(l => l.d))].sort((p, q) => at.get(p)!.left - at.get(q)!.left)
      const users = new Map<number, string[]>()
      for (const l of tracked) for (const ch of flowChannels(at.get(l.d)!, at.get(l.id)!, grid)) {
        const list = users.get(ch) ?? []
        if (!list.includes(l.d)) list.push(l.d)
        users.set(ch, list)
      }
      const trackOf = (src: string) => (ch: number): number => {
        const list = (users.get(ch) ?? []).sort((p, q) => sources.indexOf(p) - sources.indexOf(q))
        return (list.indexOf(src) - (list.length - 1) / 2) * TRACK
      }
      for (const n of nodes) {
        const to = at.get(n.id)
        if (!to || !picked.has(n.id)) continue
        // 没选的功能不画线：选得少时满屏的线盖住真正走得通的路线
        const ins = n.dependsOn.filter(d => at.has(d) && !implied(nodes, picked, d, n.id)).sort((p, q) => at.get(p)!.left - at.get(q)!.left)
        const span = Math.min(14, (to.right - to.left - 24) / Math.max(ins.length - 1, 1))
        for (const [i, d] of ins.entries()) {
          const from = at.get(d)!, key = `${d}>${n.id}`
          const step = loose(d, n.id) ? stepRoute(from, to, bends[key] ?? 0) : null
          const pts = step ? step.pts : flowRoute(from, to, grid, el.offsetWidth, trackOf(d), (sources.indexOf(d) % 3 - 1) * 3, (i - (ins.length - 1) / 2) * span)
          const ctl = step && step.pts.length === 4 ? { cx: (pts[1].x + pts[2].x) / 2, cy: (pts[1].y + pts[2].y) / 2, axis: step.axis } : longest(pts)
          next.push({ key, from: d, to: n.id, d: roundedPath(pts), on: picked.has(d), bad: !picked.has(d), sub: d !== primaryOf(n), ...ctl })
        }
      }
      setEdges(next)
      setSize({ w: el.offsetWidth, h: el.offsetHeight })
      if (!touched.current) fit()
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (port.current) ro.observe(port.current)
    return () => ro.disconnect()
  // nodes / picked 每次渲染都是新引用，内容变了 signature 才变
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  const zoomAt = (px: number, py: number, f: number): void => {
    touched.current = true
    setView(v => { const k = clamp(v.k * f, MIN_K, MAX_K), r = k / v.k; return { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r } })
  }
  const zoomBy = (f: number): void => { const vp = port.current; if (vp) zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, f) }
  useEffect(() => {
    const vp = port.current
    if (!vp) return
    // 页面里不带修饰键的滚轮留给页面滚动；全屏后画布独占窗口，滚轮平移
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const r = vp.getBoundingClientRect()
        zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01))
      } else if (full) {
        e.preventDefault()
        touched.current = true
        setView(v => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
      }
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [full]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!full) return
    const root = document.documentElement, prev = root.style.overflow
    root.style.overflow = 'hidden'
    return () => { root.style.overflow = prev }
  }, [full])
  const toggleFull = (): void => { touched.current = false; setSel(null); setFull(f => !f) }

  const dropEdge = (key: string): void => {
    const [from, to] = key.split('>')
    const { [key]: _, ...restBends } = bends
    commit(edgeIn({ ...ed, bends: restBends }, from, to, false))
    setSel(null)
  }
  const edgeIn = (v: Edits, from: string, to: string, on: boolean): Edits => {
    const key = `${from}>${to}`, base = !!base0.find(n => n.id === to)?.dependsOn.includes(from)
    const added = v.added.filter(a => !(a.from === from && a.to === to)), removed = v.removed.filter(r => r !== key)
    return on ? { ...v, removed, added: base ? added : [...added, { from, to }] } : { ...v, added, removed: base ? [...removed, key] : removed }
  }
  // 调换先后：系统认为先有 A 才有 B，客户认为反过来。去掉这条之后反向仍然成环的不能调
  const canFlip = (from: string, to: string): boolean => !reaches(nodes.map(n => (n.id === to ? { ...n, dependsOn: n.dependsOn.filter(d => d !== from) } : n)), to, from)
  const flipEdge = (key: string): void => {
    const [from, to] = key.split('>')
    if (!canFlip(from, to)) return
    const { [key]: _, ...restBends } = bends
    commit(edgeIn(edgeIn({ ...ed, bends: restBends }, from, to, false), to, from, true))
    setSel(`${to}>${from}`)
    onPick?.([from, to].filter(end => !picked.has(end) && !locked?.has(end)))
  }
  useEffect(() => {
    if (!full && !editable) return
    const onKey = (e: KeyboardEvent): void => {
      if (typing(e.target) || (!full && !inside.current)) return
      const mod = e.ctrlKey || e.metaKey
      if (e.key === 'Escape') { if (sel) setSel(null); else if (full) toggleFull(); else return }
      else if (editable && sel && (e.key === 'Delete' || e.key === 'Backspace')) dropEdge(sel)
      else if (editable && mod && e.key.toLowerCase() === 'z') { if (e.shiftKey) redo(); else undo() }
      else if (editable && mod && e.key.toLowerCase() === 'y') redo()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // 一根手指（或鼠标）拖空白处平移，全屏时两根手指捏合缩放。页面里的触摸留给页面滚动
  const fingers = useRef(new Map<number, { x: number; y: number }>())
  const startPan = (e: RPointerEvent<HTMLDivElement>): void => {
    const t = e.target as HTMLElement
    if ((e.pointerType === 'touch' && !full) || (e.pointerType !== 'touch' && e.button !== 0)) return
    if (t.closest('.oj-flow-ctl,path.hit') || ((editable || onToggle) && t.closest('[data-node]'))) return
    const el = e.currentTarget, vp = el.getBoundingClientRect(), map = fingers.current
    map.set(e.pointerId, { x: e.clientX, y: e.clientY })
    el.setPointerCapture(e.pointerId)
    if (map.size > 1) return
    let dragged = false
    const move = (ev: PointerEvent): void => {
      const prev = map.get(ev.pointerId)
      if (!prev) return
      const cur = { x: ev.clientX, y: ev.clientY }
      if (map.size === 2) {
        const other = [...map].find(([id]) => id !== ev.pointerId)![1]
        const before = Math.hypot(prev.x - other.x, prev.y - other.y), after = Math.hypot(cur.x - other.x, cur.y - other.y)
        if (before > 0) zoomAt((cur.x + other.x) / 2 - vp.left, (cur.y + other.y) / 2 - vp.top, after / before)
      } else if (dragged || Math.hypot(cur.x - prev.x, cur.y - prev.y) > 0) {
        dragged = true
        touched.current = true
        setView(v => ({ ...v, x: v.x + cur.x - prev.x, y: v.y + cur.y - prev.y }))
      }
      map.set(ev.pointerId, cur)
    }
    const up = (ev: PointerEvent): void => {
      map.delete(ev.pointerId)
      if (map.size) return
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up)
      if (!dragged) setSel(null)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const startDrag = (id: string) => (e: RPointerEvent<HTMLElement>): void => {
    if (!editable || (e.target as HTMLElement).closest('.oj-flow-port')) return
    const sx = e.clientX, sy = e.clientY, o = offsets[id] ?? { x: 0, y: 0 }, k = viewRef.current.k
    const self = rects.current.get(id), others = [...rects.current].filter(([n]) => n !== id).map(([, r]) => r)
    moved.current = false
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => {
      if (!moved.current && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 4) { moved.current = true; touched.current = true; snapshot(); setSel(null) }
      if (!moved.current) return
      let dx = (ev.clientX - sx) / k, dy = (ev.clientY - sy) / k
      const g: { x?: number; y?: number } = {}
      // 靠近别的功能的中线或顶边时吸过去，并画出对齐线
      if (self) {
        const cx = (self.left + self.right) / 2 + dx, top = self.top + dy, near = SNAP / k
        const hx = others.map(r => (r.left + r.right) / 2).sort((a, b) => Math.abs(a - cx) - Math.abs(b - cx))[0]
        const hy = others.map(r => r.top).sort((a, b) => Math.abs(a - top) - Math.abs(b - top))[0]
        if (hx != null && Math.abs(hx - cx) < near) { dx += hx - cx; g.x = hx }
        if (hy != null && Math.abs(hy - top) < near) { dy += hy - top; g.y = hy }
      }
      setGuide(g)
      setEd(v => ({ ...v, offsets: { ...v.offsets, [id]: { x: o.x + dx, y: o.y + dy } } }))
    }
    const up = (): void => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); setGuide({}) }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  const canLink = (from: string, to: string): boolean => to !== from && !locked?.has(from) && !locked?.has(to) && !nodes.find(n => n.id === to)?.dependsOn.includes(from) && !reaches(nodes, from, to)
  const startLink = (id: string) => (e: RPointerEvent<HTMLElement>): void => {
    e.stopPropagation()
    e.preventDefault()
    const b = box.current!.getBoundingClientRect()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const k = viewRef.current.k
    const at = (ev: { clientX: number; clientY: number }): { from: string; x: number; y: number; to: string | null; ok: boolean } => {
      const to = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-node]')?.dataset.node ?? null
      return { from: id, x: (ev.clientX - b.left) / k, y: (ev.clientY - b.top) / k, to: to === id ? null : to, ok: !!to && canLink(id, to) }
    }
    setDrawing(at(e))
    setSel(null)
    // 圆点长在功能按钮里，松手后的 click 会冒到按钮上；标记成拖动过，免得顺手把这个功能勾掉
    moved.current = true
    const move = (ev: PointerEvent): void => setDrawing(at(ev))
    const up = (ev: PointerEvent): void => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', cancel)
      setDrawing(null)
      const hit = at(ev)
      if (!hit.to || !hit.ok) return
      commit(edgeIn(edRef.current, id, hit.to, true))
      // 连了线就是要这两个功能：没勾的顺手勾上，不留一根「缺前置」的红线
      onPick?.([id, hit.to].filter(end => !picked.has(end)))
    }
    const cancel = (): void => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', cancel); setDrawing(null) }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', cancel)
  }
  const startBend = (edge: Edge) => (e: RPointerEvent<HTMLElement>): void => {
    e.stopPropagation()
    e.preventDefault()
    const a = rects.current.get(edge.from), b = rects.current.get(edge.to)
    if (!a || !b) return
    const axis = stepRoute(a, b).axis, start = bends[edge.key] ?? 0, s0 = axis === 'y' ? e.clientY : e.clientX, k = viewRef.current.k
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    let began = false
    const move = (ev: PointerEvent): void => {
      const d = ((axis === 'y' ? ev.clientY : ev.clientX) - s0) / k
      if (!began && Math.abs(d) < 3) return
      if (!began) { began = true; snapshot() }
      setEd(v => ({ ...v, bends: { ...v.bends, [edge.key]: start + d } }))
    }
    const up = (): void => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up) }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  const edited = added.length > 0 || removed.length > 0 || Object.keys(offsets).length > 0 || Object.keys(bends).length > 0
  const draft = drawing && rects.current.get(drawing.from)
    ? roundedPath(stepRoute(rects.current.get(drawing.from)!, (drawing.ok && drawing.to && rects.current.get(drawing.to)) || { left: drawing.x, right: drawing.x, top: drawing.y, bottom: drawing.y }).pts)
    : ''
  const picked1 = sel ? edges.find(e => e.key === sel) : undefined

  const tools = (
    <div className="oj-flow-tools">
      {editable && <span className="oj-flow-hint">拖圆点到另一个功能连线，点线可调换先后或删除</span>}
      <div className="oj-flow-btns" role="group" aria-label="画布">
        <button type="button" aria-label="缩小" onClick={() => zoomBy(1 / 1.25)}>−</button>
        <button type="button" className="pct" title="恢复 100%" onClick={() => zoomBy(1 / view.k)}>{Math.round(view.k * 100)}%</button>
        <button type="button" aria-label="放大" onClick={() => zoomBy(1.25)}>+</button>
        <button type="button" onClick={refit}>适应</button>
      </div>
      {editable && (
        <div className="oj-flow-btns" role="group" aria-label="编辑">
          <button type="button" disabled={!hist.past.length} onClick={undo}>撤销</button>
          <button type="button" disabled={!hist.future.length} onClick={redo}>重做</button>
          <button type="button" disabled={!edited} onClick={() => { commit(NO_EDITS); setSel(null) }}>还原</button>
        </div>
      )}
      <div className="oj-flow-btns"><button type="button" onClick={toggleFull}>{full ? '退出全屏' : '全屏'}</button></div>
    </div>
  )
  const canvas = (
    <div className={`oj-flowbox${full ? ' full' : ''}${editable ? ' edit' : ''}`} onPointerEnter={() => { inside.current = true }} onPointerLeave={() => { inside.current = false }}>
      {tools}
      <div ref={port} className={`oj-flow${drawing ? ' linking' : ''}`} style={full ? undefined : { height: fitH }} onPointerDown={startPan} onDoubleClick={e => { if (!(e.target as HTMLElement).closest('[data-node],.oj-flow-ctl,path.hit')) refit() }}>
        <div ref={box} className="oj-flow-stage" style={{ width: layout.width, height: layout.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }} onMouseOut={() => setHover(null)}>
          <svg className="oj-flow-lines" width={size.w} height={size.h} aria-hidden="true">
            <defs>
              {([['on', 10], ['bad', 10], ['hi', 15]] as const).map(([t, w]) => <marker key={t} id={`oj-arrow-${t}`} className={t} viewBox="0 0 10 10" refX="9" refY="5" markerWidth={w} markerHeight={w} markerUnits="userSpaceOnUse" orient="auto"><path d="M0.5 0.5 L9.5 5 L0.5 9.5 Z" /></marker>)}
            </defs>
            {edges.map(e => {
              const hi = e.key === sel || (!!hover && (e.from === hover || e.to === hover))
              return <path key={e.key} d={e.d} markerEnd={`url(#oj-arrow-${e.bad ? 'bad' : hi ? 'hi' : 'on'})`} className={`${e.bad ? 'bad' : 'on'}${e.sub ? ' sub' : ''}${hover || sel ? (hi ? ' hi' : ' dim') : ''}`} />
            })}
            {editable && edges.map(e => <path key={`${e.key}!`} d={e.d} className="hit" onClick={() => setSel(s => (s === e.key ? null : e.key))} />)}
            {guide.x != null && <line className="guide" x1={guide.x} x2={guide.x} y1={-4000} y2={4000} />}
            {guide.y != null && <line className="guide" y1={guide.y} y2={guide.y} x1={-4000} x2={4000} />}
            {draft && <path className={`draft${drawing?.to && !drawing.ok ? ' deny' : ''}`} d={draft} markerEnd="url(#oj-arrow-hi)" />}
          </svg>
          {layers.flat().map(id => {
            const n = byId.get(id)!
            const lock = !!locked?.has(id)
            const aim = drawing?.to === id ? (drawing.ok ? ' aim' : ' deny') : ''
            const cls = `oj-flow-node${picked.has(id) ? ' on' : ''}${bad.has(id) ? ' bad' : ''}${lock ? ' lock' : ''}${aim}`
            const off = offsets[id]
            const p = posOf(id)
            const style = { left: p.x, top: p.y, transform: off ? `translate(${off.x}px, ${off.y}px)` : undefined }
            const dot = editable ? <i className="oj-flow-port" aria-label={`从${n.title}连线`} onPointerDown={startLink(id)} /> : null
            return onToggle && !lock
              ? <button key={id} type="button" data-node={id} className={cls} style={style} aria-pressed={picked.has(id)} onMouseOver={() => setHover(id)} onPointerDown={startDrag(id)} onClick={() => { if (!moved.current) onToggle(id); moved.current = false }}>{n.title}{dot}</button>
              : lock && onUnlock
                ? <button key={id} type="button" data-node={id} className={cls} style={style} title="和所选方案冲突，点一下仍然加上" onMouseOver={() => setHover(id)} onPointerDown={startDrag(id)} onClick={() => { if (!moved.current) onUnlock(id); moved.current = false }}>{n.title}</button>
                : <span key={id} data-node={id} className={cls} style={style} title={lock ? '和所选方案冲突' : undefined} onMouseOver={() => setHover(id)} onPointerDown={startDrag(id)}>{n.title}{dot}</span>
          })}
          {editable && picked1 && (
            <div className="oj-flow-ctl" style={{ left: picked1.cx, top: picked1.cy, transform: `translate(-50%, -50%) scale(${1 / view.k})` }}>
              <button type="button" className={`grip ${picked1.axis}`} aria-label="拖动调整这条连线的位置" onPointerDown={startBend(picked1)} />
              <button type="button" className="flip" aria-label="调换这两个功能的先后" title={canFlip(picked1.from, picked1.to) ? '调换先后' : '调换后会绕成一圈，先删掉别的连线'} disabled={!canFlip(picked1.from, picked1.to)} onClick={() => flipEdge(picked1.key)}>⇅</button>
              <button type="button" className="del" aria-label="删掉这条连线" onClick={() => dropEdge(picked1.key)}>×</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
  // 清单卡片是容器查询的容器，里面的 fixed 会被它框住，全屏只能挂到 body 上；原位留一块同样高的空位，页面不跳
  return full ? <><div className="oj-flow-hold" style={{ height: fitH }} />{createPortal(canvas, document.body)}</> : canvas
}
