import assert from 'node:assert/strict'
import type { Brief, BriefItem } from '../shared/order-judge-brief'
import { DEFAULT_QUOTE_SETTINGS, applyDiscount, changeOrder, parseBudget, tiers, zone, type QuoteExtras } from '../shared/order-judge-quote'
import { EMPTY_QUOTE, buildSheet, calibrate, freeze, normalizeQuote, selfText, type QuoteState } from '../shared/order-judge-sheet'

let checks = 0
const pass = (label: string): void => { console.log(`PASS Q${++checks}: ${label}`) }

const item = (id: string, priority: BriefItem['priority'], hours: number, extra: Partial<BriefItem> = {}): BriefItem =>
  ({ id, title: `条目${id}`, detail: '', priority, kind: '新做', hours, reason: '理由', unclear: '', ...extra })
const brief = (items: BriefItem[]): Brief =>
  ({ title: '测试', clientType: '学生单', outcome: '', budget: '', deadline: '', alternative: '', items, excluded: [], questions: [] })
const none: QuoteExtras = { expenses: [], resultHours: 0 }

const b = brief([
  item('r1', '必须', 10),
  item('r2', '必须', 4, { kind: '接手改' }),
  item('r3', '应该', 6, { unclear: '要不要导出 Excel' }),
  item('r4', '可以', 8),
  item('r5', '不做', 20),
])

const ts = tiers(b, { expenses: [{ name: '域名', amount: 60 }], resultHours: 2 })
assert.deepEqual(ts.map(t => t.name), ['基础', '推荐', '完整'])
// 基础：10×31 + 4×267 + 2×31 + 60 = 310 + 1068 + 62 + 60 = 1500
assert.equal(ts[0].floor, 1500)
// 报价 = 1500 ÷ 0.8 = 1875，向上取到 10 元
assert.equal(ts[0].quote, 1880)
assert.equal(ts[0].minPrice, 1504)
pass('基础档底线逐行相加，报价 = 底线 ÷ 0.8 取整到 10 元')

// 推荐：基础 + 6×31=186 + 兜底 3×31=93
assert.equal(ts[1].floor, 1500 + 186 + 93)
const pad = ts[1].lines.find(l => l.kind === 'pad')!
assert.match(pad.why, /要不要导出 Excel/)
assert.equal(ts[1].lines.filter(l => l.kind === 'pad').length, 1)
pass('只有未说清的条目加兜底，写明是哪一点')

assert.equal(ts[2].floor, 1500 + 186 + 93 + 248)
assert.deepEqual(ts[2].excluded, ['条目r5'])
assert(ts.every(t => !t.itemIds.includes('r5')))
pass('完整档含「可以」，「不做」永远不计价并列入不包含')

assert.deepEqual(tiers(brief([item('r1', '必须', 10)]), none).map(t => t.name), ['基础'])
pass('三档条目相同时只保留一档')

assert.equal(parseBudget('3000左右'), 3000)
assert.equal(parseBudget('预算 2k-5k'), 5000)
assert.equal(parseBudget('1.5万'), 15000)
assert.equal(parseBudget('3千'), 3000)
assert.equal(parseBudget('不多'), null)
pass('预算按上限读数，读不出的交给人填')

// 不带附加项时：基础 1378，推荐 1657，完整 1905
const z1 = zone(b, none, 2000)
assert(z1.type === 'fits' && z1.floor === 1905 && z1.quote === 2000)
pass('预算够完整范围时不砍，报价不超过预算也不低于底线')

const z2 = zone(b, none, 1700)
assert(z2.type === 'cut' && z2.floor === 1657 && z2.quote === 1700)
assert(z2.type === 'cut' && z2.cut.join() === '条目r4')
pass('预算不够时先砍「可以」，不降价')

const z4 = zone(brief([item('r1', '必须', 10), item('r2', '应该', 20), item('r3', '应该', 2)]), none, 400)
assert(z4.type === 'cut' && z4.cut.join() === '条目r2' && z4.kept.includes('条目r3'))
pass('同级先砍贵的，砍够后放得下的补回来')

const z3 = zone(b, none, 500)
assert(z3.type === 'impossible' && z3.floor === 1378 && z3.gap === 878)
pass('只剩「必须」也超预算时判定这单在这个预算下不成立')

assert.equal(zone(b, none, null).type, 'unknown')

const d = applyDiscount(ts[0], { ratio: 0.5, reason: '同学' })
assert.equal(d.ratio, 0.2)
assert.equal(d.price, 1504)
assert(d.price >= ts[0].floor)
assert.equal(d.amount, 1880 - 1504)
pass('人情折让最多 2 成，折完不低于底线')

