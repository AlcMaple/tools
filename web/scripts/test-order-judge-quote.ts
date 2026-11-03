import assert from 'node:assert/strict'
import type { Brief, BriefItem } from '../shared/order-judge-brief'
import { applyDiscount, changeOrder, parseBudget, tiers, zone, type QuoteExtras } from '../shared/order-judge-quote'

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

console.log(`\n${checks} 项全部通过`)
