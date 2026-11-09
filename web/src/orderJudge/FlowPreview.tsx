// 功能拼接流程图：客户页可点击切换，开发者侧只读。连线要跟着节点真实位置走（换行、改字都会变），所以量 DOM 而不是算网格
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { flowChannels, flowLayout, flowOrderedLayers, flowRoute, scopeConflicts, type FlowPoint, type FlowRect, type ScopeNode } from '../../shared/order-judge-scope'

interface Edge { key: string; from: string; to: string; d: string; on: boolean; bad: boolean; sub: boolean }

const MIN_K = 0.3, MAX_K = 2.5, MAX_H = 720, TRACK = 10
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

// editable：节点可拖动，从节点底部圆点拖到另一个节点就连一条「先有前者」，点线删掉；改动只在这个页面里，刷新还原
export function FlowPreview({ nodes: base0, picked, locked, onToggle, editable, onNodes }: { nodes: ScopeNode[]; picked: ReadonlySet<string>; locked?: ReadonlySet<string>; onToggle?: (id: string) => void; editable?: boolean; onNodes?: (nodes: ScopeNode[]) => void }): JSX.Element {
  const [offsets, setOffsets] = useState<Record<string, { x: number; y: number }>>({})
  const [added, setAdded] = useState<{ from: string; to: string }[]>([])
  const [removed, setRemoved] = useState<string[]>([])
  const [drawing, setDrawing] = useState<{ from: string; x: number; y: number } | null>(null)
  const moved = useRef(false)
  const nodes = useMemo(() => base0.map(n => ({ ...n, dependsOn: [...n.dependsOn.filter(d => !removed.includes(`${d}>${n.id}`)), ...added.filter(a => a.to === n.id && !n.dependsOn.includes(a.from)).map(a => a.from)] })), [base0, added, removed])
  const nodesKey = nodes.map(n => `${n.id}:${n.dependsOn.join()}`).join('|')
  useLayoutEffect(() => { if (editable) onNodes?.(nodes) }, [nodesKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const box = useRef<HTMLDivElement>(null)
  const port = useRef<HTMLDivElement>(null)
  // 画布：每层固定一行，放不下就整体缩小；滚轮 + Ctrl/⌘ 缩放，拖空白处平移。手动动过之后不再自动适应
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const viewRef = useRef(view)
  viewRef.current = view
  const touched = useRef(false)
  const [edges, setEdges] = useState<Edge[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })
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
  const layoutKey = [...layout.pos].map(([id, p]) => `${id}@${Math.round(p.x)},${Math.round(p.y)}`).join()
  const bad = new Set(scopeConflicts(nodes, picked).map(c => c.id))
  // 每个功能只常驻一条线连到上一层最近的前置，形成一棵清楚的树；其余前置（跨层或多个来源）悬停相关功能时才画，编辑时全画
  const primaryOf = (n: ScopeNode): string | undefined => n.dependsOn.reduce<string | undefined>((best, d) => (best == null || (layerOf.get(d) ?? -1) > (layerOf.get(best) ?? -1) ? d : best), undefined)
  const signature = nodesKey + [...picked].join() + JSON.stringify(offsets) + layoutKey

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
      const rects = [...at.values()]
      const next: Edge[] = []
      const links = nodes.flatMap(n => (picked.has(n.id) && at.has(n.id) ? n.dependsOn.filter(d => at.has(d) && !implied(nodes, picked, d, n.id)).map(d => ({ d, id: n.id })) : []))
      const sources = [...new Set(links.map(l => l.d))].sort((p, q) => at.get(p)!.left - at.get(q)!.left)
      const users = new Map<number, string[]>()
      for (const l of links) for (const ch of flowChannels(at.get(l.d)!, at.get(l.id)!, rects)) {
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
          const from = at.get(d)!
          next.push({ key: `${d}>${n.id}`, from: d, to: n.id, d: roundedPath(flowRoute(from, to, rects, el.offsetWidth, trackOf(d), (sources.indexOf(d) % 3 - 1) * 3, (i - (ins.length - 1) / 2) * span)), on: picked.has(n.id) && picked.has(d), bad: picked.has(n.id) && !picked.has(d), sub: d !== primaryOf(n) })
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

  const fit = (): void => {
    const vp = port.current, st = box.current
    if (!vp || !st) return
    const vw = vp.clientWidth, W = Math.max(st.offsetWidth, st.scrollWidth), H = Math.max(st.offsetHeight, st.scrollHeight)
    if (!vw || !W || !H) return
    const k = clamp(Math.min(1, vw / W, MAX_H / H), MIN_K, 1)
    const x = (vw - W * k) / 2
    setView(v => (Math.abs(v.k - k) < 0.001 && Math.abs(v.x - x) < 0.5 && v.y === 0 ? v : { k, x, y: 0 }))
  }
  const zoomAt = (px: number, py: number, f: number): void => {
    touched.current = true
    setView(v => { const k = clamp(v.k * f, MIN_K, MAX_K), r = k / v.k; return { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r } })
  }
  useEffect(() => {
    const vp = port.current
    if (!vp) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const r = vp.getBoundingClientRect()
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01))
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const startPan = (e: RPointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'touch' || e.button !== 0 || (e.target as HTMLElement).closest('[data-node],.oj-flow-tools,path.hit')) return
    const sx = e.clientX, sy = e.clientY, v0 = viewRef.current, el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => { touched.current = true; setView({ ...v0, x: v0.x + ev.clientX - sx, y: v0.y + ev.clientY - sy }) }
    const up = (): void => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up) }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
  const lineFrom = (id: string): { x: number; y: number } | null => {
    const el = box.current?.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)
    if (!el || !box.current) return null
    const r = el.getBoundingClientRect(), b = box.current.getBoundingClientRect()
    const k = viewRef.current.k
    return { x: (r.left - b.left + r.width / 2) / k, y: (r.bottom - b.top) / k }
  }
  const dropEdge = (from: string, to: string): void => {
    if (added.some(a => a.from === from && a.to === to)) setAdded(l => l.filter(a => !(a.from === from && a.to === to)))
    else setRemoved(l => [...l, `${from}>${to}`])
  }
  const startDrag = (id: string) => (e: RPointerEvent<HTMLElement>): void => {
    if (!editable || (e.target as HTMLElement).closest('.oj-flow-port')) return
    const sx = e.clientX, sy = e.clientY, o = offsets[id] ?? { x: 0, y: 0 }, k = viewRef.current.k
    moved.current = false
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 4) moved.current = true
      if (moved.current) setOffsets(m => ({ ...m, [id]: { x: o.x + (ev.clientX - sx) / k, y: o.y + (ev.clientY - sy) / k } }))
    }
    const up = (): void => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up) }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
  const startLink = (id: string) => (e: RPointerEvent<HTMLElement>): void => {
    e.stopPropagation()
    e.preventDefault()
    const b = box.current!.getBoundingClientRect()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const k = viewRef.current.k
    setDrawing({ from: id, x: (e.clientX - b.left) / k, y: (e.clientY - b.top) / k })
    const move = (ev: PointerEvent): void => setDrawing({ from: id, x: (ev.clientX - b.left) / k, y: (ev.clientY - b.top) / k })
    const up = (ev: PointerEvent): void => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up)
      setDrawing(null)
      const to = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-node]')?.dataset.node
      if (!to || to === id || nodes.find(n => n.id === to)?.dependsOn.includes(id) || reaches(nodes, id, to)) return
      setRemoved(l => l.filter(k => k !== `${id}>${to}`))
      setAdded(l => [...l, { from: id, to }])
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
  const edited = added.length > 0 || removed.length > 0 || Object.keys(offsets).length > 0

  const height = size.h ? Math.min(size.h * view.k, MAX_H) : undefined
  return (
    <div ref={port} className={`oj-flow${editable ? ' edit' : ''}`} style={{ height }} onPointerDown={startPan} onDoubleClick={e => { if (!(e.target as HTMLElement).closest('[data-node],.oj-flow-tools')) { touched.current = false; fit() } }}>
      {editable && <div className="oj-flow-tools"><button type="button" className="btn btn-sm btn-ghost" disabled={!edited} onClick={() => { setOffsets({}); setAdded([]); setRemoved([]) }}>还原</button></div>}
      <div ref={box} className="oj-flow-stage" style={{ width: layout.width, height: layout.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }} onMouseOut={() => setHover(null)}>
      <svg className="oj-flow-lines" width={size.w} height={size.h} aria-hidden="true">
        <defs>
          {['on', 'bad', 'hi'].map(t => <marker key={t} id={`oj-arrow-${t}`} className={t} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto"><path d="M1 1.5 L9 5 L1 8.5 Z" /></marker>)}
        </defs>
        {edges.map(e => {
          const hi = !!hover && (e.from === hover || e.to === hover)
          return <path key={e.key} d={e.d} markerEnd={`url(#oj-arrow-${e.bad ? 'bad' : hi ? 'hi' : 'on'})`} className={`${e.bad ? 'bad' : 'on'}${e.sub ? ' sub' : ''}${hover ? (hi ? ' hi' : ' dim') : ''}`} />
        })}
        {editable && edges.map(e => <path key={`${e.key}!`} d={e.d} className="hit" onClick={() => dropEdge(e.from, e.to)}><title>点一下删掉这条连线</title></path>)}
        {drawing && lineFrom(drawing.from) && <line className="draft" x1={lineFrom(drawing.from)!.x} y1={lineFrom(drawing.from)!.y} x2={drawing.x} y2={drawing.y} />}
      </svg>
      {layers.flat().map(id => {
            const n = byId.get(id)!
            const lock = !!locked?.has(id)
            const cls = `oj-flow-node${picked.has(id) ? ' on' : ''}${bad.has(id) ? ' bad' : ''}${lock ? ' lock' : ''}`
            const off = offsets[id]
            const p = layout.pos.get(id)!
            const style = { left: p.x, top: p.y, transform: off ? `translate(${off.x}px, ${off.y}px)` : undefined }
            const port = editable ? <i className="oj-flow-port" aria-label={`从${n.title}连线`} onPointerDown={startLink(id)} /> : null
            return onToggle && !lock
              ? <button key={id} type="button" data-node={id} className={cls} style={style} aria-pressed={picked.has(id)} onMouseOver={() => setHover(id)} onPointerDown={startDrag(id)} onClick={() => { if (!moved.current) onToggle(id); moved.current = false }}>{n.title}{port}</button>
              : <span key={id} data-node={id} className={cls} style={style} title={lock ? '和所选方案冲突' : undefined} onMouseOver={() => setHover(id)} onPointerDown={startDrag(id)}>{n.title}{port}</span>
      })}
      </div>
    </div>
  )
}
