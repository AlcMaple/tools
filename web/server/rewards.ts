import { randomBytes, randomInt } from 'node:crypto'
import { db } from './db'

const TAIPEI_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: process.env.REWARD_TIME_ZONE || 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const ITEM_COSTS = {
  ticket_1: 50,
  ticket_5: 200,
  priority_7d: 300,
  priority_30d: 900,
} as const

export type RewardItem = keyof typeof ITEM_COSTS

export class RewardError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 409 = 400) {
    super(message)
    this.name = 'RewardError'
  }
}

function explicitFlag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  return process.env.NODE_ENV !== 'production'
}

function allowlisted(uid: number): boolean {
  const configured = process.env.REWARD_TEST_USERS?.split(',').map((v) => v.trim()).filter(Boolean) ?? []
  if (!configured.length) return true
  const row = db.prepare('SELECT username FROM users WHERE id = ?').get(uid) as { username: string } | undefined
  return !!row && configured.some((name) => name.toLowerCase() === row.username.toLowerCase())
}

export function rewardsEnabled(uid: number): boolean {
  return explicitFlag('REWARDS_ENABLED') && allowlisted(uid)
}

export function invitesEnabled(uid: number): boolean {
  return explicitFlag('INVITES_ENABLED') && rewardsEnabled(uid)
}

export function lotteryEnabled(uid: number): boolean {
  return explicitFlag('LOTTERY_ENABLED') && rewardsEnabled(uid)
}

function pointBalance(uid: number): number {
  const row = db.prepare('SELECT COALESCE(SUM(delta), 0) AS balance FROM reward_ledger WHERE user_id = ?')
    .get(uid) as { balance: number }
  return Number(row.balance)
}

function availableTicketCount(uid: number): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM reward_entitlements WHERE user_id = ? AND kind = 'ticket' AND status = 'available'",
  ).get(uid) as { count: number }
  return Number(row.count)
}

export function hasActivePriority(uid: number, now = Date.now()): boolean {
  return !!db.prepare(
    `SELECT 1 FROM reward_entitlements
     WHERE user_id = ? AND kind = 'priority' AND status = 'active'
       AND starts_at <= ? AND ends_at > ? LIMIT 1`,
  ).get(uid, now, now)
}

function activePriorityEnd(uid: number, now = Date.now()): number | null {
  const row = db.prepare(
    `SELECT MAX(ends_at) AS ends_at FROM reward_entitlements
     WHERE user_id = ? AND kind = 'priority' AND status = 'active' AND ends_at > ?`,
  ).get(uid, now) as { ends_at: number | null }
  return row.ends_at == null ? null : Number(row.ends_at)
}

function insertLedger(uid: number, eventKey: string, kind: string, delta: number, detail: string, now: number): void {
  db.prepare(
    'INSERT INTO reward_ledger (user_id, event_key, kind, delta, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(uid, eventKey, kind, delta, detail, now)
}

function grantTickets(uid: number, count: number, source: string, sourceRef: string, now: number): void {
  const insert = db.prepare(
    `INSERT INTO reward_entitlements
      (user_id, kind, status, source, source_ref, created_at)
     VALUES (?, 'ticket', 'available', ?, ?, ?)`,
  )
  for (let i = 0; i < count; i++) insert.run(uid, source, sourceRef, now)
}

function grantPriority(uid: number, days: number, source: string, sourceRef: string, now: number): { startsAt: number; endsAt: number } {
  const startsAt = Math.max(now, activePriorityEnd(uid, now) ?? now)
  const endsAt = startsAt + days * 24 * 60 * 60 * 1000
  db.prepare(
    `INSERT INTO reward_entitlements
      (user_id, kind, status, source, source_ref, starts_at, ends_at, created_at)
     VALUES (?, 'priority', 'active', ?, ?, ?, ?, ?)`,
  ).run(uid, source, sourceRef, startsAt, endsAt, now)
  return { startsAt, endsAt }
}

export function awardDailyLogin(uid: number): void {
  if (!rewardsEnabled(uid)) return
  const day = TAIPEI_DAY.format(new Date())
  const eventKey = `daily-login:${uid}:${day}`
  db.prepare(
    `INSERT OR IGNORE INTO reward_ledger
      (user_id, event_key, kind, delta, detail, created_at)
     VALUES (?, ?, 'daily_login', 5, ?, ?)`,
  ).run(uid, eventKey, day, Date.now())
}

function newInviteCode(): string {
  return randomBytes(4).toString('hex').toUpperCase()
}

export function ensureInviteCode(uid: number): string {
  const current = db.prepare('SELECT code FROM invite_codes WHERE user_id = ?').get(uid) as { code: string } | undefined
  if (current) return current.code
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = newInviteCode()
    try {
      db.prepare('INSERT INTO invite_codes (user_id, code, created_at) VALUES (?, ?, ?)').run(uid, code, Date.now())
      return code
    } catch {
      const raced = db.prepare('SELECT code FROM invite_codes WHERE user_id = ?').get(uid) as { code: string } | undefined
      if (raced) return raced.code
    }
  }
  throw new Error('无法生成邀请码')
}

