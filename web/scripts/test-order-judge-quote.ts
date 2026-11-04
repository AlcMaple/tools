import assert from 'node:assert/strict'
import { briefSystemPrompt, normalizeBrief, type Brief, type BriefItem } from '../shared/order-judge-brief'
import { DEFAULT_QUOTE_SETTINGS, applyDiscount, changeOrder, parseBudget, parseDeadline, tiers, zone, type QuoteExtras } from '../shared/order-judge-quote'
import { EMPTY_MAINTENANCE, maintenanceClientText, maintenanceSelfText, normalizeMaintenance, suggestFee, type Maintenance } from '../shared/order-judge-maintenance'
import { EMPTY_BONUS, EMPTY_QUOTE, buildSheet, calibrate, calibrateByType, experienceLines, carryHourEdits, clientText, freeze, hourRows, hoursLabel, marketLine, marketStats, normalizeQuote, sampleOf, selfText, type QuoteState } from '../shared/order-judge-sheet'

assert.deepEqual(DEFAULT_QUOTE_SETTINGS.rates, { 新做: 67, 接手改: 67 })
// 下面的算式用两档不同的时间值，才测得出新做 / 接手改有没有算混；线上起点是上面这一行
Object.assign(DEFAULT_QUOTE_SETTINGS.rates, { 新做: 31, 接手改: 267 })

let checks = 0
const pass = (label: string): void => { console.log(`PASS Q${++checks}: ${label}`) }

const item = (id: string, priority: BriefItem['priority'], hours: number, extra: Partial<BriefItem> = {}): BriefItem =>
  ({ id, title: `条目${id}`, detail: '', priority, kind: '新做', hours, reason: '理由', unclear: '', ...extra })
const brief = (items: BriefItem[]): Brief =>
  ({ title: '测试', clientType: '商单', outcome: '', budget: '', deadline: '', items, excluded: [], questions: [] })
const basisOfNormalized = (b: Brief): string | undefined => normalizeBrief({ items: b.items }, null).items[0].basis
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
assert.match(calibrate([]).notes.join(), /新做时间值 31：来自一单真实成交/)
pass('没有回填时时间值就是答题结果')

// 成交 390，实际 20 小时，觉得亏 → 每小时 19.5 < 31，不动；实际 20 ÷ 预估 10 → 小时 × 2
const c1one = proj({ status: '已成交', actual: { 新做: 20, 接手改: 0 }, feeling: '亏' })
assert.equal(calibrate([c1one, c1one]).settings.hourFactor['新做'], 1)
assert.match(calibrate([c1one, c1one]).notes.join(), /已有 2 单，攒够 3 单才调整/)
const c1 = calibrate([c1one, c1one, c1one])
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
assert.deepEqual(c5.budgets['商单'], { median: 400, count: 2 })
pass('客户嫌贵不满 3 单只记预算，不动时间值')

const reject = (clientBudget: number | null) => proj({ status: '已报价', outcome: '嫌贵', clientBudget })
assert.equal(calibrate([reject(200), reject(200), reject(250)]).settings.rates['新做'], 20)
assert.equal(calibrate([reject(290), reject(290), reject(290)]).settings.rates['新做'], 29)
const painful = proj({ status: '已成交', actual: { 新做: 5, 接手改: 0 }, feeling: '亏' })
const clash = calibrate([painful, reject(200), reject(200), reject(200)])
assert.equal(clash.settings.rates['新做'], 49)
assert.match(clash.notes.join(), /两边都难满意/)
pass('嫌贵满 3 单压低时间值，和亏冲突时取中间')

const extreme = proj({ status: '已成交', actual: { 新做: 1, 接手改: 0 }, feeling: '亏' })
assert.equal(calibrate([painful, painful, extreme]).settings.rates['新做'], 78)
pass('一单极端的亏不再决定时间值')

