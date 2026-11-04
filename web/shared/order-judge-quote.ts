// 报价计算：需求清单 → 底线 → 三档 → 预算区间 → 人情折让；成交后的追加需求按变更单单独计价。
// 纯计算，没有 AI，同样输入永远同样输出，每一笔都带「怎么算出来的」。口径见 docs/ideas/021-接单评估重新定位.md
//
// 依据：
// - 时间值：2026-11-04 三道选择题，从零做 500 元 / 16 小时 ≈ 31，修别人的项目 800 元 / 3 小时 ≈ 267（元 / 小时）
// - 267 测的是「读懂并修别人写坏的代码」。改自己交付过的代码不在此列，所以交付后的修改轮次、变更单里改自己做过的部分都按新做的价，
//   只有客户自己已有的、别人写的代码才按接手改
// - 风险垫：未说清的条目按 McConnell《Software Estimation》(2006) 不确定性锥形，需求已列出但细节未定时实际可到估计的 1.5 倍，
//   所以每条未说清的需求加它自己小时的 0.5 倍。报价单上这笔叫「兜底」：14 天保修、立刻响应的成本就从这里出
// - 报价 = 底线 ÷ (1 − 最大折让)：用户原话「1000 的单最低收 800」，即让满 2 成正好落在底线，人情价跌不穿底线

import { diffBrief, type Brief, type BriefItem, type ClientType, type Priority, type WorkKind } from './order-judge-brief'

// 兜底只给商单：学生单、个人单按「能用就行、出问题再修」估，没有未说清就多收的钱，14 天保修照给但不单独收费
export const hasPad = (type: ClientType): boolean => type === '商单' || type === '待确认'
export const settingsForType = (s: QuoteSettings, type: ClientType): QuoteSettings => (hasPad(type) ? s : { ...s, padRatio: 0 })

export interface QuoteSettings {
  rates: Record<WorkKind, number>
  hourFactor: Record<WorkKind, number>
  padRatio: number
  maxDiscount: number
  warrantyDays: number
  minCharge: number
}

export const DEFAULT_QUOTE_SETTINGS: QuoteSettings = {
  rates: { 新做: 31, 接手改: 267 },
  hourFactor: { 新做: 1, 接手改: 1 },
  padRatio: 0.5,
  maxDiscount: 0.2,
  warrantyDays: 14,
  // 最低收费：功能都是直接能做、没有要想的点时，价格不再随条数往上堆，只象征性收这一笔（开发者 2026-11-04：三个简单功能 50 差不多了）
  minCharge: 50,
}

export interface Expense { name: string; amount: number }

export interface QuoteExtras {
  expenses: Expense[]
  resultHours: number
}

export type LineKind = 'item' | 'pad' | 'result' | 'expense' | 'min'

export interface QuoteLine {
  kind: LineKind
  itemId?: string
  work?: WorkKind
  label: string
  hours: number
  rate: number
  amount: number
  why: string
}

export interface Priced {
  lines: QuoteLine[]
  floor: number
  quote: number
  minPrice: number
}

export type TierName = '基础' | '推荐' | '完整'

export interface Tier extends Priced {
  name: TierName
  itemIds: string[]
  excluded: string[]
}

const TIER_SCOPE: Record<TierName, Priority[]> = {
  基础: ['必须'],
  推荐: ['必须', '应该'],
  完整: ['必须', '应该', '可以'],
}

const yuan = (n: number): number => Math.round(n)
const hoursText = (h: number): string => `${h} 小时`

function itemLines(items: BriefItem[], s: QuoteSettings, hoursOf: (i: BriefItem) => number, whyOf: (i: BriefItem) => string): QuoteLine[] {
  const lines: QuoteLine[] = []
  for (const i of items) {
    const raw = hoursOf(i)
    const factor = s.hourFactor[i.kind]
    const hours = Math.round(raw * factor * 2) / 2
    const rate = s.rates[i.kind]
    const scaled = factor === 1 ? '' : `AI 估 ${raw} 小时，按你过去的实际 × ${factor}，`
    lines.push({ kind: 'item', itemId: i.id, work: i.kind, label: i.title, hours, rate, amount: yuan(hours * rate), why: hours > 0 ? `${i.kind}，${scaled}${hoursText(hours)} × ${rate}，${whyOf(i)}` : `${i.kind}，不计时间，${whyOf(i)}` })
  }
  if (s.padRatio <= 0) return lines
  const padded = lines.filter(l => items.find(i => i.id === l.itemId)?.unclear)
  for (const l of padded) {
    const item = items.find(i => i.id === l.itemId)!
    const hours = l.hours * s.padRatio
    if (hours <= 0) continue
    lines.push({ kind: 'pad', itemId: l.itemId, work: l.work, label: `兜底：${l.label}`, hours, rate: l.rate, amount: yuan(hours * l.rate), why: `未说清「${item.unclear}」，按 ${s.padRatio} 倍小时垫` })
  }
  return lines
}

