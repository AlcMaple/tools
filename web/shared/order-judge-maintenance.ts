// 月维护：成交后的远程兼职，按月固定报酬。口径见 docs/ideas/021-接单评估重新定位.md「月维护」：
// - 月费由你定，定了就不改；这个项目吃亏也不中途调价，每月记录只用来给下一个月维护项目定价
// - 包含加功能、改功能、优化、修复、重构；平时小维护，发工资那天交一份大功能；做不完的排到下个月，不另收钱
// - 先做后付，当天付款当天交付；随时可以停，停了以后按变更单另算

import type { Expense, QuoteSettings } from './order-judge-quote'
import { DEFAULT_QUOTE_SETTINGS } from './order-judge-quote'
import { FEELINGS, buildSheet, median, type Feeling, type SheetVersion } from './order-judge-sheet'

export const MAINTENANCE_STATES = ['不做', '在做', '已停'] as const
export type MaintenanceState = typeof MAINTENANCE_STATES[number]
export const MAX_MONTHS = 60
export const MAX_MAINT_EXPENSES = 10

export const COOPERATION_PLANS = ['一次性', '长期'] as const
export type CooperationPlan = typeof COOPERATION_PLANS[number]

export interface MonthRecord { month: string; delivered: string; hours: number; feeling: Feeling }

export interface Maintenance {
  state: MaintenanceState
  fee: number
  start: string
  expenses: Expense[]
  months: MonthRecord[]
  // 空表示跟 AI 的判断走，开发者点过才有值
  plan: CooperationPlan | ''
  monthHours: number
}

export const EMPTY_MAINTENANCE: Maintenance = { state: '不做', fee: 0, start: '', expenses: [], months: [], plan: '', monthHours: 0 }

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
  return {
    state: MAINTENANCE_STATES.includes(o.state as MaintenanceState) ? o.state as MaintenanceState : '不做',
    fee: amount(o.fee, 10_000_000),
    start: month(o.start),
    expenses: (Array.isArray(o.expenses) ? o.expenses : []).slice(0, MAX_MAINT_EXPENSES).map(e => {
      const r = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
      return { name: str(r.name, 40), amount: amount(r.amount, 1_000_000) }
    }).filter(e => e.name && e.amount > 0),
    months: (Array.isArray(o.months) ? o.months : []).slice(0, MAX_MONTHS).map(m => {
      const r = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
      return { month: month(r.month), delivered: str(r.delivered, 200), hours: halfHours(r.hours), feeling: FEELINGS.includes(r.feeling as Feeling) ? r.feeling as Feeling : '待定' }
    }).filter(m => m.month),
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

export const planOf = (m: Maintenance, engagement?: { mode: CooperationPlan }): CooperationPlan => m.plan || engagement?.mode || '一次性'

// 长期合作的月费 = 每月投入小时 × 新做时间值 + 支出。小时开发者填的优先，其次 AI 估的；都没有才退回月维护的历史口径
export function longTermFee(projects: MaintProject[], projectId: string, m: Maintenance, aiHours: number, s: QuoteSettings = DEFAULT_QUOTE_SETTINGS, scopeHours = 0): FeeSuggestion {
  const hours = m.monthHours || aiHours
  const rate = s.rates['新做']
  if (!hours) {
    const history = suggestFee(projects, projectId, s)
    if (history.fee != null) return history
    // 没有任何依据时也要给个数：不知道多少钱正是来估价的原因。按 3 个月摊是粗估，不是实测，来源里写明，开发者可以改
    const rough = Math.max(MIN_MONTH_HOURS, Math.ceil(scopeHours / ROUGH_MONTHS))
    return { hours: rough, source: `清单 ${scopeHours} 小时按 ${ROUGH_MONTHS} 个月摊的粗估`, rate, fee: Math.round(rough * rate) + expenseSum(m) }
  }
  return { hours, source: m.monthHours ? '你填的每月投入' : 'AI 估的每月投入', rate, fee: Math.round(hours * rate) + expenseSum(m) }
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
  const out = [long ? `${title} 长期合作 · ${m.state === '不做' ? '待开始' : m.state}` : `${title} 月维护 · ${m.state}`, `月费 ${m.fee ? money(m.fee) : '未定'}，定了就不改，这个项目的记录只用于下一个月维护项目`]
  out.push(suggestion.fee != null ? `建议月费 ${money(suggestion.fee)}：${suggestion.hours} 小时 × 新做 ${suggestion.rate}${m.expenses.length ? ` + 支出 ${money(expenseSum(m))}` : ''}，小时来自${suggestion.source}` : `建议月费 没有，${suggestion.source}`)
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
