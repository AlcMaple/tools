// 开屏动画「パシャッ」—— 一张立绘照片被啪地贴上稿本：卡片带回弹地落位、立绘随落位
// 一道斜光扫出显影、印章跟着 punch 下去、标题弹出，全挤在同一拍里，然后翻页进站。
// 画面部分全在 styles/splash.css。之前是「描线→上色→盖章→标题」的连续叙事，时长压不
// 下去——分步骤的仪式感只在长时长才立得住，短时长看着像被剪掉了几帧，所以改成单拍手感。
//
// 时间轴由 JS 按「真正画出来的帧」推进，不走墙上时间：首屏那阵子（包解析 + 周历数据 +
// 一堆海报解码）主线程被占住，CSS 动画照走不误，等松手时早跑到尾了——这就是
// 「第一次进来只看到一个画框、贴纸和盖章全没了」的原因。掉帧只让动画变慢，不让它跳过。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

const SEEN_KEY = 'mt-splash-seen'
const ART = '/assets/sagiri-full.webp'
const HOLD_MS = 700 // 时间轴总长：单拍动作演完 + 停一瞬
const OUT_MS = 320 // 翻页离场（与 .sp.out 动画同长）
const WAIT_MS = 800 // 等立绘解码的上限，超时就照画（宁可卡片空一点，也不能干等白纸）
const STEP_CAP = 34 // 单帧最多推进两帧的量：卡一下就慢一点，不跳帧
const HARD_MS = 8000 // 兜底：无论帧跑成什么样，最多占屏这么久（rAF 完全不来时也能退场）

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

export function Splash({ onComplete }: { onComplete?: () => void }): JSX.Element | null {
  // wait = 纸已铺好、立绘还没解码完（此时时间轴停在第一帧）
  const [state, setState] = useState<'wait' | 'play' | 'out' | 'done'>(PLAY ? 'wait' : 'done')
  const ref = useRef<HTMLDivElement>(null)
  const notified = useRef(false)

  // 等立绘就位：图没到就开画，画的是一张空卡片
  useEffect(() => {
    if (state !== 'wait') return
    let live = true
    const start = (): void => {
      if (live) setState('play')
    }
    const img = new Image()
    img.src = ART
    void (img.decode ? img.decode().then(start, start) : start())
    const cap = window.setTimeout(start, WAIT_MS)
    return () => {
      live = false
      window.clearTimeout(cap)
    }
  }, [state])

  // 时间轴：卡片里的动画全被 CSS 钉在暂停态，这里逐帧给它们设 currentTime
  useLayoutEffect(() => {
    if (state !== 'play') return
    const root = ref.current
    if (!root) return
    const anims = root
      .getAnimations({ subtree: true })
      // .sp 自己的翻页离场归 CSS 管，别一起被拖进时间轴
      .filter((a) => (a.effect as KeyframeEffect | null)?.target !== root)
    const seek = (v: number): void => {
      anims.forEach((a) => {
        try {
          a.currentTime = v
        } catch {
          // 个别动画可能已被替换掉，跳过即可
        }
      })
    }
    let t = 0 // 时间轴位置：只随真正画出来的帧前进
    let last = performance.now()
    let raf = 0
    const tick = (now: number): void => {
      t += Math.min(now - last, STEP_CAP)
      last = now
      seek(t)
      if (t >= HOLD_MS) setState('out')
      else raf = requestAnimationFrame(tick)
    }
    seek(0)
    raf = requestAnimationFrame(tick)
    // 页面在后台时 rAF 根本不跑，时间轴会一直停着 —— 留一条墙上时间的退路，
    // 别让开屏把应用永久挡在后面
    const bail = window.setTimeout(() => setState('out'), HARD_MS)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(bail)
    }
  }, [state])

  // 翻页离场：这一段在 .sp 自己身上，交给 CSS 跑
  useEffect(() => {
    if (state !== 'out') return
    const t = window.setTimeout(() => setState('done'), OUT_MS)
    return () => window.clearTimeout(t)
  }, [state])

  // 公告只能跟在一段真实播放过的开屏后面：刷新时本会话已经看过开屏，PLAY=false，就不再
  // 补弹；并用 ref 抵住开发环境 StrictMode / 父组件重渲染带来的重复通知。
  useEffect(() => {
    if (state !== 'done' || !PLAY || notified.current) return
    notified.current = true
    onComplete?.()
  }, [state, onComplete])

  // 跳过：点一下 / 按任意键都算
  useEffect(() => {
    if (state === 'done' || state === 'out') return
    const skip = (): void => setState('out')
    window.addEventListener('keydown', skip)
    return () => window.removeEventListener('keydown', skip)
  }, [state])

  if (state === 'done') return null

  return (
    <div
      ref={ref}
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
          <img src={ART} alt="" />
          {/* 显影瞬间扫过去的那道斜光，配合立绘一起淡入，制造「啪」地贴上去的手感 */}
          <span className="sp-pen" />
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
