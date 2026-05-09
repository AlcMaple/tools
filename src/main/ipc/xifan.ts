import { ipcMain } from 'electron'
import { getCaptcha, verifyCaptcha, search, watch } from '../xifan/api'
import { downloadSingleEp, cleanupParts } from '../xifan/download'
import { xifanScheduler } from '../shared/download-scheduler'
import { SiteQueueRegistry, newTaskId } from '../shared/site-download-queue'

interface XifanPayload {
  templates: string[]
  sourceIdx: number
}

const xifanQueue = new SiteQueueRegistry<XifanPayload>({
  prefix: 'xifan',
  scheduler: xifanScheduler,
  runEpisode: (q, ep, signal, onEvent) =>
    downloadSingleEp(
      q.title, ep, q.payload.templates, q.payload.sourceIdx,
      q.savePath ?? undefined, signal, onEvent,
    ),
})

export function registerXifanIpc(): void {
  ipcMain.handle('xifan:captcha', async () => getCaptcha())
  ipcMain.handle('xifan:verify', async (_event, code: string) => verifyCaptcha(code))
  ipcMain.handle('xifan:search', async (_event, keyword: string) => search(keyword))
  ipcMain.handle('xifan:watch', async (_event, watchUrl: string) => watch(watchUrl))

  ipcMain.handle(
    'xifan:download',
    async (event, title: string, templates: string[], startEp: number, endEp: number, savePath?: string) => {
      const taskId = newTaskId()
      const pending = Array.from({ length: endEp - startEp + 1 }, (_, i) => startEp + i)
      xifanQueue.create(taskId, {
        title,
        savePath: savePath ?? null,
        payload: { templates, sourceIdx: 0 },
        pending,
        sender: event.sender,
      })
      return { started: true, taskId }
    }
  )

  ipcMain.handle('xifan:download-cancel', (_event, taskId: string) => {
    xifanQueue.cancel(taskId)
    return { cancelled: true }
  })

  ipcMain.handle('xifan:download-pause', (_event, taskId: string) => {
    return { paused: xifanQueue.pause(taskId) }
  })

  ipcMain.handle(
    'xifan:download-resume',
    (event, taskId: string, title?: string, templates?: string[], pendingEps?: number[], savePath?: string, sourceIdx?: number) => {
      if (xifanQueue.has(taskId)) {
        xifanQueue.resume(taskId)
        return { resumed: true }
      }
      // Queue lost (e.g. after app restart) — recreate from caller-supplied state.
      if (title && templates && pendingEps?.length) {
        xifanQueue.create(taskId, {
          title,
          savePath: savePath ?? null,
          payload: { templates, sourceIdx: sourceIdx ?? 0 },
          pending: [...pendingEps],
          sender: event.sender,
        })
      }
      return { resumed: true }
    }
  )

  ipcMain.handle(
    'xifan:download-requeue',
    async (event, taskId: string, title: string, templates: string[], eps: number[], savePath?: string, sourceIdx?: number) => {
      // Defensive merge: if the queue's still alive (mid-download), don't
      // overwrite it — that would orphan the AbortController and leak the
      // in-flight ep. Append eps to the front instead.
      const q = xifanQueue.get(taskId)
      if (!q) {
        xifanQueue.create(taskId, {
          title,
          savePath: savePath ?? null,
          payload: { templates, sourceIdx: sourceIdx ?? 0 },
          pending: [...eps],
          sender: event.sender,
        })
        return { started: true }
      }
      if (typeof sourceIdx === 'number') q.payload.sourceIdx = sourceIdx
      xifanQueue.prependEps(taskId, eps)
      return { started: true }
    }
  )

  ipcMain.handle(
    'xifan:download-retry',
    (event, taskId: string, title: string, templates: string[], failedEps: number[], savePath?: string, sourceIdx?: number) => {
      const q = xifanQueue.get(taskId)
      if (!q) {
        xifanQueue.create(taskId, {
          title,
          savePath: savePath ?? null,
          payload: { templates, sourceIdx: sourceIdx ?? 0 },
          pending: [...failedEps],
          sender: event.sender,
        })
        return { started: true }
      }
      if (typeof sourceIdx === 'number') q.payload.sourceIdx = sourceIdx
      xifanQueue.prependEps(taskId, failedEps)
      return { started: true }
    }
  )

  ipcMain.handle(
    'xifan:download-switch-source',
    (event, taskId: string, title: string, templates: string[], failedEps: number[], newSourceIdx: number, savePath?: string) => {
      // Different source = different URL → existing .partN files are unusable.
      for (const ep of failedEps) cleanupParts(title, ep, savePath)
      const q = xifanQueue.get(taskId)
      if (!q) {
        xifanQueue.create(taskId, {
          title,
          savePath: savePath ?? null,
          payload: { templates, sourceIdx: newSourceIdx },
          pending: [...failedEps],
          sender: event.sender,
        })
        return { switched: true }
      }
      q.payload.sourceIdx = newSourceIdx
      xifanQueue.prependEps(taskId, failedEps)
      return { switched: true }
    }
  )
}
