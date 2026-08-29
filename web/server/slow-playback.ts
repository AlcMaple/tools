import { randomUUID } from 'node:crypto'
import { db } from './db'
import { emailDeliveryConfigured, sendSlowPlaybackReady } from './email-delivery'
import { consumeTicket, hasActivePriority, lockTicket, unlockTicket } from './rewards'

export const GLOBAL_SLOW_POOL = 'slow-proxy-global'
const RESERVATION_MS = 5 * 60 * 1000
const DISCONNECTED_MS = 3 * 60 * 1000
const PAUSED_MS = 10 * 60 * 1000
const ONLINE_WINDOW_MS = 20_000
const SWEEP_MS = 5_000
const releaseHooks = new Map<string, Set<(uid: number) => void>>()

type AdmissionState = 'waiting' | 'reserved' | 'active' | 'missed'
type AdmissionTier = 'priority' | 'normal'

interface AdmissionRow {
  queue_order: number
  id: string
  user_id: number
  pool_id: string
  client_id: string
  state: AdmissionState
  tier: AdmissionTier
  ticket_id: number | null
  source: string
  resource_key: string
  return_to: string
  created_at: number
  updated_at: number
  reserved_until: number | null
  last_seen_at: number | null
  paused_at: number | null
  notified_at: number | null
}

export interface AdmissionStatus {
  state: AdmissionState
  tier: AdmissionTier
  current: number
  reserved: number
  limit: number
  position: number | null
  reservedUntil: number | null
  ticketLocked: boolean
  source: string
  resourceKey: string
  returnTo: string
  owner: boolean
}

export class AdmissionRequired extends Error {
  constructor(readonly status: AdmissionStatus) {
    super(status.state === 'waiting' ? '正在候补慢源名额' : '慢源名额尚未获得')
    this.name = 'AdmissionRequired'
  }
}

export class SlowQueueClosed extends Error {
  constructor() {
    super('慢源名额已满，候补暂未开放')
    this.name = 'SlowQueueClosed'
  }
}

function queueEnabled(): boolean {
  const raw = process.env.SLOW_PLAYBACK_QUEUE_ENABLED?.trim().toLowerCase()
  return raw !== 'false' && raw !== '0'
}

export function registerSlowPoolReleaseHook(poolId: string, hook: (uid: number) => void): () => void {
  const hooks = releaseHooks.get(poolId) ?? new Set<(uid: number) => void>()
  hooks.add(hook)
  releaseHooks.set(poolId, hooks)
  return () => hooks.delete(hook)
}

function notifyReleased(uid: number, poolId: string): void {
  for (const hook of releaseHooks.get(poolId) ?? []) {
    try { hook(uid) } catch { /* 释放观察者不能阻断名额回收 */ }
  }
}

function poolLimit(_poolId: string): number {
  const configured = Number(process.env.SLOW_PLAYBACK_MAX_VIEWERS ?? 2)
  return Number.isInteger(configured) && configured > 0 ? configured : 2
}

function sanitizeReturnTo(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || value.length > 512) return '/'
  return value
}

function currentAdmission(uid: number, poolId: string): AdmissionRow | undefined {
  return db.prepare(
    `SELECT rowid AS queue_order, * FROM slow_admissions
     WHERE user_id = ? AND pool_id = ? AND state IN ('waiting', 'reserved', 'active')
     LIMIT 1`,
  ).get(uid, poolId) as AdmissionRow | undefined
}

function occupancy(poolId: string): { active: number; reserved: number } {
  const rows = db.prepare(
    `SELECT state, COUNT(*) AS count FROM slow_admissions
     WHERE pool_id = ? AND state IN ('reserved', 'active') GROUP BY state`,
  ).all(poolId) as { state: string; count: number }[]
  return {
    active: Number(rows.find((row) => row.state === 'active')?.count ?? 0),
    reserved: Number(rows.find((row) => row.state === 'reserved')?.count ?? 0),
  }
}

export function activeAdmissionCount(poolId: string): number {
  sweepAdmissions()
  return occupancy(poolId).active
}

