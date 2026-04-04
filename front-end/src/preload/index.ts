import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('versions', {
  node: () => process.versions.node,
  chrome: () => process.versions.chrome,
  electron: () => process.versions.electron,
})

contextBridge.exposeInMainWorld('bgmApi', {
  search: (keyword: string) => ipcRenderer.invoke('bgm:search', keyword),
  detail: (subjectId: number) => ipcRenderer.invoke('bgm:detail', subjectId),
})

contextBridge.exposeInMainWorld('systemApi', {
  getDiskFree: () => ipcRenderer.invoke('system:disk-free'),
  pickFolder: () => ipcRenderer.invoke('system:pick-folder'),
  checkConnectivity: () => ipcRenderer.invoke('system:connectivity'),
  loadSettingsHistory: () => ipcRenderer.invoke('system:history-read'),
  saveSettingsHistory: (entries: unknown) => ipcRenderer.invoke('system:history-write', entries),
  cacheGet: (key: string) => ipcRenderer.invoke('cache:get', key),
  cacheSet: (key: string, valueOrSubkey: unknown, maybeValue?: unknown) => ipcRenderer.invoke('cache:set', key, valueOrSubkey, maybeValue),
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
  pauseEpisode: (taskId: string, ep: number) => ipcRenderer.invoke('girigiri:download-pause-ep', taskId, ep),
  resumeEpisode: (taskId: string, ep: number) => ipcRenderer.invoke('girigiri:download-resume-ep', taskId, ep),
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
  onDownloadProgress: (cb: (taskId: string, event: unknown) => void) => {
    const handler = (_: Electron.IpcRendererEvent, taskId: string, ev: unknown) => cb(taskId, ev)
    ipcRenderer.on('download:progress', handler)
    return () => ipcRenderer.removeListener('download:progress', handler)
  },
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
  resumeDownload: (taskId: string, title?: string, templates?: string[], pendingEps?: number[], savePath?: string) =>
    ipcRenderer.invoke('xifan:download-resume', taskId, title, templates, pendingEps, savePath),
  pauseEpisode: (taskId: string, ep: number) => ipcRenderer.invoke('xifan:download-pause-ep', taskId, ep),
  resumeEpisode: (taskId: string, ep: number) => ipcRenderer.invoke('xifan:download-resume-ep', taskId, ep),
  requeueEpisodes: (taskId: string, title: string, templates: string[], eps: number[], savePath?: string) =>
    ipcRenderer.invoke('xifan:download-requeue', taskId, title, templates, eps, savePath),
  retryDownload: (taskId: string, title: string, templates: string[], failedEps: number[], savePath?: string) =>
    ipcRenderer.invoke('xifan:download-retry', taskId, title, templates, failedEps, savePath),
  onDownloadProgress: (cb: (taskId: string, event: unknown) => void) => {
    const handler = (_: Electron.IpcRendererEvent, taskId: string, ev: unknown) => cb(taskId, ev)
    ipcRenderer.on('download:progress', handler)
    return () => ipcRenderer.removeListener('download:progress', handler)
  },
})

contextBridge.exposeInMainWorld('libraryApi', {
  getPaths: () => ipcRenderer.invoke('library:get-paths'),
  addPath: (folderPath: string, label: string) => ipcRenderer.invoke('library:add-path', folderPath, label),
  removePath: (folderPath: string) => ipcRenderer.invoke('library:remove-path', folderPath),
  getEntries: () => ipcRenderer.invoke('library:get-entries'),
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
