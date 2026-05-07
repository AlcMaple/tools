import { ipcMain } from 'electron'
import { setMaxListeners } from 'events'
import { search, watch } from '../aowu/api'
import { downloadSingleEp, cleanupParts, DlEvent } from '../aowu/download'
import { resolveAowuMp4, buildAowuWatchUrl } from '../aowu/url-resolver'
import { trackSpeed, forgetTask } from '../shared/speed-tracker'
import { aowuScheduler } from '../shared/download-scheduler'

interface AowuEp {
  idx: number
  label: string
}

interface AowuEpQueue {
  title: string
  animeId: string
  sourceIdx: number
  epList: AowuEp[]
  savePath: string | null
  pending: number[]
  priorityFront: number[]
  current: number | null
  currentAbort: AbortController | null
  taskPaused: boolean
  cancelled: boolean
  sender: Electron.WebContents
}

const aowuQueues = new Map<string, AowuEpQueue>()

function startNextEp(taskId: string): void {
  const q = aowuQueues.get(taskId)
  if (!q || q.taskPaused || q.cancelled || q.current !== null) return

  const ep = q.priorityFront.shift() ?? q.pending.shift()

  if (ep === undefined) {
    aowuQueues.delete(taskId)
    forgetTask(taskId)
    aowuScheduler.release(taskId)
    q.sender.send('download:progress', taskId, { type: 'all_done' })
    return
  }

  // Per-source single slot — see download-scheduler.ts. If another aowu task holds
  // the slot, queue this ep back and wait for 'available'.
  if (!aowuScheduler.tryAcquire(taskId)) {
    q.priorityFront.unshift(ep)
    return
  }

  const epInfo = q.epList.find((e) => e.idx === ep)
  if (!epInfo) {
    aowuScheduler.release(taskId)
    if (!q.cancelled) startNextEp(taskId)
    return
  }

  const capturedEp = ep
  q.current = capturedEp
  const abort = new AbortController()
  // 8 concurrent chunks × (in-flight fetch + retry sleep) — see comment in xifan ipc.
  setMaxListeners(200, abort.signal)
  q.currentAbort = abort

  setImmediate(() => {
    downloadSingleEp(
      q.title, capturedEp, epInfo.label, q.animeId, q.sourceIdx,
      q.savePath ?? undefined, abort.signal,
      (ev: DlEvent) => {
        if (ev.type === 'ep_progress' && typeof ev.bytes === 'number') {
          trackSpeed(taskId, capturedEp, ev.bytes)
        }
        q.sender.send('download:progress', taskId, ev)
      }
    ).catch((err) => {
      console.error(`[aowu] download crashed for ep=${capturedEp}:`, err)
      q.sender.send('download:progress', taskId, { type: 'ep_error', ep: capturedEp, msg: String(err) })
    }).finally(() => {
      if (q.currentAbort === abort) {
        q.current = null
        q.currentAbort = null
      }
      if (!q.cancelled) startNextEp(taskId)
    })
  })
}

