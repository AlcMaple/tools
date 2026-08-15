import { createHmac, timingSafeEqual } from 'node:crypto'
import { db } from '../db'
import { AUTH_SECRET } from '../secrets'
import { searchAnimeTable, type AnimeHit } from './anime-search'

const TOKEN_VERSION = 1
const TOKEN_TTL_MS = 2 * 60 * 60_000
const TOKEN_PURPOSE = 'mapletools:bgm-search-addition:v1\0'
const MAX_TOKEN_LENGTH = 4096
const MAX_PAYLOAD_BYTES = 2048
const MAX_NAME_LENGTH = 512
const MAX_DATE_LENGTH = 32
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

interface AdditionTokenPayload {
  v: typeof TOKEN_VERSION
  iat: number
  exp: number
  hit: AnimeHit
}

const saveStmt = db.prepare(`
  INSERT INTO bgm_search_additions (bgm_id, name, name_cn, aliases, date, score, added_at)
  VALUES (@bgm_id, @name, @name_cn, '[]', @date, @score, @added_at)
  ON CONFLICT(bgm_id) DO UPDATE SET
    name = CASE WHEN excluded.name = '' THEN bgm_search_additions.name ELSE excluded.name END,
    name_cn = CASE WHEN excluded.name_cn = '' THEN bgm_search_additions.name_cn ELSE excluded.name_cn END,
    date = CASE WHEN excluded.date = '' THEN bgm_search_additions.date ELSE excluded.date END,
    score = CASE WHEN excluded.score = 0 THEN bgm_search_additions.score ELSE excluded.score END
`)

const enrichStmt = db.prepare(`
  UPDATE bgm_search_additions
  SET aliases = CASE WHEN @aliases = '[]' THEN aliases ELSE @aliases END,
      date = CASE WHEN @date = '' THEN date ELSE @date END
  WHERE bgm_id = @bgm_id
`)

function normalizeHit(value: unknown): AnimeHit | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!Number.isSafeInteger(raw.bgmId) || Number(raw.bgmId) <= 0) return null
  if (typeof raw.name !== 'string' || typeof raw.nameCn !== 'string' || typeof raw.date !== 'string') return null

  const name = raw.name.trim()
  const nameCn = raw.nameCn.trim()
  const date = raw.date.trim()
  if (!name && !nameCn) return null
  if (name.length > MAX_NAME_LENGTH || nameCn.length > MAX_NAME_LENGTH || date.length > MAX_DATE_LENGTH) return null

  const score = raw.score
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 10) return null
  return { bgmId: Number(raw.bgmId), name, nameCn, date, score }
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function mac(payloadB64: string): Buffer {
  return createHmac('sha256', AUTH_SECRET)
    .update(TOKEN_PURPOSE)
    .update(payloadB64)
    .digest()
}

/** 搜用户此前确实加过、但尚未进入每周离线档的 BGM 条目。 */
export function searchAdditions(query: string, limit = 30): AnimeHit[] {
  return searchAnimeTable(db, 'bgm_search_additions', query, limit)
}

/**
 * 给 BGM 在线候选签短期凭证。凭证只证明候选来自服务端，真正落库仍要等已登录用户成功新增追番。
 */
export function signSearchAddition(hit: AnimeHit, now = Date.now()): string {
  const normalized = normalizeHit(hit)
  if (!normalized) throw new TypeError('无法签发不合法的 BGM 在线候选')
  if (!validTimestamp(now)) throw new RangeError('签发时间不合法')
  const expiresAt = now + TOKEN_TTL_MS
  if (!validTimestamp(expiresAt)) throw new RangeError('签发时间超出安全范围')

  const payload: AdditionTokenPayload = {
    v: TOKEN_VERSION,
    iat: now,
    exp: expiresAt,
    hit: normalized,
  }
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8')
  if (payloadBytes.length > MAX_PAYLOAD_BYTES) throw new RangeError('BGM 在线候选凭证载荷过长')
  const payloadB64 = payloadBytes.toString('base64url')
  return `${payloadB64}.${mac(payloadB64).toString('base64url')}`
}

/**
 * 验证客户端带回的在线候选。先用定时安全比较验 HMAC，再校验版本、签发时间、有效期和路径 bgmId；
 * 返回值重新挑选并规范化字段，调用方不会直接使用客户端另带的标题。
 */
export function verifySearchAdditionToken(
  token: unknown,
  bgmId: number,
  now = Date.now(),
): AnimeHit | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null
  if (!Number.isSafeInteger(bgmId) || bgmId <= 0 || !validTimestamp(now)) return null

  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payloadB64, signatureB64] = parts
  if (!BASE64URL_RE.test(payloadB64) || !BASE64URL_RE.test(signatureB64)) return null

  const actual = Buffer.from(signatureB64, 'base64url')
  if (actual.toString('base64url') !== signatureB64) return null
  const expected = mac(payloadB64)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null

  const payloadBytes = Buffer.from(payloadB64, 'base64url')
  if (payloadBytes.length === 0 || payloadBytes.length > MAX_PAYLOAD_BYTES) return null
  if (payloadBytes.toString('base64url') !== payloadB64) return null

  let value: unknown
  try {
    value = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const payload = value as Record<string, unknown>
  if (payload.v !== TOKEN_VERSION || !validTimestamp(payload.iat) || !validTimestamp(payload.exp)) return null
  if (payload.exp <= payload.iat || payload.exp - payload.iat > TOKEN_TTL_MS) return null
  if (now < payload.iat || now >= payload.exp) return null

  const hit = normalizeHit(payload.hit)
  if (!hit || hit.bgmId !== bgmId) return null
  return hit
}

/**
 * 把验签后的候选写进全局补充表。相同 bgmId 幂等刷新公开字段，但 added_at 永远保留第一次写入值。
 */
export function saveSearchAddition(hit: AnimeHit, addedAt = Date.now()): void {
  const normalized = normalizeHit(hit)
  if (!normalized) throw new TypeError('无法保存不合法的 BGM 在线候选')
  if (!validTimestamp(addedAt)) throw new RangeError('加入时间不合法')
  saveStmt.run({
    bgm_id: normalized.bgmId,
    name: normalized.name,
    name_cn: normalized.nameCn,
    date: normalized.date,
    score: normalized.score,
    added_at: addedAt,
  })
}

/**
 * 用加番后原本就会取得的权威详情补充别名 / 日期。只更新已晋升的行，不会因详情请求单独建记录。
 */
export function enrichSearchAddition(bgmId: number, aliases: readonly string[], date = ''): void {
  if (!Number.isSafeInteger(bgmId) || bgmId <= 0) throw new RangeError('bgmId 不合法')
  if (!Array.isArray(aliases)) throw new TypeError('aliases 不合法')
  const normalizedAliases = [...new Set(
    aliases
      .filter((alias): alias is string => typeof alias === 'string')
      .map((alias) => alias.trim())
      .filter(Boolean),
  )]
  const normalizedDate = typeof date === 'string' ? date.trim() : ''
  if (normalizedDate.length > MAX_DATE_LENGTH) throw new RangeError('date 过长')
  enrichStmt.run({
    bgm_id: bgmId,
    aliases: JSON.stringify(normalizedAliases),
    date: normalizedDate,
  })
}