function extraLines(extras: QuoteExtras, s: QuoteSettings): QuoteLine[] {
  const lines: QuoteLine[] = []
  if (extras.resultHours > 0) {
    const rate = s.rates['新做']
    lines.push({ kind: 'result', work: '新做', label: '交付后修改到结果达成', hours: extras.resultHours, rate, amount: yuan(extras.resultHours * rate), why: `预计 ${hoursText(extras.resultHours)} × ${rate}` })
  }
  for (const e of extras.expenses) {
    if (e.amount > 0) lines.push({ kind: 'expense', label: e.name, hours: 0, rate: 0, amount: yuan(e.amount), why: '实际支出，原价计入' })
  }
  return lines
}

export function price(lines: QuoteLine[], s: QuoteSettings): Priced {
  const sum = lines.reduce((a, l) => a + l.amount, 0)
  if (sum < s.minCharge) {
    const all = [...lines, { kind: 'min' as const, label: '最低收费', hours: 0, rate: 0, amount: s.minCharge - sum, why: '需要想的点很少，按最低收费收；折让不再适用' }]
    return { lines: all, floor: s.minCharge, quote: s.minCharge, minPrice: s.minCharge }
  }
  const floor = sum
  const quote = Math.ceil(floor / (1 - s.maxDiscount) / 10) * 10
  return { lines, floor, quote, minPrice: Math.max(floor, Math.ceil(quote * (1 - s.maxDiscount))) }
}

// 三档是同一份清单按优先级切出来的范围；条目一样的档只保留低的那档，价格一样的档只保留范围大的那档
export function tiers(brief: Brief, extras: QuoteExtras, settings: QuoteSettings = DEFAULT_QUOTE_SETTINGS): Tier[] {
  const s = settingsForType(settings, brief.clientType)
  const out: Tier[] = []
  for (const name of ['基础', '推荐', '完整'] as TierName[]) {
    const scope = TIER_SCOPE[name]
    const items = brief.items.filter(i => scope.includes(i.priority))
    const itemIds = items.map(i => i.id)
    if (!items.length || out.some(t => t.itemIds.join() === itemIds.join())) continue
    const lines = [...itemLines(items, s, i => i.hours, i => i.reason), ...extraLines(extras, s)]
    const excluded = brief.items.filter(i => !scope.includes(i.priority)).map(i => i.title)
    const tier = { name, itemIds, excluded, ...price(lines, s) }
    // 价格一样时留范围大的那档，客户同价拿到更多
    if (out.length && out[out.length - 1].quote === tier.quote) out.pop()
    out.push(tier)
  }
  return out
}

// 「3000」「3k」「3千」「1.5万」「2000-3000」以外的说法（如「不多」）读不出来，返回 null，交给人填
export function parseBudget(text: string): number | null {
  const nums = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(万|w|W|千|k|K)?/g)].map(m => {
    const n = Number(m[1])
    return m[2] === '万' || m[2] === 'w' || m[2] === 'W' ? n * 10000 : m[2] ? n * 1000 : n
  }).filter(n => n > 0)
  return nums.length ? Math.max(...nums) : null
}

export type Zone =
  | { type: 'unknown' }
  | { type: 'fits'; budget: number; floor: number; quote: number }
  | { type: 'cut'; budget: number; kept: string[]; cut: string[]; floor: number; quote: number }
  | { type: 'impossible'; budget: number; floor: number; gap: number }

// 可成交区间（ZOPA）：客户上限 ≥ 底线才存在。从完整范围开始，不够就只砍范围不降价：先砍「可以」再砍「应该」，同级先砍贵的；
// 砍够之后再把砍掉的里面还放得下的补回来，避免先砍了大的、又多砍了小的
export function zone(brief: Brief, extras: QuoteExtras, budget: number | null, settings: QuoteSettings = DEFAULT_QUOTE_SETTINGS): Zone {
  if (budget == null) return { type: 'unknown' }
  const s = settingsForType(settings, brief.clientType)
  const priced = (items: BriefItem[]): Priced => price([...itemLines(items, s, i => i.hours, i => i.reason), ...extraLines(extras, s)], s)
  const itemCost = (i: BriefItem): number => itemLines([i], s, x => x.hours, x => x.reason).reduce((a, l) => a + l.amount, 0)
  const inOrder = (ids: Set<string>): BriefItem[] => brief.items.filter(i => ids.has(i.id))
  const kept = new Set(brief.items.filter(i => i.priority !== '不做').map(i => i.id))
  const cut: BriefItem[] = []
  for (const p of ['可以', '应该'] as Priority[]) {
    for (const i of inOrder(kept).filter(k => k.priority === p).sort((x, y) => itemCost(y) - itemCost(x))) {
      if (priced(inOrder(kept)).floor <= budget) break
      kept.delete(i.id)
      cut.push(i)
    }
  }
  for (const i of [...cut].reverse()) {
    if (priced(inOrder(new Set([...kept, i.id]))).floor <= budget) { kept.add(i.id); cut.splice(cut.indexOf(i), 1) }
  }
  const p = priced(inOrder(kept))
  if (p.floor > budget) return { type: 'impossible', budget, floor: p.floor, gap: p.floor - budget }
  const quote = Math.min(p.quote, Math.max(p.floor, budget))
  if (!cut.length) return { type: 'fits', budget, floor: p.floor, quote }
  return { type: 'cut', budget, kept: inOrder(kept).map(i => i.title), cut: cut.map(i => i.title), floor: p.floor, quote }
}

