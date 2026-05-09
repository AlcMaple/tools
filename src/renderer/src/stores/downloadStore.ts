/**
 * Download task store.
 *
 * `DownloadTask` is a discriminated union over `source`. The common fields
 * (id / title / cover / status / epStatus / ...) are the same for every site;
 * the per-source variants carry whatever each downloader needs to resume:
 *
 *   - xifan    → templates[] + sourceIdx  (sourceIdx is the templates array index)
 *   - girigiri → girigiriEps[]            (HLS m3u8, no source switching)
 *   - aowu     → aowuId + sourceIdx + aowuEps + aowuSources
 *                (sourceIdx is FantasyKon's opaque source_id, e.g. 4116)
 *
 * Tasks persist to localStorage via `download:save-state` IPC. Old tasks (saved
 * before the discriminated union landed) had a flat shape with all per-source
 * fields optional on the common type; `init()` migrates those into the new
 * shape and drops anything that can't be reconstructed.
 */

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
  /** All valid templates for the original episode set; sourceIdx picks one. */
  templates: string[]
  /** Index into `templates`. 0 if never switched. */
  sourceIdx: number
}

export interface GirigiriTaskData {
  source: 'girigiri'
  girigiriEps: { idx: number; name: string; url: string }[]
}

export interface AowuTaskData {
  source: 'aowu'
  /** Numeric video id as a string (FantasyKon's `id`), e.g. "2893". */
  aowuId: string
  /** FantasyKon source_id, e.g. 4116. NOT an index — opaque. */
  sourceIdx: number
  aowuEps: { idx: number; label: string }[]
  /** All sources discovered on the watch page, used by source-cycling UI. */
  aowuSources: { idx: number; name: string }[]
}

export type DownloadTask = TaskCommon & (XifanTaskData | GirigiriTaskData | AowuTaskData)

type Listener = () => void

const tasks = new Map<string, DownloadTask>()
const listeners = new Set<Listener>()

function persist(): void {
  window.systemApi.saveDownloadState([...tasks.values()])
}

// Heavy ep_progress events fire at >30Hz per concurrent ep. Notifying + persisting on
// every one would block the renderer's main thread (full re-render + JSON.stringify +
// IPC write each time), making clicks like "Pause All" feel sluggish.
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

/**
 * Coerce a localStorage-loaded payload (which may predate the discriminated
 * union and have missing or extra fields) into a valid DownloadTask. Returns
 * null if the task can't be reconstructed (e.g. girigiri task without
 * girigiriEps — we can't resume without the URLs).
 */
function migrateLoadedTask(raw: unknown): DownloadTask | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Partial<DownloadTask> & Record<string, unknown>
  if (typeof t.id !== 'string' || typeof t.title !== 'string') return null

  // Common fields with safe defaults.
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
    sourceIdx: typeof t.sourceIdx === 'number' ? t.sourceIdx : 0,
  }
}

export const downloadStore = {
  async init(): Promise<void> {
    try {
      const saved = await window.systemApi.loadDownloadState()
      for (const raw of (saved as unknown[])) {
        const t = migrateLoadedTask(raw)
        if (!t) continue
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
    } catch { /* ignore corrupted file */ }
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
    // Cast: TS can't prove the partial keeps the discriminator narrow, but
    // every callsite either omits `source` or passes the same one.
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
