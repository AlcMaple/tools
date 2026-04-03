import { useState, useEffect } from 'react'
import TopBar from '../components/TopBar'
import { downloadStore, type DownloadTask } from '../stores/downloadStore'

function useDownloadTasks(): DownloadTask[] {
  const [tasks, setTasks] = useState<DownloadTask[]>(() => downloadStore.getTasks())
  useEffect(() => downloadStore.subscribe(() => setTasks(downloadStore.getTasks())), [])
  return tasks
}

// ── Episode grid ──────────────────────────────────────────────────────────────

function EpisodeGrid({
  task,
  onRetryEp,
  onPauseEp,
  onResumeEp,
}: {
  task: DownloadTask
  onRetryEp: (ep: number) => void
  onPauseEp: (ep: number) => void
  onResumeEp: (ep: number) => void
}): JSX.Element {
  const eps =
    task.source === 'girigiri'
      ? Object.keys(task.epStatus).map(Number).sort((a, b) => a - b)
      : Array.from({ length: task.endEp - task.startEp + 1 }, (_, i) => task.startEp + i)

  const epLabel = (ep: number): string => {
    if (task.source === 'girigiri') {
      return task.girigiriEps?.find((e) => e.idx === ep)?.name ?? `EP ${ep}`
    }
    return `EP ${String(ep).padStart(2, '0')}`
  }

  return (
    <div className="mt-6 pt-5 border-t border-outline-variant/10">
      <div className="grid grid-cols-6 gap-2.5">
        {eps.map((ep) => {
          const status = task.epStatus[ep] ?? 'pending'
          const pct = task.epProgress[ep] ?? 0

          if (status === 'done') {
            return (
              <div
                key={ep}
                className="bg-surface-container-lowest p-3 rounded-lg flex flex-col items-center justify-center border-b-2 border-secondary/40"
              >
                <span className="font-label text-[10px] text-on-surface-variant mb-1.5">
                  {epLabel(ep)}
                </span>
                <span
                  className="material-symbols-outlined text-secondary text-sm leading-none"
                  style={{ fontVariationSettings: '"FILL" 1' }}
                >
                  check_circle
                </span>
              </div>
            )
          }

          if (status === 'downloading') {
            return (
              <div
                key={ep}
                className="group relative bg-surface-container-high p-3 rounded-lg flex flex-col items-center justify-center border-b-2 border-primary/40"
              >
                <span className="font-label text-[10px] text-on-surface-variant mb-1.5">
                  {epLabel(ep)}
                </span>
                {/* Progress bar fills as download progresses */}
                <div className="w-full h-1 bg-surface-variant rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="font-label text-[9px] text-primary/60 mt-1">{pct}%</span>
                {/* Pause button overlay on hover */}
                <button
                  onClick={() => onPauseEp(ep)}
                  title="Pause this episode"
                  className="absolute inset-0 flex items-center justify-center rounded-lg bg-surface-container-highest/80 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <span className="material-symbols-outlined text-secondary text-base leading-none">pause</span>
                </button>
              </div>
            )
          }

          if (status === 'paused') {
            return (
              <button
                key={ep}
                onClick={() => onResumeEp(ep)}
                title="Click to prioritize this episode"
                className="bg-surface-container-lowest/60 p-3 rounded-lg flex flex-col items-center justify-center border-b-2 border-on-surface-variant/20 hover:bg-surface-container transition-colors"
              >
                <span className="font-label text-[10px] text-on-surface-variant/50 mb-1.5">
                  {epLabel(ep)}
                </span>
                <span
                  className="material-symbols-outlined text-on-surface-variant/50 text-sm leading-none"
                  style={{ fontVariationSettings: '"FILL" 1' }}
                >
                  pause_circle
                </span>
              </button>
            )
          }

          if (status === 'error') {
            return (
              <button
                key={ep}
                onClick={() => onRetryEp(ep)}
                title="Click to retry this episode"
                className="bg-surface-container-lowest p-3 rounded-lg flex flex-col items-center justify-center border-b-2 border-error/40 hover:bg-error/10 transition-colors"
              >
                <span className="font-label text-[10px] text-error mb-1.5">
                  {epLabel(ep)}
                </span>
                <span className="material-symbols-outlined text-error text-sm leading-none">
                  error_outline
                </span>
              </button>
            )
          }

          // pending
          return (
            <div
              key={ep}
              className="bg-surface-container-lowest/40 p-3 rounded-lg flex flex-col items-center justify-center opacity-40"
            >
              <span className="font-label text-[10px] text-on-surface-variant mb-1.5">
                {epLabel(ep)}
              </span>
              <span className="material-symbols-outlined text-xs leading-none">hourglass_empty</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ task }: { task: DownloadTask }): JSX.Element {
  const total =
    task.source === 'girigiri'
      ? Object.keys(task.epStatus).length
      : task.endEp - task.startEp + 1
  const done = Object.values(task.epStatus).filter((s) => s === 'done').length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  const isPaused = task.status === 'paused'
  const isError = task.status === 'error'

  const barColor = isError
    ? 'bg-error/60'
    : isPaused
      ? 'bg-on-surface-variant/40'
      : 'bg-secondary'

  const label = isPaused ? `PAUSED AT: ${pct}%` : isError ? `ERROR AT: ${pct}%` : `PROGRESS: ${pct}%`
  const labelClass = isError ? 'text-error/60' : 'text-on-surface-variant'

  return (
    <div className="col-span-2">
      <div className="flex justify-between items-center mb-2">
        <span className={`font-label text-[10px] ${labelClass}`}>{label}</span>
        <span className="font-label text-[10px] text-on-surface-variant">
          {done} / {total} eps
        </span>
      </div>
      <div className="h-1.5 w-full bg-surface-variant rounded-full overflow-hidden">
        <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

// ── Active / paused / error task card ─────────────────────────────────────────

function ActiveTaskCard({ task }: { task: DownloadTask }): JSX.Element {
  const isPaused = task.status === 'paused'
  const isError = task.status === 'error'

  const failedEps = Object.entries(task.epStatus)
    .filter(([, s]) => s === 'error')
    .map(([ep]) => Number(ep))

  const api = task.source === 'girigiri' ? window.girigiriApi : window.xifanApi

  const handlePauseResume = async (): Promise<void> => {
    if (isPaused) {
      const pendingEps = Object.entries(task.epStatus)
        .filter(([, s]) => s === 'paused')
        .map(([ep]) => Number(ep))
      if (task.source === 'girigiri') {
        await window.girigiriApi.resumeDownload(task.id, task.title, task.girigiriEps, pendingEps, task.savePath)
      } else {
        await window.xifanApi.resumeDownload(task.id, task.title, task.templates, pendingEps, task.savePath)
      }
      downloadStore.updateTask(task.id, { status: 'running' })
    } else {
      await api.pauseDownload(task.id)
      downloadStore.updateTask(task.id, { status: 'paused' })
    }
  }

  const handleCancel = async (): Promise<void> => {
    await api.cancelDownload(task.id)
    downloadStore.removeTask(task.id)
  }

  const handleRetryAll = async (): Promise<void> => {
    if (failedEps.length === 0) return
    downloadStore.retryTask(task.id)
    if (task.source === 'girigiri') {
      await window.girigiriApi.retryDownload(task.id, task.title, task.girigiriEps!, failedEps, task.savePath)
    } else {
      await window.xifanApi.retryDownload(task.id, task.title, task.templates, failedEps, task.savePath)
    }
  }

  const handleRetryEp = async (ep: number): Promise<void> => {
    downloadStore.retryTask(task.id)
    if (task.source === 'girigiri') {
      await window.girigiriApi.retryDownload(task.id, task.title, task.girigiriEps!, [ep], task.savePath)
    } else {
      await window.xifanApi.retryDownload(task.id, task.title, task.templates, [ep], task.savePath)
    }
  }

  const handlePauseEp = async (ep: number): Promise<void> => {
    await api.pauseEpisode(task.id, ep)
    // ep_paused event from main process will update the store
  }

  const handleResumeEp = async (ep: number): Promise<void> => {
    await api.resumeEpisode(task.id, ep)
    // ep_queued event from main process will update the store
  }

  return (
    <div
      className={`bg-surface-container rounded-xl overflow-hidden transition-all duration-300 hover:bg-surface-container-high/60 ${
        isError ? 'border-l-4 border-error/50' : ''
      }`}
    >
      <div className="p-6">
        <div className={`flex items-start space-x-6 ${isPaused ? 'opacity-60' : ''}`}>
          {/* Cover */}
          <div className="relative w-20 h-28 flex-shrink-0 rounded-lg overflow-hidden shadow-2xl">
            {task.cover ? (
              <img
                src={task.cover}
                alt={task.title}
                className={`w-full h-full object-cover ${isPaused ? 'grayscale' : ''}`}
                onError={(e) => {
                  e.currentTarget.style.display = 'none'
                }}
              />
            ) : (
              <div className="w-full h-full bg-surface-container-high flex items-center justify-center">
                <span className="material-symbols-outlined text-on-surface-variant/30 text-2xl">movie</span>
              </div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-surface-container-lowest/80 to-transparent" />
          </div>

          {/* Info */}
          <div className="flex-1 flex flex-col justify-between h-28">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="text-xl font-black tracking-tight leading-none mb-1">{task.title}</h3>
                {isError ? (
                  <div className="flex items-center space-x-1.5">
                    <p className="font-label text-[10px] text-error uppercase tracking-widest font-bold">
                      Download Failed
                    </p>
                    <span className="material-symbols-outlined text-error text-[12px] leading-none">error</span>
                  </div>
                ) : (
                  <p className="font-label text-[10px] text-primary/80 uppercase tracking-widest">
                    {isPaused ? 'Paused' : 'Downloading'} ·{' '}
                    {task.source === 'girigiri'
                      ? `${Object.keys(task.epStatus).length} eps`
                      : `EP${task.startEp}–EP${task.endEp}`}
                  </p>
                )}
              </div>
              <div className="flex space-x-1">
                {isError ? (
                  <button
                    onClick={handleRetryAll}
                    disabled={failedEps.length === 0}
                    className="p-2 hover:bg-secondary/20 rounded-full text-secondary transition-all disabled:opacity-30"
                    title="Retry failed episodes"
                  >
                    <span className="material-symbols-outlined text-lg leading-none">refresh</span>
                  </button>
                ) : (
                  <button
                    onClick={handlePauseResume}
                    className={`p-2 rounded-full transition-all ${
                      isPaused
                        ? 'hover:bg-primary/20 text-primary'
                        : 'hover:bg-surface-variant text-secondary'
                    }`}
                    title={isPaused ? 'Resume' : 'Pause'}
                  >
                    <span
                      className="material-symbols-outlined text-lg leading-none"
                      style={isPaused ? { fontVariationSettings: '"FILL" 1' } : undefined}
                    >
                      {isPaused ? 'play_arrow' : 'pause'}
                    </span>
                  </button>
                )}
                <button
                  onClick={handleCancel}
                  className="p-2 hover:bg-error/10 rounded-full text-error transition-all"
                  title="Remove from queue"
                >
                  <span className="material-symbols-outlined text-lg leading-none">close</span>
                </button>
              </div>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-4 gap-4 items-end">
              <ProgressBar task={task} />
              <div className="text-right">
                <p className="font-label text-[10px] text-on-surface-variant uppercase mb-1">Status</p>
                {isError ? (
                  <p className="text-sm font-black text-error">Failed</p>
                ) : isPaused ? (
                  <p className="text-sm font-black text-on-surface-variant">Paused</p>
                ) : (
                  <p className="text-sm font-black text-secondary animate-pulse">Active</p>
                )}
              </div>
              <div className="text-right">
                <p className="font-label text-[10px] text-on-surface-variant uppercase mb-1">Episodes</p>
                <p className="text-sm font-black text-on-surface">
                  {task.source === 'girigiri'
                    ? Object.keys(task.epStatus).length
                    : task.endEp - task.startEp + 1}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Episode grid */}
        <EpisodeGrid
          task={task}
          onRetryEp={handleRetryEp}
          onPauseEp={handlePauseEp}
          onResumeEp={handleResumeEp}
        />
      </div>
    </div>
  )
}

// ── Completed task card ───────────────────────────────────────────────────────

function CompletedTaskCard({ task }: { task: DownloadTask }): JSX.Element {
  const isError = task.status === 'error'

  const failedEps = Object.entries(task.epStatus)
    .filter(([, s]) => s === 'error')
    .map(([ep]) => Number(ep))

  const completedDate = task.completedAt
    ? new Date(task.completedAt).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : ''

  // Both retry handlers reuse the same task.id so progress events update this card.
  const handleRetryAll = async (): Promise<void> => {
    if (failedEps.length === 0) return
    const newEpStatus = { ...task.epStatus }
    for (const ep of failedEps) newEpStatus[ep] = 'pending'
    downloadStore.updateTask(task.id, {
      status: 'running',
      epStatus: newEpStatus,
      epProgress: {},
      completedAt: undefined,
    })
    if (task.source === 'girigiri') {
      await window.girigiriApi.requeueEpisodes(task.id, task.title, task.girigiriEps!, failedEps, task.savePath)
    } else {
      await window.xifanApi.requeueEpisodes(task.id, task.title, task.templates, failedEps, task.savePath)
    }
  }

  const handleRetryEp = async (ep: number): Promise<void> => {
    downloadStore.updateTask(task.id, {
      status: 'running',
      epStatus: { ...task.epStatus, [ep]: 'pending' },
      epProgress: { ...task.epProgress },
      completedAt: undefined,
    })
    if (task.source === 'girigiri') {
      await window.girigiriApi.requeueEpisodes(task.id, task.title, task.girigiriEps!, [ep], task.savePath)
    } else {
      await window.xifanApi.requeueEpisodes(task.id, task.title, task.templates, [ep], task.savePath)
    }
  }

  return (
    <div
      className={`bg-surface-container rounded-xl overflow-hidden transition-all duration-300 ${
        isError ? 'border-l-4 border-error/50' : 'border-l-4 border-secondary/30'
      }`}
    >
      <div className="p-6">
        <div className="flex items-start space-x-6">
          {/* Cover */}
          <div className="relative w-20 h-28 flex-shrink-0 rounded-lg overflow-hidden shadow-2xl">
            {task.cover ? (
              <img
                src={task.cover}
                alt={task.title}
                className="w-full h-full object-cover opacity-70"
                onError={(e) => { e.currentTarget.style.display = 'none' }}
              />
            ) : (
              <div className="w-full h-full bg-surface-container-high flex items-center justify-center">
                <span className="material-symbols-outlined text-on-surface-variant/30 text-2xl">movie</span>
              </div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-surface-container-lowest/80 to-transparent" />
          </div>

          {/* Info */}
          <div className="flex-1 flex flex-col justify-between h-28">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="text-xl font-black tracking-tight leading-none mb-1">{task.title}</h3>
                {isError ? (
                  <div className="flex items-center space-x-1.5">
                    <p className="font-label text-[10px] text-error uppercase tracking-widest font-bold">
                      Completed with errors
                    </p>
                    <span className="material-symbols-outlined text-error text-[12px] leading-none">error</span>
                  </div>
                ) : (
                  <div className="flex items-center space-x-1.5">
                    <p className="font-label text-[10px] text-secondary uppercase tracking-widest font-bold">
                      Download complete
                    </p>
                    <span
                      className="material-symbols-outlined text-secondary text-[12px] leading-none"
                      style={{ fontVariationSettings: '"FILL" 1' }}
                    >
                      check_circle
                    </span>
                  </div>
                )}
              </div>
              <div className="flex space-x-1">
                {isError && failedEps.length > 0 && (
                  <button
                    onClick={handleRetryAll}
                    className="p-2 hover:bg-secondary/20 rounded-full text-secondary transition-all"
                    title="Retry all failed episodes"
                  >
                    <span className="material-symbols-outlined text-lg leading-none">refresh</span>
                  </button>
                )}
                <button
                  onClick={() => downloadStore.removeTask(task.id)}
                  className="p-2 hover:bg-error/10 rounded-full text-on-surface-variant hover:text-error transition-all"
                  title="Dismiss"
                >
                  <span className="material-symbols-outlined text-lg leading-none">close</span>
                </button>
              </div>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-4 gap-4 items-end">
              <ProgressBar task={task} />
              <div className="text-right">
                <p className="font-label text-[10px] text-on-surface-variant uppercase mb-1">Status</p>
                {isError ? (
                  <p className="text-sm font-black text-error">Failed</p>
                ) : (
                  <p className="text-sm font-black text-secondary">Done</p>
                )}
              </div>
              <div className="text-right">
                <p className="font-label text-[10px] text-on-surface-variant uppercase mb-1">Completed</p>
                <p className="text-xs font-bold text-on-surface-variant">{completedDate}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Episode grid — no pause/resume for completed tasks */}
        <EpisodeGrid
          task={task}
          onRetryEp={handleRetryEp}
          onPauseEp={() => {}}
          onResumeEp={() => {}}
        />
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

function DownloadQueue(): JSX.Element {
  const tasks = useDownloadTasks()
  const active = tasks.filter((t) => t.status === 'running' || t.status === 'paused' || t.status === 'error')
  const completed = tasks.filter((t) => t.status === 'done')

  const running = active.filter((t) => t.status === 'running')
  const paused = active.filter((t) => t.status === 'paused')

  const handlePauseAll = async (): Promise<void> => {
    await Promise.all(
      running.map(async (t) => {
        const api = t.source === 'girigiri' ? window.girigiriApi : window.xifanApi
        await api.pauseDownload(t.id)
        downloadStore.updateTask(t.id, { status: 'paused' })
      })
    )
  }

  const handleStartAll = async (): Promise<void> => {
    await Promise.all(
      paused.map(async (t) => {
        const pendingEps = Object.entries(t.epStatus)
          .filter(([, s]) => s === 'paused')
          .map(([ep]) => Number(ep))
        if (t.source === 'girigiri') {
          await window.girigiriApi.resumeDownload(t.id, t.title, t.girigiriEps, pendingEps, t.savePath)
        } else {
          await window.xifanApi.resumeDownload(t.id, t.title, t.templates, pendingEps, t.savePath)
        }
        downloadStore.updateTask(t.id, { status: 'running' })
      })
    )
  }

  const handleClearCompleted = (): void => {
    completed.forEach((t) => downloadStore.removeTask(t.id))
  }

  return (
    <div className="min-h-full bg-background">
      <TopBar placeholder="Filter current downloads..." />

      <main className="pt-16 px-8 py-8 max-w-6xl mx-auto">
        {/* Master control bar */}
        <div className="flex justify-between items-end mt-6 mb-10">
          <div>
            <h1 className="text-4xl font-black tracking-tighter mb-2">DOWNLOAD QUEUE</h1>
            <div className="flex items-center space-x-4">
              <span className="font-label text-xs uppercase tracking-widest text-on-surface-variant">
                Active Tasks:{' '}
                <span className="text-primary font-bold">{String(running.length).padStart(2, '0')}</span>
              </span>
              <div className="w-1 h-1 bg-on-surface-variant/30 rounded-full" />
              <span className="font-label text-xs uppercase tracking-widest text-on-surface-variant">
                Paused:{' '}
                <span className="text-secondary font-bold">{String(paused.length).padStart(2, '0')}</span>
              </span>
            </div>
          </div>

          {(running.length > 0 || paused.length > 0) && (
            <div className="flex space-x-3">
              {running.length > 0 && (
                <button
                  onClick={handlePauseAll}
                  className="flex items-center space-x-2 px-6 py-2.5 rounded-full bg-surface-container-high border border-outline-variant/10 hover:bg-surface-variant transition-colors text-sm font-bold font-label"
                >
                  <span className="material-symbols-outlined text-sm leading-none">pause_circle</span>
                  <span>Pause All</span>
                </button>
              )}
              {paused.length > 0 && (
                <button
                  onClick={handleStartAll}
                  className="flex items-center space-x-2 px-6 py-2.5 rounded-full primary-gradient text-on-primary text-sm font-bold font-label shadow-lg shadow-primary/10"
                >
                  <span
                    className="material-symbols-outlined text-sm leading-none"
                    style={{ fontVariationSettings: '"FILL" 1' }}
                  >
                    play_arrow
                  </span>
                  <span>Start All</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Empty state */}
        {tasks.length === 0 && (
          <div className="flex flex-col items-center justify-center py-32 gap-4 text-on-surface-variant/20">
            <span className="material-symbols-outlined text-6xl">download_done</span>
            <p className="font-label text-xs tracking-widest uppercase">No downloads yet</p>
            <p className="font-label text-xs text-on-surface-variant/30">
              Start a download from Search &amp; Download
            </p>
          </div>
        )}

        {/* Active / paused / error tasks */}
        {active.length > 0 && (
          <div className="space-y-6 mb-16">
            {active.map((task) => (
              <ActiveTaskCard key={task.id} task={task} />
            ))}
          </div>
        )}

        {/* Recently Completed */}
        {completed.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-6">
              <h4 className="font-label text-xs font-bold uppercase tracking-[0.2em] text-on-surface-variant/60">
                Recently Completed
              </h4>
              <button
                onClick={handleClearCompleted}
                className="text-[10px] font-label font-bold text-primary uppercase tracking-widest hover:underline transition-all"
              >
                Clear All
              </button>
            </div>
            <div className="space-y-6">
              {completed.map((task) => (
                <CompletedTaskCard key={task.id} task={task} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

export default DownloadQueue
