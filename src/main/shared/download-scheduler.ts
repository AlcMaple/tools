import { EventEmitter } from 'events'

/**
 * Per-source single-slot scheduler.
 *
 * Why: each source's IPC layer maintains its own per-task queue, but nothing
 * stopped two tasks of the same source from downloading concurrently — that's
 * a fast way to get the user's IP rate-limited or banned by that site.
 *
 * Granularity: one scheduler per source (girigiri / xifan), so cross-source
 * concurrency stays allowed (one girigiri + one xifan in parallel is fine,
 * two girigiri in parallel is not).
 *
 * Contract:
 * - tryAcquire(taskId) — claim the slot. Returns false if another taskId
 *   currently holds it; the caller should re-queue and wait for 'available'.
 *   Re-entrant: the holder can call tryAcquire again and still get true.
 * - release(taskId)    — drop the slot iff this taskId holds it. Emits
 *   'available' so all waiting tasks of this source can re-attempt.
 *
 * Each task should release on: all_done, pause, cancel.
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
// Many tasks may subscribe to 'available' (one listener per ipc module).
// Bump the cap so we don't trip the default-10 warning.
girigiriScheduler.setMaxListeners(50)
xifanScheduler.setMaxListeners(50)
aowuScheduler.setMaxListeners(50)
