/**
 * Per-source IPC dispatch table for DownloadTask.
 *
 * The renderer's DownloadQueue and the resume-on-mount path each used to do
 * three-arm `if (task.source === 'xifan'/girigiri/aowu)` chains for every
 * action (pause / cancel / resume / retry / requeue / switchSource). Each new
 * source meant editing every call site. This adapter centralizes the dispatch
 * so a task gets a uniform { pause, cancel, resume, ... } surface and adding
 * a fourth source is a single new branch here.
 *
 * Per-task helpers (epCount, listEps, epLabel, canSwitchSource, ...) live
 * alongside since they share the same source-discriminator pattern.
 */
import type { DownloadTask } from './downloadStore'

interface SiteApi {
  pause: () => Promise<unknown>
  cancel: () => Promise<unknown>
  resume: (pendingEps: number[]) => Promise<unknown>
  retry: (eps: number[]) => Promise<unknown>
  requeue: (eps: number[]) => Promise<unknown>
  /**
   * Switch to a different source for the failed eps (cycle through
   * available sources). Null when this source/task can't switch — caller
   * should hide the swap-source UI.
   */
  switchSource:
    | ((args: { failedEps: number[]; newSourceIdx: number }) => Promise<unknown>)
    | null
  /**
   * Resolve a real mp4 URL for one ep, used by the "copy URL" feature.
   * Returns '' if the source has no clipboard-friendly URL (girigiri's
   * stream is HLS, no single mp4).
   */
  resolveEpUrl: (ep: number) => Promise<string>
  /** True if `resolveEpUrl` is async / costly (renderer should show a spinner). */
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
      // OVA 等特殊集的文件名不是集号,模板拼不出来;主进程回源解析过的真实直链
      // 记在 epUrls 里,优先用它(见 docs/xifan-下载链接-集数补零-回归用例.md)。
      const resolved = task.epUrls[ep]
      if (resolved) return resolved
      // 用当前源的模板(换过源后 sourceIdx 已变);从前写死 [0] 会复制出原源的链接
      const template = task.templates[task.sourceIdx] ?? task.templates[0] ?? ''
      // 占位符按携带的位宽补零({:d} 不补零、{:0Nd} 补到 N 位);必须与主进程
      // xifan/download.ts 的 formatEpUrl 保持一致,否则复制出来的直链拼错(见
      // docs/xifan-下载链接-集数补零-回归用例.md)。兼容历史残留的旧 {:02d} 模板。
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

/**
 * Return source-cycling info, or null if this task can't switch sources.
 *
 *  - xifan: cycles through `templates`, sourceIdx is the array index
 *  - aowu:  cycles through `aowuSources`, sourceIdx is the FantasyKon source_id
 *  - girigiri: never (no IPC switchSource handler)
 */
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
