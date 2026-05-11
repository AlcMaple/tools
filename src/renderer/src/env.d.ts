declare module '*.png' {
  const src: string
  export default src
}

declare global {
  const __APP_VERSION__: string
}

import type { BgmSearchResult, BgmDetail } from './types/bgm'
import type { XifanSearchResult, XifanWatchInfo } from './types/xifan'
import type { GirigiriSearchResult, GirigiriEpisode, GirigiriWatchInfo } from './types/girigiri'
import type { AowuSearchResult, AowuEpisode, AowuWatchInfo } from './types/aowu'

export interface LibraryPath {
  path: string;
  label: string;
}

export interface LibraryEntry {
  id: string;
  title: string;
  nativeTitle: string;
  tags: string;
  episodes: number;
  specs: string;
  image: string;
  folderPath: string;
  addedAt: number;
  totalSize: number;
}

export interface LibraryFile {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface FsEntry {
  name: string
  path: string
  type: 'file' | 'folder'
  size?: number
  mtime?: string
  ext?: string
  kind?: 'video' | 'image' | 'archive' | 'text'
}

declare global {
  interface Window {
    fileExplorerApi: {
      getHomeInfo: () => Promise<{ homeDir: string; platform: string }>
      listDir: (dirPath: string) => Promise<{ entries: FsEntry[]; isVirtualRoot: boolean }>
      open: (targetPath: string) => Promise<void>
      reveal: (targetPath: string) => Promise<void>
      trash: (targetPath: string) => Promise<void>
      deletePermanent: (targetPath: string) => Promise<void>
      forceDeletePermanent: (targetPath: string) => Promise<{ killed: { pid: number; name: string }[] }>
      resolveSpecial: (input: string) => Promise<string | null>
      onDirChange: (cb: () => void) => () => void
    }
    girigiriApi: {
      getCaptcha: () => Promise<{ image_b64: string }>
      verifyCaptcha: (code: string) => Promise<{ success: boolean }>
      search: (keyword: string) => Promise<GirigiriSearchResult[] | { needs_captcha: true }>
      getWatch: (playUrl: string) => Promise<GirigiriWatchInfo>
      startDownload: (
        title: string,
        epList: GirigiriEpisode[],
        selectedIdxs: number[],
        savePath?: string
      ) => Promise<{ started: boolean; taskId: string }>
      cancelDownload: (taskId: string) => Promise<{ cancelled: boolean }>
      pauseDownload: (taskId: string) => Promise<{ paused: boolean }>
      resumeDownload: (taskId: string, title?: string, epList?: GirigiriEpisode[], pendingEps?: number[], savePath?: string) => Promise<{ resumed: boolean }>
      requeueEpisodes: (
        taskId: string,
        title: string,
        epList: GirigiriEpisode[],
        eps: number[],
        savePath?: string
      ) => Promise<{ started: boolean }>
      retryDownload: (
        taskId: string,
        title: string,
        epList: GirigiriEpisode[],
        failedEps: number[],
        savePath?: string
      ) => Promise<{ started: boolean }>
    }
    /**
     * Single subscription point for download progress events. The main process
     * emits all three sources (xifan / girigiri / aowu) onto the unified
     * 'download:progress' channel — only one listener is needed.
     */
    downloadApi: {
      onProgress: (cb: (taskId: string, event: unknown) => void) => () => void
    }
    systemApi: {
      getDiskFree: () => Promise<{ free: number; total: number }>
      pickFolder: () => Promise<string | null>
      checkConnectivity: () => Promise<boolean>
      loadSettingsHistory: () => Promise<Array<{ text: string; time: number }>>
      saveSettingsHistory: (entries: Array<{ text: string; time: number }>) => Promise<boolean>
      onSpeedUpdate: (cb: (bps: number) => void) => () => void
      cacheGet: (key: string) => Promise<Record<string, unknown> | null>
      cacheSet: (key: string, valueOrSubkey: unknown, maybeValue?: unknown) => Promise<void>
      getSetting: (key: string) => Promise<any>
      setSetting: (key: string, value: any) => Promise<void>
      loadDownloadState: () => Promise<any[]>
      saveDownloadState: (tasks: any[]) => Promise<void>
    }
    versions: {
      node: () => string
      chrome: () => string
      electron: () => string
    }
    bgmApi: {
      /** `update=true` bypasses both the renderer and main-side caches and
       * refetches every page through the rate limiter. Use sparingly — meant
       * for the manual refresh button, not background sync. */
      search: (keyword: string, update?: boolean) => Promise<BgmSearchResult[]>
      detail: (subjectId: number) => Promise<BgmDetail>
      /** Subscribe to per-page progress events. Fires `(current, total)` after
       * each page completes. Returns an unsubscribe function. */
      onSearchProgress: (cb: (current: number, total: number) => void) => () => void
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
        endEp: number,
        savePath?: string
      ) => Promise<{ started: boolean; taskId: string }>
      cancelDownload: (taskId: string) => Promise<{ cancelled: boolean }>
      pauseDownload: (taskId: string) => Promise<{ paused: boolean }>
      resumeDownload: (taskId: string, title?: string, templates?: string[], pendingEps?: number[], savePath?: string, sourceIdx?: number) => Promise<{ resumed: boolean }>
      requeueEpisodes: (
        taskId: string,
        title: string,
        templates: string[],
        eps: number[],
        savePath?: string,
        sourceIdx?: number
      ) => Promise<{ started: boolean }>
      retryDownload: (
        taskId: string,
        title: string,
        templates: string[],
        failedEps: number[],
        savePath?: string,
        sourceIdx?: number
      ) => Promise<{ started: boolean }>
      switchSource: (
        taskId: string,
        title: string,
        templates: string[],
        failedEps: number[],
        newSourceIdx: number,
        savePath?: string
      ) => Promise<{ switched: boolean }>
    }
    aowuApi: {
      search: (keyword: string) => Promise<{
        requestId: string
        results: AowuSearchResult[]
        total: number
        /** True if more pages will arrive via onSearchPage. */
        more: boolean
      }>
      onSearchPage: (
        cb: (requestId: string, results: AowuSearchResult[], done: boolean) => void
      ) => () => void
      getWatch: (watchUrl: string) => Promise<AowuWatchInfo>
      resolveMp4Url: (animeId: string, sourceIdx: number, ep: number) => Promise<string>
      startDownload: (
        title: string,
        animeId: string,
        sourceIdx: number,
        epList: AowuEpisode[],
        selectedIdxs: number[],
        savePath?: string
      ) => Promise<{ started: boolean; taskId: string }>
      cancelDownload: (taskId: string) => Promise<{ cancelled: boolean }>
      pauseDownload: (taskId: string) => Promise<{ paused: boolean }>
      resumeDownload: (
        taskId: string,
        title?: string,
        animeId?: string,
        sourceIdx?: number,
        epList?: AowuEpisode[],
        pendingEps?: number[],
        savePath?: string
      ) => Promise<{ resumed: boolean }>
      requeueEpisodes: (
        taskId: string,
        title: string,
        animeId: string,
        sourceIdx: number,
        epList: AowuEpisode[],
        eps: number[],
        savePath?: string
      ) => Promise<{ started: boolean }>
      retryDownload: (
        taskId: string,
        title: string,
        animeId: string,
        sourceIdx: number,
        epList: AowuEpisode[],
        failedEps: number[],
        savePath?: string
      ) => Promise<{ started: boolean }>
      switchSource: (
        taskId: string,
        title: string,
        animeId: string,
        newSourceIdx: number,
        epList: AowuEpisode[],
        failedEps: number[],
        savePath?: string
      ) => Promise<{ switched: boolean }>
    }
    webdavApi: {
      getConfig: () => Promise<{ account: string; appPassword: string; remotePath: string } | null>
      saveConfig: (config: { account: string; appPassword: string; remotePath: string }) => Promise<boolean>
      test: () => Promise<boolean>
      push: (jsonStr: string) => Promise<boolean>
      pull: () => Promise<string>
    }
    libraryApi: {
      getPaths: () => Promise<LibraryPath[]>
      addPath: (folderPath: string, label: string) => Promise<LibraryPath[]>
      removePath: (folderPath: string) => Promise<LibraryPath[]>
      getEntries: () => Promise<LibraryEntry[]>
      getFiles: (folderPath: string) => Promise<LibraryFile[]>
      openFolder: (folderPath: string) => Promise<void>
      playVideo: (filePath: string) => Promise<void>
      playFolder: (folderPath: string) => Promise<void>
      scan: () => Promise<LibraryEntry[]>
      onScanStatus: (cb: (status: { status: string, currentVal: number, totalVal: number }) => void) => () => void
      onLibraryUpdated: (callback: (entries: LibraryEntry[]) => void) => void
    }
  }
}

