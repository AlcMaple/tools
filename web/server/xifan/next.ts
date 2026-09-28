import { NextClient, NEXT_ORIGIN, parseNextAuth, type NextAuth } from '../../shared/xifan-next'
import { proxyReady } from '../http'
import { xifanSessionFor, type XifanCookieSession, DESKTOP_UA, XifanLocalRateLimitError } from './session'

const clients = new WeakMap<XifanCookieSession, NextClient>()
let requestQueue = Promise.resolve()
let lastStarted = 0
let pending = 0
const transport: ConstructorParameters<typeof NextClient>[0] = async (url, method, headers, body, signal) => {
  if (pending >= 12) throw new XifanLocalRateLimitError()
  pending++
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
  try {
    await proxyReady
    const gate = requestQueue.then(async () => {
      const delay = 1000 - (Date.now() - lastStarted)
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      deadline.throwIfAborted()
      lastStarted = Date.now()
    })
    requestQueue = gate.catch(() => undefined)
    await gate
    const response = await fetch(url, { method, headers: { ...headers, 'User-Agent': DESKTOP_UA, Referer: `${NEXT_ORIGIN}/` }, body, redirect: 'error', signal: deadline })
    return { status: response.status, body: await response.text(), retryAfter: response.headers.get('retry-after') ?? undefined }
  } finally { pending-- }
}
const anonymous = new NextClient(transport, async () => null, async () => {})
export function nextXifan(uid: number | null = null): NextClient {
  if (uid === null) return anonymous
  const session = xifanSessionFor(uid)
  let client = clients.get(session)
  if (!client) {
    client = new NextClient(transport, async () => {
      const raw = session.getCookie('next_auth')
      return raw ? parseNextAuth(JSON.parse(raw)) : null
    }, async (auth: NextAuth | null) => session.setNextAuth(auth))
    clients.set(session, client)
  }
  return client
}