// 冻结：报出去之后再校准，那一版的价不变
const quoted = freeze(normalizeQuote({ status: '已报价' }), DEFAULT_QUOTE_SETTINGS)
assert.deepEqual(quoted.frozen?.rates, { 新做: 31, 接手改: 267 })
const later = buildSheet('p', [v(quoted)], 1, c2.settings)
assert.equal(later.chosen!.floor, 310)
// 草稿用校准后的时间值 78；小时系数不满 3 单不动 → 10 × 78
assert.equal(buildSheet('p', [v(EMPTY_QUOTE)], 1, c2.settings).chosen!.floor, 780)
assert.equal(freeze({ ...quoted, status: '草稿' }, DEFAULT_QUOTE_SETTINGS).frozen, null)
pass('离开草稿时冻结当时的时间值，之后校准只影响草稿')

// 小时系数作用在 AI 估的小时上，并写明
const scaled = buildSheet('p', [v(EMPTY_QUOTE)], 1, c1.settings)
assert.equal(scaled.chosen!.lines[0].hours, 20)
assert.match(scaled.chosen!.lines[0].why, /AI 估 10 小时，按你过去的实际 × 2/)
assert.deepEqual(normalizeQuote(JSON.parse(JSON.stringify(quoted))), quoted)
pass('小时系数乘在 AI 预估上并写明来源，回填数据存取不走样')

// ── 成效奖金 ──
// 底线 310、报价 390；把握 5 成 → 奖金 (390 − 310) ÷ 0.5 = 160，平均收 310 + 0.5 × 160 = 390
const shop = { ...one, clientType: '商单' as const }
const terms = { ...EMPTY_BONUS, on: true, metric: '下单转化率', baseline: '1.2%', target: '2%', verify: '后台 30 天订单数 ÷ 访客数', period: '上线后 3 个月', gain: 8000 }
const bs = buildSheet('p', [v({ bonus: terms }, shop)], 1)
assert.deepEqual(bs.bonus, { fixed: 310, amount: 160, confidence: 0.5, expected: 390 })
const bc = clientText(bs)
assert.match(bc, /先付 ¥310，交付时付清\n达标后再付 ¥160/)
assert.match(bc, /· 怎么算达标：后台 30 天订单数 ÷ 访客数/)
assert.match(bc, /没达标不付奖金，先付的部分不退/)
assert.match(selfText(bs), /奖金是客户达标后多赚 ¥8,000 的 2%/)
pass('成效奖金：先付 = 底线，奖金按把握倒推，平均收入等于原报价')

assert.equal(buildSheet('p', [v({ bonus: { ...terms, confidence: 0.9 } }, shop)], 1).bonus!.amount, 90)
assert.equal(buildSheet('p', [v({ bonus: terms }, { ...one, clientType: '学生单' })], 1).bonus, null)
assert.match(selfText(buildSheet('p', [v({ bonus: { ...terms, verify: '' } }, shop)], 1)), /条款还缺：怎么算达标/)
const withDiscount = buildSheet('p', [v({ bonus: terms, discount: { ratio: 0.2, reason: '老客户' } }, shop)], 1)
assert.doesNotMatch(clientText(withDiscount), /人情折让/)
pass('把握越高奖金越少；学生单不出成效方案；条款没写清会提醒；成效方案下人情折让不生效')

// 回填：奖金还没结果不拿来校准时间值；没达标按先付算（310 ÷ 2 小时 = 155，亏 → 时间值至少 155）
const pend = calibrate([proj({ status: '已成交', actual: { 新做: 2, 接手改: 0 }, feeling: '亏', bonus: terms }, shop)])
assert.equal(pend.settings.rates['新做'], 31)
const miss = calibrate([proj({ status: '已成交', actual: { 新做: 2, 接手改: 0 }, feeling: '亏', bonus: { ...terms, result: '没达标' } }, shop)])
assert.equal(miss.settings.rates['新做'], 155)
const hit = calibrate([proj({ status: '已成交', actual: { 新做: 2, 接手改: 0 }, feeling: '亏', bonus: { ...terms, result: '达标' } }, shop)])
assert.equal(hit.settings.rates['新做'], 235)
assert.deepEqual(normalizeQuote(JSON.parse(JSON.stringify({ ...EMPTY_QUOTE, bonus: terms }))).bonus, terms)
pass('校准按实际收到的钱：奖金待定不算，没达标只算先付，达标加上奖金')

