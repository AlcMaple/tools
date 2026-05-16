import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('versions', {
  node: () => process.versions.node,
  chrome: () => process.versions.chrome,
  electron: () => process.versions.electron,
})

contextBridge.exposeInMainWorld('bgmApi', {
  search: (keyword: string, update?: boolean) =>
    ipcRenderer.invoke('bgm:search', keyword, update),
  detail: (subjectId: number) => ipcRenderer.invoke('bgm:detail', subjectId),
  // Per-page progress for multi-page searches. Main fires `(current, total)`
  // after each page is fetched (cache hit or network). Returns an unsubscribe
  // function so callers can clean up in their useEffect teardown.
  onSearchProgress: (cb: (current: number, total: number) => void) => {
    const handler = (_: Electron.IpcRendererEvent, current: number, total: number): void =>
      cb(current, total)
    ipcRenderer.on('bgm:search-progress', handler)
    return () => ipcRenderer.removeListener('bgm:search-progress', handler)
  },
  /** Weekly airing calendar (本季新番). `update=true` bypasses the 24h cache. */
  calendar: (update?: boolean) => ipcRenderer.invoke('bgm:calendar', update),
})

// Single subscription point for download progress events. The main process
// emits all three sources (xifan / girigiri / aowu) onto the unified
// 'download:progress' channel, so the renderer only needs one listener.
contextBridge.exposeInMainWorld('downloadApi', {
  onProgress: (cb: (taskId: string, event: unknown) => void) => {
    const handler = (_: Electron.IpcRendererEvent, taskId: string, ev: unknown): void => cb(taskId, ev)
    ipcRenderer.on('download:progress', handler)
    return () => ipcRenderer.removeListener('download:progress', handler)
  },
})

contextBridge.exposeInMainWorld('systemApi', {
  getDiskFree: () => ipcRenderer.invoke('system:disk-free'),
  pickFolder: () => ipcRenderer.invoke('system:pick-folder'),
  /**
   * Returns the OS default downloads folder (`app.getPath('downloads')`),
   * which is what all downloaders silently fall back to when the user
   * hasn't configured a custom save path. Used by Settings UI to display
   * the actual effective path.
   */
  getDefaultDownloadsPath: () => ipcRenderer.invoke('system:default-downloads'),
  checkConnectivity: () => ipcRenderer.invoke('system:connectivity'),
  loadSettingsHistory: () => ipcRenderer.invoke('system:history-read'),
  saveSettingsHistory: (entries: unknown) => ipcRenderer.invoke('system:history-write', entries),
  cacheGet: (key: string) => ipcRenderer.invoke('cache:get', key),
  cacheSet: (key: string, valueOrSubkey: unknown, maybeValue?: unknown) => ipcRenderer.invoke('cache:set', key, valueOrSubkey, maybeValue),
  getSetting: (key: string) => ipcRenderer.invoke('system:get-setting', key),
  setSetting: (key: string, value: any) => ipcRenderer.invoke('system:set-setting', key, value),
  loadDownloadState: () => ipcRenderer.invoke('download:load-state'),
  saveDownloadState: (tasks: unknown) => ipcRenderer.invoke('download:save-state', tasks),
  onSpeedUpdate: (cb: (bps: number) => void) => {
    const handler = (_: Electron.IpcRendererEvent, bps: number) => cb(bps)
    ipcRenderer.on('system:speed', handler)
    return () => ipcRenderer.removeListener('system:speed', handler)
  },
})

