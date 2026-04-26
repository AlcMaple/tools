export interface DownloadTask {
  id: string
  source?: 'xifan' | 'girigiri' | 'aowu'
  title: string
  cover: string
  startEp: number
  endEp: number
  templates: string[]
  sourceIdx?: number
  girigiriEps?: { idx: number; name: string; url: string }[]
  // Aowu-specific: animeId + per-source full ep list (so we can switch source / retry
  // without re-fetching watch). Each source's ep list lives on the queue side.
  aowuId?: string
  aowuEps?: { idx: number; label: string }[]
  aowuSources?: { idx: number; name: string }[]
  savePath?: string
  status: 'running' | 'paused' | 'done' | 'error'
  epStatus: Record<number, 'pending' | 'downloading' | 'done' | 'error' | 'paused'>
  epProgress: Record<number, number>  // 0–99 while downloading, -1 when total size unknown, absent when done
  startedAt: number
  completedAt?: number
}

type Listener = () => void

const STORAGE_KEY = 'xifan_download_tasks_v1'
const tasks = new Map<string, DownloadTask>()
const listeners = new Set<Listener>()

function persist(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...tasks.values()]))
}

function load(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const saved = JSON.parse(raw) as DownloadTask[]
    for (const t of saved) {
      if (t.status === 'running' || t.status === 'paused') {
        // App closed while active — restore as paused so user can resume with Range continuation
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
  } catch { /* ignore corrupted data */ }
}

load()

// Heavy ep_progress events fire at >30Hz per concurrent ep. Notifying + persisting on
// every one would block the renderer's main thread (full re-render + JSON.stringify +
// localStorage write each time), making clicks like "Pause All" feel sluggish.
//
// Strategy:
//   - state transitions  → notify() : immediate listener flush + persist
//   - progress updates   → notifyProgressThrottled() : coalesce to one flush per frame,
//                                                     skip persist (progress is ephemeral —
//                                                     resume continues from on-disk size)
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
