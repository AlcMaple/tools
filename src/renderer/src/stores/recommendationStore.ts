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
import { scheduleStorageWrite } from '../utils/deferredStorage'
import { reportError, backupCorrupt } from '../utils/reportError'

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
  /** 推荐方，谁推的，自由文本（"我" / "妹妹" / "群友老王"）。新建必填；
   *  老数据没有这个字段 —— normalize 给空串兜底，展示层据此退回"推荐给 X"。 */
  fromWhom: string
  /** 推荐对方，推给谁，自由文本（"Bob" / "妹妹" / "群里"）。 */
  toWhom: string
  status: RecommendationStatus
  /** 仅在 status === 'rejected' 时有意义。 */
  failReason?: string
  /** 仅在 status === 'accepted' 时有意义 —— 记「为什么这次推荐成功了」
   *  （对方正好在找新番 / 喜欢这个题材…），帮日后总结"什么样的番好推"。
   *  老的已接受记录没有这字段 → normalize 给 undefined，展示层不显示备注块。 */
  successReason?: string
  /** ISO date，便于将来排序 / 统计"推荐成功率随时间"。 */
  createdAt: string
}

const STORAGE_KEY = 'maple-anime-recommendations-v1'
const VALID_STATUS: ReadonlyArray<RecommendationStatus> = ['pending', 'accepted', 'rejected']

// 推荐给这些人时，新建即默认「已接受」—— cwj 基本来者不拒，省去每次手动标记。
// 大小写 / 首尾空格不敏感。
const AUTO_ACCEPT_RECIPIENTS: ReadonlyArray<string> = ['cwj']
function defaultStatusFor(toWhom: string): RecommendationStatus {
  return AUTO_ACCEPT_RECIPIENTS.includes(toWhom.trim().toLowerCase()) ? 'accepted' : 'pending'
}

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
      // 推荐方是后加字段:老记录没有 → 空串;展示层用空串退回"推荐给 X"。
      fromWhom: typeof r.fromWhom === 'string' ? r.fromWhom.trim() : '',
      toWhom: r.toWhom,
      status,
      failReason:
        status === 'rejected' && typeof r.failReason === 'string' && r.failReason.trim().length > 0
          ? r.failReason
          : undefined,
      // 成功原因是后加字段（blob 里老设备没有 → undefined）；只在 accepted 时保留。
      successReason:
        status === 'accepted' && typeof r.successReason === 'string' && r.successReason.trim().length > 0
          ? r.successReason
          : undefined,
      createdAt: typeof r.createdAt === 'string' && r.createdAt ? r.createdAt : new Date().toISOString(),
    })
  }
  return out
}

function readAll(): Recommendation[] {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return []
  try {
    return normalizeRecommendations(JSON.parse(raw))
  } catch (err) {
    // 解析失败不静默清空:备份坏数据 + 落盘报错(同 animeTrackStore)。
    backupCorrupt(STORAGE_KEY, raw)
    reportError('recommendationStore', err)
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
    // 同 animeTrackStore：先同步通知 UI，再把序列化 + 写盘挪到 idle 合并执行。
    this.listeners.forEach(cb => cb())
    scheduleStorageWrite(STORAGE_KEY, () => {
      if (this.cache === null) return
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.cache))
      } catch { /* ignore quota errors */ }
    })
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
    fromWhom: string
    toWhom: string
  }): Recommendation {
    const r: Recommendation = {
      id: genId(),
      bgmId: input.bgmId,
      title: input.title,
      titleCn: input.titleCn,
      cover: input.cover,
      fromWhom: input.fromWhom.trim(),
      toWhom: input.toWhom.trim(),
      // 推荐给 cwj 默认已接受；其余人仍是待回应。
      status: defaultStatusFor(input.toWhom),
      createdAt: new Date().toISOString(),
    }
    const list = this.ensure()
    list.push(r)
    this.persist()
    return r
  }

  /**
   * 标记接受，可带成功原因（可选 —— 不像拒绝那样强制）。覆盖旧的 failReason
   * （如果之前误标过 rejected）；reason 留空则清掉成功原因。
   */
  markAccepted(id: string, successReason?: string): void {
    const list = this.ensure()
    const r = list.find(x => x.id === id)
    if (!r) return
    r.status = 'accepted'
    r.failReason = undefined
    r.successReason = successReason && successReason.trim().length > 0 ? successReason.trim() : undefined
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
    r.successReason = undefined
    this.persist()
  }

  /** 改回待回应（用户误标后撤销）。清掉成功 / 失败原因。 */
  markPending(id: string): void {
    const list = this.ensure()
    const r = list.find(x => x.id === id)
    if (!r) return
    r.status = 'pending'
    r.failReason = undefined
    r.successReason = undefined
    this.persist()
  }

  /**
   * 编辑推荐方 / 推荐对方（自由文本）。主要用途：给老数据补「推荐方」，或纠正笔误。
   * toWhom 不允许清空（空串会被 normalize 丢弃），传空白则保留原值；fromWhom 允许
   * 清空（退回"推荐给 X"展示）。番剧本身（bgmId/标题）不在这里改 —— 那要重新选番。
   */
  edit(id: string, patch: { fromWhom?: string; toWhom?: string }): void {
    const list = this.ensure()
    const r = list.find(x => x.id === id)
    if (!r) return
    if (patch.fromWhom !== undefined) r.fromWhom = patch.fromWhom.trim()
    if (patch.toWhom !== undefined && patch.toWhom.trim().length > 0) r.toWhom = patch.toWhom.trim()
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
