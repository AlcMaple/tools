// 开屏动画「なぞる」—— 从和泉纱雾（插画家）的视角：她在画稿本上把自己画出来。
// 描线 → 上色 → 盖章 → 翻页进站，样式全在 styles/splash.css。
// 约定：一次会话只放一次（sessionStorage）；点/按任意键可跳过；
// prefers-reduced-motion 直接不挂载（全局 reduce 规则会把动画压成 0ms，留着只会闪一下白屏）。
import { useEffect, useState } from 'react'
import { Ic } from './SketchIcon'

const SEEN_KEY = 'mt-splash-seen'
const HOLD_MS = 2600 // 画完 + 停一拍
const OUT_MS = 620 // 翻页离场（与 .sp.out 动画同长）

function shouldPlay(): boolean {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  try {
    if (sessionStorage.getItem(SEEN_KEY)) return false
    sessionStorage.setItem(SEEN_KEY, '1')
  } catch {
    // 隐私模式下 sessionStorage 会抛错，放一次也无妨
  }
  return true
}

// 模块级只判一次：放在组件的 useState 初始化里，StrictMode 会调两遍，
// 第二遍读到自己刚写的 sessionStorage，开屏永远不放
const PLAY = shouldPlay()

export function Splash(): JSX.Element | null {
  const [state, setState] = useState<'play' | 'out' | 'done'>(PLAY ? 'play' : 'done')

  useEffect(() => {
    if (state === 'done') return
    const t = window.setTimeout(() => setState(state === 'play' ? 'out' : 'done'), state === 'play' ? HOLD_MS : OUT_MS)
    return () => window.clearTimeout(t)
  }, [state])

  // 跳过：点一下 / 按任意键都算
  useEffect(() => {
    if (state !== 'play') return
    const skip = (): void => setState('out')
    window.addEventListener('keydown', skip)
    return () => window.removeEventListener('keydown', skip)
  }, [state])

  if (state === 'done') return null

  return (
    <div
      className={`sp${state === 'out' ? ' out' : ''}`}
      role="presentation"
      onClick={() => setState('out')}
      aria-hidden="true"
    >
      <div className="sp-card">
        <span className="tape tl teal" style={{ width: 92 }} />
        <svg className="sp-frame" viewBox="0 0 100 100" preserveAspectRatio="none">
          <rect x="0.8" y="0.8" width="98.4" height="98.4" rx="1.2" pathLength={100} />
        </svg>
        <span className="sp-tone halftone-wash" />
        <span className="sp-focus focus-lines" />

        <div className="sp-art">
          {/* 同一张官方立绘叠两层：上层线稿先「描」出来，下层彩稿晚半拍追上来上色 */}
          <img className="sp-color" src="/assets/sagiri-full.png" alt="" />
          <img className="sp-line" src="/assets/sagiri-full.png" alt="" />
          <span className="sp-pen">
            <Ic name="pencil" />
          </span>
        </div>

        <span className="kira sp-kira k1">サラサラ…</span>
        <span className="kira sp-kira k2">キラキラ…</span>
        <span className="sparkle a">✦</span>
        <span className="sparkle b">✦</span>
        <span className="sparkle c">✦</span>
        <span className="stamp st-sakura sp-stamp">紗霧</span>
      </div>

      <div className="sp-title">
        <b>MapleTools</b>
        <i className="sp-rule" />
        <small className="sp-sub">SAGIRI · SKETCHFOLIO</small>
      </div>

      <span className="sp-skip">点一下跳过</span>
    </div>
  )
}
