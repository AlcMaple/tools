import { ipcMain } from 'electron'
import { getCaptcha, verifyCaptcha, search, watch, resolveEpPlayUrl, giriSession, type GiriEpisode } from '../girigiri/api'
import { downloadSingleEp, captureM3u8 } from '../girigiri/download'
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

  // 在线播放:某一集的播放页 → 真实播放地址(m3u8 或 mp4)。
  //
  // 首选直接解析播放页 HTML 的 player_aaaa(一次 GET,几百毫秒),这也是唯一能拿到
  // **非 m3u8 线路**(部分老番给的是 .mp4 直链)的路子 —— 截流那条只认 *.m3u8,
  // 碰到 mp4 线路会白等到超时。兜底才退回下载器的隐藏窗口截流(站点改版时救命),
  // 播放场景等不起下载那 30s,超时收紧到 15s。失败直接抛给 UI(不自动重试,红线)。
  ipcMain.handle('girigiri:resolve-ep-url', async (_event, epPageUrl: string) => {
    const direct = await resolveEpPlayUrl(epPageUrl)
    if (direct) return direct
    const sniffed = await captureM3u8(epPageUrl, giriSession.getCookieString(), 15000)
    if (!sniffed) throw new Error('未能取到这一集的播放地址,换一条线路或稍后重试')
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
