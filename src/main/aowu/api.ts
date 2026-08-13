/**
 * 嗷呜动漫的搜索与详情。
 *
 * 站点是自研前端,所有数据都走加密的 POST /api/site/secure(协议实现见 ./secure.ts)
 * 不开浏览器。这里用到三个动作:
 *   - bundle({bundle_page:"search", anime})  搜索结果
 *   - route({token})                        URL token → 数字 video_id
 *   - bundle({bundle_page:"video", id})     详情,含线路与集数
 */
import { BASE_URL, callSecure, ERR_STRUCTURE } from './secure'

export interface AowuEpisode {
  idx: number    // ep number (1, 2, ...)
  label: string  // display label e.g. "第01话", "BD", "OVA"
}

export interface AowuSource {
  idx: number      // FantasyKon's opaque source_id (e.g. 4116) — used as #s={idx} in /w/...
  name: string     // human label e.g. "D线"
  episodes: AowuEpisode[]
}

export interface AowuSearchResult {
  title: string
  cover: string
  year: string
  area: string
  watch_url: string  // ${BASE_URL}/v/{numericId} — opaque, round-tripped to watch()
}

export interface AowuWatchInfo {
  id: string             // numeric video id as string ("2893") — passed to download.ts
  title: string
  sources: AowuSource[]
}

// ── Search ────────────────────────────────────────────────────────────────────

interface SearchListItem {
  id: number
  name?: string
  pic?: string
  year?: string | number
  area?: string
  type_name?: string
  remarks?: string
}

interface BundleSearchData {
  page: string
  data: { query: string; list: SearchListItem[]; page: number; limit: number; total: number }
}

// 防跑飞的上限。每页 10 条,10 页 = 100 条,比任何真实搜索都多;secure.ts 的节流下
// 6 页约 6~9s,封在 10 页能让最坏情况保持在 15s 以内。
const MAX_SEARCH_PAGES = 10

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

/**
 * 解 HTML 实体(命名 + 十进制/十六进制)。要迭代是因为接口偶尔返回双重编码
 * (`&amp;#039;` → `&#039;` → `'`);最多 3 轮,防病态输入死循环。
 */
function decodeEntities(s: string): string {
  let prev = ''
  let cur = s
  for (let i = 0; i < 3 && cur !== prev; i++) {
    prev = cur
    cur = cur.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
        if (Number.isFinite(n) && n >= 0 && n <= 0x10ffff) return String.fromCodePoint(n)
        return m
      }
      const repl = NAMED_ENTITIES[code.toLowerCase()]
      return repl !== undefined ? repl : m
    })
  }
  return cur
}

function toResult(it: SearchListItem): AowuSearchResult {
  return {
    title: decodeEntities(it.name ?? ''),
    cover: it.pic ?? '',
    year: it.year != null ? String(it.year) : '',
    area: it.area ?? '',
    // 以数字 id 为锚。`/v/{id}` 这个 URL 是合成的,我们从不访问它,只是把它塞回 watch()
    // 再从路径尾部读回 id。
    watch_url: `${BASE_URL}/v/${it.id}`,
  }
}

export interface SearchPaging {
  /** 后续页(2..N)到达时回调,最后一次带 done=true。 */
  onPage: (results: AowuSearchResult[], done: boolean) => void
}

export interface SearchFirstPage {
  results: AowuSearchResult[]
  total: number
  /** 为 true 表示第 2..N 页会通过 onPage 回调陆续送达。 */
  more: boolean
}

/**
 * 拉搜索结果,两种模式:
 *   - 传了 opts.onPage:只等第一页就返回,后续页走回调(每次回调之间隔着全局节流
 *     中位约 1.25s,像人在翻页)。
 *   - 没传:等所有页都到齐再返回。
 *
 * 后续页单页失败会被吞掉(记日志 + 跳过)—— 有部分结果好过没有;第一页的错误一律上抛。
 */