function positionOf(row: AdmissionRow): number | null {
  if (row.state !== 'waiting') return null
  const result = db.prepare(
    `SELECT COUNT(*) AS count FROM slow_admissions
     WHERE pool_id = ? AND state = 'waiting' AND tier = ?
       AND (created_at < ? OR (created_at = ? AND rowid <= ?))`,
  ).get(row.pool_id, row.tier, row.created_at, row.created_at, row.queue_order) as { count: number }
  return Number(result.count)
}

function statusOf(row: AdmissionRow, clientId?: string): AdmissionStatus {
  const count = occupancy(row.pool_id)
  return {
    state: row.state,
    tier: row.tier,
    current: count.active,
    reserved: count.reserved,
    limit: poolLimit(row.pool_id),
    position: positionOf(row),
    reservedUntil: row.reserved_until,
    ticketLocked: row.ticket_id != null && row.state !== 'active',
    source: row.source,
    resourceKey: row.resource_key,
    returnTo: row.return_to,
    owner: !clientId || row.client_id === clientId,
  }
}

function pickWaiting(poolId: string): AdmissionRow | undefined {
  const priority = db.prepare(
    `SELECT rowid AS queue_order, * FROM slow_admissions
     WHERE pool_id = ? AND state = 'waiting' AND tier = 'priority'
     ORDER BY created_at, rowid LIMIT 1`,
  ).get(poolId) as AdmissionRow | undefined
  const normal = db.prepare(
    `SELECT rowid AS queue_order, * FROM slow_admissions
     WHERE pool_id = ? AND state = 'waiting' AND tier = 'normal'
     ORDER BY created_at, rowid LIMIT 1`,
  ).get(poolId) as AdmissionRow | undefined
  if (!priority) return normal
  if (!normal) return priority

  const state = db.prepare('SELECT priority_streak FROM slow_pool_state WHERE pool_id = ?')
    .get(poolId) as { priority_streak: number } | undefined
  return Number(state?.priority_streak ?? 0) >= 2 ? normal : priority
}

function allocateAvailable(poolId: string, now: number): void {
  const limit = poolLimit(poolId)
  for (;;) {
    const count = occupancy(poolId)
    if (count.active + count.reserved >= limit) return
    const next = pickWaiting(poolId)
    if (!next) return
    const changed = db.prepare(
      `UPDATE slow_admissions
       SET state = 'reserved', reserved_until = ?, updated_at = ?, notified_at = NULL
       WHERE id = ? AND state = 'waiting'`,
    ).run(now + RESERVATION_MS, now, next.id)
    if (changed.changes !== 1) continue

    db.prepare(
      `INSERT INTO slow_pool_state (pool_id, priority_streak) VALUES (?, ?)
       ON CONFLICT(pool_id) DO UPDATE SET priority_streak = excluded.priority_streak`,
    ).run(poolId, next.tier === 'priority'
      ? Math.min(2, Number((db.prepare('SELECT priority_streak FROM slow_pool_state WHERE pool_id = ?')
        .get(poolId) as { priority_streak: number } | undefined)?.priority_streak ?? 0) + 1)
      : 0)
  }
}

function releaseExpired(now: number): Set<string> {
  const affected = new Set<string>()
  const reserved = db.prepare(
    `SELECT * FROM slow_admissions WHERE state = 'reserved' AND reserved_until <= ?`,
  ).all(now) as AdmissionRow[]
  for (const row of reserved) {
    db.prepare(
      `UPDATE slow_admissions SET state = 'missed', updated_at = ?, reserved_until = NULL
       WHERE id = ? AND state = 'reserved'`,
    ).run(now, row.id)
    unlockTicket(row.id)
    affected.add(row.pool_id)
  }

  const active = db.prepare(`SELECT * FROM slow_admissions WHERE state = 'active'`).all() as AdmissionRow[]
  for (const row of active) {
    const pausedTooLong = row.paused_at != null && now - row.paused_at >= PAUSED_MS
    const disconnected = row.last_seen_at == null || now - row.last_seen_at >= DISCONNECTED_MS
    if (!pausedTooLong && !disconnected) continue
    db.prepare(`DELETE FROM slow_admissions WHERE id = ? AND state = 'active'`).run(row.id)
    notifyReleased(row.user_id, row.pool_id)
    affected.add(row.pool_id)
  }

  db.prepare(`DELETE FROM slow_admissions WHERE state = 'missed' AND updated_at < ?`).run(now - 24 * 60 * 60 * 1000)
  return affected
}

