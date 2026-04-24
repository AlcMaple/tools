import { ipcMain } from 'electron'
import { getCaptcha, verifyCaptcha, search, watch } from '../xifan/api'
import { downloadSingleEp, cleanupParts, DlEvent } from '../xifan/download'
import { trackSpeed, forgetTask } from '../shared/speed-tracker'

interface EpQueue {
  title: string
  templates: string[]
  sourceIdx: number
  savePath: string | null
  pending: number[]
  priorityFront: number[]
  pausedEps: Set<number>
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

  let ep: number | undefined
  while (q.priorityFront.length > 0) {
    const c = q.priorityFront.shift()!
    if (!q.pausedEps.has(c)) { ep = c; break }
  }
  if (ep === undefined) {
    while (q.pending.length > 0) {
      const c = q.pending.shift()!
      if (!q.pausedEps.has(c)) { ep = c; break }
    }
  }

  if (ep === undefined) {
    if (q.pausedEps.size === 0) {
      episodeQueues.delete(taskId)
      forgetTask(taskId)
      q.sender.send('download:progress', taskId, { type: 'all_done' })
    }
    return
  }

  const capturedEp = ep
  q.current = capturedEp
  const abort = new AbortController()
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
        pending, priorityFront: [], pausedEps: new Set(),
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
    return { paused: true }
  })

  ipcMain.handle('xifan:download-resume', (event, taskId: string, title?: string, templates?: string[], pendingEps?: number[], savePath?: string, sourceIdx?: number) => {
    const q = episodeQueues.get(taskId)
    if (!q) {
      // Queue lost after app restart — recreate it and start downloading
      if (title && templates && pendingEps?.length) {
        episodeQueues.set(taskId, {
          title, templates, sourceIdx: sourceIdx ?? 0, savePath: savePath ?? null,
          pending: [...pendingEps], priorityFront: [], pausedEps: new Set(),
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

  ipcMain.handle('xifan:download-pause-ep', (_event, taskId: string, ep: number) => {
    const q = episodeQueues.get(taskId)
    if (!q) return { paused: false }
    q.pausedEps.add(ep)
    q.sender.send('download:progress', taskId, { type: 'ep_paused', ep })
    if (q.current === ep) q.currentAbort?.abort()
    return { paused: true }
  })

  ipcMain.handle('xifan:download-resume-ep', (_event, taskId: string, ep: number) => {
    const q = episodeQueues.get(taskId)
    if (!q) return { resumed: false }
    q.pausedEps.delete(ep)
    q.priorityFront.unshift(ep)
    q.sender.send('download:progress', taskId, { type: 'ep_queued', ep })
    if (q.current === null && !q.taskPaused) startNextEp(taskId)
    return { resumed: true }
  })

  ipcMain.handle(
    'xifan:download-requeue',
    async (event, taskId: string, title: string, templates: string[], eps: number[], savePath?: string, sourceIdx?: number) => {
      episodeQueues.set(taskId, {
        title, templates, sourceIdx: sourceIdx ?? 0, savePath: savePath ?? null,
        pending: [...eps], priorityFront: [], pausedEps: new Set(),
        current: null, currentAbort: null, taskPaused: false, cancelled: false,
        sender: event.sender,
      })
      startNextEp(taskId)
      return { started: true }
    }
  )

  ipcMain.handle('xifan:download-retry', (event, taskId: string, title: string, templates: string[], failedEps: number[], savePath?: string, sourceIdx?: number) => {
    const q = episodeQueues.get(taskId)
    if (!q) {
      episodeQueues.set(taskId, {
        title, templates, sourceIdx: sourceIdx ?? 0, savePath: savePath ?? null,
        pending: [...failedEps], priorityFront: [], pausedEps: new Set(),
        current: null, currentAbort: null, taskPaused: false, cancelled: false,
        sender: event.sender,
      })
      startNextEp(taskId)
      return { started: true }
    }
    if (typeof sourceIdx === 'number') q.sourceIdx = sourceIdx
    for (const ep of [...failedEps].reverse()) { q.pausedEps.delete(ep); q.priorityFront.unshift(ep) }
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
          pending: [...failedEps], priorityFront: [], pausedEps: new Set(),
          current: null, currentAbort: null, taskPaused: false, cancelled: false,
          sender: event.sender,
        })
        startNextEp(taskId)
        return { switched: true }
      }
      q.sourceIdx = newSourceIdx
      for (const ep of [...failedEps].reverse()) { q.pausedEps.delete(ep); q.priorityFront.unshift(ep) }
      if (q.current === null && !q.taskPaused) startNextEp(taskId)
      return { switched: true }
    }
  )
}
