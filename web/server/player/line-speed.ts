// 全站共享的线路速度表，落 dataDir/line-speed.json，永久保留。
//
// 按源站记，不按线路号或番记：2026-10-31 抽查 7 部稀饭 10 月新番 + 1 部旧番，线路编号全站统一
// （4 新番主线-1 → apn.moedot.net，1 新番主线-2 → play.xfvod.pro，2 备用-1 → dl.playxf.top，5 旧番主线-1 → play.xfvod.pro），
// 同一编号在每部番里都是同一个源站；所以「线路编号 → 源站」也全站一张，新番打开就能排序，不用先解析试探。
// Girigiri 抽查 8 部，繁中 / 简中全在 akua.girigirilove.com，线路编号还是按这部番有哪几条依次排的，不记，排序时都算 0。
//
// 样本只来自用户本来就在下的直连字节；只收服务端自己解析出过的源站，防止有人往表里塞任意域名。
// 「这台设备连不上」不进这里：同一源站有的运营商直连饿死、有的很快（AGENTS.md iPhone 事故），只记在各自浏览器。

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../data-dir'

interface Sample { uid: number; bps: number }
// 条块：每 3 小时一格，格里每人只留自己最新的值，只保留最近 7 天（56 格）
interface Bucket { t: number; s: Record<string, number> }
interface HostSpeed { samples: Sample[]; at: number; n?: number; buckets?: Bucket[] }
// 贡献：每人总次数 + 最近 30 天每天的次数
interface Contrib { n: number; days: Record<string, number> }
interface Store { hosts: Record<string, HostSpeed>; lines: Record<string, string>; names: Record<string, string>; contrib: Record<string, Contrib> }

const FILE = join(dataDir, 'line-speed.json')
const MAX_BPS = 1e9
const SAMPLE_GAP_MS = 4000
const WINDOW = 50
const BUCKET_MS = 3 * 3600 * 1000
const BUCKETS = 56
const DAY_MS = 24 * 3600 * 1000
const CONTRIB_DAYS = 30

function load(): Store {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<Store>
    const hosts: Record<string, HostSpeed> = {}
    for (const [h, r] of Object.entries(raw.hosts ?? {})) if (Array.isArray(r?.samples)) hosts[h] = r
    return { hosts, lines: raw.lines ?? {}, names: raw.names ?? {}, contrib: raw.contrib ?? {} }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[player:line-speed] 读取失败，从空表开始：', error)
    return { hosts: {}, lines: {}, names: {}, contrib: {} }
  }
}
const store = load()
let saveTimer: NodeJS.Timeout | null = null
function save(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      writeFileSync(FILE + '.tmp', JSON.stringify(store))
      renameSync(FILE + '.tmp', FILE)
    } catch (error) { console.error('[player:line-speed] 写入失败：', error) }
  }, 5000)
}

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

export function noteLineHost(src: string, source: number, url: string): void {
  if (src !== 'xifan') return
  const host = hostOf(url), key = `${src}:${source}`
  if (!host || store.lines[key] === host) return
  store.lines[key] = host
  save()
}

export function noteLineNames(src: string, lines: { source: number; name: string }[]): void {
  if (src !== 'xifan') return
  let changed = false
  for (const l of lines) {
    const key = `${src}:${l.source}`
    if (l.name && store.names[key] !== l.name) { store.names[key] = l.name; changed = true }
  }
  if (changed) save()
}

export function speedsFor(src: string, lines: { source: number }[]): Record<number, number> {
  const out: Record<number, number> = {}
  for (const l of lines) {
    const host = store.lines[`${src}:${l.source}`]
    const r = host ? store.hosts[host] : undefined
    if (r?.samples.length) out[l.source] = p90(r.samples.map(x => x.bps))
  }
  return out
}

// 测到的是「源站能力」和「这个人自己网速」里小的那个：弱网用户在快源站上也只测得出自己的上限，
// 平均会把快源站拉低到比慢源站还慢。取最近 50 个用户的 90 分位：慢源站谁都测不出高值，
// 快源站只要一成用户网好就能体现；源站真变慢时所有人的值一起掉，90 分位跟着掉，不需要过期。
// 每人只占一格（自己的值按新样本 3 成滚动），不然一个人连看 3 分钟就把 50 格占满，90 分位又退回只看他一个
function p90(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]
}

