// Title-normalisation helpers used by the "关联追番" flow.
//
// Source titles often carry season / version markers that BGM's search would
// rather not see ("葬送的芙莉莲 第二季" → "葬送的芙莉莲"). Stripping these
// gives the user a sensible prefill they can still edit before searching.

/**
 * Strip common Chinese / Japanese / English season-and-version suffixes from
 * an anime title so the result is a good prefill for BGM search.
 *
 * Conservative on purpose — we only remove tokens we're confident are noise.
 * If nothing matches we return the trimmed original, never an empty string.
 */
export function cleanForBgmSearch(title: string): string {
  let s = title.trim()
  if (!s) return s

  // Bracketed prefixes/suffixes: 【...】, [...], 「...」 — usually source tags
  // ("【4K】", "[简繁内嵌]") that aren't part of the canonical title.
  s = s.replace(/【[^】]*】/g, ' ')
  s = s.replace(/「[^」]*」/g, ' ')
  s = s.replace(/\[[^\]]*\]/g, ' ')

  // Year tag in parens at end: "(2024)" / "（2024）"
  s = s.replace(/[（(]\s*(?:19|20)\d{2}\s*[）)]\s*$/u, '')

  // "第 N 季 / 期" or 数字+季/期 — Chinese season markers
  s = s.replace(/\s*第\s*[一二三四五六七八九十百千0-9]+\s*[季期]\s*$/u, '')
  s = s.replace(/\s*[0-9]+\s*[季期]\s*$/u, '')

  // Bare trailing season number: "葬送的芙莉莲 2" / "...III" / "...II"
  // Only when preceded by whitespace to avoid eating titles like "K2" that
  // happen to end in a digit.
  s = s.replace(/\s+(?:[IVXivx]{1,4}|[0-9]{1,2})\s*$/u, '')

  // "OVA" / "OAD" / "剧场版" / "电影版" / "Movie" suffix — leave for now since
  // those *are* meaningfully different titles on BGM; users can edit if needed.

  return s.replace(/\s+/g, ' ').trim() || title.trim()
}