// ── 月维护 ──
const maint = (m: Partial<Maintenance>): Maintenance => ({ ...EMPTY_MAINTENANCE, state: '在做', ...m })
const deal = v({ status: '已成交' })
// 成交后两张已成交变更单，实际 6、10 小时 → 中位数 8 → 8 × 31 + 域名 20 = 268
const changeA = { ...v({ status: '已成交', actual: { 新做: 6, 接手改: 0 } }, brief([item('r1', '必须', 10), item('r2', '必须', 5)])), n: 2 }
const changeB = { ...v({ status: '已成交', actual: { 新做: 4, 接手改: 6 } }, brief([item('r1', '必须', 10), item('r2', '必须', 5), item('r3', '必须', 3)])), n: 3 }
const mp = (id: string, versions: ReturnType<typeof v>[], m: Partial<Maintenance> = {}) => ({ id, title: id, versions, maintenance: maint(m) })
const domain = { expenses: [{ name: '域名', amount: 20 }] }
const s1 = suggestFee([mp('a', [deal, changeA, changeB], domain)], 'a')
assert.deepEqual([s1.hours, s1.fee], [8, 268])
assert.match(s1.source, /2 张变更单的实际小时中位数/)
pass('第一个月维护项目：建议月费按这个客户变更单的实际小时')

// 只有一份还没成交的变更：用 AI 预估 r2 = 5 小时
const draftChange = { ...v({}, brief([item('r1', '必须', 10), item('r2', '必须', 5)])), n: 2 }
assert.deepEqual(suggestFee([mp('a', [deal, draftChange])], 'a').hours, 5)
assert.equal(suggestFee([mp('a', [deal])], 'a').fee, null)
pass('没有变更单实际小时时用 AI 对大功能的预估，什么都没有就让你自己定')

// 别的维护项目记过 20、30、40 小时 → 下一个项目建议 30 × 31 = 930；自己项目的记录不算
const months = [20, 30, 40].map((hours, i) => ({ month: `2026-0${i + 1}`, delivered: '', hours, feeling: '待定' as const }))
const s3 = suggestFee([mp('old', [deal], { fee: 900, months }), mp('new', [deal, changeA], { months: [{ month: '2026-05', delivered: '', hours: 100, feeling: '待定' }] })], 'new')
assert.deepEqual([s3.hours, s3.fee], [30, 930])
assert.match(s3.source, /过去 3 个月维护记录/)
pass('有过月维护记录后，下一个项目按所有其他项目每月实际小时的中位数')

// 月费 900，某月 40 小时觉得亏 → 每小时 22.5 低于 31 不动；某月 10 小时觉得亏 → 90 → 新做时间值至少 90
const mc = (hours: number) => calibrate([{ title: 'm', versions: [], maintenance: maint({ fee: 900, months: [{ month: '2026-01', delivered: '', hours, feeling: '亏' }] }) }])
assert.equal(mc(40).settings.rates['新做'], 31)
assert.equal(mc(10).settings.rates['新做'], 90)
pass('月维护的亏 / 值也校准新做时间值：（月费 − 支出）÷ 当月小时')

const raw = normalizeMaintenance({ state: '在做', fee: '1200', start: '2026-13', months: [{ month: '2026-11', hours: 12.3, feeling: '值', delivered: '会员系统' }, { month: 'x' }] })
assert.deepEqual([raw.fee, raw.start, raw.months.length, raw.months[0].hours], [1200, '', 1, 12.5])
const ct = maintenanceClientText('商城', maint({ fee: 1200, start: '2026-11', ...domain }))
assert.match(ct, /每月 ¥1,200，从 2026 年 11 月 开始/)
assert.match(ct, /做不完的排到下个月，不另收钱/)
assert.match(ct, /付款，当天交付这个月的大功能/)
assert.match(ct, /随时可以停，停了以后再有需求按变更单另算/)
assert.doesNotMatch(ct, /小时/)
assert.match(maintenanceSelfText('商城', raw, s1), /2026 年 11 月  12\.5 小时，每小时 ¥96  值  交付：会员系统/)
pass('月维护的客户版不出现小时，自用版逐月列出每小时实际拿到多少')

