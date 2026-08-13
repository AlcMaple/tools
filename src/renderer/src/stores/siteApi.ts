/**
 * 按源分发的 IPC 适配层。
 *
 * 下载队列页和挂载时的恢复流程,原本对每个动作(暂停/取消/继续/重试/重排/换源)都要写一遍
 * 三分支的 if。集中到这里之后,任何任务都拿到统一的 { pause, cancel, resume, ... }
 * 加第四个源只需要在这里多一个分支。
 *
 * 每任务的小工具(集数、集列表、集标签、能否换源…)也放在一起 —— 它们共享同一套按源判别的模式。
 */
import type { DownloadTask } from './downloadStore'

interface SiteApi {
  pause: () => Promise<unknown>
  cancel: () => Promise<unknown>
  resume: (pendingEps: number[]) => Promise<unknown>
  retry: (eps: number[]) => Promise<unknown>
  requeue: (eps: number[]) => Promise<unknown>
  /** 给失败的集换一个源(在可用源之间轮换)。该源/任务不支持换源时为 null,调用方应隐藏换源 UI。 */
  switchSource:
    | ((args: { failedEps: number[]; newSourceIdx: number }) => Promise<unknown>)
    | null
  /**
   * 解析某一集的真实 mp4 地址,供「复制链接」用。源本身没有可复制的单一 mp4 地址时返回空串
   * (HLS 流就没有)。
   */
  resolveEpUrl: (ep: number) => Promise<string>
  /** 为 true 表示 `resolveEpUrl` 是异步 / 有代价的,调用方该显示 spinner。 */
  resolveIsAsync: boolean
}

export function siteApi(task: DownloadTask): SiteApi {
  const savePath = task.savePath
  if (task.source === 'girigiri') {
    return {
      pause: () => window.girigiriApi.pauseDownload(task.id),
      cancel: () => window.girigiriApi.cancelDownload(task.id),
      resume: (pendingEps) =>
        window.girigiriApi.resumeDownload(task.id, task.title, task.girigiriEps, pendingEps, savePath),
      retry: (eps) =>
        window.girigiriApi.retryDownload(task.id, task.title, task.girigiriEps, eps, savePath),
      requeue: (eps) =>
        window.girigiriApi.requeueEpisodes(task.id, task.title, task.girigiriEps, eps, savePath),
      switchSource: null, // girigiri has no switchSource handler — HLS streams are per-source-baked
      resolveEpUrl: async (ep) =>
        task.girigiriEps.find((e) => e.idx === ep)?.url ?? '',
      resolveIsAsync: false,
    }
  }
  if (task.source === 'aowu') {
    return {
      pause: () => window.aowuApi.pauseDownload(task.id),
      cancel: () => window.aowuApi.cancelDownload(task.id),
      resume: (pendingEps) =>
        window.aowuApi.resumeDownload(task.id, task.title, task.aowuId, task.sourceIdx, task.aowuEps, pendingEps, savePath),
      retry: (eps) =>
        window.aowuApi.retryDownload(task.id, task.title, task.aowuId, task.sourceIdx, task.aowuEps, eps, savePath),
      requeue: (eps) =>
        window.aowuApi.requeueEpisodes(task.id, task.title, task.aowuId, task.sourceIdx, task.aowuEps, eps, savePath),
      switchSource: ({ failedEps, newSourceIdx }) =>
        window.aowuApi.switchSource(task.id, task.title, task.aowuId, newSourceIdx, task.aowuEps, failedEps, savePath),
      resolveEpUrl: (ep) => window.aowuApi.resolveMp4Url(task.aowuId, task.sourceIdx, ep),
      resolveIsAsync: true,
    }
  }
  // xifan
  return {
    pause: () => window.xifanApi.pauseDownload(task.id),
    cancel: () => window.xifanApi.cancelDownload(task.id),
    resume: (pendingEps) =>
      window.xifanApi.resumeDownload(task.id, task.title, task.templates, pendingEps, savePath, task.sourceIdx, task.epPages),
    retry: (eps) =>
      window.xifanApi.retryDownload(task.id, task.title, task.templates, eps, savePath, task.sourceIdx, task.epPages),
    requeue: (eps) =>
      window.xifanApi.requeueEpisodes(task.id, task.title, task.templates, eps, savePath, task.sourceIdx, task.epPages),
    switchSource: ({ failedEps, newSourceIdx }) =>
      window.xifanApi.switchSource(task.id, task.title, task.templates, failedEps, newSourceIdx, savePath, task.epPages),
    resolveEpUrl: async (ep) => {
      // OVA 等特殊集的文件名不是集号、模板拼不出来;主进程回源解析过的真实直链记在 epUrls 里,优先用它。
      const resolved = task.epUrls[ep]
      if (resolved) return resolved
      // 要用**当前源**的模板(换过源后 sourceIdx 已经变了);写死 [0] 会复制出原来那个源的链接。
      const template = task.templates[task.sourceIdx] ?? task.templates[0] ?? ''
      // 占位符按携带的位宽补零,**必须**与主进程 download.ts 的 formatEpUrl 保持一致
      // 否则复制出来的直链是错的。
      return template
        ? template.replace(/\{:0?(\d*)d\}/, (_, w: string) =>
            String(ep).padStart(w ? parseInt(w, 10) : 0, '0'))
        : ''
    },
    resolveIsAsync: false,
  }
}

// ── Per-task display helpers (also source-discriminated) ──────────────────────

export function listTaskEps(task: DownloadTask): number[] {
  // epStatus 是各源真正要下的集(xifan 也已写入,且会扣掉排除项)。仅当它为空
  // ——例如旧版本持久化的 xifan 任务没存 epStatus——才回退到 startEp..endEp 区间。
  const keys = Object.keys(task.epStatus)
  if (keys.length > 0) return keys.map(Number).sort((a, b) => a - b)
  return Array.from({ length: task.endEp - task.startEp + 1 }, (_, i) => task.startEp + i)
}

export function taskEpCount(task: DownloadTask): number {
  const n = Object.keys(task.epStatus).length
  return n > 0 ? n : task.endEp - task.startEp + 1
}

export function taskEpLabel(task: DownloadTask, ep: number): string {
  if (task.source === 'girigiri') {
    return task.girigiriEps.find((e) => e.idx === ep)?.name ?? `EP ${ep}`
  }
  if (task.source === 'aowu') {
    return task.aowuEps.find((e) => e.idx === ep)?.label ?? `EP ${ep}`
  }
  return `EP ${String(ep).padStart(2, '0')}`
}

export interface SourceSwitch {
  /** Total selectable sources for this task. */
  total: number
  /** Position (1-based) of the currently selected source. */
  current: number
  /** Computed next sourceIdx if we cycle. */
  next: number
}

/** 返回换源所需的信息;该任务不支持换源时返回 null。 */
export function sourceSwitchInfo(task: DownloadTask): SourceSwitch | null {
  if (task.source === 'girigiri') return null
  if (task.source === 'aowu') {
    const list = task.aowuSources
    if (list.length <= 1) return null
    const cur = list.findIndex((s) => s.idx === task.sourceIdx)
    const next = list[(cur + 1) % list.length]
    return { total: list.length, current: cur + 1, next: next.idx }
  }
  if (task.templates.length <= 1) return null
  const cur = task.sourceIdx
  return { total: task.templates.length, current: cur + 1, next: (cur + 1) % task.templates.length }
}
