import { ipcMain } from 'electron'
import { setMaxListeners } from 'events'
import { getCaptcha, verifyCaptcha, search, watch, giriSession } from '../girigiri/api'
import { downloadSingleEp, DlEvent } from '../girigiri/download'
import { trackSpeed, forgetTask } from '../shared/speed-tracker'
import { girigiriScheduler } from '../shared/download-scheduler'

interface GiriEpQueue {
  title: string
  epList: { idx: number; name: string; url: string }[]
  savePath: string | null
  pending: number[]
  priorityFront: number[]
  current: number | null
  currentAbort: AbortController | null
  taskPaused: boolean
  cancelled: boolean
  sender: Electron.WebContents
}

const giriEpQueues = new Map<string, GiriEpQueue>()

function startNextGiriEp(taskId: string): void {
  const q = giriEpQueues.get(taskId)
  if (!q || q.taskPaused || q.cancelled || q.current !== null) return

  const ep = q.priorityFront.shift() ?? q.pending.shift()

  if (ep === undefined) {
    giriEpQueues.delete(taskId)
    forgetTask(taskId)
    girigiriScheduler.release(taskId)
    q.sender.send('download:progress', taskId, { type: 'all_done' })
    return
  }

  const epInfo = q.epList.find((e) => e.idx === ep)
  if (!epInfo) { startNextGiriEp(taskId); return }

  // Per-source single slot: if another girigiri task is currently downloading,
  // queue this ep back up and wait for the scheduler to broadcast 'available'.
  // Cross-source concurrency (girigiri + xifan) stays allowed.
  if (!girigiriScheduler.tryAcquire(taskId)) {
    q.priorityFront.unshift(ep)
    return
  }

  const capturedEp = ep
  q.current = capturedEp
  const abort = new AbortController()
  // ~10 concurrent fetchBuffer + retry sleeps may all subscribe to the same signal.
  // Bump the limit so Node doesn't print MaxListenersExceededWarning.
  setMaxListeners(50, abort.signal)
  q.currentAbort = abort

  setImmediate(() => {
    downloadSingleEp(
      q.title, capturedEp, epInfo.name, epInfo.url,
      q.savePath ?? undefined, giriSession.getCookieString(),
      abort.signal,
      (ev: DlEvent) => {
        if (ev.type === 'ep_progress' && typeof ev.bytes === 'number') {
          trackSpeed(taskId, capturedEp, ev.bytes)
        }
        q.sender.send('download:progress', taskId, ev)
      }
    ).catch((err) => {
      // Defensive: any unexpected throw inside the download flow surfaces as ep_error
      // instead of letting an unhandled rejection slip into .finally and trigger all_done.
      console.error(`[girigiri] download crashed for ep=${capturedEp}:`, err)
      q.sender.send('download:progress', taskId, { type: 'ep_error', ep: capturedEp, msg: String(err) })
    }).finally(() => {
      if (q.currentAbort === abort) {
        q.current = null
        q.currentAbort = null
      }
      if (!q.cancelled) startNextGiriEp(taskId)
    })
  })
}

export function registerGirigiriIpc(): void {
  ipcMain.handle('girigiri:captcha', async () => getCaptcha())
  ipcMain.handle('girigiri:verify', async (_event, code: string) => verifyCaptcha(code))
  ipcMain.handle('girigiri:search', async (_event, keyword: string) => search(keyword))
  ipcMain.handle('girigiri:watch', async (_event, playUrl: string) => watch(playUrl))

  ipcMain.handle(
    'girigiri:download',
    async (event, title: string, epList: { idx: number; name: string; url: string }[], selectedIdxs: number[], savePath?: string) => {
      const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      giriEpQueues.set(taskId, {
        title, epList, savePath: savePath ?? null,
        pending: [...selectedIdxs], priorityFront: [],
        current: null, currentAbort: null, taskPaused: false, cancelled: false,
        sender: event.sender,
      })
      startNextGiriEp(taskId)
      return { started: true, taskId }
    }
  )

  ipcMain.handle('girigiri:download-cancel', (_event, taskId: string) => {
    const q = giriEpQueues.get(taskId)
    if (q) {
      q.cancelled = true
      q.currentAbort?.abort()
      giriEpQueues.delete(taskId)
      forgetTask(taskId)
    }
    girigiriScheduler.release(taskId)
    return { cancelled: true }
  })

  ipcMain.handle('girigiri:download-pause', (_event, taskId: string) => {
    const q = giriEpQueues.get(taskId)
    if (!q) return { paused: false }
    q.taskPaused = true
    if (q.current !== null) {
      const ep = q.current
      q.priorityFront.unshift(ep)
      q.sender.send('download:progress', taskId, { type: 'ep_paused', ep })
      q.currentAbort?.abort()
    }
    girigiriScheduler.release(taskId)
    return { paused: true }
  })

  ipcMain.handle('girigiri:download-resume', (event, taskId: string, title?: string, epList?: { idx: number; name: string; url: string }[], pendingEps?: number[], savePath?: string) => {
    const q = giriEpQueues.get(taskId)
    if (!q) {
      if (title && epList && pendingEps?.length) {
        giriEpQueues.set(taskId, {
          title, epList, savePath: savePath ?? null,
          pending: [...pendingEps], priorityFront: [],
          current: null, currentAbort: null, taskPaused: false, cancelled: false,
          sender: event.sender,
        })
        startNextGiriEp(taskId)
      }
      return { resumed: true }
    }
    q.taskPaused = false
    startNextGiriEp(taskId)
    return { resumed: true }
  })

  ipcMain.handle(
    'girigiri:download-requeue',
    async (event, taskId: string, title: string, epList: { idx: number; name: string; url: string }[], eps: number[], savePath?: string) => {
      giriEpQueues.set(taskId, {
        title, epList, savePath: savePath ?? null,
        pending: [...eps], priorityFront: [],
        current: null, currentAbort: null, taskPaused: false, cancelled: false,
        sender: event.sender,
      })
      startNextGiriEp(taskId)
      return { started: true }
    }
  )

  ipcMain.handle('girigiri:download-retry', (event, taskId: string, title: string, epList: { idx: number; name: string; url: string }[], failedEps: number[], savePath?: string) => {
    const q = giriEpQueues.get(taskId)
    if (!q) {
      giriEpQueues.set(taskId, {
        title, epList, savePath: savePath ?? null,
        pending: [...failedEps], priorityFront: [],
        current: null, currentAbort: null, taskPaused: false, cancelled: false,
        sender: event.sender,
      })
      startNextGiriEp(taskId)
      return { started: true }
    }
    for (const ep of [...failedEps].reverse()) q.priorityFront.unshift(ep)
    if (q.current === null && !q.taskPaused) startNextGiriEp(taskId)
    return { started: true }
  })

  // When the global slot frees up (any source releases it), retry every queued task.
  // Each call is a no-op for tasks that aren't ready, so this is safe to broadcast.
  girigiriScheduler.on('available', () => {
    for (const taskId of giriEpQueues.keys()) startNextGiriEp(taskId)
  })
}
