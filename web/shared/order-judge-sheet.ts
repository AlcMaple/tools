// 报价单：一个版本的报价设置（状态、预算、支出、交付后修改、主推档、人情折让）+ 计算结果 → 客户版 / 自用版文字。
// 文字用全角括号和圆点而不是 Markdown，客户多半在微信里看，井号和星号会原样露出来。网页和桌面共用

import { BASES, BASIS_TEXT, CLIENT_TYPES, MAX_ITEMS, MAX_ITEM_HOURS, WORK_KINDS, basisOf, workOf, type Basis, type Brief, type BriefItem, type Category, type ClientType, type WorkKind } from './order-judge-brief'
import type { Maintenance } from './order-judge-maintenance'
import {
  DEFAULT_DAILY_HOURS, DEFAULT_QUOTE_SETTINGS, applyDiscount, changeOrder, factorOf, parseBudget, parseDeadline, planOf, tiers, ymd, zone,
  type ChangeOrder, type Discount, type Expense, type Plan, type Priced, type QuoteLine, type QuoteSettings, type Tier, type TierName, type Zone,
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
export interface Frozen { rates: Record<WorkKind, number>; hourFactor: Record<WorkKind, number>; basisFactor: Partial<Record<Basis, number>> }

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
  deadlineDate: string | null
  dailyHours: number
  hourEdits: Record<string, number>
  hourScale: number
  finalPrice: number | null
  share: boolean
}

export const EMPTY_QUOTE: QuoteState = {
  status: '草稿', budget: null, resultHours: 0, expenses: [], tier: '推荐', discount: { ratio: 0, reason: '' },
  outcome: '待定', clientBudget: null, actual: { 新做: 0, 接手改: 0 }, feeling: '待定', frozen: null, bonus: EMPTY_BONUS, deadlineDate: null, dailyHours: DEFAULT_DAILY_HOURS,
  hourEdits: {}, hourScale: 1, finalPrice: null, share: true,
}

export const HOUR_SCALE_MIN = 0.5
export const HOUR_SCALE_MAX = 2
export const HOURS_PER_DAY = 8
// 单项滑块只露出合计占到这个比例的几条，其余收起：功能再多也只用看几根，这是「估价要快」的关键
const MAJOR_SHARE = 0.8

const half = (h: number): number => Math.round(h * 2) / 2

function aiHours(i: BriefItem, q: QuoteState, s: QuoteSettings): number {
  return Math.min(MAX_ITEM_HOURS, half(i.hours * factorOf(i, s) * q.hourScale))
}

// 原本直接能做的条目被拖出小时后，不能还算「直接做」，否则这笔钱进不了判断分项
function withHours(i: BriefItem, hours: number): BriefItem {
  return { ...i, hours, manual: true, basis: i.hours > 0 ? i.basis : basisOf({ ...i, hours, basis: undefined }) }
}

// 滑块的结果落到清单上：单项拖过的用拖的值，其余按整体倍率缩放；都没动就原样，继续吃历史校准系数
export function adjustBrief(b: Brief, q: QuoteState, s: QuoteSettings): Brief {
  if (q.hourScale === 1 && !Object.keys(q.hourEdits).length) return b
  return {
    ...b,
    items: b.items.map(i => {
      const edit = q.hourEdits[i.id]
      if (edit != null) return withHours(i, edit)
      return q.hourScale === 1 ? i : withHours(i, aiHours(i, q, s))
    }),
  }
}

export interface HourRow {
  id: string
  title: string
  basis: Basis
  hours: number
  suggested: number
  max: number
  amount: number
  edited: boolean
  major: boolean
}

// 不做的条目不进报价，不给滑块。顺序、上限、是否收起只看 AI 的原始估计，绝不看当前拖的值：
// 否则拖动时行会换位（鼠标下的滑块被换走，拖动中断），上限跟着变大（滑块越拖越远，点哪都对不上）
export function hourRows(b: Brief, q: QuoteState, s: QuoteSettings): HourRow[] {
  const rows = b.items.filter(i => i.priority !== '不做').map(i => {
    const suggested = aiHours(i, q, s)
    const hours = q.hourEdits[i.id] ?? suggested
    const base = i.hours * factorOf(i, s)
    return { id: i.id, title: i.title, basis: basisOf(withHours(i, hours)), hours, suggested, max: Math.min(MAX_ITEM_HOURS, Math.max(16, Math.ceil(base * 3))), amount: base * s.rates[workOf(i)], edited: q.hourEdits[i.id] != null, major: false }
  }).sort((x, y) => y.amount - x.amount)
  const total = rows.reduce((a, r) => a + r.amount, 0)
  let seen = 0
  for (const r of rows) {
    r.major = r.amount > 0 && seen < total * MAJOR_SHARE
    seen += r.amount
  }
  return rows
}

export function hoursLabel(h: number): string {
  if (h < HOURS_PER_DAY) return `${h} 小时`
  const days = Math.floor(h / HOURS_PER_DAY), rest = h - days * HOURS_PER_DAY
  return rest ? `${days} 天 ${rest} 小时` : `${days} 天`
}

