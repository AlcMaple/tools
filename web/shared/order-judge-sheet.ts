// 报价单：一个版本的报价设置（状态、预算、支出、交付后修改、主推档、人情折让）+ 计算结果 → 客户版 / 自用版文字。
// 文字用全角括号和圆点而不是 Markdown，客户多半在微信里看，井号和星号会原样露出来。网页和桌面共用

import { WORK_KINDS, type Brief, type ClientType, type WorkKind } from './order-judge-brief'
import type { Maintenance } from './order-judge-maintenance'
import {
  DEFAULT_QUOTE_SETTINGS, applyDiscount, changeOrder, parseBudget, tiers, zone,
  type ChangeOrder, type Discount, type Expense, type Priced, type QuoteLine, type QuoteSettings, type Tier, type TierName, type Zone,
} from './order-judge-quote'

export const VERSION_STATUSES = ['草稿', '已报价', '已成交'] as const
export type VersionStatus = typeof VERSION_STATUSES[number]
export const TIER_NAMES: TierName[] = ['基础', '推荐', '完整']
export const DISCOUNT_STEPS = [0, 0.05, 0.1, 0.15, 0.2]
export const MAX_EXPENSES = 10
// 回填口径见 021「反馈与自动纠正」：客户结果只记在已报价的版本上（成交直接把状态改成已成交），实际小时和亏 / 值只记在已成交的版本上
export const OUTCOMES = ['待定', '嫌贵', '没回音', '我没接'] as const
export const FEELINGS = ['待定', '亏', '刚好', '值'] as const
export type Outcome = typeof OUTCOMES[number]
export type Feeling = typeof FEELINGS[number]

// 成效奖金（商单）：文章「固定建置費 + 成效獎金，客戶心理門檻最低」。文章没给奖金比例，这里不编比例，用期望值倒推：
// 先付 = 底线（没达标你也不亏），奖金 = (报价 − 底线) ÷ 你对达标的把握，于是「先付 + 把握 × 奖金」= 原报价，平均下来不少收
export const CONFIDENCE_STEPS = [0.3, 0.5, 0.7, 0.9]
export const BONUS_RESULTS = ['待定', '达标', '没达标'] as const
export type BonusResult = typeof BONUS_RESULTS[number]
export interface BonusTerms {
  on: boolean
  metric: string
  baseline: string
  target: string
  verify: string
  period: string
  confidence: number
  gain: number | null
  result: BonusResult
}
export const EMPTY_BONUS: BonusTerms = { on: false, metric: '', baseline: '', target: '', verify: '', period: '', confidence: 0.5, gain: null, result: '待定' }
export const bonusAllowed = (b: Brief): boolean => b.clientType === '商单' || b.clientType === '待确认'

// 报出去的价不能因为之后的校准变掉：状态离开草稿时把当时的时间值和小时系数存进版本
export interface Frozen { rates: Record<WorkKind, number>; hourFactor: Record<WorkKind, number> }

export interface QuoteState {
  status: VersionStatus
  budget: number | null
  resultHours: number
  expenses: Expense[]
  tier: TierName
  discount: Discount
  outcome: Outcome
  clientBudget: number | null
  actual: Record<WorkKind, number>
  feeling: Feeling
  frozen: Frozen | null
  bonus: BonusTerms
}

export const EMPTY_QUOTE: QuoteState = {
  status: '草稿', budget: null, resultHours: 0, expenses: [], tier: '推荐', discount: { ratio: 0, reason: '' },
  outcome: '待定', clientBudget: null, actual: { 新做: 0, 接手改: 0 }, feeling: '待定', frozen: null, bonus: EMPTY_BONUS,
}

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
    outcome: OUTCOMES.includes(o.outcome as Outcome) ? o.outcome as Outcome : '待定',
    clientBudget: o.clientBudget == null || o.clientBudget === '' ? null : Math.round(num(o.clientBudget, 100_000_000)) || null,
    actual: perKind(o.actual, 1000),
    feeling: FEELINGS.includes(o.feeling as Feeling) ? o.feeling as Feeling : '待定',
    frozen: frozenOf(o.frozen),
    bonus: bonusOf(o.bonus),
  }
}

