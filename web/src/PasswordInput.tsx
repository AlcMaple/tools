// 密码输入框 —— 右侧眼睛 icon 切明文 / 暗文，全站密码框共用。
import { useState } from 'react'
import { Icon } from './Icon'

export function PasswordInput({
  value,
  onChange,
  placeholder,
  autoComplete = 'current-password',
  id,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoComplete?: string
  id?: string
}): JSX.Element {
  const [reveal, setReveal] = useState(false)
  return (
    <div className="relative">
      <input
        id={id}
        type={reveal ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="w-full rounded-lg border border-outline-variant/30 bg-surface-container-high px-3 py-2.5 pr-11 text-sm text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/35 focus:border-primary/70"
      />
      <button
        type="button"
        onClick={() => setReveal((r) => !r)}
        title={reveal ? '隐藏密码' : '显示密码'}
        aria-label={reveal ? '隐藏密码' : '显示密码'}
        aria-pressed={reveal}
        className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-on-surface-variant/50 transition-colors hover:bg-surface-container-highest/60 hover:text-on-surface"
      >
        <Icon name={reveal ? 'visibility_off' : 'visibility'} size={17} />
      </button>
    </div>
  )
}
