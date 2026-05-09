import { ipcMain } from 'electron'
import { getCaptcha, verifyCaptcha, search, watch, giriSession, type GiriEpisode } from '../girigiri/api'
import { downloadSingleEp } from '../girigiri/download'
import { girigiriScheduler } from '../shared/download-scheduler'
import { SiteQueueRegistry, newTaskId } from '../shared/site-download-queue'

interface GirigiriPayload {
  epList: GiriEpisode[]
}

const giriQueue = new SiteQueueRegistry<GirigiriPayload>({
  prefix: 'girigiri',
  scheduler: girigiriScheduler,
  runEpisode: async (q, ep, signal, onEvent) => {
    const epInfo = q.payload.epList.find((e) => e.idx === ep)
    if (!epInfo) {
      // Shouldn't happen — renderer constructs epList itself. Log and let the
      // worker advance (the queue's .finally will pick up the next ep).
      console.warn(`[girigiri] ep ${ep} not in epList; skipping`)
      return
    }
    await downloadSingleEp(
      q.title, ep, epInfo.name, epInfo.url,
      q.savePath ?? undefined, giriSession.getCookieString(),
      signal, onEvent,
    )
  },
})

export function registerGirigiriIpc(): void {
  ipcMain.handle('girigiri:captcha', async () => getCaptcha())
  ipcMain.handle('girigiri:verify', async (_event, code: string) => verifyCaptcha(code))
  ipcMain.handle('girigiri:search', async (_event, keyword: string) => search(keyword))
  ipcMain.handle('girigiri:watch', async (_event, playUrl: string) => watch(playUrl))

  ipcMain.handle(
    'girigiri:download',
    async (event, title: string, epList: GiriEpisode[], selectedIdxs: number[], savePath?: string) => {
      const taskId = newTaskId()
      giriQueue.create(taskId, {
        title,
        savePath: savePath ?? null,
        payload: { epList },
        pending: [...selectedIdxs],
        sender: event.sender,
      })
      return { started: true, taskId }
    }
  )

  ipcMain.handle('girigiri:download-cancel', (_event, taskId: string) => {
    giriQueue.cancel(taskId)
    return { cancelled: true }
  })

  ipcMain.handle('girigiri:download-pause', (_event, taskId: string) => {
    return { paused: giriQueue.pause(taskId) }
  })

  ipcMain.handle(
    'girigiri:download-resume',
    (event, taskId: string, title?: string, epList?: GiriEpisode[], pendingEps?: number[], savePath?: string) => {
      if (giriQueue.has(taskId)) {
        giriQueue.resume(taskId)
        return { resumed: true }
      }
      if (title && epList && pendingEps?.length) {
        giriQueue.create(taskId, {
          title,
          savePath: savePath ?? null,
          payload: { epList },
          pending: [...pendingEps],
          sender: event.sender,
        })
      }
      return { resumed: true }
    }
  )

  ipcMain.handle(
    'girigiri:download-requeue',
    async (event, taskId: string, title: string, epList: GiriEpisode[], eps: number[], savePath?: string) => {
      // Same defensive merge as xifan:download-requeue — see comment there.
      const q = giriQueue.get(taskId)
      if (!q) {
        giriQueue.create(taskId, {
          title,
          savePath: savePath ?? null,
          payload: { epList },
          pending: [...eps],
          sender: event.sender,
        })
        return { started: true }
      }
      giriQueue.prependEps(taskId, eps)
      return { started: true }
    }
  )

  ipcMain.handle(
    'girigiri:download-retry',
    (event, taskId: string, title: string, epList: GiriEpisode[], failedEps: number[], savePath?: string) => {
      const q = giriQueue.get(taskId)
      if (!q) {
        giriQueue.create(taskId, {
          title,
          savePath: savePath ?? null,
          payload: { epList },
          pending: [...failedEps],
          sender: event.sender,
        })
        return { started: true }
      }
      giriQueue.prependEps(taskId, failedEps)
      return { started: true }
    }
  )
}
