import { clearCache, layout, prepare, type PreparedText } from '@chenglou/pretext'

const subscribers = new Map<Element, { update: (width: number) => void; reset: () => void; refresh: () => void }>()
let observer: ResizeObserver | undefined
let preparedCharacters = 0
const pendingWidths = new Map<Element, number>()
let frame = 0
function flushWidths() {
  frame = 0
  const started = performance.now()
  for (const [element, width] of pendingWidths) {
    pendingWidths.delete(element)
    subscribers.get(element)?.update(width)
    // 长历史分帧准备，避免为了节省离屏排版而先占住主线程。
    if (performance.now() - started >= 4) break
  }
  if (pendingWidths.size) frame = requestAnimationFrame(flushWidths)
}
const fontsChanged = () => {
  clearCache()
  preparedCharacters = 0
  for (const entry of subscribers.values()) entry.reset()
  for (const entry of subscribers.values()) entry.refresh()
  if (!frame && pendingWidths.size) frame = requestAnimationFrame(flushWidths)
}

export function observeText(node: HTMLParagraphElement, text: string): () => void {
  let prepared: PreparedText | undefined
  let width = 0
  let previousWidth = 0
  let lineHeight = 0
  let failed = false
  const reset = () => {
    prepared = undefined
    previousWidth = 0
    node.style.removeProperty('content-visibility')
    node.style.removeProperty('contain-intrinsic-block-size')
  }
  const update = (nextWidth: number) => {
    width = nextWidth
    if (failed || width <= 0 || width === previousWidth) return
    if (!prepared) {
      const style = getComputedStyle(node)
      const whiteSpace = style.whiteSpace
      lineHeight = Number.parseFloat(style.lineHeight)
      // 多列、竖排、非标准断词和富文本都交还原生排版，避免估算改变布局。
      if (!['normal', 'pre-wrap'].includes(whiteSpace) || style.writingMode !== 'horizontal-tb'
        || style.wordBreak !== 'normal' || !Number.isFinite(lineHeight) || style.columnCount !== 'auto'
        || style.textTransform !== 'none' || style.fontStyle !== 'normal' || style.fontVariantCaps !== 'normal'
        || style.fontFeatureSettings !== 'normal'
        || style.fontVariationSettings !== 'normal' || Number.parseFloat(style.textIndent) !== 0
        || !['normal', '0px'].includes(style.wordSpacing) || style.hyphens === 'auto') return
      if (preparedCharacters + text.length > 65_536) { clearCache(); preparedCharacters = 0 }
      preparedCharacters += text.length
      prepared = prepare(text.replace(/\r/g, ''), `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`, {
        whiteSpace: whiteSpace as 'normal' | 'pre-wrap',
        letterSpacing: Number.parseFloat(style.letterSpacing) || 0,
      })
    }
    const height = Math.max(lineHeight, layout(prepared, width, lineHeight).height)
    // auto 让浏览器在实际显示后记住真实高度；预测值绝不用作固定 height 或裁剪边界。
    node.style.containIntrinsicBlockSize = `auto ${height}px`
    node.style.contentVisibility = 'auto'
    previousWidth = width
  }
  const safeUpdate = (width: number) => {
    try { update(width) } catch (error) { failed = true; reset(); reportError(error) }
  }
  observer ??= new ResizeObserver(entries => {
    for (const entry of entries) pendingWidths.set(entry.target, entry.contentRect.width)
    // 占位高度会反过来改变观察尺寸，写样式移到下一帧，避免 ResizeObserver 循环。
    if (!frame) frame = requestAnimationFrame(flushWidths)
  })
  if (!subscribers.size) document.fonts.addEventListener('loadingdone', fontsChanged)
  subscribers.set(node, { update: safeUpdate, reset, refresh: () => pendingWidths.set(node, width) })
  observer.observe(node)
  return () => {
    observer?.unobserve(node)
    subscribers.delete(node)
    pendingWidths.delete(node)
    if (!subscribers.size) {
      observer?.disconnect(); observer = undefined; clearCache(); preparedCharacters = 0
      cancelAnimationFrame(frame); frame = 0; pendingWidths.clear()
      document.fonts.removeEventListener('loadingdone', fontsChanged)
    }
    reset()
  }
}
