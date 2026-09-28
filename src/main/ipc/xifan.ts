import { ipcMain } from 'electron'
import {
  getCaptcha, verifyCaptcha, search, watch, resolveEpRealUrl, resolveEpPlaybackUrl, resolveAllSources,
  getXifanAuthStatus, login, logout,
} from '../xifan/api'
import type { XifanSource } from '../xifan/api'
import { downloadSingleEp, cleanupParts } from '../xifan/download'
import { xifanScheduler } from '../shared/download-scheduler'
import { SiteQueueRegistry, newTaskId } from '../shared/site-download-queue'

interface XifanPayload {
  templates: string[]
  // 与 templates 同序；新版由这里的番剧和线路定位逐集签发。
  epPages: string[]
  sourceIdx: number
}

const xifanQueue = new SiteQueueRegistry<XifanPayload>({
  prefix: 'xifan',
  scheduler: xifanScheduler,
  runEpisode: (q, ep, signal, onEvent) =>
    downloadSingleEp(
      q.title, ep, q.payload.templates, q.payload.sourceIdx, q.payload.epPages,
      q.savePath ?? undefined, signal, onEvent,
    ),
})

export function registerXifanIpc(): void {
  ipcMain.handle('xifan:captcha', async () => getCaptcha())
  ipcMain.handle('xifan:verify', async (_event, code: string) => verifyCaptcha(code))
  ipcMain.handle('xifan:search', async (_event, keyword: string) => search(keyword))

  // ── 账号登录(收藏/签到等站内功能用) ─────────────────────────────────────
  ipcMain.handle('xifan:auth-status', async () => getXifanAuthStatus())
  ipcMain.handle(
    'xifan:login',
    async (_event, username: string, password: string, verify: string) => login(username, password, verify),
  )
  ipcMain.handle('xifan:logout', async () => logout())

  ipcMain.handle('xifan:watch', async (_event, watchUrl: string, preferCache?: boolean) =>
    watch(watchUrl, preferCache))
  // 复制媒体地址与下载共用逐集解析，避免继续使用旧站的文件名模板。
  ipcMain.handle('xifan:resolve-ep-url', async (_event, epPage: string, ep: number) =>
    resolveEpRealUrl(epPage, ep))
  // 新版媒体地址逐集签发，旧版 URL 模板和磁盘缓存不再作为播放依据。
  ipcMain.handle(
    'xifan:resolve-play-url',
    async (_event, template: string | null, epPage: string, ep: number, forceRefresh?: boolean) =>
      resolveEpPlaybackUrl(template, epPage, ep, forceRefresh === true),
  )
  // 下载面板复用详情中的线路和选集；不预先签发所有线路的媒体地址。
  // 播放器**不**调这个 —— 它按需惰性解析。
  ipcMain.handle('xifan:resolve-all-sources', async (_event, animeId: string, sources: XifanSource[]) =>
    resolveAllSources(animeId, sources))

  ipcMain.handle(
    'xifan:download',
    async (event, title: string, templates: string[], startEp: number, endEp: number, savePath?: string, excludeEps?: number[], epPages?: string[]) => {
      const taskId = newTaskId()
      const skip = new Set(excludeEps ?? [])
      const pending = Array.from({ length: endEp - startEp + 1 }, (_, i) => startEp + i)
        .filter((ep) => !skip.has(ep))
      xifanQueue.create(taskId, {
        title,
        savePath: savePath ?? null,
        payload: { templates, epPages: epPages ?? [], sourceIdx: 0 },
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
    (event, taskId: string, title?: string, templates?: string[], pendingEps?: number[], savePath?: string, sourceIdx?: number, epPages?: string[]) => {
      if (xifanQueue.has(taskId)) {
        xifanQueue.resume(taskId)
        return { resumed: true }
      }
      // 队列丢了(比如应用重启过)—— 用调用方带来的状态重建。
      if (title && templates && pendingEps?.length) {
        xifanQueue.create(taskId, {
          title,
          savePath: savePath ?? null,
          payload: { templates, epPages: epPages ?? [], sourceIdx: sourceIdx ?? 0 },
          pending: [...pendingEps],
          sender: event.sender,
        })
      }
      return { resumed: true }
    }
  )

  ipcMain.handle(
    'xifan:download-requeue',
    async (event, taskId: string, title: string, templates: string[], eps: number[], savePath?: string, sourceIdx?: number, epPages?: string[]) => {
      // 防御性合并:队列还活着(正在下载中)就不要覆盖它,否则会把 AbortController 弄丢、
      const q = xifanQueue.get(taskId)
      if (!q) {
        xifanQueue.create(taskId, {
          title,
          savePath: savePath ?? null,
          payload: { templates, epPages: epPages ?? [], sourceIdx: sourceIdx ?? 0 },
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
    (event, taskId: string, title: string, templates: string[], failedEps: number[], savePath?: string, sourceIdx?: number, epPages?: string[]) => {
      const q = xifanQueue.get(taskId)
      if (!q) {
        xifanQueue.create(taskId, {
          title,
          savePath: savePath ?? null,
          payload: { templates, epPages: epPages ?? [], sourceIdx: sourceIdx ?? 0 },
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
    (event, taskId: string, title: string, templates: string[], failedEps: number[], newSourceIdx: number, savePath?: string, epPages?: string[]) => {
      // Different source = different URL → existing .partN files are unusable.
      for (const ep of failedEps) cleanupParts(title, ep, savePath)
      const q = xifanQueue.get(taskId)
      if (!q) {
        xifanQueue.create(taskId, {
          title,
          savePath: savePath ?? null,
          payload: { templates, epPages: epPages ?? [], sourceIdx: newSourceIdx },
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
