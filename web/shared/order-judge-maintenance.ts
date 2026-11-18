// 月维护：成交后的远程兼职，按月固定报酬。口径见 docs/ideas/021-接单评估重新定位.md「月维护」：
// - 月费由你定，定了就不改；这个项目吃亏也不中途调价，每月记录只用来给下一个月维护项目定价
// - 包含加功能、改功能、优化、修复、重构；平时小维护，发工资那天交一份大功能；做不完的排到下个月，不另收钱
// - 先做后付，当天付款当天交付；随时可以停，停了以后按变更单另算

import type { Engagement } from './order-judge-brief'
import type { Expense, QuoteSettings } from './order-judge-quote'
import { DEFAULT_QUOTE_SETTINGS } from './order-judge-quote'
import { FEELINGS, buildSheet, latestType, median, type Feeling, type SheetVersion } from './order-judge-sheet'

export const MAINTENANCE_STATES = ['不做', '在做', '已停'] as const
export type MaintenanceState = typeof MAINTENANCE_STATES[number]
export const MAX_MONTHS = 60
export const MAX_MAINT_EXPENSES = 10

export const COOPERATION_PLANS = ['一次性', '长期'] as const
export type CooperationPlan = typeof COOPERATION_PLANS[number]

export const MONTHLY_REPLIES = ['待回复', '考虑中', '同意', '嫌贵', '已拒绝', '没回音', '我没接'] as const
export type MonthlyReply = typeof MONTHLY_REPLIES[number] | '未报价'

export interface MonthRecord { month: string; delivered: string; hours: number; feeling: Feeling }

export interface Maintenance {
  state: MaintenanceState
  fee: number
  start: string
  expenses: Expense[]
  months: MonthRecord[]
  // 仅兼容没有系统判定的旧项目；新报价不再写入人工选择
  plan: CooperationPlan | ''
  monthHours: number
  reply: MonthlyReply
  replyNote: string
  clientBudget: number
}

export const EMPTY_MAINTENANCE: Maintenance = { state: '不做', fee: 0, start: '', expenses: [], months: [], plan: '', monthHours: 0, reply: '未报价', replyNote: '', clientBudget: 0 }

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const amount = (v: unknown, max: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : 0
}
const halfHours = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(744, Math.max(0, Math.round(n * 2) / 2)) : 0
}

export function normalizeMaintenance(raw: unknown): Maintenance {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const month = (v: unknown): string => (typeof v === 'string' && MONTH_RE.test(v) ? v : '')
  const state = MAINTENANCE_STATES.includes(o.state as MaintenanceState) ? o.state as MaintenanceState : '不做'
  const months = (Array.isArray(o.months) ? o.months : []).slice(0, MAX_MONTHS).map(m => {
    const r = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
    return { month: month(r.month), delivered: str(r.delivered, 200), hours: halfHours(r.hours), feeling: FEELINGS.includes(r.feeling as Feeling) ? r.feeling as Feeling : '待定' }
  }).filter(m => m.month)
  // 老记录只有开工或履约证据才代表同意；单独填了月费或开始月份还不是成交
  const reply = state !== '不做' || months.some(r => r.hours > 0 || r.delivered || r.feeling !== '待定') ? '同意'
    : MONTHLY_REPLIES.includes(o.reply as typeof MONTHLY_REPLIES[number]) ? o.reply as MonthlyReply : '未报价'
  return {
    state, months, reply,
    replyNote: reply === '未报价' ? '' : str(o.replyNote, 300),
    clientBudget: reply === '嫌贵' ? amount(o.clientBudget, 10_000_000) : 0,
    fee: amount(o.fee, 10_000_000),
    start: month(o.start),
    expenses: (Array.isArray(o.expenses) ? o.expenses : []).slice(0, MAX_MAINT_EXPENSES).map(e => {
      const r = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
      return { name: str(r.name, 40), amount: amount(r.amount, 1_000_000) }
    }).filter(e => e.name && e.amount > 0),
    plan: COOPERATION_PLANS.includes(o.plan as CooperationPlan) ? o.plan as CooperationPlan : '',
    monthHours: halfHours(o.monthHours),
  }
}

export interface MaintProject { id: string; title: string; versions: SheetVersion[]; maintenance: Maintenance }

const expenseSum = (m: Maintenance): number => m.expenses.reduce((a, e) => a + e.amount, 0)

// 每个记过的月份，按月费扣掉原价支出后 ÷ 实际小时，就是这个月实际每小时拿到多少
export function monthRate(m: Maintenance, r: MonthRecord): number | null {
  return m.fee > 0 && r.hours > 0 ? (m.fee - expenseSum(m)) / r.hours : null
}

export interface FeeSuggestion { hours: number | null; source: string; rate: number; fee: number | null }

