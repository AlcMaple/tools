// 报价单：一个版本的报价设置（状态、预算、支出、交付后修改、主推档、人情折让）+ 计算结果 → 客户版 / 自用版文字。
// 文字用全角括号和圆点而不是 Markdown，客户多半在微信里看，井号和星号会原样露出来。网页和桌面共用

import type { Brief, ClientType } from './order-judge-brief'
import {
  DEFAULT_QUOTE_SETTINGS, applyDiscount, changeOrder, parseBudget, tiers, zone,
  type ChangeOrder, type Discount, type Expense, type Priced, type QuoteLine, type QuoteSettings, type Tier, type TierName, type Zone,
} from './order-judge-quote'

export const VERSION_STATUSES = ['草稿', '已报价', '已成交'] as const
export type VersionStatus = typeof VERSION_STATUSES[number]
export const TIER_NAMES: TierName[] = ['基础', '推荐', '完整']
export const DISCOUNT_STEPS = [0, 0.05, 0.1, 0.15, 0.2]
export const MAX_EXPENSES = 10

export interface QuoteState {
  status: VersionStatus
  budget: number | null
  resultHours: number
  expenses: Expense[]
  tier: TierName
  discount: Discount
}

export const EMPTY_QUOTE: QuoteState = { status: '草稿', budget: null, resultHours: 0, expenses: [], tier: '推荐', discount: { ratio: 0, reason: '' } }

const num = (v: unknown, max: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n * 2) / 2)) : 0
}
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export function normalizeQuote(raw: unknown): QuoteState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const d = (o.discount && typeof o.discount === 'object' ? o.discount : {}) as Record<string, unknown>
  const ratio = Number(d.ratio)
  return {
    status: VERSION_STATUSES.includes(o.status as VersionStatus) ? o.status as VersionStatus : '草稿',
    budget: o.budget == null || o.budget === '' ? null : Math.round(num(o.budget, 100_000_000)),
    resultHours: num(o.resultHours, 200),
    expenses: (Array.isArray(o.expenses) ? o.expenses : []).slice(0, MAX_EXPENSES).map(e => {
      const r = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
      return { name: text(r.name, 40), amount: Math.round(num(r.amount, 1_000_000)) }
    }).filter(e => e.name && e.amount > 0),
    tier: TIER_NAMES.includes(o.tier as TierName) ? o.tier as TierName : '推荐',
    discount: { ratio: DISCOUNT_STEPS.includes(ratio) ? ratio : 0, reason: text(d.reason, 60) },
  }
}

export interface SheetVersion { n: number; at: number; brief: Brief; quote: QuoteState }

export interface Sheet {
  title: string
  n: number
  at: number
  brief: Brief
  quote: QuoteState
  budget: number | null
  budgetFrom: '手填' | '材料' | null
  base: SheetVersion | null
  tiers: Tier[]
  change: ChangeOrder | null
  chosen: (Priced & { name: string }) | null
  discount: ReturnType<typeof applyDiscount> | null
  zone: Zone
}

// 本版之前最近一个「已成交」的版本就是变更单的基准；没有就按整单出三档
export function buildSheet(title: string, versions: SheetVersion[], n: number, s: QuoteSettings = DEFAULT_QUOTE_SETTINGS): Sheet {
  const v = versions.find(x => x.n === n)!
  const base = [...versions].filter(x => x.n < n && x.quote.status === '已成交').sort((a, b) => b.n - a.n)[0] ?? null
  const extras = { expenses: v.quote.expenses, resultHours: v.quote.resultHours }
  const parsed = parseBudget(v.brief.budget)
  const budget = v.quote.budget ?? parsed
  const budgetFrom = v.quote.budget != null ? '手填' : parsed != null ? '材料' : null
  if (base) {
    const change = changeOrder(base.brief, v.brief, extras, s)
    const chosen = change.lines.length ? { name: '变更', ...change } : null
    return { title, n, at: v.at, brief: v.brief, quote: v.quote, budget, budgetFrom, base, tiers: [], change, chosen, discount: chosen && applyDiscount(chosen, v.quote.discount, s), zone: { type: 'unknown' } }
  }
  const ts = tiers(v.brief, extras, s)
  const tier = ts.find(t => t.name === v.quote.tier) ?? ts[ts.length - 1] ?? null
  return {
    title, n, at: v.at, brief: v.brief, quote: v.quote, budget, budgetFrom, base: null, tiers: ts, change: null,
    chosen: tier, discount: tier && applyDiscount(tier, v.quote.discount, s), zone: zone(v.brief, extras, budget, s),
  }
}

