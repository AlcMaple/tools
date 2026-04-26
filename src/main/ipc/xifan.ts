import { ipcMain } from 'electron'
import { setMaxListeners } from 'events'
import { getCaptcha, verifyCaptcha, search, watch } from '../xifan/api'
import { downloadSingleEp, cleanupParts, DlEvent } from '../xifan/download'
import { trackSpeed, forgetTask } from '../shared/speed-tracker'
import { xifanScheduler } from '../shared/download-scheduler'


interface EpQueue {
  title: string
  templates: string[]
  sourceIdx: number
  savePath: string | null
  pending: number[]
  priorityFront: number[]
  current: number | null
  currentAbort: AbortController | null
  taskPaused: boolean
  cancelled: boolean
  sender: Electron.WebContents
}

const episodeQueues = new Map<string, EpQueue>()

function startNextEp(taskId: string): void {
  const q = episodeQueues.get(taskId)
  if (!q || q.taskPaused || q.cancelled || q.current !== null) return

  const ep = q.priorityFront.shift() ?? q.pending.shift()

  if (ep === undefined) {
    episodeQueues.delete(taskId)
    forgetTask(taskId)
    xifanScheduler.release(taskId)
    q.sender.send('download:progress', taskId, { type: 'all_done' })
    return
  }

  // Per-source single slot — see download-scheduler.ts. If another xifan task
  // holds the slot, queue this ep back and bail; we'll retry when 'available' fires.
  // Cross-source concurrency (girigiri + xifan) stays allowed.
  if (!xifanScheduler.tryAcquire(taskId)) {
    q.priorityFront.unshift(ep)
    return
  }

  const capturedEp = ep
  q.current = capturedEp
  const abort = new AbortController()
  // 8 concurrent chunks × (in-flight fetch + retry sleep) all subscribe to the same signal.
  // Default cap is 10, which is borderline; give headroom so spikes don't trigger
  // MaxListenersExceededWarning during retries.
  setMaxListeners(200, abort.signal)
  q.currentAbort = abort

  setImmediate(() => {
    downloadSingleEp(q.title, capturedEp, q.templates, q.sourceIdx, q.savePath ?? undefined, abort.signal, (ev: DlEvent) => {
      if (ev.type === 'ep_progress' && typeof ev.bytes === 'number') {
        trackSpeed(taskId, capturedEp, ev.bytes)
      }
      q.sender.send('download:progress', taskId, ev)
    }).finally(() => {
      if (q.currentAbort === abort) {
        q.current = null
        q.currentAbort = null
      }
      if (!q.cancelled) startNextEp(taskId)
    })
  })
}