const after = brief([
  item('r1', '必须', 10),
  item('r2', '应该', 4, { kind: '接手改' }),
  item('r3', '应该', 9, { unclear: '要不要导出 Excel' }),
  item('r4', '可以', 8, { detail: '改成按周统计' }),
  item('r6', '必须', 5),
])
const co = changeOrder(b, after, none)
const charged = co.lines.filter(l => l.kind === 'item')
assert.deepEqual(charged.map(l => [l.itemId, l.hours]), [['r3', 3], ['r4', 8], ['r6', 5]])
assert.equal(co.lines.filter(l => l.kind === 'pad').length, 1)
assert.equal(co.lines.find(l => l.kind === 'pad')!.hours, 1.5)
assert.deepEqual(co.removed, ['条目r5'])
assert.equal(co.floor, 3 * 31 + 8 * 31 + 5 * 31 + Math.round(1.5 * 31))
pass('变更单只算新增和改动：只改优先级不收，只加小时收差额，内容改了整条重算')

// ── 回填与校准 ──
// 单子：必须 10 小时新做 → 底线 310，报价 390；主推档只有基础
const one = brief([item('r1', '必须', 10)])
const v = (quote: Partial<QuoteState>, b: Brief = one) => ({ n: 1, at: 0, brief: b, quote: { ...EMPTY_QUOTE, ...quote } })
const proj = (quote: Partial<QuoteState>, b?: Brief) => ({ title: 'p', versions: [v(quote, b)] })

assert.deepEqual(calibrate([]).settings, DEFAULT_QUOTE_SETTINGS)
assert.match(calibrate([]).notes.join(), /新做时间值 31：来自答题/)
pass('没有回填时时间值就是答题结果')

// 成交 390，实际 20 小时，觉得亏 → 每小时 19.5 < 31，不动；实际 20 ÷ 预估 10 → 小时 × 2
const c1 = calibrate([proj({ status: '已成交', actual: { 新做: 20, 接手改: 0 }, feeling: '亏' })])
assert.equal(c1.settings.rates['新做'], 31)
assert.equal(c1.settings.hourFactor['新做'], 2)
assert.equal(c1.settings.hourFactor['接手改'], 1)
pass('实际小时只修小时系数：实际 ÷ 预估取中位数，亏但每小时低于现值时不动时间值')

// 成交 390，实际 5 小时，觉得亏 → 每小时 78 → 时间值至少 78
const c2 = calibrate([proj({ status: '已成交', actual: { 新做: 5, 接手改: 0 }, feeling: '亏' })])
assert.equal(c2.settings.rates['新做'], 78)
assert.match(c2.notes.join(), /时间值至少到这/)
pass('做完觉得亏：时间值抬到亏的那单每小时价格')

// 亏 78 + 值 130（3 小时）→ 取中间 104
const c3 = calibrate([proj({ status: '已成交', actual: { 新做: 5, 接手改: 0 }, feeling: '亏' }), proj({ status: '已成交', actual: { 新做: 3, 接手改: 0 }, feeling: '值' })])
assert.equal(c3.settings.rates['新做'], 104)
pass('有亏有值：时间值取亏的最高和值的最低中间')

// 我没接：报价 390 ÷ 10 小时 = 39 → 时间值至少 39；人情折让和实际小时都不参与
const c4 = calibrate([proj({ status: '已报价', outcome: '我没接' })])
assert.equal(c4.settings.rates['新做'], 39)
pass('自己不想接的单也是依据：时间值高于它的每小时报价')

const c5 = calibrate([proj({ status: '已报价', outcome: '嫌贵', clientBudget: 200 }), proj({ status: '已报价', outcome: '嫌贵', clientBudget: 600 })])
assert.deepEqual(c5.settings, DEFAULT_QUOTE_SETTINGS)
assert.deepEqual(c5.budgets['学生单'], { median: 400, count: 2 })
pass('客户嫌贵只记预算参考，不动时间值')

// 冻结：报出去之后再校准，那一版的价不变
const quoted = freeze(normalizeQuote({ status: '已报价' }), DEFAULT_QUOTE_SETTINGS)
assert.deepEqual(quoted.frozen?.rates, { 新做: 31, 接手改: 267 })
const later = buildSheet('p', [v(quoted)], 1, c2.settings)
assert.equal(later.chosen!.floor, 310)
// 草稿用校准后的：小时 × 0.5（实际 5 ÷ 预估 10）、时间值 78 → 5 × 78
assert.equal(buildSheet('p', [v(EMPTY_QUOTE)], 1, c2.settings).chosen!.floor, 390)
assert.equal(freeze({ ...quoted, status: '草稿' }, DEFAULT_QUOTE_SETTINGS).frozen, null)
assert.match(selfText(later, c2), /按报出去那一刻的/)
pass('离开草稿时冻结当时的时间值，之后校准只影响草稿')

// 小时系数作用在 AI 估的小时上，并写明
const scaled = buildSheet('p', [v(EMPTY_QUOTE)], 1, c1.settings)
assert.equal(scaled.chosen!.lines[0].hours, 20)
assert.match(scaled.chosen!.lines[0].why, /AI 估 10 小时，按你过去的实际 × 2/)
assert.deepEqual(normalizeQuote(JSON.parse(JSON.stringify(quoted))), quoted)
pass('小时系数乘在 AI 预估上并写明来源，回填数据存取不走样')

console.log(`\n${checks} 项全部通过`)