function normalizeInviteCode(code: string | undefined): string {
  const normalized = (code ?? '').trim().toUpperCase()
  return /^[A-Z0-9]{6,16}$/.test(normalized) ? normalized : ''
}

const applyInviteTx = db.transaction((inviteeId: number, rawCode: string, now: number): boolean => {
  const code = normalizeInviteCode(rawCode)
  if (!code) return false
  const owner = db.prepare('SELECT user_id FROM invite_codes WHERE code = ?').get(code) as { user_id: number } | undefined
  if (!owner || owner.user_id === inviteeId) return false
  if (db.prepare('SELECT 1 FROM invite_relations WHERE invitee_id = ?').get(inviteeId)) return false

  const monthStart = new Date(now)
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const rewarded = db.prepare(
    'SELECT COUNT(*) AS count FROM invite_relations WHERE inviter_id = ? AND rewarded = 1 AND created_at >= ?',
  ).get(owner.user_id, monthStart.getTime()) as { count: number }
  const shouldReward = Number(rewarded.count) < 10 && rewardsEnabled(owner.user_id) && rewardsEnabled(inviteeId)

  db.prepare(
    'INSERT INTO invite_relations (invitee_id, inviter_id, code, rewarded, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(inviteeId, owner.user_id, code, shouldReward ? 1 : 0, now)
  if (!shouldReward) return true

  insertLedger(owner.user_id, `invite:inviter:${inviteeId}`, 'invite_reward', 100, String(inviteeId), now)
  insertLedger(inviteeId, `invite:invitee:${inviteeId}`, 'invite_signup', 50, String(owner.user_id), now)
  return true
})

export function applyInvite(inviteeId: number, code: string | undefined): boolean {
  if (!invitesEnabled(inviteeId)) return false
  return applyInviteTx.immediate(inviteeId, code ?? '', Date.now())
}

export function rewardSummary(uid: number): {
  points: number
  tickets: number
  priorityUntil: number | null
  inviteCode: string | null
} {
  const enabled = rewardsEnabled(uid)
  return {
    points: enabled ? pointBalance(uid) : 0,
    tickets: enabled ? availableTicketCount(uid) : 0,
    priorityUntil: enabled ? activePriorityEnd(uid) : null,
    inviteCode: invitesEnabled(uid) ? ensureInviteCode(uid) : null,
  }
}

function validRequestId(value: string): boolean {
  return /^[A-Za-z0-9_-]{12,80}$/.test(value)
}

const redeemTx = db.transaction((uid: number, requestId: string, item: RewardItem, now: number): Record<string, unknown> => {
  const old = db.prepare('SELECT result_json FROM reward_redemptions WHERE user_id = ? AND request_id = ?')
    .get(uid, requestId) as { result_json: string } | undefined
  if (old) return JSON.parse(old.result_json) as Record<string, unknown>

  const cost = ITEM_COSTS[item]
  if (pointBalance(uid) < cost) throw new RewardError('积分不足', 409)
  insertLedger(uid, `redeem:${uid}:${requestId}`, 'redeem', -cost, item, now)

  let granted: Record<string, unknown>
  if (item === 'ticket_1' || item === 'ticket_5') {
    const count = item === 'ticket_1' ? 1 : 5
    grantTickets(uid, count, 'redeem', requestId, now)
    granted = { kind: 'ticket', count }
  } else {
    const days = item === 'priority_7d' ? 7 : 30
    granted = { kind: 'priority', days, ...grantPriority(uid, days, 'redeem', requestId, now) }
  }

  const result = { ok: true, item, cost, granted, points: pointBalance(uid) }
  db.prepare(
    'INSERT INTO reward_redemptions (user_id, request_id, item, result_json, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(uid, requestId, item, JSON.stringify(result), now)
  return result
})

export function redeem(uid: number, requestId: string, item: string): Record<string, unknown> {
  if (!rewardsEnabled(uid)) throw new RewardError('积分与权益功能尚未开放', 403)
  if (!validRequestId(requestId)) throw new RewardError('请求编号格式不正确')
  if (!(item in ITEM_COSTS)) throw new RewardError('兑换项目不存在')
  return redeemTx.immediate(uid, requestId, item as RewardItem, Date.now())
}

type DrawPrize = 'points_10' | 'points_20' | 'ticket_1' | 'ticket_2' | 'priority_7d' | 'priority_30d'

function drawPrize(): DrawPrize {
  const roll = randomInt(1000)
  if (roll < 450) return 'points_10'
  if (roll < 700) return 'points_20'
  if (roll < 900) return 'ticket_1'
  if (roll < 980) return 'ticket_2'
  if (roll < 998) return 'priority_7d'
  return 'priority_30d'
}

const drawTx = db.transaction((uid: number, requestId: string, now: number): Record<string, unknown> => {
  const old = db.prepare('SELECT result_json FROM draw_results WHERE user_id = ? AND request_id = ?')
    .get(uid, requestId) as { result_json: string } | undefined
  if (old) return JSON.parse(old.result_json) as Record<string, unknown>
  if (pointBalance(uid) < 20) throw new RewardError('积分不足', 409)

  insertLedger(uid, `draw:cost:${uid}:${requestId}`, 'draw_cost', -20, '', now)
  const prize = drawPrize()
  let granted: Record<string, unknown>
  if (prize === 'points_10' || prize === 'points_20') {
    const points = prize === 'points_10' ? 10 : 20
    insertLedger(uid, `draw:prize:${uid}:${requestId}`, 'draw_prize', points, prize, now)
    granted = { kind: 'points', points }
  } else if (prize === 'ticket_1' || prize === 'ticket_2') {
    const count = prize === 'ticket_1' ? 1 : 2
    grantTickets(uid, count, 'draw', requestId, now)
    granted = { kind: 'ticket', count }
  } else {
    const days = prize === 'priority_7d' ? 7 : 30
    granted = { kind: 'priority', days, ...grantPriority(uid, days, 'draw', requestId, now) }
  }

  const result = { ok: true, cost: 20, prize, granted, points: pointBalance(uid) }
  db.prepare(
    'INSERT INTO draw_results (user_id, request_id, prize, result_json, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(uid, requestId, prize, JSON.stringify(result), now)
  return result
})

export function draw(uid: number, requestId: string): Record<string, unknown> {
  if (!lotteryEnabled(uid)) throw new RewardError('幸运扭蛋尚未开放', 403)
  if (!validRequestId(requestId)) throw new RewardError('请求编号格式不正确')
  return drawTx.immediate(uid, requestId, Date.now())
}

export function existingDrawResult(uid: number, requestId: string): Record<string, unknown> | null {
  if (!validRequestId(requestId)) return null
  const row = db.prepare('SELECT result_json FROM draw_results WHERE user_id = ? AND request_id = ?')
    .get(uid, requestId) as { result_json: string } | undefined
  return row ? JSON.parse(row.result_json) as Record<string, unknown> : null
}

export function lockTicket(uid: number, lockRef: string): number | null {
  if (!rewardsEnabled(uid)) return null
  const row = db.prepare(
    `SELECT id FROM reward_entitlements
     WHERE user_id = ? AND kind = 'ticket' AND status = 'available'
     ORDER BY id LIMIT 1`,
  ).get(uid) as { id: number } | undefined
  if (!row) return null
  const changed = db.prepare(
    `UPDATE reward_entitlements SET status = 'locked', lock_ref = ?
     WHERE id = ? AND user_id = ? AND status = 'available'`,
  ).run(lockRef, row.id, uid)
  return changed.changes === 1 ? row.id : null
}

export function unlockTicket(lockRef: string): void {
  db.prepare(
    `UPDATE reward_entitlements SET status = 'available', lock_ref = NULL
     WHERE lock_ref = ? AND kind = 'ticket' AND status = 'locked'`,
  ).run(lockRef)
}

export function consumeTicket(lockRef: string, now = Date.now()): boolean {
  const changed = db.prepare(
    `UPDATE reward_entitlements SET status = 'used', used_at = ?, lock_ref = NULL
     WHERE lock_ref = ? AND kind = 'ticket' AND status = 'locked'`,
  ).run(now, lockRef)
  return changed.changes === 1
}
