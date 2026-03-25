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

contextBridge.exposeInMainWorld('xifanApi', {
  getCaptcha: () => ipcRenderer.invoke('xifan:captcha'),
  verifyCaptcha: (code: string) => ipcRenderer.invoke('xifan:verify', code),
  search: (keyword: string) => ipcRenderer.invoke('xifan:search', keyword),
  getWatch: (watchUrl: string) => ipcRenderer.invoke('xifan:watch', watchUrl),
  startDownload: (title: string, templates: string[], startEp: number, endEp: number) =>
    ipcRenderer.invoke('xifan:download', title, templates, startEp, endEp),
  cancelDownload: (taskId: string) => ipcRenderer.invoke('xifan:download-cancel', taskId),
  onDownloadProgress: (cb: (taskId: string, event: unknown) => void) => {
    const handler = (_: Electron.IpcRendererEvent, taskId: string, ev: unknown) => cb(taskId, ev)
    ipcRenderer.on('download:progress', handler)
    return () => ipcRenderer.removeListener('download:progress', handler)
  },
})
