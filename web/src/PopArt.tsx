export type PopTone = 'teal' | 'sakura' | 'lav' | 'gold'

export function PopArt({
  src,
  tone = 'teal',
  tag,
  bare = false,
  className = '',
}: {
  src: string
  tone?: PopTone
  tag?: string
  bare?: boolean
  className?: string
}): JSX.Element {
  return (
    <div className={`pop-art tone-${tone}${bare ? ' bare' : ''} ${className}`} aria-hidden="true">
      <span className="pop-art-frame">
        <span className="pop-art-burst" />
        <span className="pop-art-dots" />
      </span>
      <img className="pop-art-img" src={src} alt="" draggable={false} />
      {tag && <span className="pop-art-tag">{tag}</span>}
    </div>
  )
}

// 画稿版：平时是贴在页上的一张铅笔线稿，hover 时像纱雾把它涂完了。
export function SketchSheet({ src, sign }: { src: string; sign?: string }): JSX.Element {
  return (
    <figure className="sketch-sheet" aria-hidden="true">
      <span className="tape tl teal" />
      <span className="tape tr sakura" />
      <span className="sketch-wash" />
      <span className="sketch-clip">
        <img className="sketch-img" src={src} alt="" draggable={false} />
      </span>
      {sign && <figcaption className="sketch-sign">{sign}</figcaption>}
    </figure>
  )
}
