import { safeStorage } from 'electron'
import { JsonStore } from '../shared/json-store'
import { netRequest } from '../shared/net-request'
import { DESKTOP_USER_AGENT } from '../shared/download-types'
import { RateLimiter } from '../shared/rate-limit'
import { NextClient, NEXT_ORIGIN, nextAnimeId, parseNextAuth } from '../../../web/shared/xifan-next'

const authStore = new JsonStore<string>('xifan-next-auth.json', value => typeof value === 'string' ? value : '')
const limiter = new RateLimiter({ minGapMs: 400, jitterMs: 200, name: 'xifan-next' })
const client = new NextClient(async (url, method, headers, body, signal) => {
  const response = await limiter.schedule(() => netRequest(url, { method, headers: { ...headers, 'User-Agent': DESKTOP_USER_AGENT, Referer: `${NEXT_ORIGIN}/` }, body, signal, timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024, redirect: 'manual' }))
  const retry = response.headers['retry-after']
  return { status: response.status, body: response.body.toString('utf8'), retryAfter: Array.isArray(retry) ? retry[0] : retry }
}, async () => {
  const encrypted = await authStore.read()
  if (!encrypted) return null
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据存储暂不可用')
  return parseNextAuth(JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64'))))
}, async auth => {
  if (!auth) { authStore.set(''); return }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据存储暂不可用，登录信息未保存')
  authStore.set(safeStorage.encryptString(JSON.stringify(auth)).toString('base64'))
})

export interface XifanSearchResult {
  title: string
  cover: string
  episode: string
  year: string
  area: string
  watch_url: string
  detail_url: string
}
export interface XifanSource {
  idx: number
  name: string
  template: string | null
  ep1: string
  epPage: string
  epLabels: string[]
}
export interface XifanWatchInfo { title: string; id: string; total: number; sources: XifanSource[] }
export interface XifanAuthStatus { loggedIn: boolean }

export async function getCaptcha(): Promise<{ image_b64: string }> {
  throw new Error('稀饭新版不再使用图片验证码，请使用邮箱登录')
}
export async function verifyCaptcha(_code: string): Promise<{ success: boolean }> {
  throw new Error('稀饭新版搜索无需图片验证码，请重新搜索')
}
export async function getXifanAuthStatus(): Promise<XifanAuthStatus> { return { loggedIn: await client.status() } }
export async function login(email: string, password: string, _verify: string): Promise<{ success: boolean; message: string }> {
  await client.login(email, password)
  return { success: true, message: '登录成功' }
}
export async function logout(): Promise<XifanAuthStatus> { await client.logout(); return { loggedIn: false } }
export async function search(keyword: string): Promise<XifanSearchResult[] | { needs_captcha: true }> {
  return (await client.search(keyword)).map(h => ({ title: h.title, cover: h.cover, episode: h.episode, year: h.year, area: h.area, watch_url: `${NEXT_ORIGIN}/anime/${h.id}`, detail_url: `${NEXT_ORIGIN}/anime/${h.id}` }))
}
export async function watch(watchUrl: string, _preferCache = false): Promise<XifanWatchInfo> {
  const detail = await client.detail(nextAnimeId(watchUrl))
  return {
    title: detail.title, id: String(detail.id), total: Math.max(0, ...detail.sources.flatMap(s => s.episodes.map(e => e.number))),
    sources: detail.sources.map(s => ({ idx: s.id, name: s.name, template: null, ep1: '', epPage: `${NEXT_ORIGIN}/anime/${detail.id}?sourceId=${s.id}&episode={ep}`, epLabels: Array.from({ length: Math.max(0, ...s.episodes.map(e => e.number)) }, (_, i) => s.episodes.find(e => e.number === i + 1)?.title ?? '暂无资源') })),
  }
}
export async function resolveEpPlaybackUrl(_template: string | null, epPage: string, ep: number, forceRefresh = false): Promise<string | null> {
  if (!Number.isSafeInteger(ep) || ep < 1) throw new Error('集数无效')
  const id = nextAnimeId(epPage)
  const detail = await client.detail(id, forceRefresh)
  const url = new URL(epPage)
  const sourceId = Number(url.searchParams.get('sourceId'))
  const source = url.searchParams.has('sourceId') ? detail.sources.find(s => s.id === sourceId)
    : url.searchParams.has('source') ? detail.sources.find(s => s.code === url.searchParams.get('source'))
    : detail.sources[0]
  if (!source) throw new Error('该稀饭线路已调整，请重新选择线路')
  return (await client.playback(id, ep, source.id)).url
}
export async function resolveEpRealUrl(epPage: string, ep: number): Promise<string | null> { return resolveEpPlaybackUrl(null, epPage, ep) }
export async function resolveAllSources(animeId: string, _sources: XifanSource[]): Promise<XifanSource[]> {
  return (await watch(`${NEXT_ORIGIN}/anime/${animeId}`)).sources
}
