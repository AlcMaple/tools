import { nextXifan } from './next'

export interface WeekItem { xifanId: number; name: string; day: number; remarks: string }
let cache: { at: number; items: WeekItem[] } | null = null
let inflight: Promise<WeekItem[]> | null = null
export function fetchWeekday(): Promise<WeekItem[]> {
  if (cache && Date.now() - cache.at < 6 * 60 * 60_000) return Promise.resolve(cache.items)
  if (inflight) return inflight
  const job = nextXifan().schedule().then(items => {
    cache = { at: Date.now(), items }
    return items
  })
  inflight = job
  void job.then(() => { if (inflight === job) inflight = null }, () => { if (inflight === job) inflight = null })
  return job
}