// ── 不按写代码算时间：直接能做的功能 0 小时，只收最低收费 ──
const easy = brief([item('r1', '必须', 0), item('r2', '应该', 0), item('r3', '可以', 0)])
const easyTiers = tiers(easy, none)
assert.equal(easyTiers.length, 1)
assert.equal(easyTiers[0].quote, 50)
assert.equal(easyTiers[0].floor, 50)
assert.equal(easyTiers[0].itemIds.length, 3)
assert(easyTiers[0].lines.some(l => l.kind === 'min' && l.amount === 50))
assert.equal(applyDiscount(easyTiers[0], { ratio: 0.2, reason: '同学' }).price, 50)
pass('三个直接能做的功能只收最低收费 50，三档价格一样时只留范围最大的一档，折让不会把它压到 50 以下')

const easySelf = selfText(buildSheet('p', [v({}, easy)], 1))
assert.match(easySelf, /AI 直接写好，不收时间：条目r1/)
assert.match(easySelf, /· 最低收费  ¥50/)
pass('每个条目都列在自用版里，0 小时的写明不计时间')

// 学生单、个人单不加兜底：同样的条目，商单有兜底，学生单没有
const unclear = brief([item('r1', '必须', 2, { unclear: '字段没说' })])
assert.equal(tiers(unclear, none)[0].lines.filter(l => l.kind === 'pad').length, 1)
assert.equal(tiers({ ...unclear, clientType: '学生单' }, none)[0].lines.filter(l => l.kind === 'pad').length, 0)
assert.equal(tiers({ ...unclear, clientType: '个人单' }, none)[0].lines.filter(l => l.kind === 'pad').length, 0)
pass('兜底只给商单，学生单和个人单没有')

const student = { ...unclear, clientType: '学生单' as const }
assert.match(clientText(buildSheet('p', [v({}, student)], 1)), /保修，不另外收费/)
assert.match(clientText(buildSheet('p', [v({}, unclear)], 1)), /立刻响应，放下手头的事/)
pass('保修照给：学生单写明不另外收费，商单写明立刻响应')

// ── 截止日和工期 ──
assert.equal(parseDeadline('12 月 20 日', '2026-11-04'), '2026-12-20')
assert.equal(parseDeadline('1月5号', '2026-11-04'), '2027-01-05')
assert.equal(parseDeadline('2026-12-20', '2026-11-04'), '2026-12-20')
assert.equal(parseDeadline('明天', '2026-11-04'), '2026-11-05')
assert.equal(parseDeadline('后天交', '2026-11-04'), '2026-11-06')
assert.equal(parseDeadline('3 天内', '2026-11-04'), '2026-11-07')
assert.equal(parseDeadline('越快越好', '2026-11-04'), null)
assert.equal(parseDeadline('2 月 31 日', '2026-11-04'), null)
pass('截止日读成日期：月日、完整日期、今明后天、几天内；读不出来和不存在的日子返回空')

const timed = brief([item('r1', '必须', 8), item('r2', '应该', 8)])
const now = new Date(2026, 10, 4, 12)
const plan = (q: Partial<QuoteState>) => buildSheet('p', [{ n: 1, at: 0, brief: { ...timed, deadline: '12 月 20 日' }, quote: { ...EMPTY_QUOTE, dailyHours: 4, ...q } }], 1, DEFAULT_QUOTE_SETTINGS, now)
const roomy = plan({})
assert.deepEqual(roomy.plans.map(p => [p.name, p.days, p.ready, p.slack]), [['基础', 2, '2026-11-06', 44], ['推荐', 4, '2026-11-08', 42]])
assert.match(selfText(roomy), /基础档  8 小时 ÷ 4 = 2 天，从今天开工最早 11 月 6 日交付/)
assert.match(selfText(roomy), /截止 12 月 20 日（材料里写的「12 月 20 日」）：每一档都来得及，最紧的一档余 42 天/)
assert.match(clientText(roomy), /【推荐档】[\s\S]*预计 4 天交付/)
pass('工期：各档小时 ÷ 每天投入，从今天往后数，和截止日比出余量；客户版只写预计几天')