contextBridge.exposeInMainWorld('girigiriApi', {
  getCaptcha: () => ipcRenderer.invoke('girigiri:captcha'),
  verifyCaptcha: (code: string) => ipcRenderer.invoke('girigiri:verify', code),
  search: (keyword: string) => ipcRenderer.invoke('girigiri:search', keyword),
  getWatch: (playUrl: string) => ipcRenderer.invoke('girigiri:watch', playUrl),
  startDownload: (
    title: string,
    epList: { idx: number; name: string; url: string }[],
    selectedIdxs: number[],
    savePath?: string
  ) => ipcRenderer.invoke('girigiri:download', title, epList, selectedIdxs, savePath),
  cancelDownload: (taskId: string) => ipcRenderer.invoke('girigiri:download-cancel', taskId),
  pauseDownload: (taskId: string) => ipcRenderer.invoke('girigiri:download-pause', taskId),
  resumeDownload: (taskId: string, title?: string, epList?: { idx: number; name: string; url: string }[], pendingEps?: number[], savePath?: string) =>
    ipcRenderer.invoke('girigiri:download-resume', taskId, title, epList, pendingEps, savePath),
  requeueEpisodes: (
    taskId: string,
    title: string,
    epList: { idx: number; name: string; url: string }[],
    eps: number[],
    savePath?: string
  ) => ipcRenderer.invoke('girigiri:download-requeue', taskId, title, epList, eps, savePath),
  retryDownload: (
    taskId: string,
    title: string,
    epList: { idx: number; name: string; url: string }[],
    failedEps: number[],
    savePath?: string
  ) => ipcRenderer.invoke('girigiri:download-retry', taskId, title, epList, failedEps, savePath),
})

contextBridge.exposeInMainWorld('xifanApi', {
  getCaptcha: () => ipcRenderer.invoke('xifan:captcha'),
  verifyCaptcha: (code: string) => ipcRenderer.invoke('xifan:verify', code),
  search: (keyword: string) => ipcRenderer.invoke('xifan:search', keyword),
  getWatch: (watchUrl: string) => ipcRenderer.invoke('xifan:watch', watchUrl),
  startDownload: (title: string, templates: string[], startEp: number, endEp: number, savePath?: string) =>
    ipcRenderer.invoke('xifan:download', title, templates, startEp, endEp, savePath),
  cancelDownload: (taskId: string) => ipcRenderer.invoke('xifan:download-cancel', taskId),
  pauseDownload: (taskId: string) => ipcRenderer.invoke('xifan:download-pause', taskId),
  resumeDownload: (taskId: string, title?: string, templates?: string[], pendingEps?: number[], savePath?: string, sourceIdx?: number) =>
    ipcRenderer.invoke('xifan:download-resume', taskId, title, templates, pendingEps, savePath, sourceIdx),
  requeueEpisodes: (taskId: string, title: string, templates: string[], eps: number[], savePath?: string, sourceIdx?: number) =>
    ipcRenderer.invoke('xifan:download-requeue', taskId, title, templates, eps, savePath, sourceIdx),
  retryDownload: (taskId: string, title: string, templates: string[], failedEps: number[], savePath?: string, sourceIdx?: number) =>
    ipcRenderer.invoke('xifan:download-retry', taskId, title, templates, failedEps, savePath, sourceIdx),
  switchSource: (taskId: string, title: string, templates: string[], failedEps: number[], newSourceIdx: number, savePath?: string) =>
    ipcRenderer.invoke('xifan:download-switch-source', taskId, title, templates, failedEps, newSourceIdx, savePath),
})

