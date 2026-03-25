import type { BgmSearchResult, BgmDetail } from './types/bgm'
import type { XifanSearchResult, XifanWatchInfo } from './types/xifan'

declare global {
  interface Window {
    versions: {
      node: () => string
      chrome: () => string
      electron: () => string
    }
    bgmApi: {
      search: (keyword: string) => Promise<BgmSearchResult[]>
      detail: (subjectId: number) => Promise<BgmDetail>
    }
    xifanApi: {
      getCaptcha: () => Promise<{ image_b64: string }>
      verifyCaptcha: (code: string) => Promise<{ success: boolean }>
      search: (keyword: string) => Promise<XifanSearchResult[] | { needs_captcha: true }>
      getWatch: (watchUrl: string) => Promise<XifanWatchInfo>
      startDownload: (
        title: string,
        templates: string[],
        startEp: number,
        endEp: number
      ) => Promise<{ started: boolean; pid?: number; taskId: string }>
      cancelDownload: (taskId: string) => Promise<{ cancelled: boolean }>
      pauseDownload: (taskId: string) => Promise<{ paused: boolean }>
      resumeDownload: (taskId: string) => Promise<{ resumed: boolean }>
      pauseEpisode: (taskId: string, ep: number) => Promise<{ paused: boolean }>
      resumeEpisode: (taskId: string, ep: number) => Promise<{ resumed: boolean }>
      requeueEpisodes: (
        taskId: string,
        title: string,
        templates: string[],
        eps: number[]
      ) => Promise<{ started: boolean }>
      retryDownload: (
        taskId: string,
        title: string,
        templates: string[],
        failedEps: number[]
      ) => Promise<{ started: boolean }>
      onDownloadProgress: (
        cb: (taskId: string, event: unknown) => void
      ) => () => void
    }
  }
}