export async function search(
  keyword: string,
  opts?: SearchPaging
): Promise<SearchFirstPage> {
  const first = await callSecure<BundleSearchData>({
    action: 'bundle',
    params: { bundle_page: 'search', anime: keyword, page: 1 },
  })
  const inner = first?.data
  if (!inner || !Array.isArray(inner.list)) {
    throw new Error(`${ERR_STRUCTURE}: 搜索响应缺少 data.data.list`)
  }

  const limit = inner.limit > 0 ? inner.limit : 10
  const total = typeof inner.total === 'number' ? inner.total : inner.list.length
  const totalPages = Math.min(Math.ceil(total / limit), MAX_SEARCH_PAGES)
  const firstResults = inner.list.filter((it) => it && typeof it.id === 'number' && it.name).map(toResult)
  const more = totalPages > 1

  if (!more) {
    if (opts?.onPage) opts.onPage([], true)  // signal completion to streaming caller
    return { results: firstResults, total, more: false }
  }

  // 后台拉第 2..N 页。串行 —— 每次调用都过 secure.ts 的节流,相邻两次间隔 500~2000ms 随机。
  const fetchRest = async (): Promise<AowuSearchResult[]> => {
    const all: AowuSearchResult[] = []
    for (let p = 2; p <= totalPages; p++) {
      try {
        const res = await callSecure<BundleSearchData>({
          action: 'bundle',
          params: { bundle_page: 'search', anime: keyword, page: p },
        })
        const list = res?.data?.list
        if (!Array.isArray(list)) continue
        const pageResults: AowuSearchResult[] = []
        for (const it of list) {
          if (it && typeof it.id === 'number' && it.name) pageResults.push(toResult(it))
        }
        all.push(...pageResults)
        opts?.onPage?.(pageResults, /* done */ p === totalPages)
      } catch (e) {
        console.error(`[aowu] search page ${p} failed:`, e instanceof Error ? e.message : e)
        // 流式模式下提前发一次 done,让 UI 收掉 loading;错误本身不致命,已收到的结果保留。
        if (opts?.onPage && p === totalPages) opts.onPage([], true)
      }
    }
    return all
  }

  if (opts?.onPage) {
    // 流式模式:后台开始拉后续页,先把第一页返回。
    void fetchRest()
    return { results: firstResults, total, more: true }
  }

  // 批量模式:等所有页到齐。
  const rest = await fetchRest()
  return { results: [...firstResults, ...rest], total, more: false }
}

// ── Watch (detail page) ───────────────────────────────────────────────────────

interface RouteData {
  page: string
  video_id: number
}

interface BundleVideoData {
  page: string
  data: {
    video: { id: number; name: string; [k: string]: unknown }
    sources: Array<{ id: number; name: string; episodes: Array<{ id: number; no: number; name?: string }> }>
  }
}

