import { ipcMain } from 'electron'
import { getCaptcha, verifyCaptcha, search, watch, giriSession } from '../girigiri/api'
import { downloadSingleEp, DlEvent } from '../girigiri/download'
import { trackSpeed, forgetTask } from '../shared/speed-tracker'

interface GiriEpQueue {
  title: string
  epList: { idx: number; name: string; url: string }[]
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

const giriEpQueues = new Map<string, GiriEpQueue>()

function startNextGiriEp(taskId: string): void {
  const q = giriEpQueues.get(taskId)
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
      giriEpQueues.delete(taskId)
      forgetTask(taskId)
      q.sender.send('download:progress', taskId, { type: 'all_done' })
    }
    return
  }

  const epInfo = q.epList.find((e) => e.idx === ep)
  if (!epInfo) { startNextGiriEp(taskId); return }

  const capturedEp = ep
  q.current = capturedEp
  const abort = new AbortController()
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
        pending: [...selectedIdxs], priorityFront: [], pausedEps: new Set(),
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
    return { paused: true }
  })

  ipcMain.handle('girigiri:download-resume', (event, taskId: string, title?: string, epList?: { idx: number; name: string; url: string }[], pendingEps?: number[], savePath?: string) => {
    const q = giriEpQueues.get(taskId)
    if (!q) {
      if (title && epList && pendingEps?.length) {
        giriEpQueues.set(taskId, {
          title, epList, savePath: savePath ?? null,
          pending: [...pendingEps], priorityFront: [], pausedEps: new Set(),
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

  ipcMain.handle('girigiri:download-pause-ep', (_event, taskId: string, ep: number) => {
    const q = giriEpQueues.get(taskId)
    if (!q) return { paused: false }
    q.pausedEps.add(ep)
    q.sender.send('download:progress', taskId, { type: 'ep_paused', ep })
    if (q.current === ep) q.currentAbort?.abort()
    return { paused: true }
  })

  ipcMain.handle('girigiri:download-resume-ep', (_event, taskId: string, ep: number) => {
    const q = giriEpQueues.get(taskId)
    if (!q) return { resumed: false }
    q.pausedEps.delete(ep)
    q.priorityFront.unshift(ep)
    q.sender.send('download:progress', taskId, { type: 'ep_queued', ep })
    if (q.current === null && !q.taskPaused) startNextGiriEp(taskId)
    return { resumed: true }
  })

  ipcMain.handle(
    'girigiri:download-requeue',
    async (event, taskId: string, title: string, epList: { idx: number; name: string; url: string }[], eps: number[], savePath?: string) => {
      giriEpQueues.set(taskId, {
        title, epList, savePath: savePath ?? null,
        pending: [...eps], priorityFront: [], pausedEps: new Set(),
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
        pending: [...failedEps], priorityFront: [], pausedEps: new Set(),
        current: null, currentAbort: null, taskPaused: false, cancelled: false,
        sender: event.sender,
      })
      startNextGiriEp(taskId)
      return { started: true }
    }
    for (const ep of [...failedEps].reverse()) { q.pausedEps.delete(ep); q.priorityFront.unshift(ep) }
    if (q.current === null && !q.taskPaused) startNextGiriEp(taskId)
    return { started: true }
  })
}
