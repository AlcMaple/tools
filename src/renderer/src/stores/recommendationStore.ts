// 推荐记录 store —— 跟踪「我把哪部番推荐给了谁，对方接受还是拒绝了，
// 拒绝原因是啥」。目的是逐渐找到"什么样的番容易推荐成功"的规律。
//
// 设计：
//   - 一条推荐 = (bgmId, toWhom, status, [failReason])，每条独立 id
//     (Date.now() + random 拼出来，碰撞概率极低)
//   - status: pending（待回应）/ accepted（采纳）/ rejected（拒绝，必填原因）
//   - 同一部番可以推荐给多个人，所以不按 bgmId 去重
//   - localStorage 持久化，跟 animeTrackStore 同款"plain class + subscribe"模式
//   - WebDAV 同步走 anime.json blob 的新字段 recommendations（AnimeSyncBar 已扩展）

import { useEffect, useState } from 'react'

export type RecommendationStatus = 'pending' | 'accepted' | 'rejected'

export interface Recommendation {
  /** 唯一 id，本地生成，跨设备同步时保持稳定。 */
  id: string
  /** 被推荐的番剧 bgmId —— 通过 BGM 搜索弹窗选定。 */
  bgmId: number
  /** 这条 anime 的展示信息（冗余但同步起来更稳，BGM 在线查也省一次往返）。 */
  title: string
  titleCn?: string
  cover?: string
  /** 推荐给谁，自由文本（"Bob" / "妹妹" / "群里"）。 */
  toWhom: string
  status: RecommendationStatus
  /** 仅在 status === 'rejected' 时有意义。 */
  failReason?: string
  /** ISO date，便于将来排序 / 统计"推荐成功率随时间"。 */
  createdAt: string
}

const STORAGE_KEY = 'maple-anime-recommendations-v1'
const VALID_STATUS: ReadonlyArray<RecommendationStatus> = ['pending', 'accepted', 'rejected']

export function normalizeRecommendations(input: unknown): Recommendation[] {
  if (!Array.isArray(input)) return []
  const out: Recommendation[] = []
  for (const v of input) {
    if (!v || typeof v !== 'object') continue
    const r = v as Partial<Recommendation>
    if (typeof r.id !== 'string' || typeof r.bgmId !== 'number') continue
    if (typeof r.toWhom !== 'string' || r.toWhom.trim().length === 0) continue
    const status = r.status && VALID_STATUS.includes(r.status) ? r.status : 'pending'
    out.push({
      id: r.id,
      bgmId: r.bgmId,
      title: typeof r.title === 'string' ? r.title : '',
      titleCn: typeof r.titleCn === 'string' && r.titleCn.length > 0 ? r.titleCn : undefined,
      cover: typeof r.cover === 'string' && r.cover.length > 0 ? r.cover : undefined,
      toWhom: r.toWhom,
      status,
      failReason:
        status === 'rejected' && typeof r.failReason === 'string' && r.failReason.trim().length > 0
          ? r.failReason
          : undefined,
      createdAt: typeof r.createdAt === 'string' && r.createdAt ? r.createdAt : new Date().toISOString(),
    })
  }
  return out
}

function readAll(): Recommendation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    return normalizeRecommendations(JSON.parse(raw))
  } catch {
    return []
  }
}

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

class RecommendationStore {
  private cache: Recommendation[] | null = null
  private listeners = new Set<() => void>()

  private ensure(): Recommendation[] {
    if (this.cache === null) this.cache = readAll()
    return this.cache
  }

  private persist(): void {
    if (this.cache === null) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.cache))
    this.listeners.forEach(cb => cb())
  }

  list(): Recommendation[] {
    return [...this.ensure()]
  }

  /**
   * 新建一条推荐。caller 已经从 BGM 选好番剧 + 输入了 toWhom。返回新条目
   * 方便 UI 立即用到（例如关闭弹窗后给个 highlight）。
   */
  create(input: {
    bgmId: number
    title: string
    titleCn?: string
    cover?: string
    toWhom: string
  }): Recommendation {
    const r: Recommendation = {
      id: genId(),
      bgmId: input.bgmId,
      title: input.title,
      titleCn: input.titleCn,
      cover: input.cover,
      toWhom: input.toWhom.trim(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    }
    const list = this.ensure()
    list.push(r)
    this.persist()
    return r
  }

  /**
   * 标记接受。覆盖旧的 failReason（如果之前误标过 rejected）。
   */
  markAccepted(id: string): void {
    const list = this.ensure()
    const r = list.find(x => x.id === id)
    if (!r) return
    r.status = 'accepted'
    r.failReason = undefined
    this.persist()
  }

  /**
   * 标记拒绝，必须带原因。原因留空被调用方校验拦下（store 这里宽容，不强校验）。
   */
  markRejected(id: string, failReason: string): void {
    const list = this.ensure()
    const r = list.find(x => x.id === id)
    if (!r) return
    r.status = 'rejected'
    r.failReason = failReason.trim() || undefined
    this.persist()
  }

  /** 改回待回应（用户误标后撤销）。 */
  markPending(id: string): void {
    const list = this.ensure()
    const r = list.find(x => x.id === id)
    if (!r) return
    r.status = 'pending'
    r.failReason = undefined
    this.persist()
  }

  delete(id: string): boolean {
    const list = this.ensure()
    const idx = list.findIndex(x => x.id === id)
    if (idx < 0) return false
    list.splice(idx, 1)
    this.persist()
    return true
  }

  /** WebDAV pull 整盘替换 —— 跟 animeTrackStore.replaceAll 同款。 */
  replaceAll(items: Recommendation[]): void {
    this.cache = [...items]
    this.persist()
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }
}

export const recommendationStore = new RecommendationStore()

/**
 * React hook —— 订阅全部推荐列表。
 */
export function useRecommendationList(): Recommendation[] {
  const [list, setList] = useState<Recommendation[]>(() => recommendationStore.list())
  useEffect(() => {
    const unsub = recommendationStore.subscribe(() => setList(recommendationStore.list()))
    return unsub
  }, [])
  return list
}
