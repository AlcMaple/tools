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
