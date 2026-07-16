// 自绘下拉 —— 不用原生 <select>（见 AI_GUIDELINES「UI/样式」：原生控件展开是系统弹层，
// 蓝色高亮 + 系统字体，跟 MD3 token 毫无关系，暗色下尤其出戏）。
//
// 浮层宽度用 `w-full` 对齐触发器（同规范另一条）—— 外层 relative 收缩包裹，触发器多宽浮层多宽，
// 边缘严丝合缝，跟顶栏用户名 chip 的下拉是同一套做法。
import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'

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

  // 点外面 / ESC 关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = options.find((o) => o.id === value)

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border bg-surface-container-high px-3 py-2.5 text-left text-sm text-on-surface transition-colors ${
          open ? 'border-primary/70' : 'border-outline-variant/30'
        }`}
      >
        <span className={current ? '' : 'text-on-surface-variant/35'}>
          {current ? current.text : placeholder}
        </span>
        <Icon
          name="expand_more"
          size={16}
          className={`shrink-0 opacity-50 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute left-0 top-[calc(100%+5px)] z-30 w-full rounded-md border border-outline-variant/35 bg-surface-container-low p-1 shadow-2xl">
          {options.map((o) => {
            const sel = o.id === value
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  onChange(o.id)
                  setOpen(false)
                }}
                className={`flex w-full items-center justify-between gap-2 rounded px-2.5 py-2 text-left text-sm transition-colors ${
                  sel
                    ? 'bg-primary/10 font-semibold text-primary'
                    : 'text-on-surface-variant hover:bg-on-surface/5 hover:text-on-surface'
                }`}
              >
                {/* 文字顶格靠左；勾选放右边 —— 别让占位的勾把文字往右顶 */}
                <span>{o.text}</span>
                {sel && <Icon name="check" size={14} className="shrink-0" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
