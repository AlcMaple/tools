// 估价规则回归：用户给的例子（1350 h、2026-10-22 下单）+ 未公布年份按双休、春节提示。
// 第一段真实拉取 holiday-cn，数据缓存落临时 DATA_DIR。
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quote, quoteYears, type HolidayYear } from '../shared/order-judge-quote'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'quote-'))
const { holidayYears } = await import('../server/order-judge-holidays')

const real = quote(1350, '2026-10-22', await holidayYears(quoteYears('2026-10-22', 1350)))
assert.deepEqual(real.tiers.map(t => [t.hours, t.workdays, t.start, t.end, t.calendarDays, t.price]), [
  [81, 11, '2026-10-23', '2026-11-06', 15, 2400],
  [102, 13, '2026-10-23', '2026-11-10', 19, 3040],
])
assert.deepEqual(real.assumedYears, [])

// 国庆调休：2026-10-10（周六）上班，10-01~10-07 放假
const national = quote(8 / 0.06, '2026-09-30', await holidayYears([2026]))
assert.equal(national.tiers[0].end, '2026-10-08')

const empty2027: HolidayYear = { year: 2027, published: false, days: {} }
const cross = quote(1920, '2026-12-20', [...await holidayYears([2026]), empty2027])
assert.deepEqual(cross.assumedYears, [2027])
assert.equal(cross.springFestivalRisk, false)
const spring = quote(2617, '2027-01-04', [empty2027])
assert.equal(spring.springFestivalRisk, true)

assert.throws(() => quote(1350, '2026-12-28', [{ year: 2026, published: true, days: {} }]), /缺少 2027/)
console.log('order-judge quote ok', real.tiers.map(t => `${t.end} ${t.price}`).join(' / '))
