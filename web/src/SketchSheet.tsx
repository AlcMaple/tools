import { useEffect, useRef, type CSSProperties, type Ref } from 'react'

export type SketchPaper = 'grid' | 'note' | 'polaroid' | 'torn'
// 每页一种画法，别让各页像同一张模板：
// rise 从下往上涂（周历 / 登录）；blocks 按块从左往右填（追番：几部更新分几块）；
// develop 拍立得显影（设置）；stars 星点一颗颗亮起（福利）
export type PaintMode = 'rise' | 'blocks' | 'develop' | 'stars'

// 星点位置固定（不随机），刷新后同一进度亮的是同一批
const STARS: [number, number][] = [
  [50, 30], [30, 55], [70, 52], [44, 78], [62, 16], [22, 28], [80, 30], [56, 62], [36, 40], [74, 76],
  [16, 70], [48, 50], [86, 58], [28, 88], [64, 90], [40, 18], [58, 40], [20, 46], [78, 12], [52, 84],
]

function mask(image: string): CSSProperties {
  return { maskImage: image, WebkitMaskImage: image }
}

function paintStyle(mode: PaintMode, p: number, blocks: number): CSSProperties {
  if (p >= 1) return {}
  if (mode === 'develop') return { opacity: p }
  if (mode === 'blocks') {
    const edge = (Math.round(p * blocks) / blocks) * 100
    return mask(`linear-gradient(to right, #000 ${edge}%, transparent ${edge}%)`)
  }
  if (mode === 'stars') {
    const n = Math.round(p * STARS.length)
    if (!n) return { opacity: 0 }
    return mask(STARS.slice(0, n).map(([x, y]) => `radial-gradient(circle at ${x}% ${y}%, #000 0 11%, transparent 17%)`).join(','))
  }
  // rise：边缘留 12% 柔边像笔刷
  const edge = p * 112 - 12
  return mask(`linear-gradient(to top, #000 ${edge}%, transparent ${edge + 12}%)`)
}

// 画稿：贴在页上的一张铅笔线稿，hover 时像纱雾把它涂完了。
// 纸由独立的 .sketch-paper 画出来，不直接裁 figure——头要能探出纸面。
export function SketchSheet({
  src,
  paper = 'grid',
  sign,
  paint,
  mode = 'rise',
  blocks = 1,
  sheetRef,
  className = '',
}: {
  src: string
  paper?: SketchPaper
  sign?: string
  paint?: number
  mode?: PaintMode
  blocks?: number
  sheetRef?: Ref<HTMLElement>
  className?: string
}): JSX.Element {
  const own = useRef<HTMLElement | null>(null)
  const last = useRef(paint)
  // 进度一变就让纸轻轻一抖：用户刚做的那件事「被画上去了」。rise 跟着滚动连续变化，不抖。
  useEffect(() => {
    const prev = last.current
    last.current = paint
    if (paint === undefined || prev === undefined || paint === prev || mode === 'rise') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    own.current?.animate(
      [{ scale: '1', rotate: '0deg' }, { scale: '1.06', rotate: '-2deg' }, { scale: '1', rotate: '0deg' }],
      { duration: 420, easing: 'cubic-bezier(.34, 1.5, .64, 1)' },
    )
  }, [paint, mode])

  const setRef = (el: HTMLElement | null): void => {
    own.current = el
    if (typeof sheetRef === 'function') sheetRef(el)
    else if (sheetRef) (sheetRef as { current: HTMLElement | null }).current = el
  }

  return (
    <figure ref={setRef} className={`sketch-sheet paper-${paper} paint-${mode} ${className}`} aria-hidden="true">
      <span className="sketch-paper" />
      {paper === 'grid' && (
        <>
          <span className="tape tl teal" />
          <span className="tape tr sakura" />
        </>
      )}
      {paper === 'note' && <span className="tape tl gold" />}
      {paper === 'torn' && <span className="tape tr lav" />}
      <span className="sketch-wash" />
      <span className="sketch-clip" style={mode === 'develop' && paint !== undefined ? { opacity: 0.15 + 0.85 * paint } : undefined}>
        <img className="sketch-img" src={src} alt="" draggable={false} />
        {paint !== undefined && (
          <img className="sketch-paint" src={src} alt="" draggable={false} style={paintStyle(mode, paint, blocks)} />
        )}
      </span>
      {sign && <figcaption className="sketch-sign">{sign}</figcaption>}
    </figure>
  )
}
