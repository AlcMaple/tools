// 自绘日期区间选择：不用原生日期控件（系统弹层长不成我们的设计系统）。
// 月历按真实日期排，大小月、二月、闰年交给 Date；做完的活不会在未来，今天之后的日子不可选。
import { useRef, useState } from 'react'
import { Popover } from '../Popover'
import { Ic } from '../SketchIcon'
import { ymd } from '../../shared/order-judge-quote'

const WEEK = ['一', '二', '三', '四', '五', '六', '日']
const today = (): string => ymd(new Date())
const parts = (s: string): [number, number, number] => { const [y, m, d] = s.split('-').map(Number); return [y, m, d] }

export function dayLabel(s: string): string {
  const [y, m, d] = parts(s)
  return `${y === new Date().getFullYear() ? '' : `${y} 年 `}${m} 月 ${d} 日`
}

function cells(y: number, m: number): (string | null)[] {
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7
  const total = new Date(y, m, 0).getDate()
  const out: (string | null)[] = Array(lead).fill(null)
  for (let d = 1; d <= total; d++) out.push(ymd(new Date(y, m - 1, d)))
  while (out.length % 7) out.push(null)
  return out
}

export function DateRange({ from, to, onChange }: { from: string | null; to: string | null; onChange: (from: string | null, to: string | null) => void }): JSX.Element {
  const box = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState<string | null>(null)
  const now = today()
  const [view, setView] = useState<[number, number]>(() => { const [y, m] = parts(from ?? now); return [y, m] })
  const [ny, nm] = parts(now)
  const last = to ?? from
  const atEnd = view[0] === ny && view[1] === nm

  const shift = (n: number): void => setView(([y, m]) => { const d = new Date(y, m - 1 + n, 1); return [d.getFullYear(), d.getMonth() + 1] })
  const pick = (d: string): void => {
    if (!picking) { onChange(d, null); setPicking(d); return }
    const [a, b] = d < picking ? [d, picking] : [picking, d]
    onChange(a, a === b ? null : b)
    setPicking(null)
    setOpen(false)
  }
  const close = (): void => { setPicking(null); setOpen(false) }
  const text = from ? (to ? `${dayLabel(from)} 至 ${dayLabel(to)}` : dayLabel(from)) : '选择做的日期'

  return (
    <>
      <button ref={box} type="button" className={`oj-daterange${open ? ' open' : ''}${from ? '' : ' empty'}`} onClick={() => setOpen(v => !v)} aria-haspopup="dialog" aria-expanded={open}>
        <Ic name="calendar" cls="ic ic-sm" />
        <span className="oj-daterange-text">{text}</span>
      </button>
      <Popover anchor={box} open={open} onClose={close} maxHeight={440} className="oj-cal" role="dialog">
        <div className="oj-cal-head">
          <button type="button" className="oj-cal-nav prev" aria-label="上个月" onClick={() => shift(-1)}><Ic name="chev" cls="ic ic-sm" /></button>
          <span>{view[0]} 年 {view[1]} 月</span>
          <button type="button" className="oj-cal-nav next" aria-label="下个月" disabled={atEnd} onClick={() => shift(1)}><Ic name="chev" cls="ic ic-sm" /></button>
        </div>
        <div className="oj-cal-grid">
          {WEEK.map(w => <span key={w} className="oj-cal-wk">{w}</span>)}
          {cells(view[0], view[1]).map((d, i) => {
            if (!d) return <span key={i} />
            const lo = from && last ? (from < last ? from : last) : from, hi = from && last ? (from < last ? last : from) : from
            const edge = d === lo || d === hi, inside = !!lo && !!hi && d > lo && d < hi
            return (
              <button key={d} type="button" disabled={d > now} className={`oj-cal-day${edge ? ' edge' : ''}${inside ? ' in' : ''}${d === now ? ' today' : ''}`} onClick={() => pick(d)}>
                {Number(d.slice(8))}
              </button>
            )
          })}
        </div>
        <p className="oj-cal-tip">{picking ? '再点结束那天；只做了一天就点「完成」' : '先点开始那天，再点结束那天'}</p>
        {picking && <button type="button" className="oj-cal-done" onClick={close}>完成</button>}
      </Popover>
    </>
  )
}