function bonusOf(v: unknown): BonusTerms {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const c = Number(r.confidence)
  return {
    on: r.on === true,
    metric: text(r.metric, 60), baseline: text(r.baseline, 60), target: text(r.target, 60), verify: text(r.verify, 120), period: text(r.period, 40),
    confidence: CONFIDENCE_STEPS.includes(c) ? c : 0.5,
    gain: r.gain == null || r.gain === '' ? null : Math.round(num(r.gain, 1_000_000_000)) || null,
    result: BONUS_RESULTS.includes(r.result as BonusResult) ? r.result as BonusResult : '待定',
  }
}

function perKind(v: unknown, max: number): Record<WorkKind, number> {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return Object.fromEntries(WORK_KINDS.map(k => [k, num(r[k], max)])) as Record<WorkKind, number>
}

function frozenOf(v: unknown): Frozen | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const pick = (x: unknown, k: WorkKind): number => Number(((x && typeof x === 'object' ? x : {}) as Record<string, unknown>)[k])
  const rates = {} as Record<WorkKind, number>, hourFactor = {} as Record<WorkKind, number>
  for (const k of WORK_KINDS) {
    const rate = pick(r.rates, k), factor = pick(r.hourFactor, k)
    if (!(rate > 0 && rate <= 100_000 && factor >= 0.1 && factor <= 10)) return null
    rates[k] = Math.round(rate)
    hourFactor[k] = Math.round(factor * 100) / 100
  }
  return { rates, hourFactor }
}

// 保存前调用：离开草稿就冻结当时的设置（已冻结的不动），回到草稿就解冻
export function freeze(q: QuoteState, s: QuoteSettings): QuoteState {
  if (q.status === '草稿') return { ...q, frozen: null }
  return q.frozen ? q : { ...q, frozen: { rates: { ...s.rates }, hourFactor: { ...s.hourFactor } } }
}

export const settingsFor = (q: QuoteState, s: QuoteSettings): QuoteSettings => (q.frozen ? { ...s, ...q.frozen } : s)

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
  settings: QuoteSettings
  bonus: { fixed: number; amount: number; confidence: number; expected: number } | null
}

// 本版之前最近一个「已成交」的版本就是变更单的基准；没有就按整单出三档
export function buildSheet(title: string, versions: SheetVersion[], n: number, current: QuoteSettings = DEFAULT_QUOTE_SETTINGS): Sheet {
  const v = versions.find(x => x.n === n)!
  const s = settingsFor(v.quote, current)
  const base = [...versions].filter(x => x.n < n && x.quote.status === '已成交').sort((a, b) => b.n - a.n)[0] ?? null
  const extras = { expenses: v.quote.expenses, resultHours: v.quote.resultHours }
  const parsed = parseBudget(v.brief.budget)
  const budget = v.quote.budget ?? parsed
  const budgetFrom = v.quote.budget != null ? '手填' : parsed != null ? '材料' : null
  if (base) {
    const change = changeOrder(base.brief, v.brief, extras, s)
    const chosen = change.lines.length ? { name: '变更', ...change } : null
    return { title, n, at: v.at, brief: v.brief, quote: v.quote, budget, budgetFrom, base, tiers: [], change, chosen, discount: chosen && applyDiscount(chosen, v.quote.discount, s), zone: { type: 'unknown' }, settings: s, bonus: null }
  }
  const ts = tiers(v.brief, extras, s)
  const tier = ts.find(t => t.name === v.quote.tier) ?? ts[ts.length - 1] ?? null
  return {
    title, n, at: v.at, brief: v.brief, quote: v.quote, budget, budgetFrom, base: null, tiers: ts, change: null,
    chosen: tier, discount: tier && applyDiscount(tier, v.quote.discount, s), zone: zone(v.brief, extras, budget, s), settings: s,
    bonus: tier && v.quote.bonus.on && bonusAllowed(v.brief) ? bonusPlan(tier, v.quote.bonus.confidence) : null,
  }
}

