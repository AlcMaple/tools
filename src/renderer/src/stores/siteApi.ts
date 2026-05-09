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
        window.girigiriApi.retryDownload(task.id, task.title, task.girigiriEps!, eps, savePath),
      requeue: (eps) =>
        window.girigiriApi.requeueEpisodes(task.id, task.title, task.girigiriEps!, eps, savePath),
      switchSource: null, // girigiri has no switchSource handler — HLS streams are per-source-baked
      resolveEpUrl: async (ep) =>
        task.girigiriEps?.find((e) => e.idx === ep)?.url ?? '',
      resolveIsAsync: false,
    }
  }
  if (task.source === 'aowu') {
    const sourceIdx = task.sourceIdx ?? 1
    return {
      pause: () => window.aowuApi.pauseDownload(task.id),
      cancel: () => window.aowuApi.cancelDownload(task.id),
      resume: (pendingEps) =>
        window.aowuApi.resumeDownload(task.id, task.title, task.aowuId, sourceIdx, task.aowuEps, pendingEps, savePath),
      retry: (eps) =>
        window.aowuApi.retryDownload(task.id, task.title, task.aowuId!, sourceIdx, task.aowuEps!, eps, savePath),
      requeue: (eps) =>
        window.aowuApi.requeueEpisodes(task.id, task.title, task.aowuId!, sourceIdx, task.aowuEps!, eps, savePath),
      switchSource: ({ failedEps, newSourceIdx }) =>
        window.aowuApi.switchSource(task.id, task.title, task.aowuId!, newSourceIdx, task.aowuEps!, failedEps, savePath),
      resolveEpUrl: (ep) => {
        if (!task.aowuId || !task.sourceIdx) {
          return Promise.reject(new Error('任务缺少 aowuId / sourceIdx'))
        }
        return window.aowuApi.resolveMp4Url(task.aowuId, task.sourceIdx, ep)
      },
      resolveIsAsync: true,
    }
  }
  // xifan (default for legacy tasks without `source`)
  const sourceIdx = task.sourceIdx ?? 0
  return {
    pause: () => window.xifanApi.pauseDownload(task.id),
    cancel: () => window.xifanApi.cancelDownload(task.id),
    resume: (pendingEps) =>
      window.xifanApi.resumeDownload(task.id, task.title, task.templates, pendingEps, savePath, sourceIdx),
    retry: (eps) =>
      window.xifanApi.retryDownload(task.id, task.title, task.templates, eps, savePath, sourceIdx),
    requeue: (eps) =>
      window.xifanApi.requeueEpisodes(task.id, task.title, task.templates, eps, savePath, sourceIdx),
    switchSource: ({ failedEps, newSourceIdx }) =>
      window.xifanApi.switchSource(task.id, task.title, task.templates, failedEps, newSourceIdx, savePath),
    resolveEpUrl: async (ep) => {
      const template = task.templates?.[0] ?? ''
      return template ? template.replace('{:02d}', String(ep).padStart(2, '0')) : ''
    },
    resolveIsAsync: false,
  }
}

// ── Per-task display helpers (also source-discriminated) ──────────────────────

export function listTaskEps(task: DownloadTask): number[] {
  if (task.source === 'girigiri' || task.source === 'aowu') {
    return Object.keys(task.epStatus).map(Number).sort((a, b) => a - b)
  }
  return Array.from({ length: task.endEp - task.startEp + 1 }, (_, i) => task.startEp + i)
}

export function taskEpCount(task: DownloadTask): number {
  if (task.source === 'girigiri' || task.source === 'aowu') {
    return Object.keys(task.epStatus).length
  }
  return task.endEp - task.startEp + 1
}

export function taskEpLabel(task: DownloadTask, ep: number): string {
  if (task.source === 'girigiri') {
    return task.girigiriEps?.find((e) => e.idx === ep)?.name ?? `EP ${ep}`
  }
  if (task.source === 'aowu') {
    return task.aowuEps?.find((e) => e.idx === ep)?.label ?? `EP ${ep}`
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
    if (!list || list.length <= 1) return null
    const cur = list.findIndex((s) => s.idx === (task.sourceIdx ?? 1))
    const next = list[(cur + 1) % list.length]
    return { total: list.length, current: cur + 1, next: next.idx }
  }
  if (task.templates.length <= 1) return null
  const cur = task.sourceIdx ?? 0
  return { total: task.templates.length, current: cur + 1, next: (cur + 1) % task.templates.length }
}