export interface Discount { ratio: number; reason: string }

// 人情折让：原价照写，单列一行，最多让到 maxDiscount，且永远不低于底线
export function applyDiscount(p: Priced, d: Discount, s: QuoteSettings = DEFAULT_QUOTE_SETTINGS): { ratio: number; amount: number; price: number; reason: string } {
  const ratio = Math.min(s.maxDiscount, Math.max(0, d.ratio))
  const priceAfter = Math.max(p.floor, Math.round(p.quote * (1 - ratio)))
  return { ratio, amount: p.quote - priceAfter, price: priceAfter, reason: d.reason.trim() }
}

export interface ChangeOrder extends Priced {
  removed: string[]
}

// 变更单：已成交版本之后的新版本，只对新增和改动的条目计价，已成交的部分不重算。
// 改动只改了优先级不收钱；只改了小时收多出来的部分；内容（标题、说明、新做 / 接手改）变了按新小时整条重做
export function changeOrder(deal: Brief, current: Brief, extras: QuoteExtras, settings: QuoteSettings = DEFAULT_QUOTE_SETTINGS): ChangeOrder {
  const s = settingsForType(settings, current.clientType)
  const before = new Map(deal.items.map(i => [i.id, i]))
  const charge = new Map<string, { hours: number; why: string }>()
  const removed: string[] = []
  for (const c of diffBrief(deal, current)) {
    if (c.type === 'removed') { removed.push(c.title); continue }
    const item = current.items.find(i => i.id === c.id)!
    if (item.priority === '不做') continue
    if (c.type === 'added') { charge.set(item.id, { hours: item.hours, why: `新增，${item.reason}` }); continue }
    const old = before.get(item.id)!
    if (c.fields.some(f => f === 'title' || f === 'detail' || f === 'kind')) charge.set(item.id, { hours: item.hours, why: `内容改了，按新的整条做，${item.reason}` })
    else if (c.fields.includes('hours') && item.hours > old.hours) charge.set(item.id, { hours: item.hours - old.hours, why: `原 ${old.hours} 小时，现 ${item.hours} 小时，收多出来的` })
  }
  const items = current.items.filter(i => charge.has(i.id))
  const lines = [...itemLines(items, s, i => charge.get(i.id)!.hours, i => charge.get(i.id)!.why), ...extraLines(extras, s)]
  return { removed, ...price(lines, s) }
}

// ── 工期 ──
// 客户常问「多久能做完」，也常给截止日：按各档的总小时 ÷ 你每天能投入的小时算出几天，再和截止日比。
// 每天能投入几小时是你自己填的（默认 4），不含等客户回复的时间

export const DEFAULT_DAILY_HOURS = 4

export interface Plan {
  name: string
  hours: number
  days: number
  ready: string
  slack: number | null
}

const DAY_MS = 86_400_000
export const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const dayNumber = (text: string): number => { const [y, m, d] = text.split('-').map(Number); return Date.UTC(y, m - 1, d) / DAY_MS }
const addDays = (text: string, days: number): string => {
  const [y, m, d] = text.split('-').map(Number)
  return ymd(new Date(y, m - 1, d + days))
}

export function planOf(name: string, p: Priced, dailyHours: number, today: string, deadline: string | null): Plan {
  const hours = p.lines.filter(l => l.kind !== 'expense').reduce((a, l) => a + l.hours, 0)
  const perDay = dailyHours > 0 ? dailyHours : DEFAULT_DAILY_HOURS
  const days = Math.max(1, Math.ceil(hours / perDay))
  const ready = addDays(today, days)
  return { name, hours, days, ready, slack: deadline ? dayNumber(deadline) - dayNumber(ready) : null }
}

// 材料里的截止说法读成日期：「12 月 20 日」「12/20」「2026-12-20」「明天」「后天」「3 天内」；读不出来返回 null，交给人填
export function parseDeadline(text: string, today: string): string | null {
  const t = text.trim()
  if (!t) return null
  const [y, m, d] = today.split('-').map(Number)
  const fixed = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(t)
  if (fixed) return validDate(Number(fixed[1]), Number(fixed[2]), Number(fixed[3]))
  const md = /(\d{1,2})\s*(?:月|\/)\s*(\d{1,2})\s*(?:日|号)?/.exec(t)
  if (md) {
    const month = Number(md[1]), date = Number(md[2])
    const thisYear = validDate(y, month, date)
    if (thisYear && thisYear >= today) return thisYear
    return validDate(y + 1, month, date)
  }
  if (/今天|今晚|当天/.test(t)) return today
  if (/明天|明早|明晚/.test(t)) return addDays(today, 1)
  if (/后天/.test(t)) return addDays(today, 2)
  const within = /(\d{1,3})\s*天/.exec(t)
  if (within) return addDays(today, Number(within[1]))
  return null
}

function validDate(y: number, m: number, d: number): string | null {
  const date = new Date(y, m - 1, d)
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? ymd(date) : null
}
