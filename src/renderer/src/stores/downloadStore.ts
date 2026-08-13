/**
 * 下载任务 store。
 *
 * `DownloadTask` 是按 `source` 判别的联合类型:公共字段(id / 标题 / 封面 / 状态 / 每集状态)
 * 三个站一样,各站变体带的是**各自续传所需**的东西:
 *   - xifan    → templates[] + sourceIdx(sourceIdx 是 templates 的数组下标)
 *   - girigiri → girigiriEps[](HLS,不支持换源)
 *   - aowu     → aowuId + sourceIdx + aowuEps + aowuSources
 *                (这里的 sourceIdx 是站点不透明的 source_id,**不是下标**)
 *
 * 任务通过 IPC 持久化到本地。老任务是所有字段可选的扁平结构,`init()` 会把它们迁到新形状
 * 重建不出来的直接丢弃。
 */
import { reportError } from '../utils/reportError'

interface TaskCommon {
  id: string
  title: string
  cover: string
  startEp: number
  endEp: number
  savePath?: string
  status: 'running' | 'paused' | 'done' | 'error'
  epStatus: Record<number, 'pending' | 'downloading' | 'done' | 'error' | 'paused'>
  epProgress: Record<number, number>
  startedAt: number
  completedAt?: number
}

export interface XifanTaskData {
  source: 'xifan'
  /** 原始集数范围对应的全部线路模板,sourceIdx 决定用哪一条。 */
  templates: string[]
  /** 与 templates 平行:各线路播放页的 URL 模板({ep} 占位),模板拼出来 404 时用它回源解析。 */
  epPages: string[]
  /** templates 的下标,没换过源就是 0。 */
  sourceIdx: number
  /** 主进程回源解析出的特殊集真实直链(OVA 等)。「复制 mp4 直链」优先用这里的。 */
  epUrls: Record<number, string>
}

export interface GirigiriTaskData {
  source: 'girigiri'
  girigiriEps: { idx: number; name: string; url: string }[]
}

export interface AowuTaskData {
  source: 'aowu'
  /** 站点的数字 video id(字符串形式)。 */
  aowuId: string
  /** 站点的 source_id,**不透明、不是下标**。 */
  sourceIdx: number
  aowuEps: { idx: number; label: string }[]
  /** 播放页上发现的全部线路,供换源 UI 使用。 */
  aowuSources: { idx: number; name: string }[]
}

export type DownloadTask = TaskCommon & (XifanTaskData | GirigiriTaskData | AowuTaskData)

type Listener = () => void

const tasks = new Map<string, DownloadTask>()
const listeners = new Set<Listener>()

function persist(): void {
  window.systemApi.saveDownloadState([...tasks.values()])
}

// 每个并发集的 ep_progress 事件超过 30Hz。每来一条就通知 + 落盘会卡住渲染主线程(整树重渲染 +
// 序列化 + IPC 写),点「全部暂停」都会发顿。
// 所以分两条路:**状态变化**立即 flush + 落盘;**进度更新**合并到每帧一次,并且**跳过落盘** ——
// 进度是易失的,续传本来就按磁盘上已有的字节数接着走。
let progressRaf: number | null = null

function flushListeners(): void {
  listeners.forEach((l) => l())
}

function notify(): void {
  if (progressRaf !== null) {
    cancelAnimationFrame(progressRaf)
    progressRaf = null
  }
  flushListeners()
  persist()
}

function notifyProgressThrottled(): void {
  if (progressRaf !== null) return
  progressRaf = requestAnimationFrame(() => {
    progressRaf = null
    flushListeners()
  })
}

/**
 * 把从 localStorage 读出来的旧结构收敛成合法的 DownloadTask;重建不出来的返回 null
 * (比如缺集列表的 HLS 任务 —— 没有地址就没法续传)。
 */
function migrateLoadedTask(raw: unknown): DownloadTask | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Partial<DownloadTask> & Record<string, unknown>
  if (typeof t.id !== 'string' || typeof t.title !== 'string') return null

  // 公共字段,带安全默认值。
  const common: TaskCommon = {
    id: t.id,
    title: t.title,
    cover: typeof t.cover === 'string' ? t.cover : '',
    startEp: typeof t.startEp === 'number' ? t.startEp : 1,
    endEp: typeof t.endEp === 'number' ? t.endEp : 1,
    savePath: typeof t.savePath === 'string' ? t.savePath : undefined,
    status: (t.status === 'running' || t.status === 'paused' || t.status === 'done' || t.status === 'error')
      ? t.status : 'error',
    epStatus: (t.epStatus && typeof t.epStatus === 'object') ? t.epStatus as TaskCommon['epStatus'] : {},
    epProgress: (t.epProgress && typeof t.epProgress === 'object') ? t.epProgress as TaskCommon['epProgress'] : {},
    startedAt: typeof t.startedAt === 'number' ? t.startedAt : Date.now(),
    completedAt: typeof t.completedAt === 'number' ? t.completedAt : undefined,
  }

  if (t.source === 'girigiri') {
    if (!Array.isArray(t.girigiriEps) || t.girigiriEps.length === 0) return null
    return { ...common, source: 'girigiri', girigiriEps: t.girigiriEps as GirigiriTaskData['girigiriEps'] }
  }
  if (t.source === 'aowu') {
    if (typeof t.aowuId !== 'string' || !Array.isArray(t.aowuEps) || !Array.isArray(t.aowuSources)) return null
    return {
      ...common,
      source: 'aowu',
      aowuId: t.aowuId,
      sourceIdx: typeof t.sourceIdx === 'number' ? t.sourceIdx : 1,
      aowuEps: t.aowuEps as AowuTaskData['aowuEps'],
      aowuSources: t.aowuSources as AowuTaskData['aowuSources'],
    }
  }
  // No source field, or source: 'xifan' → xifan (legacy default).
  return {
    ...common,
    source: 'xifan',
    templates: Array.isArray(t.templates) ? t.templates as string[] : [],
    epPages: Array.isArray(t.epPages) ? t.epPages as string[] : [],
    sourceIdx: typeof t.sourceIdx === 'number' ? t.sourceIdx : 0,
    epUrls: (t.epUrls && typeof t.epUrls === 'object') ? t.epUrls as Record<number, string> : {},
  }
}

