// 在线搜兜底 —— **只在本地索引 0 命中时**才走这条（`server/index.ts` 的 /api/search）。
//
// 为什么需要：本地索引来自每周三的官方离线档，本周新建的 BGM 条目最迟下周四才进得来。
// 极新 / 刚补录的条目在本地就是搜不到 —— 那一小撮走这里。
//
// 为什么它必须被死死看住：整个网页版是**单机单 IP**，周历和封面代理也都指着 BGM。
// 一旦这个 IP 被限流，用户看到的不只是搜不到，而是**首页周历一起白屏**。所以这里的原则是
// 「宁可这次搜不到，也绝不多打一次」：
//
//   本地有结果 → 根本不进来（调用方保证）
//   ├ 缓存命中（含空结果）→ 不联网
//   ├ 冷却中（连挂 3 次）→ 不联网，直接告诉前端「在线补充暂停中」
//   ├ 超过每小时上限 → 不联网
//   ├ 距上次不足 2s → 不联网（不排队等：让用户干等还不如让他改个词）
//   └ 以上都过 → 打一次，**失败不重试**（传输层抖动由 fetchJson 兜一次，见 AI_GUIDELINES）
//
// 结果只放内存缓存，**不写进 bgm_index.db** —— 那库每周被整体原子替换，写了也会被冲掉，
// 而且它是只读打开的。
import { fetchJson } from '../http'
import type { AnimeHit } from './anime-index'

const API = 'https://api.bgm.tv/v0/search/subjects?limit=10'

// UA 跟 detail.ts 一致：api.bgm.tv 要的是**诚实标识**，不是浏览器伪装（跟抓 HTML 相反，见 CLAUDE.md）
const HEADERS = {
  'User-Agent': 'MapleTools-Web/0.1 (https://github.com/AlcMaple/tools)',
  Accept: 'application/json',
}

const MIN_INTERVAL = 2000 // 两次在线搜最小间隔
const HOURLY_CAP = 40 // 每小时上限
const CACHE_TTL = 30 * 60_000 // 结果缓存 30 分钟（空结果也缓存：搜不到的词最容易被反复敲）
const CACHE_MAX = 500
const FAIL_STREAK_LIMIT = 3 // 连挂几次进冷却
const COOLDOWN = 10 * 60_000

interface CacheEntry {
  at: number
  hits: AnimeHit[]
}

const cache = new Map<string, CacheEntry>()
let lastAt = 0
let hourStart = 0
let hourCount = 0
let failStreak = 0
let cooldownUntil = 0

export interface OnlineResult {
  hits: AnimeHit[]
  /** 没能联网 / 联网失败时的**具体**原因，给前端如实说明（绝不写成笼统的「网络请求失败」） */
  error?: string
}

/** BGM 返回的条目 → 跟本地索引同构的 AnimeHit，前端不用分两套渲染 */
function toHit(raw: unknown): AnimeHit | null {
  const o = (raw ?? {}) as Record<string, unknown>
  const id = Number(o.id)
  if (!id) return null
  const rating = (o.rating ?? {}) as Record<string, unknown>
  return {
    bgmId: id,
    name: typeof o.name === 'string' ? o.name : '',
    nameCn: typeof o.name_cn === 'string' ? o.name_cn : '',
    date: typeof o.date === 'string' ? o.date : '',
    score: Number(rating.score) || 0,
  }
}

/** 把失败翻译成人话 —— 限流 / 超时 / 其它要分得清，用户才知道是「等等再试」还是「换个词」 */
function explain(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/HTTP 429/.test(msg)) return 'BGM 限流了，过会儿再试'
  if (/HTTP 5\d\d/.test(msg)) return 'BGM 服务端出错了，过会儿再试'
  if (/timeout|aborted|TimeoutError/i.test(msg)) return '连 BGM 超时了'
  return 'BGM 在线补充失败'
}

export async function searchOnline(query: string, now = Date.now()): Promise<OnlineResult> {
  const q = query.trim()
  if (q.length < 2) return { hits: [] } // 一个字的词在线搜也是噪音，不值得为它开一次口子

  const cached = cache.get(q)
  if (cached && now - cached.at < CACHE_TTL) return { hits: cached.hits }

  if (now < cooldownUntil) {
    return { hits: [], error: `在线补充暂停中（连续失败），约 ${Math.ceil((cooldownUntil - now) / 60000)} 分钟后恢复` }
  }
  if (now - hourStart >= 3600_000) {
    hourStart = now
    hourCount = 0
  }
  if (hourCount >= HOURLY_CAP) return { hits: [], error: '在线补充已达本小时上限，先歇会儿' }
  if (now - lastAt < MIN_INTERVAL) return { hits: [], error: '在线补充太频繁了，等一下再搜' }

  lastAt = now
  hourCount++
  try {
    const raw = (await fetchJson(API, {
      method: 'POST',
      headers: HEADERS,
      timeoutMs: 6000, // 短超时：这是「加分项」，不能让加番搜索框卡住
      body: { keyword: q, sort: 'match', filter: { type: [2] } }, // type=2 只要动画
    })) as { data?: unknown }
    const hits = (Array.isArray(raw.data) ? raw.data : []).map(toHit).filter((h): h is AnimeHit => !!h)
    failStreak = 0
    if (cache.size >= CACHE_MAX) cache.clear() // 简单粗暴：满了整清，反正是纯加速
    cache.set(q, { at: now, hits })
    return { hits }
  } catch (err) {
    // **不重试**（传输层抖动 fetchJson 已经兜过一次）。连挂几次就闭嘴一段时间，
    // 这正是限流的典型信号 —— 继续打只会把 IP 陷得更深。
    failStreak++
    if (failStreak >= FAIL_STREAK_LIMIT) {
      cooldownUntil = now + COOLDOWN
      failStreak = 0
    }
    return { hits: [], error: explain(err) }
  }
}