const lastSample = new Map<number, number>()
export function noteSample(uid: number, src: string, host: string, bps: number): boolean {
  if (!Object.entries(store.lines).some(([k, h]) => h === host && k.startsWith(src + ':'))) return false
  if (!(bps > 0) || bps > MAX_BPS) return false
  const now = Date.now()
  if (now - (lastSample.get(uid) ?? 0) < SAMPLE_GAP_MS) return true
  lastSample.set(uid, now)
  const r = store.hosts[host] ?? (store.hosts[host] = { samples: [], at: now })
  const at = r.samples.findIndex(x => x.uid === uid)
  const mine = at < 0 ? bps : r.samples.splice(at, 1)[0].bps * 0.7 + bps * 0.3
  r.samples.push({ uid, bps: Math.round(mine) })
  if (r.samples.length > WINDOW) r.samples.splice(0, r.samples.length - WINDOW)
  r.at = now
  r.n = (r.n ?? 0) + 1
  const t = Math.floor(now / BUCKET_MS) * BUCKET_MS
  const buckets = r.buckets ?? (r.buckets = [])
  if (buckets[buckets.length - 1]?.t !== t) buckets.push({ t, s: {} })
  buckets[buckets.length - 1].s[uid] = Math.round(bps)
  while (buckets.length && buckets[0].t <= t - BUCKETS * BUCKET_MS) buckets.shift()
  const c = store.contrib[uid] ?? (store.contrib[uid] = { n: 0, days: {} })
  const day = dayKey(now)
  c.n++
  c.days[day] = (c.days[day] ?? 0) + 1
  for (const d of Object.keys(c.days)) if (d < dayKey(now - (CONTRIB_DAYS - 1) * DAY_MS)) delete c.days[d]
  save()
  return true
}

function dayKey(ms: number): string {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

export interface LineStatus {
  source: number
  name: string
  bps: number
  users: number
  samples: number
  mine: number
  bars: ({ t: number; bps: number; users: number } | null)[]
}

// 线路观测页：只给线路名，不给源站域名
export function lineStatus(uid: number): { lines: LineStatus[]; me: { n: number; rank: number; days: number[] } } {
  const now = Date.now()
  const last = Math.floor(now / BUCKET_MS) * BUCKET_MS
  const lines: LineStatus[] = Object.entries(store.lines)
    .filter(([k]) => k.startsWith('xifan:'))
    .map(([k, host]) => {
      const r = store.hosts[host]
      const byT = new Map((r?.buckets ?? []).map(b => [b.t, b]))
      const bars = Array.from({ length: BUCKETS }, (_, i) => {
        const b = byT.get(last - (BUCKETS - 1 - i) * BUCKET_MS)
        const vals = b ? Object.values(b.s) : []
        return vals.length ? { t: b!.t, bps: p90(vals), users: vals.length } : null
      })
      const users = new Set((r?.buckets ?? []).flatMap(b => Object.keys(b.s)))
      return {
        source: Number(k.slice(6)),
        name: store.names[k] ?? `线路 ${k.slice(6)}`,
        bps: r?.samples.length ? p90(r.samples.map(x => x.bps)) : 0,
        users: users.size,
        samples: r?.n ?? 0,
        mine: r?.samples.find(x => x.uid === uid)?.bps ?? 0,
        bars,
      }
    })
    .sort((a, b) => b.bps - a.bps || a.source - b.source)
  const mine = store.contrib[uid]
  const rank = mine ? 1 + Object.values(store.contrib).filter(c => c.n > mine.n).length : 0
  const days = Array.from({ length: CONTRIB_DAYS }, (_, i) => mine?.days[dayKey(now - (CONTRIB_DAYS - 1 - i) * DAY_MS)] ?? 0)
  return { lines, me: { n: mine?.n ?? 0, rank, days } }
}