export const downloadStore = {
  async init(): Promise<void> {
    try {
      const saved = await window.systemApi.loadDownloadState()
      let dropped = 0
      for (const raw of (saved as unknown[])) {
        const t = migrateLoadedTask(raw)
        if (!t) { dropped++; continue }
        if (t.status === 'running' || t.status === 'paused') {
          const newEpStatus = { ...t.epStatus }
          for (const ep of Object.keys(newEpStatus)) {
            const s = newEpStatus[Number(ep)]
            if (s === 'downloading' || s === 'pending') newEpStatus[Number(ep)] = 'paused'
          }
          tasks.set(t.id, { ...t, status: 'paused', epStatus: newEpStatus })
        } else {
          tasks.set(t.id, t)
        }
      }
      // 有任务因 schema 不全被丢弃时留痕,否则"下载任务重启后消失"无从查起。
      if (dropped > 0) reportError('downloadStore', `${dropped} 个下载任务因数据不完整无法恢复,已跳过`)
    } catch (err) {
      reportError('downloadStore', err)
    }
    flushListeners()
  },

  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },

  getTasks(): DownloadTask[] {
    return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt)
  },

  getActiveTasks(): DownloadTask[] {
    return downloadStore.getTasks().filter((t) => t.status === 'running' || t.status === 'paused')
  },

  getCompletedTasks(): DownloadTask[] {
    return downloadStore.getTasks().filter((t) => t.status === 'done' || t.status === 'error')
  },

  addTask(task: DownloadTask): void {
    tasks.set(task.id, task)
    notify()
  },

  updateTask(id: string, updates: Partial<DownloadTask>): void {
    const t = tasks.get(id)
    if (!t) return
    // TS 证明不了 partial 会保持判别字段不变,但所有调用点要么不传 source、要么传同一个。
    tasks.set(id, { ...t, ...updates } as DownloadTask)
    notify()
  },

  updateEpStatus(
    id: string,
    ep: number,
    status: 'pending' | 'downloading' | 'done' | 'error' | 'paused'
  ): void {
    const t = tasks.get(id)
    if (!t) return
    tasks.set(id, { ...t, epStatus: { ...t.epStatus, [ep]: status } })
    notify()
  },

  removeTask(id: string): void {
    tasks.delete(id)
    notify()
  },

  retryTask(id: string): void {
    const t = tasks.get(id)
    if (!t) return
    const newEpStatus = { ...t.epStatus }
    for (const ep of Object.keys(newEpStatus)) {
      if (newEpStatus[Number(ep)] === 'error' || newEpStatus[Number(ep)] === 'paused') {
        newEpStatus[Number(ep)] = 'pending'
      }
    }
    tasks.set(id, { ...t, status: 'running', epStatus: newEpStatus, completedAt: undefined })
    notify()
  },

  handleProgressEvent(taskId: string, ev: unknown): void {
    if (!ev || typeof ev !== 'object') return
    const event = ev as Record<string, unknown>
    const ep = Number(event.ep)

    if (event.type === 'ep_start') {
      const t = tasks.get(taskId)
      if (!t) return
      tasks.set(taskId, {
        ...t,
        epStatus: { ...t.epStatus, [ep]: 'downloading' },
        epProgress: { ...t.epProgress, [ep]: 0 },
      })
      notify()
    } else if (event.type === 'ep_progress') {
      const t = tasks.get(taskId)
      if (!t) return
      tasks.set(taskId, { ...t, epProgress: { ...t.epProgress, [ep]: Number(event.pct) } })
      notifyProgressThrottled()
    } else if (event.type === 'ep_done') {
      const t = tasks.get(taskId)
      if (!t) return
      const newProgress = { ...t.epProgress }
      delete newProgress[ep]
      tasks.set(taskId, {
        ...t,
        epStatus: { ...t.epStatus, [ep]: 'done' },
        epProgress: newProgress,
      })
      notify()
    } else if (event.type === 'ep_url') {
      // 主进程回源解析出某集的真实直链(OVA 等特殊集,模板拼的那条是 404),
      // 记到 epUrls,「复制 mp4 直链」优先用这条。
      const t = tasks.get(taskId)
      if (!t || t.source !== 'xifan' || typeof event.url !== 'string') return
      tasks.set(taskId, { ...t, epUrls: { ...t.epUrls, [ep]: event.url } })
      notify()
    } else if (event.type === 'ep_error') {
      downloadStore.updateEpStatus(taskId, ep, 'error')
    } else if (event.type === 'ep_paused') {
      downloadStore.updateEpStatus(taskId, ep, 'paused')
    } else if (event.type === 'all_done') {
      const t = tasks.get(taskId)
      if (!t) return
      const hasError = event.error === true || Object.values(t.epStatus).some((s) => s === 'error')
      downloadStore.updateTask(taskId, {
        status: hasError ? 'error' : 'done',
        completedAt: Date.now(),
      })
    }
  },
}
