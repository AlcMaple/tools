// BGM 连通状态 —— 只记「用户真实触发的那些 BGM 请求」的结果，不主动去敲 BGM。
// 主动定时探测会在限流时加重限流，也违背「别周期性探测恢复了没」的规矩；被动记账零额外请求，
// 看到的正好是真实流量碰到的情况。状态只在内存里：重启清零，窗口内没有请求时报 idle（不是故障）。
//
// 失败的口径：429（限流）、403（被拦，BGM 前面有 Cloudflare）、5xx、超时 / 连不上。
// 404 / 400 这类是「BGM 正常应答，只是没有这条」，算正常。
const WINDOW_MS = 15 * 60_000
const MAX_EVENTS = 300
const MIN_SAMPLE = 3

type Kind = 'ok' | 'rate-limited' | 'blocked' | 'server-error' | 'unreachable'

interface BgmEvent {
  at: number
  host: string
  kind: Kind
  status: number | null
}

const events: BgmEvent[] = []
let lastOkAt: number | null = null
let lastFailAt: number | null = null
let lastFailKind: Exclude<Kind, 'ok'> | null = null

const isBgmHost = (host: string): boolean => host === 'bgm.tv' || host.endsWith('.bgm.tv')

function classify(status: number | null): Kind {
  if (status === null) return 'unreachable'
  if (status === 429) return 'rate-limited'
  if (status === 403) return 'blocked'
  if (status >= 500) return 'server-error'
  return 'ok'
}

/** 记一次对 BGM 的请求结果：拿到响应传状态码，没拿到响应（超时 / 连不上）传 null。非 bgm.tv 的 URL 直接忽略。 */
export function noteBgmRequest(url: string, status: number | null): void {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return
  }
  if (!isBgmHost(host)) return
  const at = Date.now()
  const kind = classify(status)
  events.push({ at, host, kind, status })
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
  if (kind === 'ok') lastOkAt = at
  else {
    lastFailAt = at
    lastFailKind = kind
  }
}

export type BgmState = 'ok' | 'idle' | 'degraded' | 'limited'

export interface BgmHealth {
  state: BgmState
  windowMinutes: number
  total: number
  failed: number
  rateLimited: number
  blocked: number
  serverError: number
  unreachable: number
  lastOkAt: number | null
  lastFailAt: number | null
  lastFailKind: Exclude<Kind, 'ok'> | null
  byHost: Record<string, { total: number; failed: number }>
}

export function bgmHealth(now = Date.now()): BgmHealth {
  const recent = events.filter((e) => now - e.at <= WINDOW_MS)
  const count = (kind: Kind): number => recent.filter((e) => e.kind === kind).length
  const failed = recent.filter((e) => e.kind !== 'ok').length
  const byHost: BgmHealth['byHost'] = {}
  for (const e of recent) {
    const slot = (byHost[e.host] ??= { total: 0, failed: 0 })
    slot.total++
    if (e.kind !== 'ok') slot.failed++
  }
  const latest = recent[recent.length - 1]
  let state: BgmState = 'ok'
  if (!recent.length) state = 'idle'
  // 最近一次就是被限流 / 被拦：此刻仍在被限，哪怕之前成功过
  else if (latest.kind === 'rate-limited' || latest.kind === 'blocked') state = 'limited'
  else if (recent.length >= MIN_SAMPLE && failed / recent.length >= 0.5) state = 'degraded'
  return {
    state,
    windowMinutes: WINDOW_MS / 60_000,
    total: recent.length,
    failed,
    rateLimited: count('rate-limited'),
    blocked: count('blocked'),
    serverError: count('server-error'),
    unreachable: count('unreachable'),
    lastOkAt,
    lastFailAt,
    lastFailKind,
    byHost,
  }
}
