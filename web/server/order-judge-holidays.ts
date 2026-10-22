// 国务院节假日安排：holiday-cn 每年发文后自动抓取，按年一个 JSON（含调休上班日）。
// 拉到后按年缓存到 dataDir；已公布的年份不再变，只有「还没发文」的空年份每天最多重查一次，
// 不周期探测（网络请求红线）。拉取失败时用旧缓存，连缓存都没有就抛错，不静默按双休算。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from './data-dir'
import './http'
import type { HolidayYear } from '../shared/order-judge-quote'

const SOURCE = (year: number) => `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`
const CACHE_DIR = join(dataDir, 'holidays')
const RECHECK_MS = 86_400_000
const TIMEOUT_MS = 10_000

interface Cached extends HolidayYear { checkedAt: number }

const inflight = new Map<number, Promise<HolidayYear>>()

async function readCache(year: number): Promise<Cached | null> {
  try {
    return JSON.parse(await readFile(join(CACHE_DIR, `${year}.json`), 'utf8')) as Cached
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

async function download(year: number): Promise<Cached> {
  const res = await fetch(SOURCE(year), { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`节假日数据 ${year} 年拉取失败：HTTP ${res.status}`)
  const body = await res.json() as { year: number; days: { date: string; isOffDay: boolean }[] }
  if (body.year !== year || !Array.isArray(body.days)) throw new Error(`节假日数据 ${year} 年格式不对`)
  const days: Record<string, boolean> = {}
  for (const d of body.days) days[d.date] = d.isOffDay
  const cached: Cached = { year, published: body.days.length > 0, days, checkedAt: Date.now() }
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(join(CACHE_DIR, `${year}.json`), JSON.stringify(cached))
  return cached
}

async function load(year: number): Promise<HolidayYear> {
  const cached = await readCache(year)
  if (cached && (cached.published || Date.now() - cached.checkedAt < RECHECK_MS)) return cached
  try {
    return await download(year)
  } catch (err) {
    if (!cached) throw err
    console.warn(`[order-judge] 节假日 ${year} 年重查失败，沿用缓存：${(err as Error).message}`)
    return cached
  }
}

export function holidayYear(year: number): Promise<HolidayYear> {
  let p = inflight.get(year)
  if (!p) {
    p = load(year).finally(() => inflight.delete(year))
    inflight.set(year, p)
  }
  return p
}

export function holidayYears(years: number[]): Promise<HolidayYear[]> {
  return Promise.all(years.map(holidayYear))
}
