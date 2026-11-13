export const EPISODE_LIMITS = [0, 13, 26, 52] as const

export function exactDate(value: string): string {
  const normalized = value.trim().replace(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/, '$1-$2-$3')
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(normalized)
  if (!m) return ''
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (year < 1900 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return ''
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}

// 归档只保证保留原始 wiki；章节数量和最晚章节日期都不保证已收齐，因此只认条目明示的结束日
// 来源：https://github.com/bangumi/Archive，Subject.infobox；不把系列其他季度算进本条目
export function explicitEndDate(infobox: unknown, start: string): string {
  if (typeof infobox !== 'string' || !exactDate(start)) return ''
  const values = [...infobox.matchAll(/^\s*\|\s*(?:播放结束|放送结束)\s*=([^\n\r|]*)/gm)].map(m => exactDate(m[1]))
  if (!values.length || values.some(value => !value || value !== values[0]) || values[0] < exactDate(start)) return ''
  return values[0]
}

export function matchesPlanning(eps: number, endDate: string, maxEps: number, finished: boolean, today: string): boolean {
  if (maxEps > 0 && (!Number.isInteger(eps) || eps <= 0 || eps > maxEps)) return false
  return !finished || (!!exactDate(endDate) && endDate < today)
}