export function registerAowuIpc(): void {
  ipcMain.handle('aowu:search', async (_event, keyword: string) => search(keyword))
  ipcMain.handle('aowu:watch', async (_event, watchUrl: string) => watch(watchUrl))

  // Resolve a watch (animeId, sourceIdx, ep) tuple to the signed ByteDance CDN
  // direct URL. Used by the queue's "copy URL" feature so the user can paste
  // into external downloaders (NDM 等) and actually get the mp4. ~3-5s per call
  // because we drive the SPA in a hidden BrowserWindow and wait for <video>.src.
  ipcMain.handle(
    'aowu:resolve-mp4-url',
    async (_event, animeId: string, sourceIdx: number, ep: number): Promise<string> => {
      if (!animeId || !sourceIdx) throw new Error('Missing animeId or sourceIdx')
      if (!/^[A-Za-z0-9_-]+$/.test(animeId)) {
        throw new Error(`任务数据已过期（aowuId="${animeId}"）— 请删除该任务并重新搜索添加`)
      }
      const watchUrl = buildAowuWatchUrl(animeId, sourceIdx, ep)
      return resolveAowuMp4(watchUrl)
    }
  )

  ipcMain.handle(
    'aowu:download',
    async (event, title: string, animeId: string, sourceIdx: number, epList: AowuEp[], selectedIdxs: number[], savePath?: string) => {
      const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      aowuQueues.set(taskId, {
        title, animeId, sourceIdx, epList, savePath: savePath ?? null,
        pending: [...selectedIdxs], priorityFront: [],
        current: null, currentAbort: null, taskPaused: false, cancelled: false,
        sender: event.sender,
      })
      startNextEp(taskId)
      return { started: true, taskId }
    }
  )

  ipcMain.handle('aowu:download-cancel', (_event, taskId: string) => {
    const q = aowuQueues.get(taskId)
    if (q) {
      q.cancelled = true
      q.currentAbort?.abort()
      aowuQueues.delete(taskId)
      forgetTask(taskId)
    }
    aowuScheduler.release(taskId)
    return { cancelled: true }
  })

  ipcMain.handle('aowu:download-pause', (_event, taskId: string) => {
    const q = aowuQueues.get(taskId)
    if (!q) return { paused: false }
    q.taskPaused = true
    if (q.current !== null) {
      const ep = q.current
      q.priorityFront.unshift(ep)
      q.sender.send('download:progress', taskId, { type: 'ep_paused', ep })
      q.currentAbort?.abort()
    }
    aowuScheduler.release(taskId)
    return { paused: true }
  })

  ipcMain.handle(
    'aowu:download-resume',
    (event, taskId: string, title?: string, animeId?: string, sourceIdx?: number, epList?: AowuEp[], pendingEps?: number[], savePath?: string) => {
      const q = aowuQueues.get(taskId)
      if (!q) {
        // Queue lost (e.g. after app restart) — recreate from caller-supplied state.
        if (title && animeId && sourceIdx && epList && pendingEps?.length) {
          aowuQueues.set(taskId, {
            title, animeId, sourceIdx, epList, savePath: savePath ?? null,
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
    }
  )

  ipcMain.handle(
    'aowu:download-requeue',
    async (event, taskId: string, title: string, animeId: string, sourceIdx: number, epList: AowuEp[], eps: number[], savePath?: string) => {
      // Defensive merge — see xifan:download-requeue comment.
      const q = aowuQueues.get(taskId)
      if (!q) {
        aowuQueues.set(taskId, {
          title, animeId, sourceIdx, epList, savePath: savePath ?? null,
          pending: [...eps], priorityFront: [],
          current: null, currentAbort: null, taskPaused: false, cancelled: false,
          sender: event.sender,
        })
        startNextEp(taskId)
        return { started: true }
      }
      q.sourceIdx = sourceIdx
      q.epList = epList
      for (const ep of [...eps].reverse()) q.priorityFront.unshift(ep)
      if (q.current === null && !q.taskPaused) startNextEp(taskId)
      return { started: true }
    }
  )

  ipcMain.handle(
    'aowu:download-retry',
    (event, taskId: string, title: string, animeId: string, sourceIdx: number, epList: AowuEp[], failedEps: number[], savePath?: string) => {
      const q = aowuQueues.get(taskId)
      if (!q) {
        aowuQueues.set(taskId, {
          title, animeId, sourceIdx, epList, savePath: savePath ?? null,
          pending: [...failedEps], priorityFront: [],
          current: null, currentAbort: null, taskPaused: false, cancelled: false,
          sender: event.sender,
        })
        startNextEp(taskId)
        return { started: true }
      }
      for (const ep of [...failedEps].reverse()) q.priorityFront.unshift(ep)
      if (q.current === null && !q.taskPaused) startNextEp(taskId)
      return { started: true }
    }
  )

  ipcMain.handle(
    'aowu:download-switch-source',
    (event, taskId: string, title: string, animeId: string, newSourceIdx: number, epList: AowuEp[], failedEps: number[], savePath?: string) => {
      // Different source means a different signed mp4 URL — partial bytes are unusable.
      for (const ep of failedEps) {
        const epInfo = epList.find((e) => e.idx === ep)
        if (epInfo) cleanupParts(title, epInfo.label, savePath)
      }
      const q = aowuQueues.get(taskId)
      if (!q) {
        aowuQueues.set(taskId, {
          title, animeId, sourceIdx: newSourceIdx, epList, savePath: savePath ?? null,
          pending: [...failedEps], priorityFront: [],
          current: null, currentAbort: null, taskPaused: false, cancelled: false,
          sender: event.sender,
        })
        startNextEp(taskId)
        return { switched: true }
      }
      q.sourceIdx = newSourceIdx
      q.epList = epList
      for (const ep of [...failedEps].reverse()) q.priorityFront.unshift(ep)
      if (q.current === null && !q.taskPaused) startNextEp(taskId)
      return { switched: true }
    }
  )

  // When the global slot frees up, retry every queued task.
  aowuScheduler.on('available', () => {
    for (const taskId of aowuQueues.keys()) startNextEp(taskId)
  })
}
