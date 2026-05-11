import { ipcMain } from 'electron'
import { search, watch, resolveSharePath, type AowuEpisode } from '../aowu/api'
import { downloadSingleEp, cleanupParts } from '../aowu/download'
import { resolveAowuMp4, buildAowuWatchUrl } from '../aowu/url-resolver'
import { aowuScheduler } from '../shared/download-scheduler'
import { SiteQueueRegistry, newTaskId } from '../shared/site-download-queue'

interface AowuPayload {
  animeId: string
  sourceIdx: number
  epList: AowuEpisode[]
}

const aowuQueue = new SiteQueueRegistry<AowuPayload>({
  prefix: 'aowu',
  scheduler: aowuScheduler,
  runEpisode: async (q, ep, signal, onEvent) => {
    const epInfo = q.payload.epList.find((e) => e.idx === ep)
    if (!epInfo) {
      console.warn(`[aowu] ep ${ep} not in epList; skipping`)
      return
    }
    await downloadSingleEp(
      q.title, ep, epInfo.label, q.payload.animeId, q.payload.sourceIdx,
      q.savePath ?? undefined, signal, onEvent,
    )
  },
})

export function registerAowuIpc(): void {
  // Streaming search:
  //   - Returns { requestId, results: <page 1>, total, more }.
  //   - If `more=true`, emits 'aowu:search-page' events on the same sender for
  //     each subsequent page, with payload (requestId, results, done).
  //   - The renderer should track the latest requestId and discard events from
  //     stale searches (user typing fast).
  ipcMain.handle('aowu:search', async (event, keyword: string) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const sender = event.sender
    const first = await search(keyword, {
      onPage: (results, done) => {
        if (sender.isDestroyed()) return
        sender.send('aowu:search-page', requestId, results, done)
      },
    })
    return { requestId, results: first.results, total: first.total, more: first.more }
  })

  ipcMain.handle('aowu:watch', async (_event, watchUrl: string) => watch(watchUrl))

  // Convert search-time synthetic /v/{id} URL → user-facing /w/{token} URL.
  // Used by WatchHere chips so the user lands on the SPA's real watch page
  // instead of the "页面令牌生成失败" error page. Single-shot, no caching here
  // since it's only called when the user clicks a chip (and the renderer
  // persists the resolved URL to the binding's sourceUrl after the first hit).
  ipcMain.handle('aowu:resolve-share-url', async (_event, input: string) => {
    return resolveSharePath(input)
  })

  // Resolve a watch (animeId, sourceIdx, ep) tuple to the signed ByteDance CDN
  // direct URL. Used by the queue's "copy URL" feature so the user can paste
  // into external downloaders (NDM 等) and actually get the mp4. Sub-second
  // typically — two encrypted POSTs (bundle/play → play) over the warm key cache.
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
    async (event, title: string, animeId: string, sourceIdx: number, epList: AowuEpisode[], selectedIdxs: number[], savePath?: string) => {
      const taskId = newTaskId()
      aowuQueue.create(taskId, {
        title,
        savePath: savePath ?? null,
        payload: { animeId, sourceIdx, epList },
        pending: [...selectedIdxs],
        sender: event.sender,
      })
      return { started: true, taskId }
    }
  )

  ipcMain.handle('aowu:download-cancel', (_event, taskId: string) => {
    aowuQueue.cancel(taskId)
    return { cancelled: true }
  })

  ipcMain.handle('aowu:download-pause', (_event, taskId: string) => {
    return { paused: aowuQueue.pause(taskId) }
  })

  ipcMain.handle(
    'aowu:download-resume',
    (event, taskId: string, title?: string, animeId?: string, sourceIdx?: number, epList?: AowuEpisode[], pendingEps?: number[], savePath?: string) => {
      if (aowuQueue.has(taskId)) {
        aowuQueue.resume(taskId)
        return { resumed: true }
      }
      // Queue lost (e.g. after app restart) — recreate from caller-supplied state.
      if (title && animeId && sourceIdx && epList && pendingEps?.length) {
        aowuQueue.create(taskId, {
          title,
          savePath: savePath ?? null,
          payload: { animeId, sourceIdx, epList },
          pending: [...pendingEps],
          sender: event.sender,
        })
      }
      return { resumed: true }
    }
  )

  ipcMain.handle(
    'aowu:download-requeue',
    async (event, taskId: string, title: string, animeId: string, sourceIdx: number, epList: AowuEpisode[], eps: number[], savePath?: string) => {
      // Defensive merge — see xifan:download-requeue comment.
      const q = aowuQueue.get(taskId)
      if (!q) {
        aowuQueue.create(taskId, {
          title,
          savePath: savePath ?? null,
          payload: { animeId, sourceIdx, epList },
          pending: [...eps],
          sender: event.sender,
        })
        return { started: true }
      }
      q.payload.sourceIdx = sourceIdx
      q.payload.epList = epList
      aowuQueue.prependEps(taskId, eps)
      return { started: true }
    }
  )

  ipcMain.handle(
    'aowu:download-retry',
    (event, taskId: string, title: string, animeId: string, sourceIdx: number, epList: AowuEpisode[], failedEps: number[], savePath?: string) => {
      const q = aowuQueue.get(taskId)
      if (!q) {
        aowuQueue.create(taskId, {
          title,
          savePath: savePath ?? null,
          payload: { animeId, sourceIdx, epList },
          pending: [...failedEps],
          sender: event.sender,
        })
        return { started: true }
      }
      aowuQueue.prependEps(taskId, failedEps)
      return { started: true }
    }
  )

  ipcMain.handle(
    'aowu:download-switch-source',
    (event, taskId: string, title: string, animeId: string, newSourceIdx: number, epList: AowuEpisode[], failedEps: number[], savePath?: string) => {
      // Different source = different signed mp4 URL → partial bytes are unusable.
      for (const ep of failedEps) {
        const epInfo = epList.find((e) => e.idx === ep)
        if (epInfo) cleanupParts(title, epInfo.label, savePath)
      }
      const q = aowuQueue.get(taskId)
      if (!q) {
        aowuQueue.create(taskId, {
          title,
          savePath: savePath ?? null,
          payload: { animeId, sourceIdx: newSourceIdx, epList },
          pending: [...failedEps],
          sender: event.sender,
        })
        return { switched: true }
      }
      q.payload.sourceIdx = newSourceIdx
      q.payload.epList = epList
      aowuQueue.prependEps(taskId, failedEps)
      return { switched: true }
    }
  )
}
