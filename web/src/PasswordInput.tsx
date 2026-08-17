// 密码输入框 —— 右侧眼睛 icon 切明文 / 暗文，全站密码框共用。
// 皮肤 = 原型稿 .field-row > input + .eye（稿纸输入框 + 墨线眼睛）。
import { useState } from 'react'
import { Ic } from './SketchIcon'

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
    <div className="field-row">
      <input
        id={id}
        type={reveal ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
      />
      <button
        type="button"
        className="eye"
        onClick={() => setReveal((r) => !r)}
        title={reveal ? '隐藏密码' : '显示密码'}
        aria-label={reveal ? '隐藏密码' : '显示密码'}
        aria-pressed={reveal}
      >
        <Ic name={reveal ? 'eye-off' : 'eye'} cls="ic" />
      </button>
    </div>
  )
}
