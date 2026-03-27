export interface DownloadTask {
  id: string
  source?: 'xifan' | 'girigiri'
  title: string
  cover: string
  startEp: number
  endEp: number
  templates: string[]
  girigiriEps?: { idx: number; name: string; url: string }[]
  savePath?: string
  status: 'running' | 'paused' | 'done' | 'error'
  epStatus: Record<number, 'pending' | 'downloading' | 'done' | 'error' | 'paused'>
  epProgress: Record<number, number>  // 0–99 while downloading, absent when done
  startedAt: number
  completedAt?: number
  pid?: number
}

type Listener = () => void

const STORAGE_KEY = 'xifan_download_tasks_v1'
const tasks = new Map<string, DownloadTask>()
const listeners = new Set<Listener>()

function persist(): void {
  const toSave = [...tasks.values()].map((t) => ({ ...t, epProgress: {} }))
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave))
}

function load(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const saved = JSON.parse(raw) as DownloadTask[]
    for (const t of saved) {
      if (t.status === 'running' || t.status === 'paused') {
        // Process died on app close — mark unfinished eps as error so user can retry
        const newEpStatus = { ...t.epStatus }
        for (const ep of Object.keys(newEpStatus)) {
          const s = newEpStatus[Number(ep)]
          if (s === 'downloading' || s === 'pending') newEpStatus[Number(ep)] = 'error'
        }
        tasks.set(t.id, { ...t, status: 'error', epStatus: newEpStatus, epProgress: {} })
      } else {
        tasks.set(t.id, { ...t, epProgress: {} })
      }
    }
  } catch { /* ignore corrupted data */ }
}

load()

function notify(): void {
  listeners.forEach((l) => l())
  persist()
}

export const downloadStore = {
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
    tasks.set(id, { ...t, ...updates })
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
      notify()
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
    } else if (event.type === 'ep_error') {
      downloadStore.updateEpStatus(taskId, ep, 'error')
    } else if (event.type === 'ep_paused') {
      downloadStore.updateEpStatus(taskId, ep, 'paused')
    } else if (event.type === 'ep_queued') {
      downloadStore.updateEpStatus(taskId, ep, 'pending')
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
