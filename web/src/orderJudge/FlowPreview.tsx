// 功能拼接流程图：客户页可点击切换，开发者侧只读。连线要跟着节点真实位置走（换行、改字都会变），所以量 DOM 而不是算网格
import { useLayoutEffect, useRef, useState } from 'react'
import { flowChannels, flowOrderedLayers, flowRoute, scopeConflicts, type FlowPoint, type FlowRect, type ScopeNode } from '../../shared/order-judge-scope'

interface Edge { key: string; from: string; to: string; d: string; on: boolean; bad: boolean }

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

export function FlowPreview({ nodes, picked, locked, onToggle }: { nodes: ScopeNode[]; picked: ReadonlySet<string>; locked?: ReadonlySet<string>; onToggle?: (id: string) => void }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState<Edge[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })
  const byId = new Map(nodes.map(n => [n.id, n]))
  const layers = flowOrderedLayers(nodes)
  const [hover, setHover] = useState<string | null>(null)
  const bad = new Set(scopeConflicts(nodes, picked).map(c => c.id))
  const signature = nodes.map(n => `${n.id}:${n.dependsOn.join()}`).join('|') + [...picked].join()

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = (): void => {
      const base = el.getBoundingClientRect()
      const at = new Map<string, FlowRect>()
      el.querySelectorAll<HTMLElement>('[data-node]').forEach(n => {
        const r = n.getBoundingClientRect()
        at.set(n.dataset.node!, { left: r.left - base.left, right: r.right - base.left, top: r.top - base.top, bottom: r.bottom - base.top })
      })
      const rects = [...at.values()]
      const next: Edge[] = []
      const links = nodes.flatMap(n => (picked.has(n.id) && at.has(n.id) ? n.dependsOn.filter(d => at.has(d)).map(d => ({ d, id: n.id })) : []))
      const sources = [...new Set(links.map(l => l.d))].sort((p, q) => at.get(p)!.left - at.get(q)!.left)
      const users = new Map<number, string[]>()
      for (const l of links) for (const ch of flowChannels(at.get(l.d)!, at.get(l.id)!, rects)) {
        const list = users.get(ch) ?? []
        if (!list.includes(l.d)) list.push(l.d)
        users.set(ch, list)
      }
      const trackOf = (src: string) => (ch: number): number => {
        const list = (users.get(ch) ?? []).sort((p, q) => sources.indexOf(p) - sources.indexOf(q))
        const step = Math.min(6, 22 / Math.max(list.length - 1, 1))
        return (list.indexOf(src) - (list.length - 1) / 2) * step
      }
      for (const n of nodes) {
        const to = at.get(n.id)
        if (!to) continue
        for (const d of n.dependsOn) {
          const from = at.get(d)
          // 没选的功能不画线：选得少时满屏虚线盖住真正走得通的路线
          if (!from || !picked.has(n.id)) continue
          next.push({ key: `${d}>${n.id}`, from: d, to: n.id, d: roundedPath(flowRoute(from, to, rects, base.width, trackOf(d), (sources.indexOf(d) % 3 - 1) * 3)), on: picked.has(n.id) && picked.has(d), bad: picked.has(n.id) && !picked.has(d) })
        }
      }
      setEdges(next)
      setSize({ w: base.width, h: base.height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  // nodes / picked 每次渲染都是新引用，内容变了 signature 才变
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  return (
    <div ref={box} className="oj-flow">
      <svg className="oj-flow-lines" width={size.w} height={size.h} aria-hidden="true">
        {edges.map(e => <path key={e.key} d={e.d} className={`${e.bad ? 'bad' : e.on ? 'on' : ''}${hover ? (e.from === hover || e.to === hover ? ' hi' : ' dim') : ''}`} />)}
      </svg>
      {layers.map((layer, i) => (
        <div key={i} className="oj-flow-layer" onMouseOut={() => setHover(null)}>
          {layer.map(id => {
            const n = byId.get(id)!
            const lock = !!locked?.has(id)
            const cls = `oj-flow-node${picked.has(id) ? ' on' : ''}${bad.has(id) ? ' bad' : ''}${lock ? ' lock' : ''}`
            return onToggle && !lock
              ? <button key={id} type="button" data-node={id} className={cls} aria-pressed={picked.has(id)} onMouseOver={() => setHover(id)} onClick={() => onToggle(id)}>{n.title}</button>
              : <span key={id} data-node={id} className={cls} title={lock ? '和所选方案冲突' : undefined} onMouseOver={() => setHover(id)}>{n.title}</span>
          })}
        </div>
      ))}
    </div>
  )
}
