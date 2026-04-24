import { BrowserWindow } from 'electron'

let _speedAccum = 0
const _epLastBytes = new Map<string, Map<number, number>>()

export function trackSpeed(taskId: string, ep: number, bytes: number): void {
  const taskMap = _epLastBytes.get(taskId) ?? new Map<number, number>()
  const prev = taskMap.get(ep) ?? 0
  _speedAccum += Math.max(0, bytes - prev)
  taskMap.set(ep, bytes)
  _epLastBytes.set(taskId, taskMap)
}

export function forgetTask(taskId: string): void {
  _epLastBytes.delete(taskId)
}

export function startSpeedBroadcast(): void {
  setInterval(() => {
    const bps = _speedAccum
    _speedAccum = 0
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('system:speed', bps)
    }
  }, 1000)
}
