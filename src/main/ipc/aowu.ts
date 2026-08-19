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
  // 流式搜索:返回第一页 + requestId;`more=true` 时后续每页通过事件发回。
  // 渲染层要记住最新的 requestId 并丢弃旧搜索的事件(用户打字快时会有)。
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

  // 把搜索期的合成 URL 换成用户可用的观看页 URL —— 否则用户点开会落到「页面令牌生成失败」。
  // 这里不缓存:只有用户点 chip 时才调,而渲染层拿到结果后会持久化进 binding。
  ipcMain.handle('aowu:resolve-share-url', async (_event, input: string) => {
    return resolveSharePath(input)
  })

  // 把 (animeId, 线路, 集数) 解析成签名后的 CDN 直链,供队列的「复制链接」用 ——
  // 用户粘进外部下载器才拿得到真正的 mp4。
  ipcMain.handle(
    'aowu:resolve-mp4-url',
    async (_event, animeId: string, sourceIdx: number, ep: number, forceRefresh = false): Promise<string> => {
      if (!animeId || !sourceIdx) throw new Error('Missing animeId or sourceIdx')
      if (!/^[A-Za-z0-9_-]+$/.test(animeId)) {
        throw new Error(`任务数据已过期（aowuId="${animeId}"）— 请删除该任务并重新搜索添加`)
      }
      const watchUrl = buildAowuWatchUrl(animeId, sourceIdx, ep)
      return resolveAowuMp4(watchUrl, forceRefresh)
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
      // 队列丢了(比如应用重启过)—— 用调用方带来的状态重建。
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
      // 防御性合并 —— 见 xifan 那边同名 handler 的说明。
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