/** 取 /v/{x} 或 /w/{x} 的路径尾部。不抛错。 */
function parsePathTail(watchUrl: string): string {
  try {
    const u = new URL(watchUrl)
    const m = /^\/(?:v|w)\/([^/?#]+)/.exec(u.pathname)
    return m ? decodeURIComponent(m[1]) : ''
  } catch {
    return ''
  }
}

/**
 * 把数字 video id(或 /v/{id} 合成 URL)解析成用户可用的 /w/{token}#s={source_id}&ep=1
 * —— 也就是站点「立即播放」按钮的落点,拿到就能直接开播。
 *
 * 必须换成 token 形式:搜索给的是 `/v/{数字id}`,那是我们自己合成的;站点真正认的是
 * 每个视频一个的不透明 token,拿数字 id 直接在浏览器里打开会得到「页面令牌生成失败」。
 *
 * 并发两个请求:route-tokens 拿 token,bundle("video") 拿 sources[0].id。
 * 后者失败(限流/网络)就退回 `/v/{token}` 列表页 —— 只要有 token 它总能打开,用户自己点
 * 「立即播放」也一样。
 *
 * 入参可以是裸数字 id、`/v/{数字id}`,或已经是 token 形式的 URL。
 */
export async function resolveSharePath(input: string): Promise<string> {
  const raw = input.trim()
  if (!raw) throw new Error('resolveSharePath: empty input')

  // 已经是 token 形式(路径尾部不是数字):要拼 /w/{token}#s=&ep= 还得先 route 回数字 id
  // 这一趟往返不划算,直接返回 /v/{token} 列表页。
  const tail = parsePathTail(raw)
  if (tail && !/^\d+$/.test(tail)) {
    return `${BASE_URL}/v/${tail}`
  }

  // 数字 id 形式,两个请求并发发。
  const id = /^\d+$/.test(raw) ? raw : tail
  if (!/^\d+$/.test(id)) {
    throw new Error(`resolveSharePath: not a numeric id or token URL: ${raw}`)
  }

  const path = `/play/${id}`
  const [tokenRes, watchInfoRes] = await Promise.allSettled([
    callSecure<unknown>({ action: 'route-tokens', params: { paths: [path] } }),
    watch(`${BASE_URL}/v/${id}`),
  ])

  if (tokenRes.status === 'rejected') {
    throw new Error(
      `${ERR_STRUCTURE}: route-tokens 调用失败 for ${path}: ${tokenRes.reason}`,
    )
  }
  const token = extractTokenFromRouteTokens(tokenRes.value, path)
  if (!token) {
    throw new Error(
      `${ERR_STRUCTURE}: route-tokens 未返回 token for ${path}; ` +
      `response shape unexpected: ${JSON.stringify(tokenRes.value).slice(0, 300)}`,
    )
  }

  // 有 token 了,再尽量拿 source_id 拼直达播放页;拿不到就退回列表页。
  if (watchInfoRes.status === 'fulfilled' && watchInfoRes.value.sources.length > 0) {
    const sourceId = watchInfoRes.value.sources[0].idx
    return `${BASE_URL}/w/${token}#s=${sourceId}&ep=1`
  }
  console.warn(
    `[aowu/resolveSharePath] watch() failed or no sources for id=${id}, ` +
    `falling back to /v/{token} listing page`,
    watchInfoRes.status === 'rejected' ? watchInfoRes.reason : '(empty sources)',
  )
  return `${BASE_URL}/v/${token}`
}

/**
 * 从 route-tokens 响应里取 token。实际形状是 `{ "/play/{id}": { token, expires_in } }`
 * 路径是顶层 key。另外几种兜底形状(扁平字符串、包在 data / tokens 下)是防接口变形;
 * 都取不到就返回 null,由调用方带上原始响应抛错。
 */
function extractTokenFromRouteTokens(res: unknown, path: string): string | null {
  if (!res || typeof res !== 'object') return null
  const r = res as Record<string, unknown>

  // entry 本身可能是字符串,也可能是 `{ token: "..." }`。
  const stringify = (v: unknown): string | null => {
    if (typeof v === 'string' && v) return v
    if (v && typeof v === 'object') {
      const tok = (v as Record<string, unknown>).token
      if (typeof tok === 'string' && tok) return tok
    }
    return null
  }

  // Primary shape (observed live): `{ "/play/14": { token, expires_in } }`
  const primary = stringify(r[path])
  if (primary) return primary

  // Fallback: `{ data: { "/play/14": <string or {token}> } }`
  const data = r.data
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    const fromData = stringify(d[path])
    if (fromData) return fromData
    // `{ data: [{ path, token }, ...] }`
    if (Array.isArray(d.tokens)) {
      for (const t of d.tokens) {
        const e = t as Record<string, unknown>
        if (e?.path === path && typeof e.token === 'string' && e.token) return e.token as string
      }
    }
    // `{ data: { tokens: { "/play/14": <...> } } }`
    if (d.tokens && typeof d.tokens === 'object') {
      const tt = d.tokens as Record<string, unknown>
      const fromTokens = stringify(tt[path])
      if (fromTokens) return fromTokens
    }
  }

  // Fallback: `{ tokens: { "/play/14": <...> } }`
  const tokens = r.tokens
  if (tokens && typeof tokens === 'object') {
    const t = tokens as Record<string, unknown>
    const fromTokens = stringify(t[path])
    if (fromTokens) return fromTokens
  }

  return null
}

/**
 * 把 watch URL(`/v/{数字id}` 或 `/v/{token}`)解析成详情。路径尾部不是数字时先 route 一次
 * 换回数字 id —— 老队列里存的就是 token 形式。
 */
export async function watch(watchUrl: string): Promise<AowuWatchInfo> {
  const tail = parsePathTail(watchUrl)
  if (!tail) throw new Error(`${ERR_STRUCTURE}: 无法从 URL 解析出 token (${watchUrl})`)

  let videoId: number
  if (/^\d+$/.test(tail)) {
    videoId = parseInt(tail, 10)
  } else {
    const route = await callSecure<RouteData>({
      action: 'route',
      params: { token: tail },
    })
    if (!route?.video_id) {
      throw new Error(`${ERR_STRUCTURE}: route 未返回 video_id (token=${tail})`)
    }
    videoId = route.video_id
  }

  const data = await callSecure<BundleVideoData>({
    action: 'bundle',
    params: { id: videoId, bundle_page: 'video' },
  })
  const inner = data?.data
  if (!inner?.video || !Array.isArray(inner.sources)) {
    throw new Error(`${ERR_STRUCTURE}: 详情响应缺少 video / sources`)
  }
  return {
    id: String(inner.video.id),
    title: decodeEntities(inner.video.name ?? ''),
    sources: inner.sources.map((s) => ({
      idx: s.id,
      name: decodeEntities(s.name ?? ''),
      episodes: (s.episodes ?? [])
        .filter((e) => e && typeof e.no === 'number')
        .map((e) => ({
          idx: e.no,
          label: decodeEntities(e.name || `第${String(e.no).padStart(2, '0')}话`),
        })),
    })),
  }
}