const tight = plan({ deadlineDate: '2026-11-07' })
assert.deepEqual(tight.plans.map(p => p.slack), [1, -1])
assert.match(selfText(tight), /推荐档晚 1 天；基础档来得及，余 1 天，可以只做到这一档，或和客户商量延期/)
const never = plan({ deadlineDate: '2026-11-04', dailyHours: 2 })
assert.match(selfText(never), /基础档晚 4 天、推荐档晚 8 天，来不及；砍范围或和客户商量延期/)
assert.equal(plan({}).deadlineFrom, '材料')
assert.equal(tight.deadlineFrom, '手填')
pass('截止日不够时指出哪一档能赶上，一档都赶不上就说来不及；手填的截止日优先于材料里的说法')

const norm = normalizeQuote({ deadlineDate: '2026-12-20', dailyHours: 0 })
assert.equal(norm.deadlineDate, '2026-12-20')
assert.equal(norm.dailyHours, 8)
assert.equal(normalizeQuote({ deadlineDate: '明天' }).deadlineDate, null)
pass('截止日只认 YYYY-MM-DD，每天投入为 0 时回到默认 8 小时')

// 滑块：单项值不吃校准系数，整体倍率只缩没拖过的；钱和工期一起变；成交时调定的小时不会被变更单重复收费
const dragged = brief([item('r1', '必须', 10, { basis: '确认' }), item('r2', '必须', 2, { basis: '上线' }), item('r3', '必须', 0, { basis: '直接做' })])
const calibrated = { ...DEFAULT_QUOTE_SETTINGS, hourFactor: { 新做: 2, 接手改: 1 } }
const dragSheet = (q: Partial<QuoteState>) => buildSheet('p', [{ n: 1, at: 0, brief: dragged, quote: { ...EMPTY_QUOTE, ...q } }], 1, calibrated)
assert.equal(dragSheet({}).chosen!.floor, 24 * 31)
assert.equal(dragSheet({ hourEdits: { r1: 4 } }).chosen!.floor, (4 + 4) * 31)
assert.equal(dragSheet({ hourScale: 0.5 }).chosen!.floor, 12 * 31)
assert.equal(dragSheet({ hourScale: 0.5, hourEdits: { r2: 8 } }).chosen!.floor, (10 + 8) * 31)
assert.equal(dragSheet({ hourEdits: { r3: 8 } }).plans[0].hours, 32)
pass('滑块改小时：单项不吃系数，整体只缩没拖过的，价格和工期跟着变')

const blocksText = clientText(dragSheet({}))
assert.match(blocksText, /上线保障 ¥\d+/)
assert.match(blocksText, /需求确认 ¥\d+/)
assert.doesNotMatch(blocksText, /小时|底线/)
const blockSum = [...blocksText.matchAll(/^  (?:上线保障|需求确认) ¥([\d,]+)$/gm)].reduce((a, m) => a + Number(m[1].replace(',', '')), 0)
assert.equal(blockSum, dragSheet({}).chosen!.quote)
pass('客户版按判断分项列价，分项加起来等于报价，不露小时')

const manyItems = brief([item('r1', '必须', 40), item('r2', '必须', 4), ...Array.from({ length: 20 }, (_, i) => item(`r${i + 3}`, '应该', 0))])
const rows = hourRows(manyItems, EMPTY_QUOTE, DEFAULT_QUOTE_SETTINGS)
assert.deepEqual(rows.filter(r => r.major).map(r => r.id), ['r1'])
const before = hourRows(manyItems, EMPTY_QUOTE, DEFAULT_QUOTE_SETTINGS)
const dragging = hourRows(manyItems, { ...EMPTY_QUOTE, hourEdits: { r2: 90, r9: 2 } }, DEFAULT_QUOTE_SETTINGS)
assert.deepEqual(dragging.map(r => [r.id, r.max, r.major]), before.map(r => [r.id, r.max, r.major]))
assert.equal(hoursLabel(0), '0 小时')
assert.equal(hoursLabel(4), '4 小时')
assert.equal(hoursLabel(12), '1 天 4 小时')
assert.equal(hoursLabel(16), '2 天')
pass('22 条需求只露出占钱 80% 的条目；拖动时行序、上限、收起都不变；8 小时起按整天加小时显示')

