import { EventEmitter } from 'events'

/**
 * 每个源一个单槽调度器:**同一个源同时只能有一个任务在下载**(跨源并行没问题
 * 一个 girigiri + 一个 xifan 可以;两个 girigiri 不行 —— 那是被站点封 IP 的快车道)。
 *
 * `tryAcquire` 抢不到时返回 false,调用方应把这一集放回队列、等 'available' 事件;
 * 持有者重复 acquire 仍返回 true。任务在 all_done / pause / cancel 时都要 release。
 */
class DownloadScheduler extends EventEmitter {
  private activeTaskId: string | null = null

  tryAcquire(taskId: string): boolean {
    if (this.activeTaskId === null || this.activeTaskId === taskId) {
      this.activeTaskId = taskId
      return true
    }
    return false
  }

  release(taskId: string): void {
    if (this.activeTaskId === taskId) {
      this.activeTaskId = null
      this.emit('available')
    }
  }
}

export const girigiriScheduler = new DownloadScheduler()
export const xifanScheduler = new DownloadScheduler()
export const aowuScheduler = new DownloadScheduler()
// 每个 ipc 模块一个监听者,抬高上限免得触发默认 10 个的告警。
girigiriScheduler.setMaxListeners(50)
xifanScheduler.setMaxListeners(50)
aowuScheduler.setMaxListeners(50)
