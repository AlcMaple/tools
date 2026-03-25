import { useState, useEffect } from 'react'
import TopBar from '../components/TopBar'
import { downloadStore, type DownloadTask } from '../stores/downloadStore'

function useDownloadTasks(): DownloadTask[] {
  const [tasks, setTasks] = useState<DownloadTask[]>(() => downloadStore.getTasks())
  useEffect(() => downloadStore.subscribe(() => setTasks(downloadStore.getTasks())), [])
  return tasks
}

function EpisodeGrid({ task }: { task: DownloadTask }): JSX.Element {
  const eps = Array.from({ length: task.endEp - task.startEp + 1 }, (_, i) => task.startEp + i)
  const visible = eps.slice(0, 12)
  const overflow = eps.length - visible.length

  return (
    <div className="flex items-center flex-wrap gap-1.5">
      {visible.map((ep) => {
        const status = task.epStatus[ep] ?? 'pending'
        return (
          <div
            key={ep}
            className={`px-2 py-1 rounded text-[9px] font-label font-bold flex items-center space-x-1 ${
              status === 'done'
                ? 'bg-primary/10 text-primary'
                : status === 'downloading'
                  ? 'bg-secondary/10 text-secondary animate-pulse'
                  : status === 'error'
                    ? 'bg-error/10 text-error'
                    : 'bg-surface-container-high text-on-surface-variant/40'
            }`}
          >
            {status === 'done' && (
              <span className="material-symbols-outlined text-[10px] leading-none">check</span>
            )}
            {status === 'error' && (
              <span className="material-symbols-outlined text-[10px] leading-none">close</span>
            )}
            {status === 'pending' && (
              <span className="material-symbols-outlined text-[10px] leading-none">
                hourglass_empty
              </span>
            )}
            <span>EP{String(ep).padStart(2, '0')}</span>
          </div>
        )
      })}
      {overflow > 0 && (
        <span className="text-[9px] font-label text-on-surface-variant/40">+{overflow} more</span>
      )}
    </div>
  )
}

function ProgressBar({ task }: { task: DownloadTask }): JSX.Element {
  const total = task.endEp - task.startEp + 1
  const done = Object.values(task.epStatus).filter((s) => s === 'done').length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  const barClass =
    task.status === 'error'
      ? 'bg-error/60'
      : task.status === 'done'
        ? 'bg-primary'
        : 'primary-gradient'

  return (
    <>
      <div className="w-full h-1.5 bg-surface-container-high rounded-full mb-3 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-label text-on-surface-variant/40">{pct}% complete</span>
        <span className="text-[10px] font-label text-on-surface-variant/40">
          {done} / {total} episodes
        </span>
      </div>
    </>
  )
}