const dealt: QuoteState = { ...EMPTY_QUOTE, status: '已成交', hourEdits: { r1: 3 } }
const afterDeal = brief([item('r1', '必须', 10, { basis: '确认' }), item('r2', '必须', 2, { basis: '上线' }), item('r3', '必须', 0, { basis: '直接做' })])
const dealChange = buildSheet('p', [{ n: 1, at: 0, brief: dragged, quote: dealt }, { n: 2, at: 1, brief: afterDeal, quote: EMPTY_QUOTE }], 2)
assert.equal(dealChange.chosen, null)
pass('成交时把条目调低，下一版 AI 小时没变时变更单不收钱')

const carried = carryHourEdits({ ...EMPTY_QUOTE, hourEdits: { r1: 3, r2: 5 } }, dragged, brief([item('r1', '必须', 10), item('r2', '必须', 9)]))
assert.deepEqual(carried.hourEdits, { r1: 3 })
assert.deepEqual(normalizeQuote({ hourEdits: { r1: 3.3, bad: 1, r2: 999 }, hourScale: 9 }).hourEdits, { r1: 3.5, r2: 200 })
assert.equal(normalizeQuote({ hourScale: 9 }).hourScale, 1)
const zeroItem = brief([item('r1', '必须', 0, { basis: '验证' })])
assert.equal(basisOfNormalized(zeroItem), '直接做')
pass('追加版本只沿用没变条目的拖动值；非法值被挡；0 小时一律算直接做')

const savedCalib = (q: Partial<QuoteState>) => calibrate(Array.from({ length: 3 }, () => ({ title: 'p', versions: [{ n: 1, at: 0, brief: brief([item('r1', '必须', 10), item('r2', '必须', 10)]), quote: { ...EMPTY_QUOTE, ...q } }] }))).settings.hourFactor['新做']
assert.equal(savedCalib({ hourEdits: { r1: 20 } }), 1.5)
assert.equal(savedCalib({ status: '已报价' }), 1)
assert.equal(savedCalib({}), 1)
assert.equal(savedCalib({ hourScale: 0.5 }), 0.5)
assert.equal(savedCalib({ hourEdits: { r1: 20 }, status: '已成交', actual: { 新做: 30, 接手改: 0 } }), 1.5)
pass('校准用最后保存的小时，没拖的算认可，未处理的草稿不算；有实际小时时以实际为准')

// 三类单子：从 0 到 1 只收入场价，业务单几百块，价差来自验证可行性
const priceOf = (items: BriefItem[]): number => tiers(brief(items), none).at(-1)!.quote
const admin = priceOf(Array.from({ length: 12 }, (_, i) => item(`r${i + 1}`, '必须', 0, { basis: '直接做' })))
const business = priceOf([item('r1', '必须', 0, { basis: '直接做' }), item('r2', '必须', 3, { basis: '确认' }), item('r3', '必须', 3, { basis: '上线' })])
const hard = priceOf([item('r1', '必须', 16, { basis: '验证' }), item('r2', '必须', 16, { basis: '验证' }), item('r3', '必须', 16, { basis: '验证' }), item('r4', '必须', 4, { basis: '确认' })])
console.log({ admin, business, hard })
assert.equal(admin, 50)
assert(business >= 200 && business < 1000)
assert(hard > 10000)
pass('12 个直接能做的后台 ¥50，业务单几百，硬骨头过万')

const mVer = (q: Partial<QuoteState>, b: Brief = brief([item('r1', '必须', 2)])) => [{ n: 1, at: 0, brief: b, quote: { ...EMPTY_QUOTE, ...q } }]
const finalSheet = buildSheet('p', mVer({ finalPrice: 900 }), 1)
assert.equal(finalSheet.chosen!.quote, 900); assert.equal(finalSheet.tiers.length, 1)
assert.match(clientText(finalSheet), /¥900/)
pass('填了实际报价只报这一个价')