const RESULT_PROMISE: Record<ClientType, string> = {
  商单: '交付后按需求清单陪你验收，验收中发现的问题改到通过',
  学生单: '交付后按老师和答辩的意见修改，改到答辩通过',
  个人单: '帮你装好跑起来，教会你怎么用',
  待确认: '交付后按需求清单陪你验收，改到通过',
}

const WARRANTY = (days: number): string[] => [
  `交付后 ${days} 天保修：需求清单里写了的功能，在交付时的环境下不工作，我会立刻响应，放下手头的事只修这一件，直到解决`,
  `不在保修里：清单外的新想法；你自己改了代码、环境或第三方服务后出的问题；${days} 天后发现的问题，这些按变更单另算`,
  '要更长的保修或加急，也按变更单另算',
]

const money = (n: number): string => `¥${n.toLocaleString('zh-CN')}`
const day = (at: number): string => new Date(at).toLocaleDateString('zh-CN')
const sum = (lines: QuoteLine[], kinds: QuoteLine['kind'][]): number => lines.filter(l => kinds.includes(l.kind)).reduce((a, l) => a + l.amount, 0)

// 报价比底线多出的部分按金额比例摊到交付、兜底、结果三块；支出原价列出，尾差落在交付
export function blocks(p: Priced): { label: string; amount: number }[] {
  const expense = sum(p.lines, ['expense'])
  const work = p.floor - expense
  const scale = work > 0 ? (p.quote - expense) / work : 0
  const pad = Math.round(sum(p.lines, ['pad']) * scale)
  const result = Math.round(sum(p.lines, ['result']) * scale)
  const out = [
    { label: '交付', amount: p.quote - expense - pad - result },
    { label: `兜底（${DEFAULT_QUOTE_SETTINGS.warrantyDays} 天保修）`, amount: pad },
    { label: '交付后修改', amount: result },
    { label: '实际支出（原价）', amount: expense },
  ]
  return out.filter(b => b.amount > 0)
}

function discountLines(sheet: Sheet): string[] {
  const d = sheet.discount
  if (!d || !d.amount || !sheet.chosen) return []
  return ['', `【人情折让】${sheet.chosen.name === '变更' ? '' : sheet.chosen.name + '档'}`, `原价 ${money(sheet.chosen.quote)}`, `人情折让 −${money(d.amount)}${d.reason ? `（${d.reason}）` : ''}`, `实收 ${money(d.price)}`]
}

function afterLines(sheet: Sheet, days: number): string[] {
  const out = ['', '【交付之后】', ...WARRANTY(days).map(x => '· ' + x)]
  if (sheet.quote.resultHours > 0) out.push('· ' + RESULT_PROMISE[sheet.brief.clientType])
  return out
}