const sweepTx = db.transaction((now: number): void => {
  const affected = releaseExpired(now)
  const waitingPools = db.prepare(`SELECT DISTINCT pool_id FROM slow_admissions WHERE state = 'waiting'`)
    .all() as { pool_id: string }[]
  for (const row of waitingPools) affected.add(row.pool_id)
  for (const poolId of affected) allocateAvailable(poolId, now)
})

function publicOrigin(): string {
  return (process.env.WEB_PUBLIC_ORIGIN || 'https://anime.alcmaple.cn').replace(/\/$/, '')
}

async function deliverOfflineNotifications(now: number): Promise<void> {
  const rows = db.prepare(
    `SELECT a.*, u.email, u.email_verified_at
     FROM slow_admissions a JOIN users u ON u.id = a.user_id
     WHERE a.state = 'reserved' AND a.notified_at IS NULL
       AND (a.last_seen_at IS NULL OR a.last_seen_at < ?)`,
  ).all(now - ONLINE_WINDOW_MS) as Array<AdmissionRow & { email: string | null; email_verified_at: string | null }>

  for (const row of rows) {
    const claimed = db.prepare(
      `UPDATE slow_admissions SET notified_at = ? WHERE id = ? AND state = 'reserved' AND notified_at IS NULL`,
    ).run(now, row.id)
    if (claimed.changes !== 1) continue
    if (!row.email || !row.email_verified_at || !emailDeliveryConfigured()) {
      db.prepare(
        `INSERT OR REPLACE INTO slow_notification_log
          (admission_id, channel, status, detail, created_at) VALUES (?, 'email', 'skipped', ?, ?)`,
      ).run(row.id, row.email ? '邮件服务未配置' : '账号没有已验证邮箱', now)
      continue
    }
    const link = publicOrigin() + sanitizeReturnTo(row.return_to)
    try {
      await sendSlowPlaybackReady(row.email, link, row.reserved_until ?? now + RESERVATION_MS)
      db.prepare(
        `INSERT OR REPLACE INTO slow_notification_log
          (admission_id, channel, status, detail, created_at) VALUES (?, 'email', 'sent', '', ?)`,
      ).run(row.id, now)
    } catch (error) {
      db.prepare(
        `INSERT OR REPLACE INTO slow_notification_log
          (admission_id, channel, status, detail, created_at) VALUES (?, 'email', 'failed', ?, ?)`,
      ).run(row.id, error instanceof Error ? error.message.slice(0, 200) : '发送失败', now)
    }
  }
}

export function sweepAdmissions(now = Date.now()): void {
  sweepTx.immediate(now)
}

