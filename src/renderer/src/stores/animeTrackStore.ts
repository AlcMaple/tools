// Anime tracking store — backs the "我的状态" card on AnimeInfo and (later)
// the aggregate view + per-source bindings. Mirrors homework's storage shape:
// localStorage-only, plain class with manual subscribe, normalize on read.
//
// The canonical key is `bgmId` (Bangumi subject id) — every other surface in
// the app (xifan/girigiri/aowu search results, schedule, etc.) joins back to
// this id via a per-track `bindings[]` list, populated when the user actively
// links a source result to the track. There is *no* fuzzy title matching.

export type AnimeStatus = 'plan' | 'watching' | 'completed' | 'paused' | 'dropped'

export interface AnimeBinding {
  /** Capitalised to match the existing `Source` type used by SearchDownload. */
  source: 'Xifan' | 'Girigiri' | 'Aowu' | 'Bilibili' | 'Custom'
  /** Title as it appears on that source — kept for display when the user reviews their bindings. */
  sourceTitle: string
  /** Either the per-source slug/key or a full URL. */
  sourceKey: string
  /** Optional explicit URL; if omitted, callers compute it from sourceKey + source convention. */
  sourceUrl?: string
}

export interface AnimeTrack {
  bgmId: number
  title: string
  titleCn?: string
  cover?: string
  status: AnimeStatus
  /** Last watched episode (0 = not started). */
  episode: number
  /** From BGM detail when known; left undefined for ongoing series with TBD count. */
  totalEpisodes?: number
  /** Per-source bindings — empty in step 1a, populated in step 1b. */
  bindings: AnimeBinding[]
  notes: string[]
  /** ISO date when the user first tracked this anime. */
  startedAt: string
  /** ISO date of the most recent mutation. */
  updatedAt: string
}

const STORAGE_KEY = 'maple-anime-tracks-v1'
const VALID_STATUS: ReadonlyArray<AnimeStatus> = ['plan', 'watching', 'completed', 'paused', 'dropped']

function normalize(t: Partial<AnimeTrack> & { bgmId: number }): AnimeTrack {
  const now = new Date().toISOString()
  const status = (t.status && VALID_STATUS.includes(t.status)) ? t.status : 'plan'
  const episode = typeof t.episode === 'number' && t.episode >= 0 ? Math.floor(t.episode) : 0
  const total = typeof t.totalEpisodes === 'number' && t.totalEpisodes > 0 ? Math.floor(t.totalEpisodes) : undefined
  const notes = Array.isArray(t.notes) ? t.notes.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : []
  const bindings = Array.isArray(t.bindings) ? t.bindings.filter(b => b && typeof b === 'object') as AnimeBinding[] : []
  return {
    bgmId: t.bgmId,
    title: typeof t.title === 'string' ? t.title : '',
    titleCn: typeof t.titleCn === 'string' && t.titleCn.length > 0 ? t.titleCn : undefined,
    cover: typeof t.cover === 'string' && t.cover.length > 0 ? t.cover : undefined,
    status,
    episode: total != null ? Math.min(episode, total) : episode,
    totalEpisodes: total,
    bindings,
    notes,
    startedAt: typeof t.startedAt === 'string' && t.startedAt ? t.startedAt : now,
    updatedAt: typeof t.updatedAt === 'string' && t.updatedAt ? t.updatedAt : now,
  }
}

function readAll(): Map<number, AnimeTrack> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Map()
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return new Map()
    const m = new Map<number, AnimeTrack>()
    for (const v of arr) {
      const t = v as Partial<AnimeTrack>
      if (typeof t?.bgmId === 'number') {
        m.set(t.bgmId, normalize({ ...t, bgmId: t.bgmId }))
      }
    }
    return m
  } catch { return new Map() }
}

class AnimeTrackStore {
  private cache: Map<number, AnimeTrack> | null = null
  private listeners = new Set<() => void>()

  private ensure(): Map<number, AnimeTrack> {
    if (this.cache === null) this.cache = readAll()
    return this.cache
  }

  private persist(): void {
    if (this.cache === null) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.cache.values()]))
    } catch { /* ignore quota errors */ }
    this.listeners.forEach(cb => cb())
  }

  /** Touch updatedAt and recompute all derived state. Returns the stored entry. */
  upsert(patch: Partial<AnimeTrack> & { bgmId: number }): AnimeTrack {
    const map = this.ensure()
    const prev = map.get(patch.bgmId)
    const merged = normalize({
      ...prev,
      ...patch,
      // Preserve startedAt across upserts unless explicitly overwritten.
      startedAt: prev?.startedAt ?? patch.startedAt,
      // Always bump updatedAt regardless of caller.
      updatedAt: new Date().toISOString(),
    })
    map.set(patch.bgmId, merged)
    this.persist()
    return merged
  }

  getByBgmId(id: number): AnimeTrack | null {
    return this.ensure().get(id) ?? null
  }

  delete(bgmId: number): boolean {
    const map = this.ensure()
    const removed = map.delete(bgmId)
    if (removed) this.persist()
    return removed
  }

  list(): AnimeTrack[] {
    return [...this.ensure().values()]
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }
}

export const animeTrackStore = new AnimeTrackStore()
