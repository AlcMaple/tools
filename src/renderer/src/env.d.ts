declare module '*.png' {
  const src: string
  export default src
}

declare global {
  const __APP_VERSION__: string
}

import type { BgmSearchResult, BgmDetail, BgmCalendarResult } from './types/bgm'
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
      /**
       * 「移到回收站」Stage 1（5s 整体送回收站窗口）。
       *   - `success`        整体送入成功
       *   - `stage1-failed`  整体送入失败，**未**尝试 Stage 2。renderer
       *                      据此弹「分片回收」确认弹窗；用户点继续
       *                      才调 trashFragmented，点取消则流程终止。
       *   - `already-absent` 路径已不存在（静默成功）
       * 抛错 = 出现致命错误（spawn 失败 / helper 路径找不到等）。
       */
      trash: (
        targetPath: string,
      ) => Promise<{ status: 'success' | 'stage1-failed' | 'already-absent' }>
      /**
       * 「移到回收站」Stage 2（用户确认后调）—— 跑完整两阶段。
       *   - `success`        Stage 1 重试中成了（运气好）
       *   - `fragmented`     Stage 2 分片回收成功。renderer **必须**强提示
       *                      "回收站里是散件，可全选→还原重建结构"。
       *   - `already-absent` 路径已不存在
       * 抛错 = Stage 1 + Stage 2 都失败。
       */
      trashFragmented: (
        targetPath: string,
      ) => Promise<{ status: 'success' | 'fragmented' | 'already-absent' }>
      /**
       * 永久删除（recycle-helper --purge：Remove-Item → cmd `rd /s /q` →
       * robocopy /MIR 三级 fallback，每个策略自动重试 4 次）。几乎一次必成。
       */
      deletePermanent: (
        targetPath: string,
      ) => Promise<{ status: 'success' | 'already-absent' }>
      resolveSpecial: (input: string) => Promise<string | null>
      /** Walk up from `targetPath` and return the closest still-existing
       *  directory (returns `targetPath` itself if it still exists, null
       *  only if even the filesystem root is unreachable). Used by the
       *  delete flow to navigate away from a now-deleted cwd. */
      findExistingAncestor: (targetPath: string) => Promise<string | null>
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
      /** OS-default downloads folder that all downloaders fall back to when no
       *  custom save path is set. Used by Settings UI to make the effective
       *  path visible. */
      getDefaultDownloadsPath: () => Promise<string>
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
      /** Weekly airing calendar. `update=true` bypasses the 24h cache. */
      calendar: (update?: boolean) => Promise<BgmCalendarResult>
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
      /** Convert search-time /v/{id} URL → user-facing /w/{token} URL. */
      resolveShareUrl: (input: string) => Promise<string>
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
    mailApi: {
      /**
       * 返回当前邮件配置。出于安全考虑 authCode 不会原样回传，仅有
       * hasAuthCode 布尔位告诉 UI「磁盘上有/没有」。
       */
      getConfig: () => Promise<{ enabled: boolean; qqEmail: string; hasAuthCode: boolean }>
      /**
       * 保存邮件配置。authCode 留空时表示「沿用磁盘旧值」—— 编辑 enabled /
       * qqEmail 时用户不必每次重新输入授权码。
       */
      setConfig: (config: { enabled: boolean; qqEmail: string; authCode: string }) => Promise<boolean>
      /**
       * 触发一次周历邮件发送（截图 + SMTP）。返回 `sent` 即是否真的成功
       * 发出；reason 留作排错线索（disabled / incomplete-config / 错误文本）。
       */
      sendCalendar: () => Promise<{ sent: boolean; reason?: string }>
      /**
       * 发一封 MyAnime 极简报告邮件。`html` 是 renderer 已拼好的完整邮件
       * 正文（带内联样式）。返回 `sent` 即是否成功；reason 同 sendCalendar。
       */
      sendAnimeReport: (html: string) => Promise<{ sent: boolean; reason?: string }>
      /** 发一封不带截图的测试邮件，失败会抛错。 */
      testSend: () => Promise<boolean>
    }
    /** screenshot 模式渲染器专用，普通页面不应使用。 */
    screenshotApi: {
      reportCalendarReady: (height: number) => Promise<boolean>
    }
    updaterApi: {
      /** 主动触发检查更新。dev 模式下返回 { skipped: true }。 */
      check: () => Promise<{ skipped?: boolean; reason?: string; ok?: boolean }>
      /** Windows: 重启并安装；macOS: shell.openExternal release 页。 */
      install: () => Promise<{ ok: boolean; error?: string }>
      openReleasePage: () => Promise<{ ok: boolean }>
      onChecking: (cb: () => void) => () => void
      onAvailable: (cb: (info: { version: string }) => void) => () => void
      onAvailableMac: (cb: (info: { version: string; releaseUrl?: string }) => void) => () => void
      onDownloadProgress: (
        cb: (p: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void,
      ) => () => void
      onDownloaded: (cb: (info: { version: string }) => void) => () => void
      onNotAvailable: (cb: (info: { version: string }) => void) => () => void
      onError: (cb: (info: { message: string }) => void) => () => void
    }
    webdavApi: {
      getConfig: () => Promise<{ account: string; appPassword: string; remotePath: string } | null>
      saveConfig: (config: { account: string; appPassword: string; remotePath: string }) => Promise<boolean>
      test: () => Promise<boolean>
      /**
       * Push a JSON blob to the per-kind remote file. `kind` selects which
       * file under the user's base folder is written
       * (`homework.json` / `anime.json`). Each kind syncs independently.
       */
      push: (kind: 'homework' | 'anime', jsonStr: string) => Promise<boolean>
      pull: (kind: 'homework' | 'anime') => Promise<string>
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