const requestTx = db.transaction((
  uid: number,
  poolId: string,
  source: string,
  resourceKey: string,
  returnTo: string,
  clientId: string,
  now: number,
): AdmissionRow => {
  releaseExpired(now)
  const existing = currentAdmission(uid, poolId)
  if (existing) {
    if (existing.state === 'active' && existing.client_id !== clientId) notifyReleased(uid, poolId)
    db.prepare(
      `UPDATE slow_admissions SET source = ?, resource_key = ?, return_to = ?, client_id = ?, updated_at = ?, last_seen_at = ?
       WHERE id = ?`,
    ).run(source, resourceKey, sanitizeReturnTo(returnTo), clientId, now, now, existing.id)
    return currentAdmission(uid, poolId)!
  }

  const id = randomUUID()
  const count = occupancy(poolId)
  const free = count.active + count.reserved < poolLimit(poolId)
  if (!free && !queueEnabled()) throw new SlowQueueClosed()
  let tier: AdmissionTier = 'normal'
  let ticketId: number | null = null
  if (!free) {
    if (hasActivePriority(uid, now)) tier = 'priority'
    else {
      ticketId = lockTicket(uid, id)
      if (ticketId != null) tier = 'priority'
    }
  }
  db.prepare(
    `INSERT INTO slow_admissions
      (id, user_id, pool_id, client_id, state, tier, ticket_id, source, resource_key, return_to,
       created_at, updated_at, reserved_until, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, uid, poolId, clientId, free ? 'reserved' : 'waiting', tier, ticketId, source, resourceKey,
    sanitizeReturnTo(returnTo), now, now, free ? now + RESERVATION_MS : null, now,
  )
  return currentAdmission(uid, poolId)!
})

export function requestAdmission(
  uid: number,
  input: { poolId: string; source: string; resourceKey: string; returnTo: string; clientId: string },
): AdmissionStatus {
  if (!/^[a-z0-9-]{3,64}$/.test(input.poolId)) throw new Error('容量池不合法')
  if (!/^[a-z0-9-]{2,32}$/.test(input.source)) throw new Error('来源不合法')
  if (!input.resourceKey || input.resourceKey.length > 200) throw new Error('资源标识不合法')
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(input.clientId)) throw new Error('播放器会话不合法')
  sweepAdmissions()
  const row = requestTx.immediate(
    uid, input.poolId, input.source, input.resourceKey, input.returnTo, input.clientId, Date.now(),
  )
  return statusOf(row, input.clientId)
}

export function admissionStatus(uid: number, poolId: string, clientId: string): AdmissionStatus | null {
  sweepAdmissions()
  const row = currentAdmission(uid, poolId)
  if (!row) return null
  if (row.client_id === clientId) {
    db.prepare('UPDATE slow_admissions SET last_seen_at = ?, updated_at = ? WHERE id = ?')
      .run(Date.now(), Date.now(), row.id)
  }
  return statusOf(currentAdmission(uid, poolId)!, clientId)
}

const claimTx = db.transaction((uid: number, poolId: string, clientId: string, now: number): AdmissionRow => {
  releaseExpired(now)
  const row = currentAdmission(uid, poolId)
  if (!row) throw new Error('没有慢源观看名额')
  if (row.client_id !== clientId) throw new Error('慢源名额已由另一个播放器接管')
  if (row.state === 'waiting') throw new AdmissionRequired(statusOf(row))
  if (row.state === 'active') {
    db.prepare('UPDATE slow_admissions SET last_seen_at = ?, updated_at = ? WHERE id = ?').run(now, now, row.id)
    return currentAdmission(uid, poolId)!
  }
  if (row.state !== 'reserved' || !row.reserved_until || row.reserved_until <= now) {
    throw new Error('慢源保留名额已经失效')
  }
  if (row.ticket_id != null && !consumeTicket(row.id, now)) throw new Error('放映券状态已经变化')
  db.prepare(
    `UPDATE slow_admissions
     SET state = 'active', reserved_until = NULL, updated_at = ?, last_seen_at = ?, paused_at = NULL
     WHERE id = ? AND state = 'reserved'`,
  ).run(now, now, row.id)
  return currentAdmission(uid, poolId)!
})

export function claimAdmission(uid: number, poolId: string, clientId: string): AdmissionStatus {
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(clientId)) throw new Error('播放器会话不合法')
  return statusOf(claimTx.immediate(uid, poolId, clientId, Date.now()), clientId)
}

export function heartbeatAdmission(uid: number, poolId: string, clientId: string, paused: boolean): AdmissionStatus | null {
  sweepAdmissions()
  const row = currentAdmission(uid, poolId)
  if (!row || row.state !== 'active' || row.client_id !== clientId) return row ? statusOf(row, clientId) : null
  const now = Date.now()
  db.prepare(
    `UPDATE slow_admissions
     SET last_seen_at = ?, updated_at = ?, paused_at = ? WHERE id = ? AND state = 'active'`,
  ).run(now, now, paused ? (row.paused_at ?? now) : null, row.id)
  return statusOf(currentAdmission(uid, poolId)!, clientId)
}

export function releaseAdmission(uid: number, poolId: string, clientId: string): void {
  const row = currentAdmission(uid, poolId)
  if (!row || row.client_id !== clientId) return
  db.transaction(() => {
    if (row.state !== 'active') unlockTicket(row.id)
    db.prepare('DELETE FROM slow_admissions WHERE id = ?').run(row.id)
    if (row.state === 'active') notifyReleased(uid, poolId)
    allocateAvailable(poolId, Date.now())
  }).immediate()
}

const timer = setInterval(() => {
  try {
    sweepAdmissions()
    void deliverOfflineNotifications(Date.now())
  } catch (error) {
    console.warn('[slow-playback] 候补维护失败：', error)
  }
}, SWEEP_MS)
timer.unref?.()
