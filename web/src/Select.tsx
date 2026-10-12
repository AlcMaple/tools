// 自绘下拉 —— 不用原生 <select>（原生控件展开是系统弹层，永远长不成我们的设计系统）。
// 皮肤 = 原型稿 .dd 系列（手绘描边触发器 + 浮层与触发器同宽），浮层的定位 / 关闭交给 Popover。
import { useState, useRef } from 'react'
import { Popover } from './Popover'
import { Ic } from './SketchIcon'

export interface SelectOption {
  id: string
  text: string
}

export function Select({
  options,
  value,
  onChange,
  placeholder,
}: {
  options: SelectOption[]
  value: string
  onChange: (id: string) => void
  placeholder: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  const current = options.find((o) => o.id === value)

  return (
    <div ref={box} className={`dd-host${open ? ' open' : ''}`}>
      <button type="button" className="dd-trigger" onClick={() => setOpen((v) => !v)}>
        <span className="dd-val">{current ? current.text : placeholder}</span>
        <Ic name="chev" cls="ic" />
      </button>

      <Popover anchor={box} open={open} onClose={() => setOpen(false)} matchWidth className="dd">
        {options.map((o) => {
          const sel = o.id === value
          return (
            <button
              key={o.id}
              type="button"
              className={`dd-item${sel ? ' on' : ''}`}
              onClick={() => {
                onChange(o.id)
                setOpen(false)
              }}
            >
              <span>{o.text}</span>
              {sel && <Ic name="check" cls="ic ic-sm" />}
            </button>
          )
        })}
      </Popover>
    </div>
  )
}
