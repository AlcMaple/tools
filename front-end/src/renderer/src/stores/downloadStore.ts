export interface DownloadTask {
  id: string
  title: string
  cover: string
  startEp: number
  endEp: number
  status: 'running' | 'done' | 'error'
  epStatus: Record<number, 'pending' | 'downloading' | 'done' | 'error'>
  startedAt: number
  completedAt?: number
  pid?: number
}

type Listener = () => void

const tasks = new Map<string, DownloadTask>()
const listeners = new Set<Listener>()

function notify(): void {
  listeners.forEach((l) => l())
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
    return downloadStore.getTasks().filter((t) => t.status === 'running')
  },

  getCompletedTasks(): DownloadTask[] {
    return downloadStore.getTasks().filter((t) => t.status !== 'running')
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
    status: 'pending' | 'downloading' | 'done' | 'error'
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

  handleProgressEvent(taskId: string, ev: unknown): void {
    if (!ev || typeof ev !== 'object') return
    const event = ev as Record<string, unknown>
    if (event.type === 'ep_start') {
      downloadStore.updateEpStatus(taskId, Number(event.ep), 'downloading')
    } else if (event.type === 'ep_done') {
      downloadStore.updateEpStatus(taskId, Number(event.ep), 'done')
    } else if (event.type === 'ep_error') {
      downloadStore.updateEpStatus(taskId, Number(event.ep), 'error')
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