// 建议月费 = 一个月要花的小时 × 新做时间值 + 支出。维护的是你自己交付的代码，按新做算（021「第三阶段的计算口径」）。
// 小时的来源按可信程度依次取：别的月维护项目的实际记录 → 这个客户成交过的变更单实际小时 → AI 对最新一份变更的预估
export function suggestFee(projects: MaintProject[], projectId: string, s: QuoteSettings = DEFAULT_QUOTE_SETTINGS): FeeSuggestion {
  const rate = s.rates['新做']
  const self = projects.find(p => p.id === projectId)
  const withFee = (hours: number | null, source: string): FeeSuggestion =>
    ({ hours, source, rate, fee: hours == null ? null : Math.round(hours * rate) + (self ? expenseSum(self.maintenance) : 0) })
  const months = projects.filter(p => p.id !== projectId).flatMap(p => p.maintenance.months).filter(r => r.hours > 0).map(r => r.hours)
  if (months.length) return withFee(median(months), `过去 ${months.length} 个月维护记录的实际小时中位数`)
  if (!self) return withFee(null, '没有数据，自己定')
  const firstDeal = self.versions.find(v => v.quote.status === '已成交')
  const changes = self.versions.filter(v => firstDeal && v.n > firstDeal.n && v.quote.status === '已成交')
  const actual = changes.map(v => v.quote.actual['新做'] + v.quote.actual['接手改']).filter(h => h > 0)
  if (actual.length) return withFee(median(actual), `这个客户 ${actual.length} 张变更单的实际小时中位数，小维护没有数据，没算进去`)
  const last = self.versions[self.versions.length - 1]
  if (firstDeal && last.n > firstDeal.n) {
    const sheet = buildSheet(self.title, self.versions, last.n, s)
    const hours = sheet.chosen?.lines.filter(l => l.kind === 'item').reduce((a, l) => a + l.hours, 0) ?? 0
    if (hours > 0) return withFee(hours, `第 ${last.n} 版要做的大功能 AI 预估，小维护没有数据，没算进去`)
  }
  return withFee(null, '没有数据：先用「追加需求」录入第一个月要做的大功能，或自己定')
}

const ROUGH_MONTHS = 3
const MIN_MONTH_HOURS = 8

// 项目版本只追加，不修改。以最早的系统判定为准，后来追加需求和查看旧版都不重新选合作方式
export function projectDecision(versions: { n: number; brief: { engagement?: Engagement } }[], m: Maintenance): Pick<Engagement, 'mode' | 'reason'> {
  const first = [...versions].sort((a, b) => a.n - b.n).find(v => v.brief.engagement)?.brief.engagement
  return first ?? { mode: m.plan || (m.reply !== '未报价' ? '长期' : '一次性'), reason: '' }
}

type MonthlySuggestion = FeeSuggestion & { hours: number; fee: number; notes: string[] }

export function longTermFee(projects: MaintProject[], projectId: string, m: Maintenance, aiHours: number, s: QuoteSettings = DEFAULT_QUOTE_SETTINGS, scopeHours = 0): MonthlySuggestion {
  const self = projects.find(p => p.id === projectId)
  const peers = self ? projects.filter(p => p.id !== projectId && latestType(p.versions) === latestType(self.versions)) : []
  const offers = peers.map(p => p.maintenance).filter(p => p.reply !== '未报价')
  const counts = MONTHLY_REPLIES.flatMap(reply => {
    const n = offers.filter(p => p.reply === reply).length
    return n ? [`${reply} ${n} 单`] : []
  })
  const notes = [counts.length ? `其他同类项目的月报价：${counts.join('，')}` : '还没有其他同类项目的月报价反馈']
  let rate = s.rates['新做']
  // 每个项目只投一票；交付月份多的一个客户不该盖过其他客户
  const ratesFor = (feeling: Feeling): number[] => offers.filter(p => p.reply === '同意').flatMap(p => {
    const rates = p.months.filter(r => r.feeling === feeling).map(r => monthRate(p, r)).filter((n): n is number => n !== null && n > 0)
    return rates.length ? [median(rates)] : []
  })
  const fair = ratesFor('刚好'), poor = ratesFor('亏'), good = ratesFor('值')
  if (fair.length) rate = median(fair)
  if (good.length && !fair.length) rate = Math.min(rate, median(good))
  // 预算是每月而非总价。只有明确嫌贵、给了更低预算且有报价工时，才可比较
  const limits = offers.filter(p => p.reply === '嫌贵' && p.monthHours > 0 && p.clientBudget > expenseSum(p) && p.clientBudget < p.fee)
    .map(p => (p.clientBudget - expenseSum(p)) / p.monthHours)
  if (limits.length >= 3) rate = Math.min(rate, median(limits))
  if (poor.length) rate = Math.max(rate, median(poor))
  rate = Math.max(1, Math.round(rate))
  if (limits.length) notes.push(`有明确月预算的嫌贵反馈 ${limits.length} 单，${limits.length < 3 ? '满 3 单后再用于估价' : '已按扣除支出后的每小时预算中位数作参考'}`)
  if (poor.length || fair.length || good.length) notes.push('已参考实际交付的小时和感受，建议不低于做完觉得亏的每小时收入中位数')
  notes.push(`本次按每小时 ¥${rate} 估算，待回复和没回音都不参与调价`)
  let hours = m.monthHours || aiHours
  let source = m.monthHours ? '已填的每月投入' : 'AI 估的每月投入'
  if (!hours) {
    const history = suggestFee(self ? [...peers, self] : [], projectId, s)
    hours = history.hours ?? Math.max(MIN_MONTH_HOURS, Math.ceil(scopeHours / ROUGH_MONTHS))
    source = history.hours != null ? history.source : `清单 ${scopeHours} 小时按 ${ROUGH_MONTHS} 个月摊的粗估`
  }
  return { hours, source, rate, fee: Math.round(hours * rate) + expenseSum(m), notes }
}

