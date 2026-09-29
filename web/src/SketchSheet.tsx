export type SketchPaper = 'grid' | 'note' | 'polaroid' | 'torn'

// 画稿：贴在页上的一张铅笔线稿，hover 时像纱雾把它涂完了。
// 纸由独立的 .sketch-paper 画出来，不直接裁 figure——头要能探出纸面。
export function SketchSheet({
  src,
  paper = 'grid',
  sign,
  className = '',
}: {
  src: string
  paper?: SketchPaper
  sign?: string
  className?: string
}): JSX.Element {
  return (
    <figure className={`sketch-sheet paper-${paper} ${className}`} aria-hidden="true">
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
      </span>
      {sign && <figcaption className="sketch-sign">{sign}</figcaption>}
    </figure>
  )
}