export function clientText(sheet: Sheet, s: QuoteSettings = DEFAULT_QUOTE_SETTINGS): string {
  const b = sheet.brief
  const byId = new Map(b.items.map(i => [i.id, i]))
  const out: string[] = []
  if (sheet.change && sheet.base) {
    out.push(`${sheet.title} 变更单`, `基于第 ${sheet.base.n} 版 · ${day(sheet.at)}`)
    if (!sheet.chosen) return [...out, '', '这次没有需要另外收费的变更'].join('\n')
    out.push('', `【这次变更】${money(sheet.chosen.quote)}`)
    for (const l of sheet.chosen.lines.filter(x => x.kind === 'item')) out.push(`· ${l.label}`)
    for (const bl of blocks(sheet.chosen)) out.push(`  ${bl.label} ${money(bl.amount)}`)
    out.push(...discountLines(sheet))
    out.push('', '【交付之后】', `· 这次变更的内容交付后 ${s.warrantyDays} 天保修，规则同原单`)
    return out.join('\n')
  }
  out.push(`${sheet.title} 报价单`, `第 ${sheet.n} 版 · ${day(sheet.at)}`)
  if (b.deadline) out.push(`交期：${b.deadline}`)
  // 完整档放最前当锚，主推档标出来（Tversky & Kahneman 1974；Huber 等 1982）
  for (const t of [...sheet.tiers].reverse()) {
    out.push('', `【${t.name}档】${money(t.quote)}${t.name === sheet.chosen?.name ? '（主推）' : ''}`)
    for (const id of t.itemIds) out.push(`· ${byId.get(id)!.title}`)
    for (const bl of blocks(t)) out.push(`  ${bl.label} ${money(bl.amount)}`)
  }
  out.push(...discountLines(sheet), ...afterLines(sheet, s.warrantyDays))
  const notIn = [...b.items.filter(i => i.priority === '不做').map(i => i.title), ...b.excluded]
  if (notIn.length) out.push('', '【不包含】', ...notIn.map(x => '· ' + x))
  out.push('', '清单以外的新想法，每一条单独报价，你决定要不要做')
  return out.join('\n')
}

const lineText = (l: QuoteLine): string => (l.kind === 'expense' ? `· ${l.label}  ${money(l.amount)}  ${l.why}` : `· ${l.label}  ${l.hours} 小时 × ${l.rate} = ${money(l.amount)}  ${l.why}`)

function zoneText(z: Zone, budget: number | null): string[] {
  if (z.type === 'unknown') return budget == null ? ['预算：待问'] : []
  if (z.type === 'fits') return [`预算 ${money(z.budget)}：完整范围就能成交，底线 ${money(z.floor)}，可报 ${money(z.quote)}`]
  if (z.type === 'cut') return [`预算 ${money(z.budget)}：完整范围放不下，砍掉 ${z.cut.join('、')} 后底线 ${money(z.floor)}，可报 ${money(z.quote)}`]
  return [`预算 ${money(z.budget)}：只做必须的底线也要 ${money(z.floor)}，差 ${money(z.gap)}，这单在这个预算下不成立`]
}

export function selfText(sheet: Sheet, s: QuoteSettings = DEFAULT_QUOTE_SETTINGS): string {
  const out = [`${sheet.title} 自用`, `第 ${sheet.n} 版 · ${sheet.quote.status} · 时间值 新做 ${s.rates['新做']} / 接手改 ${s.rates['接手改']} 元每小时`]
  const priced: (Priced & { name: string })[] = sheet.change ? (sheet.chosen ? [sheet.chosen] : []) : sheet.tiers
  for (const p of priced) {
    out.push('', `【${p.name === '变更' ? `变更单（基于第 ${sheet.base!.n} 版）` : p.name + '档'}】底线 ${money(p.floor)} · 报价 ${money(p.quote)} · 最低可收 ${money(p.minPrice)}`)
    out.push(...p.lines.map(lineText))
  }
  if (sheet.change?.removed.length) out.push('', '【这一版去掉的】已成交的部分，客户不提就不退', ...sheet.change.removed.map(x => '· ' + x))
  if (!sheet.change) out.push('', ...zoneText(sheet.zone, sheet.budget))
  if (sheet.discount?.amount) out.push(`人情折让 −${money(sheet.discount.amount)}，实收 ${money(sheet.discount.price)}，底线 ${money(sheet.chosen!.floor)}`)
  return out.join('\n')
}
