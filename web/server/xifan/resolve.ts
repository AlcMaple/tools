// 稀饭在线观看解析 —— **懒加载版**（用户 2026-07-21 定）。
//
// 为什么懒加载：一次并行解析所有源 = 一串请求瞬间砸向稀饭，像爬虫、有触发反爬 / 限流的风险；
// 而且用户多半只看默认线路，预解析其余线路是白费。所以：
//   - 打开播放页 → `getPlaylist`：**一次抓取**（source 1 的页面）拿到「线路 1 地址 + 全部线路名单」。
//   - 用户点线路 2/3 → `resolveLine`：那时才抓那一条。
// 不再自动选最优线路，也不预探 content-disposition / HLS 空壳 —— 播放层「直连失败就套娃兜底」。
//
// **拷贝复用 + 换传输层**（ideas/012）：parsePlayerData 抄自 src/main/xifan/api.ts；
// 源 tab 名单改用正则扒（web 侧只为这几个 <a> 标签不值当加 cheerio 依赖）。

import '../http' // 副作用导入：让 undici fetch 认 HTTPS_PROXY（本地 Clash 非 TUN 时用）

// 与 app 的 DESKTOP_USER_AGENT 一致 —— 稀饭对 UA 敏感。
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const BASE_URL = 'https://anime.xifanacg.com'
const XIFAN_HEADERS: Record<string, string> = {
  'User-Agent': DESKTOP_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: `${BASE_URL}/`,
}

interface PlayerData {
  url: string
  from: string
  id: string
  vod_data?: { vod_name?: string }
}

// ↓↓↓ parsePlayerData 逐字抄自 src/main/xifan/api.ts（勿改；要改两边一起改）↓↓↓
function parsePlayerData(html: string): PlayerData | null {
  const m1 = html.match(/var player_aaaa\s*=\s*(\{.*?\})<\/script>/)
  if (m1) {
    try { return JSON.parse(m1[1]) as PlayerData } catch { /* fall through */ }
  }
  const m2 = html.match(/var player_aaaa\s*=\s*\{(.*?)\};/s)
  if (!m2) return null
  const block = m2[1]

  function getStr(key: string): string {
    const pat = new RegExp(`\\b${key}\\s*:\\s*\\n?\\s*"((?:[^"\\\\]|\\\\.)*)"`, 's')
    const r = block.match(pat)
    if (!r) return ''
    try { return JSON.parse(`"${r[1]}"`) } catch { return r[1].replace(/\\\//g, '/') }
  }

  const vodM = block.match(/vod_data\s*:\s*\{(.*?)\}/s)
  let vodName = ''
  if (vodM) {
    const nm = vodM[1].match(/\bvod_name\s*:\s*\n?\s*"((?:[^"\\]|\\.)*)"/s)
    if (nm) { try { vodName = JSON.parse(`"${nm[1]}"`) } catch { vodName = nm[1] } }
  }

  return { url: getStr('url'), from: getStr('from'), id: getStr('id'), vod_data: { vod_name: vodName } }
}
// ↑↑↑ 抄写结束 ↑↑↑

/**
 * 源 tab 名单 —— 从 source 1 页 HTML 里**正则**扒出（不引 cheerio）。一次抓取就拿到全部线路名，不逐条解析。
 * `vod-playerUrl` 是稀饭源切换 tab 专用 class；名字里的集数徽章 `<span class="badge">` 和图标 `<i>` 剥掉。
 * 扒不到就回空 → getPlaylist 兜底只留线路 1（不会崩，最多少了换线入口）。
 */
function parseSourceTabs(html: string): LineMeta[] {
  const out: LineMeta[] = []
  const re = /<a[^>]*class="[^"]*\bvod-playerUrl\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(html)) !== null) {
    const name = m[1]
      .replace(/<span[^>]*\bbadge\b[^>]*>[\s\S]*?<\/span>/gi, '') // 去集数徽章
      .replace(/<i[^>]*>[\s\S]*?<\/i>/gi, '') // 去图标
      .replace(/<[^>]*>/g, '') // 剥剩余标签
      .replace(/&nbsp;| /gi, ' ')
      .trim()
    out.push({ source: ++i, name: name || `线路${i}` })
  }
  return out
}

/** 按后缀分类（不发额外请求）。播放层据此选 <video> / hls.js。 */
function classify(url: string): 'mp4' | 'hls' {
  return /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'mp4'
}

async function fetchHtml(url: string): Promise<string> {
  const run = async (): Promise<string> => {
    const res = await fetch(url, { headers: XIFAN_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(12000) })
    return res.text()
  }
  try {
    return await run()
  } catch (err) {
    // 传输层瞬时抖动（TLS socket 断、ECONNRESET、DNS 抖）允许**单次**重试 —— AI_GUIDELINES 唯一放行的
    // 代码层重试。应用层失败（4xx/5xx）不在此列。稀饭偶发 "socket disconnected before TLS"，重试即好。
    const msg = err instanceof Error ? err.message : String(err)
    if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket disconnected|TLS|fetch failed|terminated/i.test(msg)) return run()
    throw err
  }
}

export interface LineMeta {
  source: number
  name: string
}
export interface PlayLine {
  source: number
  url: string
  kind: 'mp4' | 'hls'
}
export interface Playlist {
  title: string
  lines: LineMeta[]
  first: PlayLine | null // 线路 1（顺手解析出来，打开即可播）
}

// 进程内缓存（1h）—— 刷新 / 换人秒回。但**不预解析、不并行**：缓存的只是「已经解析过的那条」。
const cache = new Map<string, { v: unknown; at: number }>()
const TTL = 60 * 60 * 1000
function cached<T>(key: string): { hit: true; v: T } | { hit: false } {
  const h = cache.get(key)
  if (h && Date.now() - h.at < TTL) return { hit: true, v: h.v as T }
  return { hit: false }
}
function put<T>(key: string, v: T): T {
  cache.set(key, { v, at: Date.now() })
  return v
}

/** 打开播放页调这个：一次抓 source 1 → 线路 1 地址 + 全部线路名单。**不碰线路 2/3**。 */
export async function getPlaylist(animeId: string, ep: number): Promise<Playlist> {
  const key = `pl:${animeId}:${ep}`
  const c = cached<Playlist>(key)
  if (c.hit) return c.v
  const body = await fetchHtml(`${BASE_URL}/watch/${animeId}/1/${ep}.html`)
  const data = parsePlayerData(body)
  const tabs = parseSourceTabs(body)
  const url1 = data?.url ? decodeURIComponent(data.url) : ''
  const first: PlayLine | null = url1 ? { source: 1, url: url1, kind: classify(url1) } : null
  const lines = tabs.length ? tabs : first ? [{ source: 1, name: '线路1' }] : []
  return put(key, { title: data?.vod_data?.vod_name ?? '', lines, first })
}

/** 用户手动点线路 N 时才调这个：只抓那一条。 */
export async function resolveLine(animeId: string, ep: number, source: number): Promise<PlayLine | null> {
  const key = `ln:${animeId}:${ep}:${source}`
  const c = cached<PlayLine | null>(key)
  if (c.hit) return c.v
  const body = await fetchHtml(`${BASE_URL}/watch/${animeId}/${source}/${ep}.html`)
  const data = parsePlayerData(body)
  const url = data?.url ? decodeURIComponent(data.url) : ''
  return put<PlayLine | null>(key, url ? { source, url, kind: classify(url) } : null)
}
