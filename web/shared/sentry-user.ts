export interface SentryUser {
  id: string
  username?: string
}

const USER_ID_RE = /^[1-9]\d{0,18}$/
const USERNAME_MAX = 128

function normalizeUserId(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined
  }
  return typeof value === 'string' && USER_ID_RE.test(value) ? value : undefined
}

function normalizeUsername(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim())
    .slice(0, USERNAME_MAX)
    .join('')
  return clean || undefined
}

export function sanitizeSentryUser(value: unknown): SentryUser | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { id?: unknown; uid?: unknown; username?: unknown }
  const id = normalizeUserId(candidate.id ?? candidate.uid)
  if (!id) return undefined
  const username = normalizeUsername(candidate.username)
  return username ? { id, username } : { id }
}