export function bonusPlan(p: Priced, confidence: number): NonNullable<Sheet['bonus']> {
  const amount = Math.ceil((p.quote - p.floor) / confidence / 10) * 10
  return { fixed: p.floor, amount, confidence, expected: Math.round(p.floor + confidence * amount) }
}

// 实际收到的钱：带成效奖金的单，先付 + 达标才有的奖金；奖金还没结果时返回 null，不拿来校准
export function received(sheet: Sheet): number | null {
  if (!sheet.discount) return null
  if (!sheet.bonus) return sheet.discount.price
  const r = sheet.quote.bonus.result
  return r === '待定' ? null : sheet.bonus.fixed + (r === '达标' ? sheet.bonus.amount : 0)
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
  if (!d || !d.amount || !sheet.chosen || sheet.bonus) return []
  return ['', `【人情折让】${sheet.chosen.name === '变更' ? '' : sheet.chosen.name + '档'}`, `原价 ${money(sheet.chosen.quote)}`, `人情折让 −${money(d.amount)}${d.reason ? `（${d.reason}）` : ''}`, `实收 ${money(d.price)}`]
}

const BONUS_FIELDS: [keyof BonusTerms, string][] = [['metric', '看什么'], ['baseline', '现在'], ['target', '目标'], ['verify', '怎么算达标'], ['period', '考核期']]

function bonusLines(sheet: Sheet): string[] {
  const p = sheet.bonus, t = sheet.quote.bonus
  if (!p || !sheet.chosen) return []
  const out = ['', `【成效方案】${sheet.chosen.name}档的内容，换一种付法`, `先付 ${money(p.fixed)}，交付时付清`, `达标后再付 ${money(p.amount)}`]
  for (const [k, label] of BONUS_FIELDS) if (t[k]) out.push(`· ${label}：${t[k]}`)
  out.push('· 没达标不付奖金，先付的部分不退')
  return out
}

function afterLines(sheet: Sheet, days: number): string[] {
  const out = ['', '【交付之后】', ...WARRANTY(days).map(x => '· ' + x)]
  if (sheet.quote.resultHours > 0) out.push('· ' + RESULT_PROMISE[sheet.brief.clientType])
  return out
}

