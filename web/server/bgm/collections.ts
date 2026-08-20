// BGM 动画收藏分页。收藏接口已经内嵌条目元数据，导入时绝不能再逐条请求 subject detail。
import { fetchJson } from '../http'

const HEADERS = {
  'User-Agent': 'MapleTools-Web/0.1 (https://github.com/AlcMaple/tools)',
  Accept: 'application/json',
}

export const BGM_COLLECTION_PAGE_SIZE = 50
const MIN_PAGE_PAUSE = 1000
const PAGE_PAUSE_JITTER = 1000

export type BgmCollectionErrorKind =
  | 'not_found'
  | 'private'
  | 'rate_limited'
  | 'network'
  | 'upstream'
  | 'invalid_response'

export class BgmCollectionError extends Error {
  constructor(
    message: string,
    readonly kind: BgmCollectionErrorKind,
  ) {
    super(message)
    this.name = 'BgmCollectionError'
  }
}

export interface BgmCollectionPage {
  total: number
  data: unknown[]
}

export interface BgmCollectionAnime {
  bgmId: number
  collectionType: 1 | 2 | 3 | 4 | 5
  episode: number
  title: string
  titleCn: string
  airDate: string
  score: number
  cover: string
  eps: number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// 不同用户的导入也共用同一个出口 IP。请求排成一条队列，并在上一页完成后主动休息 1~2 秒，
// 避免多个任务各自“有限速”却在全局同时起跑。
let requestTail: Promise<unknown> = Promise.resolve()
let nextRequestAt = 0

// 导出给 tracks.ts 的导入标签回填复用——那批 detail 请求必须排进同一条队列,
// 不能单开一条并发通道去砸同一个出口 IP。
export async function pacedRequest<T>(run: () => Promise<T>): Promise<T> {
  const request = requestTail.then(async () => {
    const waitMs = Math.max(0, nextRequestAt - Date.now())
    if (waitMs > 0) await sleep(waitMs)
    try {
      return await run()
    } finally {
      nextRequestAt = Date.now() + MIN_PAGE_PAUSE + Math.random() * PAGE_PAUSE_JITTER
    }
  })
  requestTail = request.then(
    () => undefined,
    () => undefined,
  )
  return request
}

function requestError(error: unknown): BgmCollectionError {
  const message = error instanceof Error ? error.message : String(error)
  if (/HTTP 404/.test(message)) {
    return new BgmCollectionError('没有找到这个 Bangumi 用户，请检查 UID 或用户名', 'not_found')
  }
  if (/HTTP 401|HTTP 403/.test(message)) {
    return new BgmCollectionError('该用户的 Bangumi 收藏未公开，无法导入', 'private')
  }
  if (/HTTP 429/.test(message)) {
    return new BgmCollectionError('Bangumi 请求过于频繁，请稍后再试', 'rate_limited')
  }
  if (/HTTP 5\d\d/.test(message)) {
    return new BgmCollectionError('Bangumi 服务暂时不可用，请稍后再试', 'upstream')
  }
  if (/timeout|aborted|TimeoutError/i.test(message)) {
    return new BgmCollectionError('连接 Bangumi 超时，请稍后再试', 'network')
  }
  if (error instanceof SyntaxError || /JSON|Unexpected (?:token|end)/i.test(message)) {
    return new BgmCollectionError('Bangumi 返回的收藏数据格式不完整，请稍后再试', 'invalid_response')
  }
  return new BgmCollectionError('无法连接 Bangumi，请检查网络后再试', 'network')
}

export async function fetchBgmCollectionPage(
  bgmUserId: string,
  offset: number,
): Promise<BgmCollectionPage> {
  const url = new URL(`https://api.bgm.tv/v0/users/${encodeURIComponent(bgmUserId)}/collections`)
  url.searchParams.set('subject_type', '2')
  url.searchParams.set('limit', String(BGM_COLLECTION_PAGE_SIZE))
  url.searchParams.set('offset', String(offset))

  let result: unknown
  try {
    result = await pacedRequest(() => fetchJson<unknown>(url.toString(), {
      headers: HEADERS,
      timeoutMs: 10000,
    }))
  } catch (error) {
    throw requestError(error)
  }

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new BgmCollectionError('Bangumi 返回的收藏数据格式不完整，请稍后再试', 'invalid_response')
  }
  const raw = result as Record<string, unknown>
  const total = Number(raw.total)
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(raw.data)) {
    throw new BgmCollectionError('Bangumi 返回的收藏数据格式不完整，请稍后再试', 'invalid_response')
  }
  return { total, data: raw.data }
}

/** 收藏行转成导入所需的最小字段。个人标签和 subject.tags 都刻意不进入该结构。 */
export function normalizeBgmCollectionAnime(raw: unknown): BgmCollectionAnime | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const bgmId = Number(row.subject_id)
  const collectionType = Number(row.type)
  const episode = Number(row.ep_status)
  if (
    !Number.isSafeInteger(bgmId) || bgmId <= 0 ||
    !Number.isInteger(collectionType) || collectionType < 1 || collectionType > 5 ||
    !Number.isInteger(episode) || episode < 0
  ) return null

  if (!row.subject || typeof row.subject !== 'object') return null
  const subject = row.subject as Record<string, unknown>
  if (subject.type !== undefined && Number(subject.type) !== 2) return null
  const images = subject.images && typeof subject.images === 'object'
    ? subject.images as Record<string, unknown>
    : {}
  const cover = ['large', 'common', 'medium']
    .map((key) => images[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim() ?? ''
  const score = Number(subject.score)
  const eps = Number(subject.eps)

  return {
    bgmId,
    collectionType: collectionType as BgmCollectionAnime['collectionType'],
    episode,
    title: typeof subject.name === 'string' ? subject.name.trim() : '',
    titleCn: typeof subject.name_cn === 'string' ? subject.name_cn.trim() : '',
    airDate: typeof subject.date === 'string' ? subject.date.trim() : '',
    score: Number.isFinite(score) && score > 0 ? score : 0,
    cover: cover.length <= 2000 ? cover : '',
    eps: Number.isInteger(eps) && eps > 0 ? eps : 0,
  }
}
