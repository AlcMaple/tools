import { useEffect, useState } from 'react'
import { animeTrackStore, AnimeStatus, useAnimeTrack } from '../../stores/animeTrackStore'
import { NoteTagInput } from '../homework/shared'

interface Props {
  bgmId: number
  totalEpisodes?: number
}

const STATUS_ORDER: ReadonlyArray<AnimeStatus> = ['plan', 'watching', 'completed', 'paused', 'dropped']
const STATUS_LABEL: Record<AnimeStatus, string> = {
  plan: '想看',
  watching: '在追',
  completed: '看完',
  paused: '暂停',
  dropped: '弃番',
}

function relativeAgo(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * "我的状态" — only renders when the user has an active track entry.
 * The empty-state CTA is owned by the host page (AnimeInfo) and integrated
 * into its existing button column, so this component itself never creates
 * an extra visual layer for the "not yet tracked" state.
 */
export function AnimeStatusCard({ bgmId, totalEpisodes }: Props): JSX.Element | null {
  const track = useAnimeTrack(bgmId)
  const [confirmRemove, setConfirmRemove] = useState(false)

  // Local draft state for the notes tag input — committed back to store on change.
  // Reset whenever the underlying track's notes change (e.g. another tab edits).
  const [noteDraft, setNoteDraft] = useState('')
  useEffect(() => { setNoteDraft('') }, [bgmId])

  if (!track) return null

  const setStatus = (s: AnimeStatus): void => {
    // Toggling to "watching" auto-bumps episode 0 → 1 so the user doesn't need
    // a second tap. Setting to "completed" backfills episode to total when known.
    let episode = track.episode
    if (s === 'watching' && episode === 0) episode = 1
    if (s === 'completed' && totalEpisodes && episode < totalEpisodes) episode = totalEpisodes
    animeTrackStore.upsert({ bgmId, status: s, episode })
  }

  const setEpisode = (n: number): void => {
    const clamped = Math.max(0, totalEpisodes != null ? Math.min(n, totalEpisodes) : n)
    // Auto-promote status if user starts watching while in plan/paused/dropped
    let status: AnimeStatus | undefined
    if (clamped > 0 && (track.status === 'plan' || track.status === 'paused' || track.status === 'dropped')) {
      status = 'watching'
    }
    if (totalEpisodes != null && clamped >= totalEpisodes && totalEpisodes > 0) {
      status = 'completed'
    }
    animeTrackStore.upsert({ bgmId, episode: clamped, ...(status ? { status } : {}) })
  }

  const setNotes = (notes: string[]): void => {
    animeTrackStore.upsert({ bgmId, notes })
  }

  const handleRemove = (): void => {
    if (!confirmRemove) { setConfirmRemove(true); setTimeout(() => setConfirmRemove(false), 3000); return }
    animeTrackStore.delete(bgmId)
    setConfirmRemove(false)
  }

  return (
    <div className="mt-4 bg-surface-container rounded-xl border border-outline-variant/15 overflow-hidden">
      {/* Header */}
      <div className="px-5 pt-4 pb-3 flex items-center justify-between border-b border-outline-variant/10">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-[16px] leading-none" style={{ fontVariationSettings: "'FILL' 1" }}>bookmark</span>
          <span className="font-label text-[10px] uppercase tracking-[0.25em] text-on-surface-variant/60">My Status</span>
        </div>
        <button
          onClick={handleRemove}
          className={`flex items-center gap-1 font-label text-[10px] uppercase tracking-widest transition-colors ${
            confirmRemove ? 'text-error' : 'text-on-surface-variant/35 hover:text-error'
          }`}
          title={confirmRemove ? '再次点击确认移除' : '从追番列表移除'}
        >
          <span className="material-symbols-outlined text-[13px] leading-none">{confirmRemove ? 'warning' : 'close'}</span>
          {confirmRemove ? '确认移除' : '移除'}
        </button>
      </div>

      {/* Status segment */}
      <div className="px-5 pt-4">
        <div className="flex bg-surface-container-high/60 rounded-lg p-1 border border-outline-variant/10 gap-0.5">
          {STATUS_ORDER.map(s => {
            const active = track.status === s
            return (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`flex-1 py-1.5 rounded-md font-label text-[11px] tracking-wider transition-all ${
                  active
                    ? 'bg-primary-container text-on-primary-container font-bold shadow-sm'
                    : 'text-on-surface-variant/65 hover:text-on-surface'
                }`}
              >
                {STATUS_LABEL[s]}
              </button>
            )
          })}
        </div>
      </div>

      {/* Episode counter */}
      <div className="px-5 pt-4">
        <div className="flex items-center justify-between mb-2">
          <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50">Progress</span>
          {totalEpisodes != null && totalEpisodes > 0 && (
            <span className="font-label text-[10px] tracking-widest text-on-surface-variant/40 tabular-nums">
              {Math.round((track.episode / totalEpisodes) * 100)}%
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 bg-surface-container-high/60 rounded-lg border border-outline-variant/10 px-2 py-2">
          <button
            onClick={() => setEpisode(track.episode - 1)}
            disabled={track.episode <= 0}
            className="w-8 h-8 rounded-md hover:bg-on-surface/[0.06] disabled:opacity-25 disabled:cursor-not-allowed flex items-center justify-center text-on-surface-variant/70 hover:text-on-surface transition-colors"
            title="减一集"
          >
            <span className="material-symbols-outlined text-[18px] leading-none">remove</span>
          </button>
          <input
            type="number"
            min={0}
            max={totalEpisodes ?? undefined}
            value={track.episode}
            onChange={e => {
              const n = parseInt(e.target.value, 10)
              if (!isNaN(n)) setEpisode(n)
            }}
            className="flex-1 bg-transparent outline-none text-center font-headline font-black text-2xl tabular-nums text-on-surface placeholder-on-surface-variant/30 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/40 tabular-nums whitespace-nowrap">
            / {totalEpisodes != null && totalEpisodes > 0 ? totalEpisodes : '—'} eps
          </span>
          <button
            onClick={() => setEpisode(track.episode + 1)}
            disabled={totalEpisodes != null && totalEpisodes > 0 && track.episode >= totalEpisodes}
            className="w-8 h-8 rounded-md bg-primary/10 hover:bg-primary/20 text-primary disabled:opacity-25 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
            title="加一集"
          >
            <span className="material-symbols-outlined text-[18px] leading-none" style={{ fontVariationSettings: "'FILL' 1" }}>add</span>
          </button>
        </div>
      </div>

      {/* Notes */}
      <div className="px-5 pt-4 pb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50">Notes</span>
          <span className="font-label text-[9px] tracking-widest text-on-surface-variant/30">回车添加</span>
        </div>
        <NoteTagInput
          notes={track.notes}
          onNotesChange={setNotes}
          draft={noteDraft}
          onDraftChange={setNoteDraft}
          placeholder="例：从第 5 集开始追、装备配置 …"
        />
      </div>

      {/* Footer meta */}
      <div className="px-5 py-2.5 border-t border-outline-variant/10 bg-surface-container-low/40 flex items-center justify-between font-label text-[9.5px] tracking-widest uppercase text-on-surface-variant/35">
        <span>开始 · {relativeAgo(track.startedAt)}</span>
        <span>更新 · {relativeAgo(track.updatedAt)}</span>
      </div>
    </div>
  )
}