export function clientText(sheet: Sheet): string {
  const s = sheet.settings
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
  out.push(...bonusLines(sheet), ...discountLines(sheet), ...afterLines(sheet, s.warrantyDays))
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

export function selfText(sheet: Sheet, calib: Calibration | null = null): string {
  const s = sheet.settings
  const out = [`${sheet.title} 自用`, `第 ${sheet.n} 版 · ${sheet.quote.status} · 时间值 新做 ${s.rates['新做']} / 接手改 ${s.rates['接手改']} 元每小时`]
  if (sheet.quote.frozen) out.push('时间值和小时系数按报出去那一刻的，之后的校准不改这一版')
  else if (calib) out.push(...calib.notes)
  const ref = calib?.budgets[sheet.brief.clientType]
  if (ref) out.push(`同类客户（${sheet.brief.clientType}）嫌贵时说过的预算：中位数 ${money(ref.median)}（${ref.count} 单）`)
  const priced: (Priced & { name: string })[] = sheet.change ? (sheet.chosen ? [sheet.chosen] : []) : sheet.tiers
  for (const p of priced) {
    out.push('', `【${p.name === '变更' ? `变更单（基于第 ${sheet.base!.n} 版）` : p.name + '档'}】底线 ${money(p.floor)} · 报价 ${money(p.quote)} · 最低可收 ${money(p.minPrice)}`)
    out.push(...p.lines.map(lineText))
  }
  if (sheet.change?.removed.length) out.push('', '【这一版去掉的】已成交的部分，客户不提就不退', ...sheet.change.removed.map(x => '· ' + x))
  if (!sheet.change) out.push('', ...zoneText(sheet.zone, sheet.budget))
  if (sheet.bonus && sheet.chosen) {
    const p = sheet.bonus, t = sheet.quote.bonus
    out.push('', `【成效方案】先付 = ${sheet.chosen.name}档底线 ${money(p.fixed)}；奖金 = (报价 ${money(sheet.chosen.quote)} − 底线) ÷ 把握 ${p.confidence * 10} 成 = ${money(p.amount)}`)
    out.push(`按你的把握，平均能收 ${money(p.expected)}，和直接报价差不多；没达标也不低于底线`)
    if (t.gain) out.push(`奖金是客户达标后多赚 ${money(t.gain)} 的 ${Math.round(p.amount / t.gain * 100)}%`)
    const missing = BONUS_FIELDS.filter(([k]) => !t[k]).map(([, label]) => label)
    if (missing.length) out.push(`条款还缺：${missing.join('、')}，没写清的不要发给客户`)
    if (sheet.discount?.amount) out.push('选了成效方案，人情折让不再生效：先付已经是底线')
    if (sheet.quote.status === '已成交') out.push(`奖金结果：${t.result}`)
  }
  if (sheet.discount?.amount && !sheet.bonus) out.push(`人情折让 −${money(sheet.discount.amount)}，实收 ${money(sheet.discount.price)}，底线 ${money(sheet.chosen!.floor)}`)
  return out.join('\n')
}

// ── 回填与校准（021「反馈与自动纠正」）──
// 三件事分开算，互不混：实际小时只修小时系数；亏 / 刚好 / 值、我没接只修时间值；嫌贵时客户说的预算只给参考，不动你的价

export interface Calibration {
  settings: QuoteSettings
  notes: string[]
  budgets: Partial<Record<ClientType, { median: number; count: number }>>
}

export const median = (xs: number[]): number => {
  const a = [...xs].sort((x, y) => x - y), m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

// 成交价扣掉原价支出后，按各类工作在报价里的金额比例分给新做 / 接手改
function shares(lines: QuoteLine[]): Record<WorkKind, number> {
  const amount = { 新做: 0, 接手改: 0 } as Record<WorkKind, number>
  for (const l of lines) if (l.work) amount[l.work] += l.amount
  const total = amount['新做'] + amount['接手改']
  return { 新做: total ? amount['新做'] / total : 0, 接手改: total ? amount['接手改'] / total : 0 }
}

const hoursBy = (lines: QuoteLine[], k: WorkKind, f: number, kinds: QuoteLine['kind'][]): number =>
  lines.filter(l => l.work === k && kinds.includes(l.kind)).reduce((a, l) => a + (l.kind === 'item' ? l.hours / f : l.hours), 0)

export function calibrate(projects: { title: string; versions: SheetVersion[]; maintenance?: Maintenance }[], base: QuoteSettings = DEFAULT_QUOTE_SETTINGS): Calibration {
  const lows = { 新做: [] as number[], 接手改: [] as number[] }, highs = { 新做: [] as number[], 接手改: [] as number[] }, exact = { 新做: [] as number[], 接手改: [] as number[] }
  const ratios = { 新做: [] as number[], 接手改: [] as number[] }
  const budgets: Partial<Record<ClientType, number[]>> = {}
  // 月维护：月费扣掉支出 ÷ 当月实际小时，维护的是自己的代码，算进新做
  for (const p of projects) {
    const m = p.maintenance
    if (!m || m.fee <= 0) continue
    const net = m.fee - m.expenses.reduce((a, e) => a + e.amount, 0)
    for (const r of m.months) {
      if (r.hours <= 0 || r.feeling === '待定') continue
      ;(r.feeling === '亏' ? lows : r.feeling === '值' ? highs : exact)['新做'].push(net / r.hours)
    }
  }
  for (const p of projects) for (const v of p.versions) {
    const q = v.quote
    if (q.status === '已报价' && q.outcome === '嫌贵' && q.clientBudget) (budgets[v.brief.clientType] ??= []).push(q.clientBudget)
    const worth = q.status === '已成交' && q.feeling !== '待定'
    const refused = q.status === '已报价' && q.outcome === '我没接'
    const timed = q.status === '已成交' && WORK_KINDS.some(k => q.actual[k] > 0)
    if (!worth && !refused && !timed) continue
    const sheet = buildSheet(p.title, p.versions, v.n, base)
    if (!sheet.chosen || !sheet.discount) continue
    const f = sheet.settings.hourFactor
    const lines = sheet.chosen.lines
    const share = shares(lines)
    const expense = lines.filter(l => l.kind === 'expense').reduce((a, l) => a + l.amount, 0)
    for (const k of WORK_KINDS) {
      if (!share[k]) continue
      const actual = q.actual[k]
      const estimate = hoursBy(lines, k, f[k], ['item', 'result'])
      if (q.status === '已成交' && actual > 0 && estimate > 0) ratios[k].push(actual / estimate)
      const paid = received(sheet)
      if (worth && actual > 0 && paid != null) {
        const rate = (paid - expense) * share[k] / actual
        ;(q.feeling === '亏' ? lows : q.feeling === '值' ? highs : exact)[k].push(rate)
      }
      // 自己不想接：按报价和预计小时（含兜底）折出的每小时都不够，时间值高于它
      const planned = hoursBy(lines, k, 1, ['item', 'pad', 'result'])
      if (refused && planned > 0) lows[k].push((sheet.chosen.quote - expense) * share[k] / planned)
    }
  }
  const notes: string[] = []
  const rates = { ...base.rates }, hourFactor = { ...base.hourFactor }
  for (const k of WORK_KINDS) {
    const lo = lows[k].length ? Math.max(...lows[k]) : null, hi = highs[k].length ? Math.min(...highs[k]) : null
    let rate = base.rates[k]
    let why = '来自答题'
    if (exact[k].length) {
      rate = median(exact[k])
      if (lo != null) rate = Math.max(rate, lo)
      if (hi != null) rate = Math.min(rate, hi)
      why = `做完觉得刚好的 ${exact[k].length} 单中位数`
    } else if (lo != null && hi != null) {
      rate = (lo + hi) / 2
      why = lo <= hi ? `亏的最高 ${Math.round(lo)} 与值的最低 ${Math.round(hi)} 之间` : `亏的最高 ${Math.round(lo)} 反而高于值的最低 ${Math.round(hi)}，前后感受矛盾，暂取中间`
    } else if (lo != null) {
      rate = Math.max(rate, lo)
      why = rate === lo ? `亏了或不想接的单里每小时最高 ${Math.round(lo)}，时间值至少到这` : '来自答题，亏了或不想接的单都低于它'
    } else if (hi != null) {
      rate = Math.min(rate, hi)
      why = rate === hi ? `做完觉得值的单里每小时最低 ${Math.round(hi)}，时间值不高于它` : '来自答题，觉得值的单都高于它'
    }
    rates[k] = Math.max(1, Math.round(rate))
    const count = lows[k].length + highs[k].length + exact[k].length
    notes.push(`${k}时间值 ${rates[k]}：${why}${count ? `（依据 ${count} 单）` : ''}`)
    if (ratios[k].length) {
      hourFactor[k] = Math.min(10, Math.max(0.1, Math.round(median(ratios[k]) * 20) / 20))
      notes.push(`${k}小时 × ${hourFactor[k]}：过去 ${ratios[k].length} 单实际 ÷ AI 预估的中位数`)
    }
  }
  const refs: Calibration['budgets'] = {}
  for (const [t, xs] of Object.entries(budgets) as [ClientType, number[]][]) refs[t] = { median: Math.round(median(xs)), count: xs.length }
  return { settings: { ...base, rates, hourFactor }, notes, budgets: refs }
}
