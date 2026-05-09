/**
 * Per-site download queue runtime, shared by xifan / girigiri / aowu IPC layers.
 *
 * Each site has the same queue mechanics:
 *   - in-memory `Map<taskId, QueueState>` of in-flight tasks
 *   - per-source single-slot scheduler (so two tasks of the same source don't
 *     hammer the site in parallel)
 *   - sequential one-ep-at-a-time worker that pops `priorityFront` then `pending`
 *   - cancel / pause / resume / requeue / retry / switch-source primitives
 *
 * The only per-source variation is the `runEpisode` hook, which knows how to
 * actually download one ep given the queue's source-specific payload (templates,
 * animeId+sourceIdx, epList, etc.). Everything else lives here.
 *
 * Replaces three near-identical 200-line ipc files (and fixes two parity bugs
 * along the way: xifan was missing the defensive .catch around runEpisode, and
 * none of the three guarded `sender.send` against a destroyed WebContents).
 */
import { setMaxListeners } from 'events'
import type { WebContents } from 'electron'
import { trackSpeed, forgetTask } from './speed-tracker'
import type { DlEvent } from './download-types'

export interface QueueState<TPayload> {
  title: string
  savePath: string | null
  /** Per-source data the runEpisode hook needs (templates, animeId, epList, ...). */
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
  /** Used as a log tag prefix ('xifan' / 'girigiri' / 'aowu'). */
  prefix: string
  /** Per-source single-slot gate. */
  scheduler: SchedulerLike
  /**
   * Run one episode. Resolve when complete; throw to surface as ep_error so the
   * worker advances to the next ep instead of stalling. Use `signal` for abort.
   */
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
    // When the source's slot frees up, every queued task of this source gets a
    // chance to grab it. tryAcquire is a no-op for tasks that aren't ready
    // (paused / cancelled / already running), so broadcasting is safe.
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

  /** Create a fresh queue and kick the worker. */
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
   * Push eps onto the front of the priority queue. Used by retry / requeue /
   * switch-source after the queue already exists. Restarts the worker if it's
   * idle and not paused. No-op if the task is unknown.
   */
  prependEps(taskId: string, eps: number[]): void {
    const q = this.queues.get(taskId)
    if (!q) return
    for (const ep of [...eps].reverse()) q.priorityFront.unshift(ep)
    if (q.current === null && !q.taskPaused) this.startNext(taskId)
  }

  /** Cancel the active download, drop the queue, release the slot. */
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
   * Pause the active download — abort the in-flight ep and put it back at the
   * front of the priority queue so it resumes where it left off (assuming the
   * site's downloader supports per-part / per-segment resume).
   * Returns true if the task existed.
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
      // retry when 'available' fires.
      q.priorityFront.unshift(ep)
      return
    }

    const capturedEp = ep
    q.current = capturedEp
    const abort = new AbortController()
    // Many concurrent fetches inside one ep download (chunks / HLS segments,
    // each with retry sleeps) all subscribe to the same signal. Default cap is
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
        // Defensive: any unexpected throw inside runEpisode surfaces as
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
