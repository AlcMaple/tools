// 估价：总小时 → 两档工期 → 不加急价格。纯函数，网页和桌面共用；节假日数据由服务端拉取后传入。
// 规则来源 docs/ideas/020-接单评估估价.md：按日历天数（含周末假期）计费，加急只在页面说明，不进计算。

export const DAY_RATE = 160
export const HOURS_PER_DAY = 8
export const QUOTE_FACTORS = [0.06, 0.075] as const

// 一年的国务院安排：date → true 放假 / false 调休上班；不在表里的日子按周一到五上班。
// published=false 表示该年还没发文（holiday-cn 的 days 为空），只能按双休排。
export interface HolidayYear {
  year: number
  published: boolean
  days: Record<string, boolean>
}

export interface QuoteTier {
  factor: number
  hours: number
  workdays: number
  start: string
  end: string
  calendarDays: number
  price: number
}

export interface Quote {
  totalHours: number
  tiers: QuoteTier[]
  assumedYears: number[]
  springFestivalRisk: boolean
}

const DAY_MS = 86_400_000

function parseDate(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function chinaToday(now = Date.now()): string {
  return formatDate(now + 8 * 3_600_000)
}

export function quoteYears(orderDate: string, totalHours: number): number[] {
  // 最长工期按高档算，日历天数不会超过工作日的 2 倍再加一个春节长假
  const maxWorkdays = Math.ceil(Math.ceil(totalHours * QUOTE_FACTORS[QUOTE_FACTORS.length - 1]) / HOURS_PER_DAY)
  const first = new Date(parseDate(orderDate)).getUTCFullYear()
  const last = new Date(parseDate(orderDate) + (maxWorkdays * 2 + 14) * DAY_MS).getUTCFullYear()
  const years: number[] = []
  for (let y = first; y <= last; y++) years.push(y)
  return years
}

export function quote(totalHours: number, orderDate: string, calendars: HolidayYear[]): Quote {
  const byYear = new Map(calendars.map(c => [c.year, c]))
  const used = new Set<number>()
  const isWorkday = (ms: number): boolean => {
    const date = formatDate(ms)
    const year = new Date(ms).getUTCFullYear()
    const cal = byYear.get(year)
    if (!cal) throw new Error(`缺少 ${year} 年节假日数据`)
    used.add(year)
    if (date in cal.days) return !cal.days[date]
    const dow = new Date(ms).getUTCDay()
    return dow !== 0 && dow !== 6
  }

  const start = parseDate(orderDate) + DAY_MS
  const tiers = QUOTE_FACTORS.map(factor => {
    const hours = Math.ceil(totalHours * factor)
    const workdays = Math.ceil(hours / HOURS_PER_DAY)
    let cursor = start - DAY_MS
    for (let counted = 0; counted < workdays;) {
      cursor += DAY_MS
      if (isWorkday(cursor)) counted++
    }
    const calendarDays = Math.round((cursor - start) / DAY_MS) + 1
    return { factor, hours, workdays, start: formatDate(start), end: formatDate(cursor), calendarDays, price: calendarDays * DAY_RATE }
  })

  const assumedYears = [...used].filter(y => !byYear.get(y)!.published).sort()
  // 春节落在 1 月下旬到 2 月中旬；未公布年份的工期进了这段，实际交期大概率顺延
  const springFestivalRisk = tiers.some(t => assumedYears.some(year =>
    parseDate(t.start) <= Date.UTC(year, 1, 20) && parseDate(t.end) >= Date.UTC(year, 0, 20)))
  return { totalHours, tiers, assumedYears, springFestivalRisk }
}