export function registerXifanIpc(): void {
  ipcMain.handle('xifan:captcha', async () => getCaptcha())
  ipcMain.handle('xifan:verify', async (_event, code: string) => verifyCaptcha(code))
  ipcMain.handle('xifan:search', async (_event, keyword: string) => search(keyword))
  ipcMain.handle('xifan:watch', async (_event, watchUrl: string) => watch(watchUrl))

  ipcMain.handle(
    'xifan:download',
    async (event, title: string, templates: string[], startEp: number, endEp: number, savePath?: string) => {
      const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const pending = Array.from({ length: endEp - startEp + 1 }, (_, i) => startEp + i)
      episodeQueues.set(taskId, {
        title, templates, sourceIdx: 0, savePath: savePath ?? null,
        pending, priorityFront: [],
        current: null, currentAbort: null, taskPaused: false, cancelled: false,
        sender: event.sender,
      })
      startNextEp(taskId)
      return { started: true, taskId }
    }
  )

  ipcMain.handle('xifan:download-cancel', (_event, taskId: string) => {
    const q = episodeQueues.get(taskId)
    if (q) {
      q.cancelled = true
      q.currentAbort?.abort()
      episodeQueues.delete(taskId)
      forgetTask(taskId)
    }
    xifanScheduler.release(taskId)
    return { cancelled: true }
  })

  ipcMain.handle('xifan:download-pause', (_event, taskId: string) => {
    const q = episodeQueues.get(taskId)
    if (!q) return { paused: false }
    q.taskPaused = true
    if (q.current !== null) {
      const ep = q.current
      q.priorityFront.unshift(ep)
      q.sender.send('download:progress', taskId, { type: 'ep_paused', ep })
      q.currentAbort?.abort()
    }
    xifanScheduler.release(taskId)
    return { paused: true }
  })

  ipcMain.handle('xifan:download-resume', (event, taskId: string, title?: string, templates?: string[], pendingEps?: number[], savePath?: string, sourceIdx?: number) => {
    const q = episodeQueues.get(taskId)
    if (!q) {
      // Queue lost after app restart — recreate it and start downloading
      if (title && templates && pendingEps?.length) {
        episodeQueues.set(taskId, {
          title, templates, sourceIdx: sourceIdx ?? 0, savePath: savePath ?? null,
          pending: [...pendingEps], priorityFront: [],
          current: null, currentAbort: null, taskPaused: false, cancelled: false,
          sender: event.sender,
        })
        startNextEp(taskId)
      }
      return { resumed: true }
    }
    q.taskPaused = false
    startNextEp(taskId)
    return { resumed: true }
  })

  ipcMain.handle(
    'xifan:download-requeue',
    async (event, taskId: string, title: string, templates: string[], eps: number[], savePath?: string, sourceIdx?: number) => {
      // Called from the completed-card retry path. In normal flow the queue was deleted
      // on all_done, so we recreate. But guard against a live queue: blindly overwriting
      // would orphan its AbortController and leak an in-flight download. Mirror the
      // retry handler's merge pattern instead.
      const q = episodeQueues.get(taskId)
      if (!q) {
        episodeQueues.set(taskId, {
          title, templates, sourceIdx: sourceIdx ?? 0, savePath: savePath ?? null,
          pending: [...eps], priorityFront: [],
          current: null, currentAbort: null, taskPaused: false, cancelled: false,
          sender: event.sender,
        })
        startNextEp(taskId)
        return { started: true }
      }
      if (typeof sourceIdx === 'number') q.sourceIdx = sourceIdx
      for (const ep of [...eps].reverse()) q.priorityFront.unshift(ep)
      if (q.current === null && !q.taskPaused) startNextEp(taskId)
      return { started: true }
    }
  )

  ipcMain.handle('xifan:download-retry', (event, taskId: string, title: string, templates: string[], failedEps: number[], savePath?: string, sourceIdx?: number) => {
    const q = episodeQueues.get(taskId)
    if (!q) {
      episodeQueues.set(taskId, {
        title, templates, sourceIdx: sourceIdx ?? 0, savePath: savePath ?? null,
        pending: [...failedEps], priorityFront: [],
        current: null, currentAbort: null, taskPaused: false, cancelled: false,
        sender: event.sender,
      })
      startNextEp(taskId)
      return { started: true }
    }
    if (typeof sourceIdx === 'number') q.sourceIdx = sourceIdx
    for (const ep of [...failedEps].reverse()) q.priorityFront.unshift(ep)
    if (q.current === null && !q.taskPaused) startNextEp(taskId)
    return { started: true }
  })

  ipcMain.handle(
    'xifan:download-switch-source',
    (event, taskId: string, title: string, templates: string[], failedEps: number[], newSourceIdx: number, savePath?: string) => {
      // Wipe any partial files for these eps — switching source = different URL, cannot reuse parts.
      for (const ep of failedEps) {
        cleanupParts(title, ep, savePath)
      }
      const q = episodeQueues.get(taskId)
      if (!q) {
        episodeQueues.set(taskId, {
          title, templates, sourceIdx: newSourceIdx, savePath: savePath ?? null,
          pending: [...failedEps], priorityFront: [],
          current: null, currentAbort: null, taskPaused: false, cancelled: false,
          sender: event.sender,
        })
        startNextEp(taskId)
        return { switched: true }
      }
      q.sourceIdx = newSourceIdx
      for (const ep of [...failedEps].reverse()) q.priorityFront.unshift(ep)
      if (q.current === null && !q.taskPaused) startNextEp(taskId)
      return { switched: true }
    }
  )

  // When the global slot frees up (any source releases it), retry every queued task.
  xifanScheduler.on('available', () => {
    for (const taskId of episodeQueues.keys()) startNextEp(taskId)
  })
}
