import { ipcMain } from 'electron'
import { getCaptcha, verifyCaptcha, search, watch, resolveEpPlayUrl, giriSession, type GiriEpisode } from '../girigiri/api'
import { downloadSingleEp, captureM3u8 } from '../girigiri/download'
import { girigiriScheduler } from '../shared/download-scheduler'
import { SiteQueueRegistry, newTaskId } from '../shared/site-download-queue'
import { logInfo } from '../shared/logger'

interface GirigiriPayload {
  epList: GiriEpisode[]
}

const giriQueue = new SiteQueueRegistry<GirigiriPayload>({
  prefix: 'girigiri',
  scheduler: girigiriScheduler,
  runEpisode: async (q, ep, signal, onEvent) => {
    const epInfo = q.payload.epList.find((e) => e.idx === ep)
    if (!epInfo) {
      // 理论上不会走到这里(集列表由渲染层自己构造)。记一行日志后让 worker 继续下一集。
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
  ipcMain.handle('girigiri:watch', async (_event, playUrl: string, preferCache?: boolean) =>
    watch(playUrl, preferCache))

  // 在线播放:某一集的播放页 → 真实播放地址(m3u8 或 mp4)。
  //
  // 首选直接解析播放页 HTML 的 player_aaaa(一次 GET,几百毫秒),这也是唯一能拿到
  // **非 m3u8 线路**(部分老番给的是 .mp4 直链)的路子 —— 截流那条只认 *.m3u8,
  // 碰到 mp4 线路会白等到超时。兜底才退回下载器的隐藏窗口截流(站点改版时救命),
  // 播放场景等不起下载那 30s,超时收紧到 15s。失败直接抛给 UI(不自动重试,红线)。
  // 与稀饭同一套 24h 地址缓存;video 报错时传 forceRefresh 绕过缓存强刷本线路。
  ipcMain.handle('girigiri:resolve-ep-url', async (_event, epPageUrl: string, forceRefresh?: boolean) => {
    const direct = await resolveEpPlayUrl(epPageUrl, forceRefresh === true)
    if (direct) return direct
    logInfo('girigiri-resolve', `直接解析未拿到地址,退回隐藏窗口截流(15s)：${epPageUrl}`)
    const sniffed = await captureM3u8(epPageUrl, giriSession.getCookieString(), 15000)
    if (!sniffed) {
      logInfo('girigiri-resolve', `截流也未拿到地址,抛错给 UI：${epPageUrl}`)
      throw new Error('未能取到这一集的播放地址,换一条线路或稍后重试')
    }
    return sniffed
  })

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
      // 与 xifan 的 requeue 同一套防御性合并,见那边的说明。
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