export function scaleLabel(scale: number): string {
  const pct = Math.round(Math.abs(scale - 1) * 100)
  return pct === 0 ? '不调整' : `${scale > 1 ? '多' : '少'} ${pct}%`
}

// 新版本沿用设置时，内容或 AI 小时变了的条目，上一版拖的值已经不算数
export function carryHourEdits(q: QuoteState, previous: Brief | null, current: Brief): QuoteState {
  const before = new Map(previous?.items.map(i => [i.id, i]))
  const hourEdits: Record<string, number> = {}
  for (const i of current.items) {
    const old = before.get(i.id)
    if (old && old.title === i.title && old.detail === i.detail && old.hours === i.hours && q.hourEdits[i.id] != null) hourEdits[i.id] = q.hourEdits[i.id]
  }
  return { ...q, hourEdits }
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
    deadlineDate: typeof o.deadlineDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.deadlineDate) ? o.deadlineDate : null,
    dailyHours: num(o.dailyHours, 16) || DEFAULT_DAILY_HOURS,
    hourEdits: hourEditsOf(o.hourEdits),
    hourScale: hourScaleOf(o.hourScale),
    finalPrice: o.finalPrice == null || o.finalPrice === '' ? null : Math.round(num(o.finalPrice, 100_000_000)),
    share: o.share !== false,
  }
}

function hourEditsOf(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [id, h] of Object.entries(v && typeof v === 'object' ? v : {}).slice(0, MAX_ITEMS)) {
    if (/^r\d+$/.test(id) && Number.isFinite(Number(h))) out[id] = num(h, MAX_ITEM_HOURS)
  }
  return out
}

function hourScaleOf(v: unknown): number {
  const n = Number(v)
  return n >= HOUR_SCALE_MIN && n <= HOUR_SCALE_MAX ? Math.round(n * 10) / 10 : 1
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
  // 老版本冻结时没有这项，必须给空，否则会沿用当前校准，改掉已报出去的价
  const basisFactor: Partial<Record<Basis, number>> = {}
  for (const [b, f] of Object.entries(r.basisFactor && typeof r.basisFactor === 'object' ? r.basisFactor : {})) {
    if (BASES.includes(b as Basis) && Number(f) >= 0.1 && Number(f) <= 10) basisFactor[b as Basis] = Number(f)
  }
  return { rates, hourFactor, basisFactor }
}

// 保存前调用：离开草稿就冻结当时的设置（已冻结的不动），回到草稿就解冻
export function freeze(q: QuoteState, s: QuoteSettings): QuoteState {
  if (q.status === '草稿') return { ...q, frozen: null }
  return q.frozen ? q : { ...q, frozen: { rates: { ...s.rates }, hourFactor: { ...s.hourFactor }, basisFactor: { ...s.basisFactor } } }
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
  deadline: string | null
  deadlineFrom: '手填' | '材料' | null
  plans: Plan[]
}