contextBridge.exposeInMainWorld('aowuApi', {
  // Streaming search. Returns first page immediately; further pages stream
  // through onSearchPage events. See registerAowuIpc('aowu:search') for shape.
  search: (keyword: string) => ipcRenderer.invoke('aowu:search', keyword),
  onSearchPage: (cb: (requestId: string, results: unknown[], done: boolean) => void) => {
    const handler = (_: Electron.IpcRendererEvent, requestId: string, results: unknown[], done: boolean): void =>
      cb(requestId, results, done)
    ipcRenderer.on('aowu:search-page', handler)
    return () => ipcRenderer.removeListener('aowu:search-page', handler)
  },
  getWatch: (watchUrl: string) => ipcRenderer.invoke('aowu:watch', watchUrl),
  /** Convert search-time /v/{id} URL → user-facing /w/{token} URL. */
  resolveShareUrl: (input: string) =>
    ipcRenderer.invoke('aowu:resolve-share-url', input) as Promise<string>,
  resolveMp4Url: (animeId: string, sourceIdx: number, ep: number) =>
    ipcRenderer.invoke('aowu:resolve-mp4-url', animeId, sourceIdx, ep) as Promise<string>,
  startDownload: (
    title: string,
    animeId: string,
    sourceIdx: number,
    epList: { idx: number; name?: string; label: string }[],
    selectedIdxs: number[],
    savePath?: string
  ) => ipcRenderer.invoke('aowu:download', title, animeId, sourceIdx, epList, selectedIdxs, savePath),
  cancelDownload: (taskId: string) => ipcRenderer.invoke('aowu:download-cancel', taskId),
  pauseDownload: (taskId: string) => ipcRenderer.invoke('aowu:download-pause', taskId),
  resumeDownload: (
    taskId: string,
    title?: string,
    animeId?: string,
    sourceIdx?: number,
    epList?: { idx: number; label: string }[],
    pendingEps?: number[],
    savePath?: string
  ) => ipcRenderer.invoke('aowu:download-resume', taskId, title, animeId, sourceIdx, epList, pendingEps, savePath),
  requeueEpisodes: (
    taskId: string,
    title: string,
    animeId: string,
    sourceIdx: number,
    epList: { idx: number; label: string }[],
    eps: number[],
    savePath?: string
  ) => ipcRenderer.invoke('aowu:download-requeue', taskId, title, animeId, sourceIdx, epList, eps, savePath),
  retryDownload: (
    taskId: string,
    title: string,
    animeId: string,
    sourceIdx: number,
    epList: { idx: number; label: string }[],
    failedEps: number[],
    savePath?: string
  ) => ipcRenderer.invoke('aowu:download-retry', taskId, title, animeId, sourceIdx, epList, failedEps, savePath),
  switchSource: (
    taskId: string,
    title: string,
    animeId: string,
    newSourceIdx: number,
    epList: { idx: number; label: string }[],
    failedEps: number[],
    savePath?: string
  ) => ipcRenderer.invoke('aowu:download-switch-source', taskId, title, animeId, newSourceIdx, epList, failedEps, savePath),
})

contextBridge.exposeInMainWorld('fileExplorerApi', {
  getHomeInfo: () => ipcRenderer.invoke('fs:home-info'),
  listDir: (dirPath: string) => ipcRenderer.invoke('fs:list-dir', dirPath),
  open: (targetPath: string) => ipcRenderer.invoke('fs:open', targetPath),
  reveal: (targetPath: string) => ipcRenderer.invoke('fs:reveal', targetPath),
  trash: (targetPath: string) => ipcRenderer.invoke('fs:trash', targetPath),
  deletePermanent: (targetPath: string) => ipcRenderer.invoke('fs:delete-permanent', targetPath),
  resolveSpecial: (input: string) => ipcRenderer.invoke('fs:resolve-special', input),
  /**
   * Walk up from `targetPath` and return the closest still-existing directory
   * (returns `targetPath` itself if it still exists). Used by the delete flow
   * to navigate away from a now-deleted cwd without leaving the UI stranded
   * on an unreachable path.
   */
  findExistingAncestor: (targetPath: string): Promise<string | null> =>
    ipcRenderer.invoke('fs:find-existing-ancestor', targetPath),
  onDirChange: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('fs:dir-changed', handler)
    return () => ipcRenderer.removeListener('fs:dir-changed', handler)
  },
})

