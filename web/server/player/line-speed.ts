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
interface HostSpeed { samples: Sample[]; at: number }
interface Store { hosts: Record<string, HostSpeed>; lines: Record<string, string> }

const FILE = join(dataDir, 'line-speed.json')
const MAX_BPS = 1e9
const SAMPLE_GAP_MS = 4000
const WINDOW = 50

function load(): Store {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<Store>
    const hosts: Record<string, HostSpeed> = {}
    for (const [h, r] of Object.entries(raw.hosts ?? {})) if (Array.isArray(r?.samples)) hosts[h] = r
    return { hosts, lines: raw.lines ?? {} }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[player:line-speed] 读取失败，从空表开始：', error)
    return { hosts: {}, lines: {} }
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
  save()
  return true
}
