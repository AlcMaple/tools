import { useEffect, useRef } from 'react'

// 保留真实文本 DOM 和浏览器排版，只给离屏段落提供占位高度；不接管选择、查找或链接。
export function LongText({ text, className }: { text: string; className?: string }): JSX.Element {
  const ref = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    const node = ref.current
    // 短文准备成本大于收益；超长单段的同步分词会形成长任务，保留原生排版。
    if (!node || text.length < 512 || text.length > 8192 || !CSS.supports('content-visibility', 'auto')
      || !CSS.supports('contain-intrinsic-block-size', 'auto 1px') || typeof ResizeObserver === 'undefined') return
    let dispose: (() => void) | undefined
    let alive = true
    void import('./text-visibility').then(({ observeText }) => {
      if (alive) dispose = observeText(node, text)
    }).catch(error => {
      // 分块加载失败保留普通段落，不影响正文阅读。
      if (alive) reportError(error)
    })
    return () => { alive = false; dispose?.() }
  }, [text, className])
  return <p ref={ref} className={className}>{text}</p>
}
