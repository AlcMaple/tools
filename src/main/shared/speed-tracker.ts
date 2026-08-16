import { BrowserWindow } from 'electron'

let _speedAccum = 0
const _epLastBytes = new Map<string, Map<number, number>>()
let _timer: NodeJS.Timeout | null = null

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
  if (_timer) return
  _timer = setInterval(() => {
    const bps = _speedAccum
    _speedAccum = 0
    for (const win of BrowserWindow.getAllWindows()) {
      const wc = win.webContents
      // 退出期竞态：窗口在销毁中、渲染帧已没了，此时 send 会抛
      // 「Render frame was disposed」，曾把退出流程绊住（2026-08-16 孤儿进程事故）。
      if (wc.isDestroyed()) continue
      try {
        wc.send('system:speed', bps)
      } catch {
        // isDestroyed 挡不住「帧先走一步」的窗口，单个失败无害，下一个窗口继续
      }
    }
  }, 1000)
}

export function stopSpeedBroadcast(): void {
  if (_timer) {
    clearInterval(_timer)
    _timer = null
  }
}
