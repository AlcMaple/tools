// 标题归一化 —— 给「关联追番」流程用。
// 源站标题常带季度 / 版本标记(「葬送的芙莉莲 第二季」),去掉后作为 BGM 搜索的预填值
// 用户仍可自己改。

/**
 * 去掉常见的中 / 日 / 英季度与版本后缀。**刻意保守**:只删有把握是噪音的部分;
 * 什么都没匹配上就返回 trim 过的原串,**永远不返回空字符串**。
 */
export function cleanForBgmSearch(title: string): string {
  let s = title.trim()
  if (!s) return s

  // 括号包裹的前后缀通常是片源标记(「【4K】」「[简繁内嵌]」),不属于规范标题。
  s = s.replace(/【[^】]*】/g, ' ')
  s = s.replace(/「[^」]*」/g, ' ')
  s = s.replace(/\[[^\]]*\]/g, ' ')

  // 结尾括号里的年份
  s = s.replace(/[（(]\s*(?:19|20)\d{2}\s*[）)]\s*$/u, '')

  // 「第 N 季 / 期」这类中文季度标记
  s = s.replace(/\s*第\s*[一二三四五六七八九十百千0-9]+\s*[季期]\s*$/u, '')
  s = s.replace(/\s*[0-9]+\s*[季期]\s*$/u, '')

  // Bare trailing season number: "葬送的芙莉莲 2" / "...III" / "...II"
  // Only when preceded by whitespace to avoid eating titles like "K2" that
  // 恰好以数字结尾的情况。
  s = s.replace(/\s+(?:[IVXivx]{1,4}|[0-9]{1,2})\s*$/u, '')

  // "OVA" / "OAD" / "剧场版" / "电影版" / "Movie" suffix — leave for now since
  // those *are* meaningfully different titles on BGM; users can edit if needed.

  return s.replace(/\s+/g, ' ').trim() || title.trim()
}
