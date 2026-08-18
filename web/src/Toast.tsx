// 便签 Toast（单例）—— 视觉 = 原型稿 .toast-note（纱雾头像 + 名牌 + 圆章，失败换樱粉描边）。
// 右下角始终只有一张：后来的直接顶掉先来的（key 变化重挂载 → stick-in 动画重放）。
// 模块级发布订阅（同 auth.ts 的做法，不上 Context）。
import { useEffect, useState } from 'react'

export interface ToastOpt {
  err?: boolean
}

interface ToastItem {
  text: string
  opt: ToastOpt
  seq: number
}

let cur: ToastItem | null = null
let seq = 0
const listeners = new Set<() => void>()

function publish(): void {
  listeners.forEach((l) => l())
}

export function toast(text: string, opt?: ToastOpt): void {
  cur = { text, opt: opt ?? {}, seq: ++seq }
  publish()
}

export function ToastRoot(): JSX.Element | null {
  const [, bump] = useState(0)
  useEffect(() => {
    const l = (): void => bump((v) => v + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])

  const item = cur
  useEffect(() => {
    if (!item) return
    const t = setTimeout(() => {
      cur = null
      publish()
    }, item.opt.err ? 3600 : 2700)
    return () => clearTimeout(t)
  }, [item?.seq])

  if (!item) return null
  return (
    <div id="toast-root">
      <div className={`toast-note${item.opt.err ? ' err' : ''}`} key={item.seq}>
        <img className="avatar" src="/assets/sagiri-face.webp" alt="" />
        <div className="toast-body">
          <div className="toast-name">纱雾{item.opt.err ? ' · 小声' : ''}</div>
          <div className="toast-text">{item.text}</div>
        </div>
        <span className={`stamp small ${item.opt.err ? 'st-sakura' : 'st-teal'} toast-stamp pop`}>
          {item.opt.err ? '!' : '✓'}
        </span>
      </div>
    </div>
  )
}
