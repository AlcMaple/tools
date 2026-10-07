// 往期周历 —— BGM 只给「当前在播」的周历，过了就没了，所以自己按季度存快照。
//
// 一个季度一份文件 `calendar-seasons/YYYY-MM.json`（MM = 该季首月 01/04/07/10），永久保留，
// 落在 dataDir 里不进部署目录。本季内每次拿到新的 BGM 周历就并进去：
// 按 bgmId 取并集，同一部番以最新一次的星期和资料为准，中途已经完结掉出周历的番不会丢。
// 季度一换，旧文件不再被写，自然冻结成往期。
//
// 接入这个功能之前的季度，BGM 没有现成周历，只能按「首播日在这个季度首月」翻出来补（见 deriveSeason）：
// 星期由首播日推算，实测和 BGM 当季周历对上 100 部里的 98 部。补出来的快照标 derived，页面上要说明。
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../data-dir'
import { fetchJson } from '../http'
import { coverUrl } from './calendar'
import type { CalendarItem, CalendarWeekday } from './calendar'

const seasonsDir = join(dataDir, 'calendar-seasons')
try {
  mkdirSync(seasonsDir, { recursive: true })
} catch {
  // 盘不可写就不存往期，当季周历本身不受影响
}

const KEY_RE = /^(\d{4})-(01|04|07|10)$/

/** 最早补到哪一季：再往前 BGM 的首播日和封面都稀疏，补出来也不好看 */
export const HISTORY_START = '2013-01'

export interface SeasonSnapshot {
  key: string
  updatedAt: number
  data: CalendarWeekday[]
  /** 按首播日推算补出来的，不是当季周历原样 */
  derived: boolean
}

export interface SeasonSummary {
  key: string
  year: number
  /** 0 冬(1月) 1 春(4月) 2 夏(7月) 3 秋(10月) */
  q: number
  /** 还没存过的季度是 null，点开时才去 BGM 翻 */
  count: number | null
  updatedAt: number | null
  current: boolean
  derived: boolean
}

export const isSeasonKey = (key: string): boolean => KEY_RE.test(key)

/** 按东八区算季度：服务器所在时区不该影响「这是几月番」 */
export function seasonKeyOf(ts: number): string {
  const d = new Date(ts + 8 * 3_600_000)
  const month = Math.floor(d.getUTCMonth() / 3) * 3 + 1
  return `${d.getUTCFullYear()}-${String(month).padStart(2, '0')}`
}

const fileOf = (key: string): string => join(seasonsDir, `${key}.json`)

function readSnapshot(key: string): SeasonSnapshot | null {
  try {
    const raw = JSON.parse(readFileSync(fileOf(key), 'utf8')) as Partial<SeasonSnapshot>
    if (!Array.isArray(raw.data) || typeof raw.updatedAt !== 'number') return null
    return { key, updatedAt: raw.updatedAt, data: raw.data, derived: raw.derived === true }
  } catch {
    return null
  }
}

