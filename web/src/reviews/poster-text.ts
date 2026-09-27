import { clearCache, layoutWithLines, prepareWithSegments } from '@chenglou/pretext'

let measuredCharacters = 0

export function wrapPosterBody(text: string, font: string, width: number): string[] {
  // 库的分词测量缓存没有容量限制，长时间连续生成海报时按累计字符量回收。
  if (measuredCharacters + text.length > 32_768) {
    clearCache()
    measuredCharacters = 0
  }
  measuredCharacters += text.length
  // Canvas 仍负责绘制；只替换长正文的逐字重复测宽，空段落继续占一行。
  return text.replace(/\r/g, '').split('\n').flatMap(paragraph => {
    if (!paragraph) return ['']
    const prepared = prepareWithSegments(paragraph, font, { whiteSpace: 'pre-wrap' })
    return layoutWithLines(prepared, width, 1).lines.map(line => line.text.trimEnd())
  })
}