assert.equal(sampleOf(mVer({}), 1), null)
assert.equal(sampleOf(mVer({ status: '已报价' }), 1), null)
assert.equal(sampleOf(mVer({ status: '已成交', share: false }), 1), null)
assert.equal(sampleOf(mVer({ status: '已报价', outcome: '我没接' }), 1), null)
assert.deepEqual(sampleOf(mVer({ status: '已成交', finalPrice: 900 }), 1), { clientType: '商单', category: '其他', result: '成交', price: 900, budget: null })
assert.deepEqual(Object.keys(sampleOf(mVer({ status: '已报价', outcome: '嫌贵', clientBudget: 300 }), 1)!).sort(), ['budget', 'category', 'clientType', 'price', 'result'])
pass('只有成交和客户拒绝进样本，不贡献和草稿不进，样本不含客户文字')

const mDeal = (price: number, contributor: string, clientType: 'typeA' | '商单' = '商单') => ({ clientType, category: '网站', result: '成交', price, budget: null, contributor }) as never
assert.deepEqual(marketStats([mDeal(1, 'a'), mDeal(2, 'a')]), [])
assert.equal(marketStats([mDeal(1, 'a'), mDeal(2, 'a'), mDeal(3, 'a')]).length, 1)
const mStat = marketStats([100, 200, 300, 400, 500].map((p, i) => mDeal(p, String(i % 3))))
assert.deepEqual(mStat, [{ clientType: '商单', category: '网站', count: 5, low: 200, high: 400 }])
assert.match(marketLine({ ...brief([]), category: '网站' }, mStat), /5 单成交，多数在 ¥200 ～ ¥400/)
assert.match(marketLine({ ...brief([]), clientType: '学生单', category: '网站' }, mStat), /同类成交还不够/)
pass('行情要 3 单才显示，一个人的数据也算，学生单和商单不混')

const thesis = { ...brief([item('r1', '必须', 3, { basis: '接手', kind: '接手改' })]), clientType: '学生单' as const }
const atStart = { ...DEFAULT_QUOTE_SETTINGS, rates: { 新做: 67, 接手改: 67 } }
assert.equal(buildSheet('p', [v({}, thesis)], 1, atStart).chosen!.quote, 260)
assert.equal(buildSheet('p', [v({ frozen: { rates: { 新做: 31, 接手改: 267 }, hourFactor: { 新做: 1, 接手改: 1 }, basisFactor: {} } }, thesis)], 1, atStart).chosen!.floor, 801)
pass('论文单回测：3 小时报 ¥260；已冻结的报价不被改')

const dealOf = (type: '学生单' | '商单') => ({ title: 'p', versions: [{ n: 1, at: 0, brief: { ...brief([item('r1', '必须', 10)]), clientType: type }, quote: { ...EMPTY_QUOTE, status: '已成交' as const, actual: { 新做: 1, 接手改: 0 }, feeling: '亏' as const } }] })
const split = calibrateByType([dealOf('学生单'), dealOf('学生单'), dealOf('学生单')])
assert.ok(split.学生单.settings.rates['新做'] > 31)
assert.equal(split.商单.settings.rates['新做'], 31)
assert.equal(split.个人单.settings.rates['新做'], 31)
pass('校准按客户类型分开：学生单的亏不影响商单和个人单')

const near = tiers(brief([item('r1', '必须', 100), item('r2', '应该', 5)]), none)
assert.deepEqual(near.map(t => t.name), ['推荐'])
const apart = tiers(brief([item('r1', '必须', 100), item('r2', '应该', 50)]), none)
assert.deepEqual(apart.map(t => t.name), ['基础', '推荐'])
pass('相邻两档价差不到 1 成合并成范围大的那档')

const talking = buildSheet('p', [{ n: 1, at: 0, brief: b, quote: { ...EMPTY_QUOTE, status: '已报价' } }, { n: 2, at: 1, brief: b, quote: EMPTY_QUOTE }], 2)
assert.equal(talking.base, null); assert.equal(talking.change, null); assert(talking.tiers.length > 0)
pass('第 1 版只是报过价时，追加的第 2 版仍是完整报价，不是变更单')