const money = (n: number): string => `¥${n.toLocaleString('zh-CN')}`
const monthText = (m: string): string => (m ? `${Number(m.slice(0, 4))} 年 ${Number(m.slice(5))} 月` : '')

export function maintenanceClientText(title: string, m: Maintenance): string {
  const out = [`${title} 月维护`, `每月 ${m.fee ? money(m.fee) : '待定'}${m.start ? `，从 ${monthText(m.start)} 开始` : ''}`]
  out.push('', '【包含】', '· 加功能、改功能、优化、修复、重构，你随时提，按你定的先后顺序做', '· 平时的小问题随时修，每个月交付一份大功能')
  if (m.expenses.length) out.push(`· ${m.expenses.map(e => e.name).join('、')}的费用已经算在月费里`)
  out.push('', '【规则】', '· 一个月做不完的排到下个月，不另收钱', '· 每月约定的日子付款，当天交付这个月的大功能', '· 随时可以停，停了以后再有需求按变更单另算')
  return out.join('\n')
}

export function longTermClientText(title: string, m: Maintenance, fee: number | null, firstMonth: string[]): string {
  const out = [`${title} 长期合作`, `每月 ${m.fee || fee ? money(m.fee || fee!) : '待定'}${m.start ? `，从 ${monthText(m.start)} 开始` : ''}`, '这个项目要边核对边推进，不报总价，按月投入、按月交付']
  out.push('', '【第一个月交付】', ...(firstMonth.length ? firstMonth : ['需求路线图', '最不确定部分的可行性结论']).map(x => `· ${x}`))
  if (m.expenses.length) out.push('', `${m.expenses.map(e => e.name).join('、')}的费用已经算在月费里`)
  out.push('', '【规则】', '· 第一个月之后按你定的先后顺序做，每月交付一份', '· 一个月做不完的排到下个月，不另收钱', '· 每月约定的日子付款，当天交付', '· 随时可以停')
  return out.join('\n')
}

export function maintenanceSelfText(title: string, m: Maintenance, suggestion: FeeSuggestion, long = false): string {
  const out = [long ? `${title} 长期合作 · ${m.reply === '同意' ? `已成交 · ${m.state === '不做' ? '待开始' : m.state}` : m.reply}` : `${title} 月维护 · ${m.state}`, `月费 ${m.fee ? money(m.fee) : '未定'}`]
  if (long && m.replyNote) out.push(`客户原话：${m.replyNote}`)
  if (long && m.reply === '嫌贵' && m.clientBudget) out.push(`客户月预算：${money(m.clientBudget)}`)
  out.push(suggestion.fee != null ? `建议月费 ${money(suggestion.fee)}：${suggestion.hours} 小时 × ${suggestion.rate}${m.expenses.length ? ` + 支出 ${money(expenseSum(m))}` : ''}，小时来自${suggestion.source}` : `建议月费 没有，${suggestion.source}`)
  if (m.months.length) {
    out.push('', '【每月记录】')
    for (const r of m.months) {
      const rate = monthRate(m, r)
      out.push(`· ${monthText(r.month)}  ${r.hours ? `${r.hours} 小时` : '小时未填'}${rate != null ? `，每小时 ${money(Math.round(rate))}` : ''}  ${r.feeling}${r.delivered ? `  交付：${r.delivered}` : ''}`)
    }
    const hours = m.months.map(r => r.hours).filter(h => h > 0)
    if (hours.length) out.push(`实际小时中位数 ${median(hours)}`)
  }
  return out.join('\n')
}
