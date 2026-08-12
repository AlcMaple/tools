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
  /** 与 templates 平行:各源播放页 URL 模板,模板拼出 404 时回源解析用。旧任务恢复时为空数组。 */
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
  // 在线播放:模板拼出的直链 404(OVA 等特殊集)时,回源播放页解析真实地址。
  // 与下载流程内部的回源是同一个函数,这里只是把它开给渲染进程按需调用。
  ipcMain.handle('xifan:resolve-ep-url', async (_event, epPage: string, ep: number) =>
    resolveEpRealUrl(epPage, ep))
  // 在线播放统一先看 24h 的逐集地址缓存；只有没命中，或 video 已报错要求强制
  // 刷新时，才到对应播放页读 player_aaaa.url。不能把这个 cache 放 renderer，避免
  // 刷新页面 / 重启应用后又重新触发站点安全检查。
  ipcMain.handle(
    'xifan:resolve-play-url',
    async (_event, template: string | null, epPage: string, ep: number, forceRefresh?: boolean) =>
      resolveEpPlaybackUrl(template, epPage, ep, forceRefresh === true),
  )
  // 下载配置面板专用:watch() 只解析当前激活源,这里主动并发补全其余线路的
  // template/ep1/epLabels,给面板一次性展示全部线路用。播放器不调这个——
  // 它按需惰性解析,见 xifan/api.ts watch() 的注释。
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
      // Queue lost (e.g. after app restart) — recreate from caller-supplied state.
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
      // Defensive merge: if the queue's still alive (mid-download), don't
      // overwrite it — that would orphan the AbortController and leak the
      // in-flight ep. Append eps to the front instead.
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