const oldest = Array.from({ length: 51 }, (_, i) => ({ title: `p${i}`, versions: [{ n: 1, at: i, brief: brief([item('r1', '必须', 10)]), quote: { ...EMPTY_QUOTE, status: '已成交' as const, actual: { 新做: i === 0 ? 100 : 10, 接手改: 0 }, hourEdits: {} } }] }))
assert.equal(calibrate(oldest).settings.hourFactor['新做'], 1)
assert.equal(calibrate(oldest.slice(0, 3).map((p, i) => ({ ...p, versions: [{ ...p.versions[0], quote: { ...p.versions[0].quote, actual: { 新做: i === 0 ? 100 : 30, 接手改: 0 } } }] }))).settings.hourFactor['新做'], 3)
pass('校准只用最近 50 个项目')

const fact = (hours: number, edit: number, title = '微信分账') => ({ title: 'p', versions: [{ n: 1, at: 0, brief: { ...brief([item('r1', '必须', hours, { title, basis: hours ? '验证' as const : '直接做' as const }), item('r2', '必须', 10, { basis: '确认' })]), category: '电商支付' as const }, quote: { ...EMPTY_QUOTE, hourEdits: { r1: edit } } }] })
const learned = calibrate([fact(4, 8), fact(4, 8), fact(4, 8)]).settings
assert.equal(learned.basisFactor['验证'], 2)
assert.equal(learned.basisFactor['确认'], 1)
const applied = buildSheet('p', [{ n: 1, at: 0, brief: brief([item('r1', '必须', 4, { basis: '验证' }), item('r2', '必须', 4, { basis: '确认' })]), quote: EMPTY_QUOTE }], 1, learned).chosen!.lines
assert.deepEqual(applied.map(l => l.hours), [8, 4])
pass('按判断类型分别校准：只放大一直被低估的那一类')

const oldFrozen = normalizeQuote({ status: '已报价', frozen: { rates: { 新做: 31, 接手改: 267 }, hourFactor: { 新做: 1, 接手改: 1 } } })
assert.equal(buildSheet('p', [{ n: 1, at: 0, brief: brief([item('r1', '必须', 4, { basis: '验证' })]), quote: oldFrozen }], 1, learned).chosen!.lines[0].hours, 4)
pass('已冻结的报价不吃后来的分类系数')

const exp = experienceLines([fact(0, 3, '订阅消息')], '商单')
assert.match(exp[0], /电商支付｜订阅消息｜.*：0 小时 → 3 小时（调整）/)
assert.deepEqual(experienceLines([fact(0, 3)], '学生单'), [])
assert.match(briefSystemPrompt(null, '商单', exp), /订阅消息/)
assert.doesNotMatch(briefSystemPrompt(null, '商单'), /过去同类单子/)
assert.equal(experienceLines(Array.from({ length: 20 }, () => fact(4, 8)), '商单', 30).length, 30)
assert.match(briefSystemPrompt(null, '商单'), /保修、售后答疑不单列/)
pass('历史修正传给 AI：估 0 的也传，不跨客户类型，最多 30 条')

const doneProject = { title: 'p', versions: [{ n: 1, at: 0, brief: brief([item('r1', '必须', 10)]), quote: { ...EMPTY_QUOTE, status: '已成交' as const, actual: { 新做: 20, 接手改: 0 } } }] }
const lostProject = { title: 'p', versions: [{ n: 1, at: 0, brief: brief([item('r1', '必须', 10)]), quote: { ...EMPTY_QUOTE, status: '已报价' as const, outcome: '没回音' as const } }] }
const acc = calibrate([doneProject, lostProject]).notes.join()
assert.match(acc, /最近 1 单，AI 估的小时和实际平均差 50%/)
assert.match(acc, /有结果的 2 单，成交 1 单（50%）/)
assert.doesNotMatch(calibrate([fact(4, 8)]).notes.join(), /历史记录/)
assert.match(calibrate(Array.from({ length: 20 }, () => fact(4, 8))).notes.join(), /历史记录 40 条，每次只能带 30 条/)
pass('准确度：小时偏差和成交率')

console.log(`\n${checks} 项全部通过`)
