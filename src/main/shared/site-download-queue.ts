/**
 * 各站共用的下载队列运行时(xifan / girigiri / aowu 的 IPC 层都用它)。
 *
 * 队列机制对三个站是一样的:内存里一张 `Map<taskId, QueueState>`、每个源一个单槽调度器
 * (同源两个任务不会并行去捶站点)、一次只跑一集的串行 worker(先取 `priorityFront` 再取
 * `pending`),外加 取消 / 暂停 / 继续 / 重排 / 重试 / 换源 这些原语。
 *
 * 各站唯一不同的是 `runEpisode` 钩子 —— 它知道怎么用本站的载荷(模板、animeId+源下标、集列表)
 * 真正下完一集。其余全在这里。
 */
import { setMaxListeners } from 'events'
import type { WebContents } from 'electron'
import { trackSpeed, forgetTask } from './speed-tracker'
import type { DlEvent } from './download-types'

export interface QueueState<TPayload> {
  title: string
  savePath: string | null
  /** runEpisode 钩子需要的、各站自己的数据(模板、animeId、集列表…)。 */
  payload: TPayload
  pending: number[]
  priorityFront: number[]
  current: number | null
  currentAbort: AbortController | null
  taskPaused: boolean
  cancelled: boolean
  sender: WebContents
}

export interface QueueInit<TPayload> {
  title: string
  savePath: string | null
  payload: TPayload
  pending: number[]
  sender: WebContents
}

interface SchedulerLike {
  tryAcquire(taskId: string): boolean
  release(taskId: string): void
  on(event: 'available', listener: () => void): void
}

export interface RegistryConfig<TPayload> {
  /** 日志前缀标签('xifan' / 'girigiri' / 'aowu')。 */
  prefix: string
  /** 该源的单槽闸门。 */
  scheduler: SchedulerLike
  /** 下载一集。完成时 resolve;抛错会被转成 ep_error,worker 继续下一集而不是卡住。用 `signal` 中止。 */
  runEpisode: (
    q: QueueState<TPayload>,
    ep: number,
    signal: AbortSignal,
    onEvent: (ev: DlEvent) => void,
  ) => Promise<void>
}

function safeSend(sender: WebContents, channel: string, ...args: unknown[]): void {
  if (!sender.isDestroyed()) sender.send(channel, ...args)
}

export function newTaskId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export class SiteQueueRegistry<TPayload> {
  private readonly queues = new Map<string, QueueState<TPayload>>()

  constructor(private readonly cfg: RegistryConfig<TPayload>) {
    // 槽位一空,本源所有排队任务都得到一次抢占机会。对没准备好的任务(暂停 / 已取消 / 正在跑)
    // tryAcquire 是空操作,所以广播是安全的。
    cfg.scheduler.on('available', () => {
      for (const taskId of this.queues.keys()) this.startNext(taskId)
    })
  }

  has(taskId: string): boolean {
    return this.queues.has(taskId)
  }

  get(taskId: string): QueueState<TPayload> | undefined {
    return this.queues.get(taskId)
  }

  /** 新建一个队列并启动 worker。 */
  create(taskId: string, init: QueueInit<TPayload>): void {
    this.queues.set(taskId, {
      ...init,
      priorityFront: [],
      current: null,
      currentAbort: null,
      taskPaused: false,
      cancelled: false,
    })
    this.startNext(taskId)
  }

  /**
   * 把若干集插到优先队列前面(重试 / 重排 / 换源用)。worker 空闲且未暂停时会重新启动;
   * 任务不存在则是空操作。
   */
  prependEps(taskId: string, eps: number[]): void {
    const q = this.queues.get(taskId)
    if (!q) return
    for (const ep of [...eps].reverse()) q.priorityFront.unshift(ep)
    if (q.current === null && !q.taskPaused) this.startNext(taskId)
  }

  /** 取消当前下载、丢弃队列、释放槽位。 */
  cancel(taskId: string): void {
    const q = this.queues.get(taskId)
    if (q) {
      q.cancelled = true
      q.currentAbort?.abort()
      this.queues.delete(taskId)
      forgetTask(taskId)
    }
    this.cfg.scheduler.release(taskId)
  }

  /**
   * 暂停:中止正在下的那一集,并把它放回优先队列最前面,继续时接着断点往下(前提是该站的
   * 下载器支持分片续传)。任务存在则返回 true。
   */
  pause(taskId: string): boolean {
    const q = this.queues.get(taskId)
    if (!q) return false
    q.taskPaused = true
    if (q.current !== null) {
      const ep = q.current
      q.priorityFront.unshift(ep)
      safeSend(q.sender, 'download:progress', taskId, { type: 'ep_paused', ep })
      q.currentAbort?.abort()
    }
    this.cfg.scheduler.release(taskId)
    return true
  }

  resume(taskId: string): void {
    const q = this.queues.get(taskId)
    if (!q) return
    q.taskPaused = false
    this.startNext(taskId)
  }

  private startNext(taskId: string): void {
    const q = this.queues.get(taskId)
    if (!q || q.taskPaused || q.cancelled || q.current !== null) return

    const ep = q.priorityFront.shift() ?? q.pending.shift()
    if (ep === undefined) {
      this.queues.delete(taskId)
      forgetTask(taskId)
      this.cfg.scheduler.release(taskId)
      safeSend(q.sender, 'download:progress', taskId, { type: 'all_done' })
      return
    }

    if (!this.cfg.scheduler.tryAcquire(taskId)) {
      // Another task on this source holds the slot. Put the ep back; we'll
      // 等 'available' 事件再抢一次。
      q.priorityFront.unshift(ep)
      return
    }

    const capturedEp = ep
    q.current = capturedEp
    const abort = new AbortController()
    // 一集下载内部有很多并发请求(分片 / HLS 段,各自还带重试 sleep)都订阅同一个信号,
    // 10; give generous headroom so spikes don't trigger MaxListenersExceeded.
    setMaxListeners(200, abort.signal)
    q.currentAbort = abort

    setImmediate(() => {
      this.cfg.runEpisode(q, capturedEp, abort.signal, (ev) => {
        if (ev.type === 'ep_progress' && typeof ev.bytes === 'number') {
          trackSpeed(taskId, capturedEp, ev.bytes)
        }
        safeSend(q.sender, 'download:progress', taskId, ev)
      }).catch((err: unknown) => {
        // 防御:runEpisode 里任何意外抛错都转成
        // ep_error so the worker advances instead of leaving a stuck "in
        // progress" episode and (eventually) firing all_done with bad state.
        console.error(`[${this.cfg.prefix}] download crashed for ep=${capturedEp}:`, err)
        safeSend(q.sender, 'download:progress', taskId, {
          type: 'ep_error',
          ep: capturedEp,
          msg: String(err),
        })
      }).finally(() => {
        if (q.currentAbort === abort) {
          q.current = null
          q.currentAbort = null
        }
        if (!q.cancelled) this.startNext(taskId)
      })
    })
  }
}