// 本版之前最近一个「已成交」的版本就是变更单的基准；没有就按整单出三档
export function buildSheet(title: string, versions: SheetVersion[], n: number, settings?: QuoteSettings, now: Date = new Date()): Sheet {
  const raw = versions.find(x => x.n === n)!
  const current = settings ?? DEFAULT_QUOTE_SETTINGS
  const s = settingsFor(raw.quote, current)
  const rawBase = [...versions].filter(x => x.n < n && x.quote.status === '已成交').sort((a, b) => b.n - a.n)[0] ?? null
  const base = rawBase && { ...rawBase, brief: adjustBrief(rawBase.brief, rawBase.quote, settingsFor(rawBase.quote, current)) }
  // 变更单从空白设置开始：AI 小时没变的条目沿用成交时调定的小时，否则成交时调低的条目会被当成「小时变多」重复收费
  const inherited = rawBase && {
    ...adjustBrief(raw.brief, raw.quote, s),
    items: adjustBrief(raw.brief, raw.quote, s).items.map(i => {
      const dealRaw = rawBase.brief.items.find(x => x.id === i.id)
      const dealt = base!.brief.items.find(x => x.id === i.id)
      return !i.manual && dealt?.manual && dealRaw?.hours === i.hours ? { ...i, hours: dealt.hours, manual: true } : i
    }),
  }
  const v = { ...raw, brief: inherited ?? adjustBrief(raw.brief, raw.quote, s) }
  const extras = { expenses: v.quote.expenses, resultHours: v.quote.resultHours }
  const parsed = parseBudget(v.brief.budget)
  const budget = v.quote.budget ?? parsed
  const budgetFrom = v.quote.budget != null ? '手填' : parsed != null ? '材料' : null
  const today = ymd(now)
  const parsedDeadline = parseDeadline(v.brief.deadline, today)
  const deadline = v.quote.deadlineDate ?? parsedDeadline
  const deadlineFrom = v.quote.deadlineDate ? '手填' : parsedDeadline ? '材料' : null
  const timing = { deadline, deadlineFrom } as const
  if (base) {
    const change = changeOrder(base.brief, v.brief, extras, s)
    const chosen = change.lines.length ? { name: '变更', ...change } : null
    return { title, n, at: v.at, brief: v.brief, quote: v.quote, budget, budgetFrom, base, tiers: [], change, chosen, discount: chosen && applyDiscount(chosen, v.quote.discount, s), zone: { type: 'unknown' }, settings: s, bonus: null, ...timing, plans: chosen ? [planOf('变更', chosen, v.quote.dailyHours, today, deadline)] : [] }
  }
  const computed = tiers(v.brief, extras, s)
  const picked = computed.find(t => t.name === v.quote.tier) ?? computed[computed.length - 1] ?? null
  // 手填了实际报价就只报这一个价：客户看到的范围是主推档，分项按比例摊，不再出公式算的另外两档
  const final = v.quote.finalPrice
  const ts = picked && final != null ? [{ ...picked, quote: final, floor: Math.min(picked.floor, final), minPrice: Math.min(picked.minPrice, final) }] : computed
  const tier = ts.find(t => t.name === v.quote.tier) ?? ts[ts.length - 1] ?? null
  return {
    title, n, at: v.at, brief: v.brief, quote: v.quote, budget, budgetFrom, base: null, tiers: ts, change: null,
    chosen: tier, discount: tier && applyDiscount(tier, v.quote.discount, s), zone: zone(v.brief, extras, budget, s), settings: s,
    bonus: tier && v.quote.bonus.on && bonusAllowed(v.brief) ? bonusPlan(tier, v.quote.bonus.confidence) : null,
    ...timing, plans: ts.map(t => planOf(t.name, t, v.quote.dailyHours, today, deadline)),
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

const WARRANTY = (days: number, type: ClientType): string[] => [
  type === '商单'
    ? `交付后 ${days} 天保修：需求清单里写了的功能，在交付时的环境下不工作，我会立刻响应，放下手头的事只修这一件，直到解决`
    : `交付后 ${days} 天保修，不另外收费：需求清单里写了的功能，在交付时的环境下不工作，我会尽快帮你修好`,
  `不在保修里：清单外的新想法；你自己改了代码、环境或第三方服务后出的问题；${days} 天后发现的问题，这些按变更单另算`,
  '要更长的保修或加急，也按变更单另算',
]

const money = (n: number): string => `¥${n.toLocaleString('zh-CN')}`
const day = (at: number): string => new Date(at).toLocaleDateString('zh-CN')
const sum = (lines: QuoteLine[], kinds: QuoteLine['kind'][]): number => lines.filter(l => kinds.includes(l.kind)).reduce((a, l) => a + l.amount, 0)

const BASIS_LABEL: [Basis, string][] = [['确认', '需求确认'], ['验证', '可行性验证'], ['接手', '接手旧代码'], ['上线', '上线保障']]

// 报价比底线多出的部分按金额比例摊到每一块；判断分项列（文章第三条），支出原价列出；
// 尾差落在最大的判断项，没有判断项（只有最低收费）时整笔叫「交付」
export function blocks(p: Priced): { label: string; amount: number }[] {
  const expense = sum(p.lines, ['expense'])
  const work = p.floor - expense
  const scale = work > 0 ? (p.quote - expense) / work : 0
  const pad = Math.round(sum(p.lines, ['pad']) * scale)
  const result = Math.round(sum(p.lines, ['result']) * scale)
  const judged = BASIS_LABEL.map(([basis, label]) => ({
    label, amount: Math.round(p.lines.filter(l => l.kind === 'item' && l.basis === basis).reduce((a, l) => a + l.amount, 0) * scale),
  })).filter(b => b.amount > 0)
  const rest = p.quote - expense - pad - result - judged.reduce((a, b) => a + b.amount, 0)
  if (judged.length) judged.reduce((x, y) => (y.amount > x.amount ? y : x)).amount += rest
  const out = [
    ...(judged.length ? judged : [{ label: '交付', amount: rest }]),
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
  const out = ['', '【交付之后】', ...WARRANTY(days, sheet.brief.clientType).map(x => '· ' + x)]
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
    if (sheet.plans[0]) out.push(`  预计 ${sheet.plans[0].days} 天交付`)
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
    const plan = sheet.plans.find(x => x.name === t.name)
    if (plan) out.push(`  预计 ${plan.days} 天交付`)
  }
  out.push(...bonusLines(sheet), ...discountLines(sheet), ...afterLines(sheet, s.warrantyDays))
  const notIn = [...b.items.filter(i => i.priority === '不做').map(i => i.title), ...b.excluded]
  if (notIn.length) out.push('', '【不包含】', ...notIn.map(x => '· ' + x))
  out.push('', '清单以外的新想法，每一条单独报价，你决定要不要做')
  return out.join('\n')
}

const lineText = (l: QuoteLine): string => (l.kind === 'expense' || l.kind === 'min' ? `· ${l.label}  ${money(l.amount)}  ${l.why}` : `· ${l.label}  ${l.hours} 小时 × ${l.rate} = ${money(l.amount)}  ${l.why}`)

// AI 直接写好的条目都是 ¥0，合成一行；高档只列比上一档多的，不把同样的算式再抄一遍
function tierLines(p: Priced, previous: Priced | null): string[] {
  const shown = new Set(previous?.lines.map(l => l.label))
  const lines = p.lines.filter(l => !shown.has(l.label))
  const free = lines.filter(l => l.kind === 'item' && l.hours === 0)
  return [
    ...lines.filter(l => !free.includes(l)).map(lineText),
    ...(free.length ? [`· ${BASIS_TEXT['直接做']}，不收时间：${free.map(l => l.label).join('、')}`] : []),
  ]
}

export interface SelfGroup { label: string; amount: number; detail: string }
export interface SelfSummary {
  name: string
  price: number
  minPrice: number
  days: number | null
  others: { name: string; price: number }[]
  groups: SelfGroup[]
  alerts: string[]
}

// 自用版的第一屏：先给要报的价，再按「钱花在哪」归类；逐项算式收起，要核对时才看
export function selfSummary(sheet: Sheet): SelfSummary | null {
  const p = sheet.chosen, d = sheet.discount
  if (!p || !d) return null
  const items = p.lines.filter(l => l.kind === 'item')
  const groups: SelfGroup[] = (Object.keys(BASIS_TEXT) as Basis[]).map(b => {
    const ls = items.filter(l => l.basis === b)
    return { label: BASIS_TEXT[b], amount: ls.reduce((a, l) => a + l.amount, 0), detail: ls.map(l => (l.hours > 0 ? `${l.label} ${hoursLabel(l.hours)}` : l.label)).join('、') }
  }).filter(g => g.detail).sort((x, y) => y.amount - x.amount)
  const others: [QuoteLine['kind'], string][] = [['pad', '没说清的部分留的余量'], ['result', '交付后修改'], ['expense', '实际支出'], ['min', '最低收费']]
  for (const [kind, label] of others) {
    const ls = p.lines.filter(l => l.kind === kind)
    if (ls.length) groups.push({ label, amount: ls.reduce((a, l) => a + l.amount, 0), detail: kind === 'expense' ? ls.map(l => l.label).join('、') : '' })
  }
  const gap = p.quote - p.lines.reduce((a, l) => a + l.amount, 0)
  if (gap > 0) groups.push({ label: '留给客户还价', amount: gap, detail: `最低可以让到 ${money(p.minPrice)}` })
  if (gap < 0) groups.push({ label: '实际报价比粗算少', amount: gap, detail: '' })
  if (d.amount && !sheet.bonus) groups.push({ label: '人情折让', amount: -d.amount, detail: d.reason })
  const alerts: string[] = []
  if (sheet.zone.type === 'cut' || sheet.zone.type === 'impossible') alerts.push(...zoneText(sheet.zone, sheet.budget))
  const plan = planText(sheet).at(-1)
  if (plan?.includes(' 天') && plan.includes('晚 ')) alerts.push(plan)
  return {
    name: p.name, price: sheet.bonus ? p.quote : d.price, minPrice: p.minPrice,
    days: sheet.plans.find(x => x.name === p.name)?.days ?? null,
    others: sheet.tiers.filter(t => t.name !== p.name).map(t => ({ name: t.name, price: t.quote })),
    groups, alerts,
  }
}

function zoneText(z: Zone, budget: number | null): string[] {
  if (z.type === 'unknown') return budget == null ? ['预算：待问'] : []
  if (z.type === 'fits') return [`预算 ${money(z.budget)}：完整范围就能成交，底线 ${money(z.floor)}，可报 ${money(z.quote)}`]
  if (z.type === 'cut') return [`预算 ${money(z.budget)}：完整范围放不下，砍掉 ${z.cut.join('、')} 后底线 ${money(z.floor)}，可报 ${money(z.quote)}`]
  return [`预算 ${money(z.budget)}：只做必须的底线也要 ${money(z.floor)}，差 ${money(z.gap)}，这单在这个预算下不成立`]
}

const md = (date: string): string => { const [, m, d] = date.split('-').map(Number); return `${m} 月 ${d} 日` }

// 工期：各档总小时 ÷ 每天投入小时；有截止日就说清每一档来不来得及，不够时指出哪一档能赶上
export function planText(sheet: Sheet): string[] {
  if (!sheet.plans.length) return []
  const out = ['', `【工期】每天投入 ${sheet.quote.dailyHours} 小时，不含等客户回复的时间`]
  for (const p of sheet.plans) out.push(`· ${p.name === '变更' ? '这次变更' : p.name + '档'}  ${p.hours} 小时 ÷ ${sheet.quote.dailyHours} = ${p.days} 天，从今天开工最早 ${md(p.ready)}交付`)
  if (!sheet.deadline) return [...out, '截止日：待问']
  const from = sheet.deadlineFrom === '材料' ? `（材料里写的「${sheet.brief.deadline}」）` : ''
  const ok = sheet.plans.filter(p => p.slack != null && p.slack >= 0)
  const late = sheet.plans.filter(p => p.slack != null && p.slack < 0)
  if (!late.length) out.push(`截止 ${md(sheet.deadline)}${from}：${sheet.plans.length > 1 ? '每一档都来得及，最紧的一档' : '来得及，'}余 ${Math.min(...sheet.plans.map(p => p.slack!))} 天`)
  else if (ok.length) out.push(`截止 ${md(sheet.deadline)}${from}：${late.map(p => `${p.name}档晚 ${-p.slack!} 天`).join('、')}；${ok[ok.length - 1].name}档来得及，余 ${ok[ok.length - 1].slack} 天，可以只做到这一档，或和客户商量延期`)
  else out.push(`截止 ${md(sheet.deadline)}${from}：${late.map(p => `${p.name === '变更' ? '这次变更' : p.name + '档'}晚 ${-p.slack!} 天`).join('、')}，来不及；砍范围或和客户商量延期`)
  return out
}

export function selfText(sheet: Sheet, calib: Calibration | null = null): string {
  const out = [marketLine(sheet.brief, calib?.market), `${sheet.title} 自用 · 第 ${sheet.n} 版 · ${sheet.quote.status}`]
  const ref = calib?.budgets[sheet.brief.clientType]
  if (ref) out.push(`同类客户（${sheet.brief.clientType}）嫌贵时说过的预算：中位数 ${money(ref.median)}（${ref.count} 单）`)
  const priced: (Priced & { name: string })[] = sheet.change ? (sheet.chosen ? [sheet.chosen] : []) : sheet.tiers
  priced.forEach((p, i) => {
    out.push('', `【${p.name === '变更' ? `变更单（基于第 ${sheet.base!.n} 版）` : p.name + '档'}】底线 ${money(p.floor)} · 报价 ${money(p.quote)} · 最低可收 ${money(p.minPrice)}`)
    if (i > 0) out.push(`比${priced[i - 1].name}档多：`)
    out.push(...tierLines(p, priced[i - 1] ?? null))
  })
  if (sheet.change?.removed.length) out.push('', '【这一版去掉的】已成交的部分，客户不提就不退', ...sheet.change.removed.map(x => '· ' + x))
  out.push(...planText(sheet))
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
  market?: MarketStat[]
}

// ── 同类行情 ──
// 估价的依据是真实成交，不是公式。样本只有类型、价格和结果，不含任何客户材料；学生单、个人单、商单绝不混算。
// 凑够 3 单才显示；目前只有开发者一个人用，不设人数门槛
export const CALIBRATION_PROJECTS = 50
const MIN_SAMPLES = 3
export const MARKET_MIN_DEALS = 3
export const MARKET_WINDOW_MS = 365 * 86_400_000

export interface Sample { clientType: ClientType; category: Category; result: '成交' | '嫌贵' | '没回音'; price: number; budget: number | null }
export interface SampleRow extends Sample { contributor: string }
export interface MarketStat { clientType: ClientType; category: Category; count: number; low: number; high: number }

// 只有成交和被客户拒绝才是市场信号；草稿、待定、我没接、变更单、不愿贡献的都不算
export function sampleOf(versions: SheetVersion[], n: number): Sample | null {
  const sheet = buildSheet('', versions, n)
  const q = sheet.quote
  if (!q.share || sheet.base || !sheet.discount || sheet.brief.clientType === '待确认') return null
  const paid = q.status === '已成交' ? received(sheet) ?? sheet.discount.price : sheet.discount.price
  const result = q.status === '已成交' ? '成交' : q.status === '已报价' && q.outcome === '嫌贵' ? '嫌贵' : q.status === '已报价' && q.outcome === '没回音' ? '没回音' : null
  if (!result || paid <= 0) return null
  return { clientType: sheet.brief.clientType, category: sheet.brief.category ?? '其他', result, price: paid, budget: result === '嫌贵' ? q.clientBudget : null }
}

export function marketStats(rows: SampleRow[]): MarketStat[] {
  const groups = new Map<string, SampleRow[]>()
  for (const r of rows) if (r.result === '成交') groups.set(`${r.clientType}/${r.category}`, [...(groups.get(`${r.clientType}/${r.category}`) ?? []), r])
  const out: MarketStat[] = []
  for (const g of groups.values()) {
    if (g.length < MARKET_MIN_DEALS) continue
    const p = g.map(r => r.price).sort((a, b) => a - b)
    out.push({ clientType: g[0].clientType, category: g[0].category, count: g.length, low: p[Math.floor((p.length - 1) * 0.25)], high: p[Math.ceil((p.length - 1) * 0.75)] })
  }
  return out
}

export function marketLine(b: Brief, market: MarketStat[] | undefined): string {
  const m = market?.find(x => x.clientType === b.clientType && x.category === (b.category ?? '其他'))
  const what = `${b.category ?? '其他'} · ${b.clientType}`
  return m ? `${what}：近一年 ${m.count} 单成交，多数在 ¥${m.low.toLocaleString('zh-CN')} ～ ¥${m.high.toLocaleString('zh-CN')}` : `${what}：同类成交还不够，下面是粗算，不代表行情`
}

export interface Calibrations { byType: Record<ClientType, Calibration>; market?: MarketStat[] }
export const latestType = (versions: { n: number; brief: Brief }[]): ClientType => [...versions].sort((a, b) => b.n - a.n)[0]?.brief.clientType ?? '待确认'

// 商单、学生单、个人单的价钱和感受不能互相影响，一个项目按最新版本的客户类型归入一组
export function calibrateByType(projects: { title: string; versions: SheetVersion[]; maintenance?: Maintenance }[]): Record<ClientType, Calibration> {
  return Object.fromEntries(CLIENT_TYPES.map(t => [t, calibrate(projects.filter(p => latestType(p.versions) === t))])) as Record<ClientType, Calibration>
}
export const calibFor = (c: Calibrations, type: ClientType): Calibration => ({ ...c.byType[type], market: c.market })

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
  lines.filter(l => l.work === k && kinds.includes(l.kind)).reduce((a, l) => a + (l.kind === 'item' && !l.manual ? l.hours / f : l.hours), 0)

interface ItemFact { category: string; title: string; basis: Basis; ai: number; final: number }
interface ProjectFacts { source: '实际' | '调整'; items: ItemFact[] }
type LearnProject = { title: string; versions: SheetVersion[]; maintenance?: Maintenance }

const byRecent = <T extends LearnProject>(projects: T[]): T[] => [...projects].sort((a, b) => Math.max(0, ...b.versions.map(v => v.at)) - Math.max(0, ...a.versions.map(v => v.at)))

// 一个项目每条需求「AI 当时估的」和「最后的小时」。实际小时只分新做 / 接手改，按保存时的小时比例摊到每条；变更单只算差额，不拿来比
function projectFacts(p: LearnProject, base: QuoteSettings): ProjectFacts | null {
  const desc = [...p.versions].sort((a, b) => b.n - a.n)
  const sheetOf = (v: SheetVersion): Sheet => buildSheet(p.title, p.versions, v.n, base)
  const done = desc.find(v => v.quote.status === '已成交' && WORK_KINDS.some(k => v.quote.actual[k] > 0) && !sheetOf(v).base)
  const v = done ?? desc.find(x => x.quote.status !== '草稿' || x.quote.hourScale !== 1 || Object.keys(x.quote.hourEdits).length > 0)
  if (!v) return null
  const s = settingsFor(v.quote, base)
  const chosen = done ? sheetOf(done).chosen as Tier | null : null
  const kept = adjustBrief(v.brief, v.quote, s).items.filter(i => i.priority !== '不做' && (!chosen?.itemIds || chosen.itemIds.includes(i.id)))
  const shown = (i: BriefItem): number => (i.manual ? i.hours : i.hours * factorOf(i, s))
  const items = kept.map(i => {
    const total = kept.filter(x => workOf(x) === workOf(i)).reduce((a, x) => a + shown(x), 0)
    const actual = done ? v.quote.actual[workOf(i)] : 0
    const raw = v.brief.items.find(x => x.id === i.id)!
    return { category: v.brief.category ?? '其他', title: i.title, basis: basisOf(raw), ai: raw.hours, final: half(actual > 0 && total > 0 ? shown(i) * actual / total : shown(i)) }
  })
  return { source: done ? '实际' : '调整', items }
}

// 给 AI 看的经验：改动过的条目最有用，放前面；同类单子最近的优先。AI 看到后自己判断哪些相似
export const EXPERIENCE_LIMIT = 30
function experienceRows(projects: LearnProject[], base: QuoteSettings): (ItemFact & { source: ProjectFacts['source'] })[] {
  const rows = byRecent(projects).slice(0, CALIBRATION_PROJECTS).flatMap(p => { const f = projectFacts(p, base); return f ? f.items.map(i => ({ ...i, source: f.source })) : [] })
  return [...rows.filter(r => r.final !== r.ai), ...rows.filter(r => r.final === r.ai && r.ai > 0)]
}

export function experienceLines(projects: LearnProject[], type: ClientType, limit = EXPERIENCE_LIMIT): string[] {
  return experienceRows(projects.filter(p => latestType(p.versions) === type), DEFAULT_QUOTE_SETTINGS).slice(0, limit).map(r => `${r.category}｜${r.title.slice(0, 40)}｜${BASIS_TEXT[r.basis]}：${r.ai} 小时 → ${r.final} 小时（${r.source}）`)
}

// 能不能验证「越用越准」：AI 估的和做完的差多少，报出去的单成交了多少
function accuracyNotes(projects: LearnProject[], base: QuoteSettings): string[] {
  const out: string[] = []
  const gaps = byRecent(projects).map(p => projectFacts(p, base)).filter(f => f?.source === '实际').slice(0, 10).map(f => {
    const ai = f!.items.reduce((a, i) => a + i.ai, 0), final = f!.items.reduce((a, i) => a + i.final, 0)
    return final > 0 ? Math.abs(ai - final) / final : null
  }).filter(g => g != null)
  if (gaps.length) out.push(`最近 ${gaps.length} 单，AI 估的小时和实际平均差 ${Math.round(gaps.reduce((a, g) => a + g, 0) / gaps.length * 100)}%`)
  let deals = 0, lost = 0
  for (const p of projects) {
    const v = [...p.versions].sort((a, b) => b.n - a.n).find(x => x.quote.status !== '草稿')
    if (v?.quote.status === '已成交') deals++
    else if (v?.quote.outcome === '嫌贵' || v?.quote.outcome === '没回音') lost++
  }
  if (deals + lost) out.push(`有结果的 ${deals + lost} 单，成交 ${deals} 单（${Math.round(deals / (deals + lost) * 100)}%）`)
  // 只按「最近、改动过」挑，超出后可能漏掉最相似的条目；这时才值得考虑按相似度挑，到点自己提醒，不靠人记
  const rows = experienceRows(projects, base).length
  if (rows > EXPERIENCE_LIMIT) out.push(`历史记录 ${rows} 条，每次只能带 ${EXPERIENCE_LIMIT} 条给 AI，可能漏掉最相似的；如果上面的偏差不再缩小，就该按相似度挑了`)
  return out
}

export function calibrate(projects: { title: string; versions: SheetVersion[]; maintenance?: Maintenance }[], base: QuoteSettings = DEFAULT_QUOTE_SETTINGS): Calibration {
  // 只用最近动过的 50 个项目，老单子的行情和感受会自然退出；项目本身不删
  const recent = [...projects].sort((a, b) => Math.max(0, ...b.versions.map(v => v.at)) - Math.max(0, ...a.versions.map(v => v.at))).slice(0, CALIBRATION_PROJECTS)
  const lows = { 新做: [] as number[], 接手改: [] as number[] }, highs = { 新做: [] as number[], 接手改: [] as number[] }, exact = { 新做: [] as number[], 接手改: [] as number[] }
  const ratios = { 新做: [] as number[], 接手改: [] as number[] }
  const rejects = { 新做: [] as number[], 接手改: [] as number[] }
  const budgets: Partial<Record<ClientType, number[]>> = {}
  // 月维护：月费扣掉支出 ÷ 当月实际小时，维护的是自己的代码，算进新做
  for (const p of recent) {
    const m = p.maintenance
    if (!m || m.fee <= 0) continue
    const net = m.fee - m.expenses.reduce((a, e) => a + e.amount, 0)
    for (const r of m.months) {
      if (r.hours <= 0 || r.feeling === '待定') continue
      ;(r.feeling === '亏' ? lows : r.feeling === '值' ? highs : exact)['新做'].push(net / r.hours)
    }
  }
  for (const p of recent) {
  const measured = new Set<WorkKind>()
  for (const v of p.versions) {
    const q = v.quote
    if (q.status === '已报价' && q.outcome === '嫌贵' && q.clientBudget) (budgets[v.brief.clientType] ??= []).push(q.clientBudget)
    const worth = q.status === '已成交' && q.feeling !== '待定'
    const refused = q.status === '已报价' && q.outcome === '我没接'
    const timed = q.status === '已成交' && WORK_KINDS.some(k => q.actual[k] > 0)
    const rejected = q.status === '已报价' && q.outcome === '嫌贵'
    if (!worth && !refused && !timed && !rejected) continue
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
      // 小时系数校准的是 AI 的预估，分母一律用 AI 原始小时，开发者拖过也不影响
      const aiEstimate = lines.filter(l => l.work === k && l.kind === 'item').reduce((a, l) => a + (v.brief.items.find(i => i.id === l.itemId)?.hours ?? 0), 0) + hoursBy(lines, k, 1, ['result'])
      if (q.status === '已成交' && actual > 0 && aiEstimate > 0) { ratios[k].push(actual / aiEstimate); measured.add(k) }
      const paid = received(sheet)
      if (worth && actual > 0 && paid != null) {
        const rate = (paid - expense) * share[k] / actual
        ;(q.feeling === '亏' ? lows : q.feeling === '值' ? highs : exact)[k].push(rate)
      }
      // 自己不想接：按报价和预计小时（含兜底）折出的每小时都不够，时间值高于它
      const planned = hoursBy(lines, k, 1, ['item', 'pad', 'result'])
      if (refused && planned > 0) lows[k].push((sheet.chosen.quote - expense) * share[k] / planned)
      // 客户嫌贵：说了预算按预算折，没说按报价折，都是「这个每小时客户不接受」
      const asked = q.clientBudget ?? sheet.chosen.quote
      if (rejected && planned > 0 && asked > expense) rejects[k].push((asked - expense) * share[k] / planned)
    }
  }
  // 每个项目一个样本：实际小时最可信；没有实际小时时，用最新一个你表过态的版本：拖过并保存，或没拖就报出去了。
  // 没拖的条目也算认可当时显示的小时；只生成没处理的草稿不算。库里只存最后一次保存的值，反复拖不会多算
  const edited = [...p.versions].sort((a, b) => b.n - a.n).find(v => v.quote.status !== '草稿' || v.quote.hourScale !== 1 || Object.keys(v.quote.hourEdits).length > 0)
  if (edited) {
    const after = adjustBrief(edited.brief, edited.quote, settingsFor(edited.quote, base)).items
    for (const k of WORK_KINDS) {
      if (measured.has(k)) continue
      const kept = after.filter(i => workOf(i) === k && i.priority !== '不做')
      const ai = kept.reduce((a, i) => a + (edited.brief.items.find(x => x.id === i.id)?.hours ?? 0), 0)
      const shown = kept.reduce((a, i) => a + (i.manual ? i.hours : i.hours * settingsFor(edited.quote, base).hourFactor[k]), 0)
      if (ai > 0) ratios[k].push(shown / ai)
    }
  }
  }
  const notes: string[] = []
  const rates = { ...base.rates }, hourFactor = { ...base.hourFactor }
  for (const k of WORK_KINDS) {
    // 取中位数：一单极端的亏或值不能决定之后所有报价
    const lo = lows[k].length ? median(lows[k]) : null, hi = highs[k].length ? median(highs[k]) : null
    let rate = base.rates[k]
    const origin = '来自一单真实成交'
    let why = origin
    if (exact[k].length) {
      rate = median(exact[k])
      if (lo != null) rate = Math.max(rate, lo)
      if (hi != null) rate = Math.min(rate, hi)
      why = `做完觉得刚好的 ${exact[k].length} 单中位数`
    } else if (lo != null && hi != null) {
      rate = (lo + hi) / 2
      why = lo <= hi ? `亏的中位数 ${Math.round(lo)} 与值的中位数 ${Math.round(hi)} 之间` : `亏的中位数 ${Math.round(lo)} 反而高于值的中位数 ${Math.round(hi)}，前后感受矛盾，暂取中间`
    } else if (lo != null) {
      rate = Math.max(rate, lo)
      why = rate === lo ? `亏了或不想接的单每小时中位数 ${Math.round(lo)}，时间值至少到这` : `${origin}，亏了或不想接的单都低于它`
    } else if (hi != null) {
      rate = Math.min(rate, hi)
      why = rate === hi ? `做完觉得值的单每小时中位数 ${Math.round(hi)}，时间值不高于它` : `${origin}，觉得值的单都高于它`
    }
    // 客户拒绝攒够样本才压价，一个砍价的客户不算行情。和「亏」冲突时取中间：两边都不满意，说明这类单子的价本来就谈不拢
    if (rejects[k].length >= MIN_SAMPLES) {
      const cap = median(rejects[k])
      if (rate > cap) {
        rate = lo != null && lo > cap ? (lo + cap) / 2 : cap
        why = lo != null && lo > cap ? `你觉得亏的 ${Math.round(lo)} 高于客户能接受的 ${Math.round(cap)}，暂取中间，这类单子两边都难满意` : `${rejects[k].length} 单客户嫌贵，他们能接受的每小时中位数 ${Math.round(cap)}，时间值压到这`
      }
    }
    rates[k] = Math.max(1, Math.round(rate))
    const count = lows[k].length + highs[k].length + exact[k].length
    notes.push(`${k}时间值 ${rates[k]}：${why}${count ? `（依据 ${count} 单）` : ''}`)
    if (ratios[k].length && ratios[k].length < MIN_SAMPLES) notes.push(`${k}小时系数还没生效：已有 ${ratios[k].length} 单，攒够 ${MIN_SAMPLES} 单才调整`)
    if (ratios[k].length >= MIN_SAMPLES) {
      hourFactor[k] = Math.min(10, Math.max(0.1, Math.round(median(ratios[k]) * 20) / 20))
      notes.push(`${k}小时 × ${hourFactor[k]}：过去 ${ratios[k].length} 单实际或你保存的小时 ÷ AI 预估的中位数`)
    }
  }
  const basisRatios: Partial<Record<Basis, number[]>> = {}
  for (const p of recent) {
    const facts = projectFacts(p, base)
    for (const b of BASES) {
      const items = facts?.items.filter(i => i.basis === b && i.ai > 0) ?? []
      if (items.length) (basisRatios[b] ??= []).push(items.reduce((a, i) => a + i.final, 0) / items.reduce((a, i) => a + i.ai, 0))
    }
  }
  const basisFactor: QuoteSettings['basisFactor'] = {}
  for (const [b, xs] of Object.entries(basisRatios) as [Basis, number[]][]) {
    if (xs.length < MIN_SAMPLES) continue
    basisFactor[b] = Math.min(10, Math.max(0.1, Math.round(median(xs) * 20) / 20))
    if (basisFactor[b] !== 1) notes.push(`「${BASIS_TEXT[b]}」小时 × ${basisFactor[b]}：过去 ${xs.length} 单的中位数`)
  }
  notes.unshift(...accuracyNotes(recent, base))
  const refs: Calibration['budgets'] = {}
  for (const [t, xs] of Object.entries(budgets) as [ClientType, number[]][]) refs[t] = { median: Math.round(median(xs)), count: xs.length }
  return { settings: { ...base, rates, hourFactor, basisFactor }, notes, budgets: refs }
}
