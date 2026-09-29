export type PopTone = 'teal' | 'sakura' | 'lav' | 'gold'

export function PopArt({
  src,
  tone = 'teal',
  tag,
  className = '',
}: {
  src: string
  tone?: PopTone
  tag?: string
  className?: string
}): JSX.Element {
  return (
    <div className={`pop-art tone-${tone} ${className}`} aria-hidden="true">
      <span className="pop-art-frame">
        <span className="pop-art-burst" />
        <span className="pop-art-dots" />
      </span>
      <img className="pop-art-img" src={src} alt="" draggable={false} />
      {tag && <span className="pop-art-tag">{tag}</span>}
    </div>
  )
}
