import type { CSSProperties, Ref } from 'react'

export type SketchPaper = 'grid' | 'note' | 'polaroid' | 'torn'

// 上色进度 0→1：彩色图层从下往上被「涂」出来，边缘留 12% 的柔边像笔刷
function paintMask(p: number): CSSProperties {
  const edge = p * 112 - 12
  const mask = `linear-gradient(to top, #000 ${edge}%, transparent ${edge + 12}%)`
  return { maskImage: mask, WebkitMaskImage: mask }
}

// 画稿：贴在页上的一张铅笔线稿，hover 时像纱雾把它涂完了。
// 纸由独立的 .sketch-paper 画出来，不直接裁 figure——头要能探出纸面。
export function SketchSheet({
  src,
  paper = 'grid',
  sign,
  paint,
  sheetRef,
  className = '',
}: {
  src: string
  paper?: SketchPaper
  sign?: string
  paint?: number
  sheetRef?: Ref<HTMLElement>
  className?: string
}): JSX.Element {
  return (
    <figure ref={sheetRef} className={`sketch-sheet paper-${paper} ${className}`} aria-hidden="true">
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
      <span className="sketch-clip">
        <img className="sketch-img" src={src} alt="" draggable={false} />
        {paint !== undefined && (
          <img className="sketch-paint" src={src} alt="" draggable={false} style={paintMask(paint)} />
        )}
      </span>
      {sign && <figcaption className="sketch-sign">{sign}</figcaption>}
    </figure>
  )
}