function ActiveTaskCard({ task }: { task: DownloadTask }): JSX.Element {
  const handleCancel = async (): Promise<void> => {
    await window.xifanApi.cancelDownload(task.id)
    downloadStore.removeTask(task.id)
  }

  return (
    <div
      className={`bg-surface-container rounded-xl p-5 border transition-colors ${
        task.status === 'error'
          ? 'border-error/30 border-l-4 border-l-error/50'
          : 'border-outline-variant/20 hover:border-primary/20'
      }`}
    >
      <div className="flex items-start space-x-4">
        {task.cover ? (
          <img
            src={task.cover}
            alt={task.title}
            className="w-16 h-20 object-cover rounded-lg flex-shrink-0"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        ) : (
          <div className="w-16 h-20 bg-surface-container-high rounded-lg flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-on-surface-variant/30 text-2xl">
              movie
            </span>
          </div>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between mb-1">
            <div>
              <h3 className="font-bold text-on-surface text-sm truncate">{task.title}</h3>
              <p className="text-xs font-label text-on-surface-variant/50 mt-0.5">
                EP{task.startEp}–EP{task.endEp} · Xifan
              </p>
            </div>
            <div className="flex items-center space-x-2 flex-shrink-0 ml-3">
              {task.status === 'running' && (
                <p className="text-[10px] font-label text-secondary animate-pulse">Downloading</p>
              )}
              {task.status === 'error' && (
                <p className="text-xs font-label text-error font-bold">Failed</p>
              )}
              <button
                onClick={handleCancel}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-surface-container-high hover:bg-surface-container-highest transition-colors"
                title="Remove from queue"
              >
                <span className="material-symbols-outlined text-on-surface-variant text-base leading-none">
                  close
                </span>
              </button>
            </div>
          </div>

          <ProgressBar task={task} />
          <EpisodeGrid task={task} />
        </div>
      </div>
    </div>
  )
}

function CompletedTaskCard({ task }: { task: DownloadTask }): JSX.Element {
  const total = task.endEp - task.startEp + 1
  const completedDate = task.completedAt
    ? new Date(task.completedAt).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : ''

  return (
    <div className="flex items-center space-x-4 bg-surface-container-low rounded-xl p-4 border border-outline-variant/10">
      <div
        className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
          task.status === 'error' ? 'bg-error/10' : 'bg-primary/10'
        }`}
      >
        <span
          className={`material-symbols-outlined text-xl leading-none ${
            task.status === 'error' ? 'text-error' : 'text-primary'
          }`}
        >
          {task.status === 'error' ? 'error_outline' : 'check_circle'}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-on-surface truncate">{task.title}</p>
        <p className="text-xs font-label text-on-surface-variant/50 mt-0.5">
          {total} episodes · EP{task.startEp}–EP{task.endEp}
        </p>
      </div>
      <div className="text-right flex-shrink-0">
        <p className="text-xs font-label text-on-surface-variant/40">{completedDate}</p>
      </div>
      <button
        onClick={() => downloadStore.removeTask(task.id)}
        className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container transition-colors"
        title="Dismiss"
      >
        <span className="material-symbols-outlined text-on-surface-variant/40 text-base leading-none">
          close
        </span>
      </button>
    </div>
  )
}

function DownloadQueue(): JSX.Element {
  const tasks = useDownloadTasks()
  const active = tasks.filter((t) => t.status === 'running')
  const completed = tasks.filter((t) => t.status !== 'running')

  const handleClearCompleted = (): void => {
    completed.forEach((t) => downloadStore.removeTask(t.id))
  }

  return (
    <div className="min-h-full bg-background">
      <TopBar placeholder="Filter downloads..." />

      <main className="pt-16 px-8 py-8">
        {/* Master control bar */}
        <div className="flex items-center justify-between mt-6 mb-8">
          <div>
            <h1 className="text-3xl font-black tracking-tight text-on-surface">DOWNLOAD QUEUE</h1>
            <div className="flex items-center space-x-4 mt-1.5">
              <span className="text-xs font-label text-on-surface-variant/50">
                Active Tasks:{' '}
                <span className="text-primary font-bold">{String(active.length).padStart(2, '0')}</span>
              </span>
              <span className="text-on-surface-variant/20">·</span>
              <span className="text-xs font-label text-on-surface-variant/50">
                Completed:{' '}
                <span className="text-secondary font-bold">{String(completed.length).padStart(2, '0')}</span>
              </span>
            </div>
          </div>
          {completed.length > 0 && (
            <button
              onClick={handleClearCompleted}
              className="flex items-center space-x-2 px-5 py-2.5 rounded-xl border border-outline-variant/30 text-sm font-label text-on-surface-variant hover:bg-surface-container transition-colors"
            >
              <span className="material-symbols-outlined text-base leading-none">delete_sweep</span>
              <span>Clear Completed</span>
            </button>
          )}
        </div>

        {/* Empty state */}
        {tasks.length === 0 && (
          <div className="flex flex-col items-center justify-center py-32 gap-4 text-on-surface-variant/20">
            <span className="material-symbols-outlined text-6xl">download_done</span>
            <p className="font-label text-xs tracking-widest uppercase">No downloads yet</p>
            <p className="font-label text-xs text-on-surface-variant/30">
              Start a download from Search & Download
            </p>
          </div>
        )}

        {/* Active download tasks */}
        {active.length > 0 && (
          <div className="space-y-4 mb-10">
            {active.map((task) => (
              <ActiveTaskCard key={task.id} task={task} />
            ))}
          </div>
        )}

        {/* Recently Completed */}
        {completed.length > 0 && (
          <section>
            <h2 className="text-xs font-label text-on-surface-variant/50 tracking-widest uppercase mb-4">
              Recently Completed
            </h2>
            <div className="space-y-3">
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