contextBridge.exposeInMainWorld('libraryApi', {
  getPaths: () => ipcRenderer.invoke('library:get-paths'),
  addPath: (folderPath: string, label: string) => ipcRenderer.invoke('library:add-path', folderPath, label),
  removePath: (folderPath: string) => ipcRenderer.invoke('library:remove-path', folderPath),
  getEntries: () => ipcRenderer.invoke('library:get-entries'),
  getFiles: (folderPath: string) => ipcRenderer.invoke('library:get-files', folderPath),
  openFolder: (folderPath: string) => ipcRenderer.invoke('library:open-folder', folderPath),
  playVideo: (filePath: string) => ipcRenderer.invoke('library:play-video', filePath),
  playFolder: (folderPath: string) => ipcRenderer.invoke('library:play-folder', folderPath),
  scan: () => ipcRenderer.invoke('library:scan'),
  onScanStatus: (cb: (status: { status: string, currentVal: number, totalVal: number }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, status: any) => cb(status)
    ipcRenderer.on('library:scan-status', handler)
    return () => ipcRenderer.removeListener('library:scan-status', handler)
  },
  onLibraryUpdated: (callback: (entries: any[]) => void) => {
    ipcRenderer.removeAllListeners('library-updated') // 防止热更新导致重复绑定
    ipcRenderer.on('library-updated', (_event, entries) => callback(entries))
  }
})

contextBridge.exposeInMainWorld('mailApi', {
  /** 获取邮件配置（authCode 不会原样返回，只回布尔 hasAuthCode）。 */
  getConfig: () => ipcRenderer.invoke('mail:get-config'),
  /**
   * 保存邮件配置。authCode 留空表示沿用磁盘上已有的加密值（编辑场景里
   * 用户不重新输入授权码也能改 enabled / qqEmail）。
   */
  setConfig: (config: { enabled: boolean; qqEmail: string; authCode: string }) =>
    ipcRenderer.invoke('mail:set-config', config),
  /** 手动触发周历邮件发送（用于内部自动触发逻辑，UI 一般不直接调）。 */
  sendCalendar: () => ipcRenderer.invoke('mail:send-calendar'),
  /**
   * MyAnime「发送极简报告」按钮调这个。html 参数是 renderer 拼好的完整
   * 邮件正文（含内联样式），主进程只负责套上 from/to/subject 通过 SMTP 发送。
   */
  sendAnimeReport: (html: string) => ipcRenderer.invoke('mail:send-anime-report', html),
  /** Settings 页「发送测试邮件」按钮调这个，失败会抛错让用户看到原因。 */
  testSend: () => ipcRenderer.invoke('mail:test-send'),
})

// 仅供 screenshot 模式的渲染器使用：渲染好后上报 scrollHeight 让主进程
// resize 隐藏窗口然后 capturePage。普通页面不应该用这个接口。
// IPC payload 用对象包一层 —— 主进程那边解构 .height 才能拿到，直接传数字会让
// 主进程拿到 undefined（destructure on number → undefined），导致 setBounds
// 传入 NaN，截图整个崩在 resize 这一步。
contextBridge.exposeInMainWorld('screenshotApi', {
  reportCalendarReady: (height: number) =>
    ipcRenderer.invoke('screenshot:calendar-ready', { height }),
})

contextBridge.exposeInMainWorld('webdavApi', {
  getConfig: () => ipcRenderer.invoke('webdav:get-config'),
  saveConfig: (config: { account: string; appPassword: string; remotePath: string }) =>
    ipcRenderer.invoke('webdav:save-config', config),
  test: () => ipcRenderer.invoke('webdav:test'),
  /**
   * Push a JSON blob to the per-kind remote file (e.g. `homework.json` /
   * `anime.json` under the user's base folder). Each kind has its own rev /
   * conflict detection; renderer pages call this only for their own kind.
   */
  push: (kind: 'homework' | 'anime', jsonStr: string) => ipcRenderer.invoke('webdav:push', kind, jsonStr),
  pull: (kind: 'homework' | 'anime') => ipcRenderer.invoke('webdav:pull', kind),
})