function writeSnapshot(snapshot: SeasonSnapshot): void {
  const tmp = `${fileOf(snapshot.key)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ updatedAt: snapshot.updatedAt, data: snapshot.data, ...(snapshot.derived ? { derived: true } : {}) }))
  renameSync(tmp, fileOf(snapshot.key))
}

const countOf = (data: CalendarWeekday[]): number => data.reduce((n, d) => n + d.items.length, 0)

function merge(prev: CalendarWeekday[], next: CalendarWeekday[]): CalendarWeekday[] {
  const seen = new Map<number, { weekday: number; item: CalendarItem }>()
  for (const day of prev) for (const item of day.items) seen.set(item.id, { weekday: day.id, item })
  for (const day of next) for (const item of day.items) seen.set(item.id, { weekday: day.id, item })
  return next.map((day) => ({
    id: day.id,
    label: day.label,
    items: [...seen.values()].filter((s) => s.weekday === day.id).map((s) => s.item),
  }))
}

/** 把一份 BGM 周历并进它所属季度的快照；内容没变就不写盘，也不挪 updatedAt。 */
export function recordSeason(data: CalendarWeekday[], at: number): void {
  if (!data.length) return
  try {
    const key = seasonKeyOf(at)
    const prev = readSnapshot(key)
    const merged = prev ? merge(prev.data, data) : data
    if (prev && JSON.stringify(prev.data) === JSON.stringify(merged)) return
    writeSnapshot({ key, updatedAt: at, data: merged, derived: false })
  } catch (error) {
    // 往期存不下不能拖垮当季周历；留一行原因，别静默
    console.warn('[calendar-history] 保存季度快照失败:', error instanceof Error ? error.message : error)
  }
}

export function getSeason(key: string): SeasonSnapshot | null {
  return isSeasonKey(key) ? readSnapshot(key) : null
}

/** 能补的季度：HISTORY_START 到当季之前（当季只靠周历快照，不倒推） */
export const isBackfillable = (key: string, now = Date.now()): boolean =>
  isSeasonKey(key) && key >= HISTORY_START && key < seasonKeyOf(now)

// 列表要给每个已存季度报条数，别每次都把几十个文件整个解析一遍：按修改时间缓存。
const countCache = new Map<string, { mtimeMs: number; count: number; updatedAt: number; derived: boolean }>()

export function listSeasons(now = Date.now()): SeasonSummary[] {
  const currentKey = seasonKeyOf(now)
  const out: SeasonSummary[] = []
  const [startYear] = HISTORY_START.split('-').map(Number)
  const nowYear = Number(currentKey.slice(0, 4))
  for (let year = nowYear; year >= startYear; year--) {
    for (let q = 3; q >= 0; q--) {
      const key = `${year}-${String(q * 3 + 1).padStart(2, '0')}`
      if (key > currentKey || key < HISTORY_START) continue
      let saved = countCache.get(key)
      try {
        const { mtimeMs } = statSync(fileOf(key))
        if (!saved || saved.mtimeMs !== mtimeMs) {
          const snapshot = readSnapshot(key)
          saved = snapshot ? { mtimeMs, count: countOf(snapshot.data), updatedAt: snapshot.updatedAt, derived: snapshot.derived } : undefined
          if (saved) countCache.set(key, saved)
        }
      } catch {
        saved = undefined
      }
      // 当季没有快照就不列：它只能靠周历接口产生，列出来点了也是空的
      if (!saved && key === currentKey) continue
      out.push({
        key,
        year,
        q,
        count: saved?.count ?? null,
        updatedAt: saved?.updatedAt ?? null,
        current: key === currentKey,
        derived: saved?.derived ?? false,
      })
    }
  }
  return out
}

// ── 补更早的季度 ─────────────────────────────────────────────────────────────
// BGM 按年月检索：year + month 命中「首播日在这个月」的条目，一页最多 50。platform 参数无效，
// 只能自己按 platform 字段筛；BGM 当季周历收的就是 TV + WEB，这里保持一致，剧场版 / OVA / 其他不收。
const BGM_HEADERS = {
  'User-Agent': 'MapleTools-Web/0.1 (https://github.com/AlcMaple/tools)',
  Accept: 'application/json',
}
const WEEKDAY_LABELS = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']

interface BgmSubject {
  id: number
  name?: string
  name_cn?: string
  date?: string | null
  platform?: string
  eps?: number
  total_episodes?: number
  images?: Record<string, string>
  rating?: { score?: number }
}

function toCalendar(subjects: BgmSubject[]): CalendarWeekday[] {
  const days: CalendarWeekday[] = WEEKDAY_LABELS.map((label, i) => ({ id: i + 1, label, items: [] }))
  const sorted = subjects
    .filter((s) => (s.platform === 'TV' || s.platform === 'WEB') && s.date && /^\d{4}-\d{2}-\d{2}$/.test(s.date))
    .sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : a.id - b.id))
  for (const s of sorted) {
    // BGM 的首播日就是日本当地日期，按 UTC 取星期即可，不受服务器时区影响
    const weekday = new Date(`${s.date}T12:00:00Z`).getUTCDay() || 7
    days[weekday - 1].items.push({
      id: s.id,
      name: String(s.name ?? ''),
      name_cn: String(s.name_cn ?? ''),
      url: `https://bgm.tv/subject/${s.id}`,
      cover: coverUrl(s.images ?? {}),
      airDate: s.date!,
      episodes: s.eps || s.total_episodes || 0,
      score: typeof s.rating?.score === 'number' ? s.rating.score : 0,
    })
  }
  return days
}

// 一次只补一季、同一季只补一次：对 BGM 的请求排成一条队，不因为用户连点十个季度就并发十路。
const building = new Map<string, Promise<SeasonSnapshot>>()
let queue: Promise<unknown> = Promise.resolve()

async function fetchSeasonSubjects(key: string, pageGapMs: number): Promise<BgmSubject[]> {
  const year = Number(key.slice(0, 4))
  const month = Number(key.slice(5))
  const all: BgmSubject[] = []
  for (let offset = 0; ; offset += 50) {
    const page = await fetchJson<{ total: number; data: BgmSubject[] }>(
      `https://api.bgm.tv/v0/subjects?type=2&year=${year}&month=${month}&sort=date&limit=50&offset=${offset}`,
      { headers: BGM_HEADERS, timeoutMs: 15000 },
    )
    all.push(...page.data)
    if (offset + 50 >= page.total || !page.data.length) break
    if (pageGapMs > 0) await new Promise((resolve) => setTimeout(resolve, pageGapMs))
  }
  return all
}

/** 没存过的往期季度：去 BGM 翻一次并永久存下。失败如实抛出，不重试，也不存半成品。 */
export function deriveSeason(key: string, opts: { pageGapMs?: number } = {}): Promise<SeasonSnapshot> {
  let job = building.get(key)
  if (job) return job
  job = queue.then(async () => {
    const existing = readSnapshot(key)
    if (existing) return existing
    let subjects: BgmSubject[]
    try {
      subjects = await fetchSeasonSubjects(key, opts.pageGapMs ?? 0)
    } catch (error) {
      throw new Error(`没能从 BGM 翻到这一季：${error instanceof Error ? error.message.replace(/ for https?:\/\/\S+/, '') : String(error)}`)
    }
    const data = toCalendar(subjects)
    if (!data.some((d) => d.items.length)) throw new Error('BGM 里这一季没有查到番剧')
    const snapshot: SeasonSnapshot = { key, updatedAt: Date.now(), data, derived: true }
    writeSnapshot(snapshot)
    return snapshot
  })
  building.set(key, job)
  queue = job.catch(() => undefined)
  const clear = (): void => { if (building.get(key) === job) building.delete(key) }
  job.then(clear, clear)
  return job
}
