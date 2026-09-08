// 仅本地开发：本机通常没有 5.6MB 的 bgm_index.db（生成它要下载 400MB+ 官方离线档）。
// 索引未就绪时，借线上公开的**离线结果**（source=local/learned，含线上做过的模糊匹配）返回候选，
// 并写入本地补充表供后续追番添加读取。生产有自己的索引（indexStatus().ready 为 true），永不进入
// 这条路径；这里不碰 BGM 在线搜索，追番写入、登录和播放会话仍全部本地。
import { indexStatus } from './anime-index'
import { saveSearchAddition } from './search-additions'
import type { AnimeHit } from './anime-search'

const ORIGIN = process.env.DEV_SEARCH_ORIGIN || 'https://anime.alcmaple.cn'
const isDev = () => process.env.NODE_ENV !== 'production' && !process.env.VERCEL

/**
 * 借回线上离线候选（线上已按名字模糊匹配），写入 bgm_search_additions，并返回这批命中。
 * 非 dev 或索引已就绪时返回空数组。
 */
export async function borrowDeployedOfflineSearch(query: string): Promise<AnimeHit[]> {
  if (!isDev() || indexStatus().ready || !query.trim()) return []
  try {
    const url = new URL('/api/search', ORIGIN)
    url.searchParams.set('q', query.trim().slice(0, 120))
    url.searchParams.set('mode', 'local')
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) })
    if (!response.ok) return []
    const data = await response.json() as { ready?: unknown; source?: unknown; data?: unknown }
    // 只收离线来源；当前对端 mode=local 不会在线兜底，这是对旧版本的防御。
    if (data.ready !== true || !['local', 'learned'].includes(String(data.source)) || !Array.isArray(data.data)) return []
    const hits: AnimeHit[] = []
    for (const raw of data.data.slice(0, 30)) {
      const hit = raw as Record<string, unknown>
      if (!Number.isSafeInteger(hit.bgmId) || Number(hit.bgmId) <= 0) continue
      const normalized: AnimeHit = {
        bgmId: Number(hit.bgmId), name: String(hit.name ?? ''), nameCn: String(hit.nameCn ?? ''),
        date: String(hit.date ?? ''), score: Number(hit.score) || 0,
      }
      if (!normalized.name && !normalized.nameCn) continue
      try { saveSearchAddition(normalized); hits.push(normalized) } catch { /* 跳过不合法候选 */ }
    }
    return hits
  } catch {
    return []
  }
}
