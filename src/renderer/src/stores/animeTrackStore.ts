// Anime tracking store — backs the "我的状态" card on AnimeInfo and (later)
// the aggregate view + per-source bindings. Mirrors homework's storage shape:
// localStorage-only, plain class with manual subscribe, normalize on read.
//
// The canonical key is `bgmId` (Bangumi subject id) — every other surface in
// the app (xifan/girigiri/aowu search results, schedule, etc.) joins back to
// this id via a per-track `bindings[]` list, populated when the user actively
// links a source result to the track. There is *no* fuzzy title matching.

import { useEffect, useState } from 'react'

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

/**
 * Idempotent normalize for an array of unknown tracks — used both for
 * localStorage read and for the WebDAV pull path. Filters out entries
 * without a numeric bgmId, deduplicates by bgmId (keeps the last one in
 * iteration order), and routes each through the per-entry normalizer.
 */
export function normalizeTracks(input: unknown): AnimeTrack[] {
  if (!Array.isArray(input)) return []
  const map = new Map<number, AnimeTrack>()
  for (const v of input) {
    if (!v || typeof v !== 'object') continue
    const t = v as Partial<AnimeTrack>
    if (typeof t.bgmId !== 'number') continue
    map.set(t.bgmId, normalize({ ...t, bgmId: t.bgmId }))
  }
  return [...map.values()]
}

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

  /**
   * Resolve `(source, sourceKey)` → the track that owns this binding, if any.
   * Used by SearchDownload to draw "已追" badges on cards the user has linked
   * before. We compare sourceKey loosely (trim) since both Aowu / Xifan watch
   * URLs and Girigiri play URLs are sometimes pasted with extra whitespace.
   */
  findByBinding(source: AnimeBinding['source'], sourceKey: string): AnimeTrack | null {
    const key = sourceKey.trim()
    if (!key) return null
    for (const t of this.ensure().values()) {
      if (t.bindings.some(b => b.source === source && b.sourceKey.trim() === key)) return t
    }
    return null
  }

  /**
   * Append a binding to an existing track or create a new one. Idempotent on
   * (source, sourceKey) — duplicate bindings are filtered out. Returns the
   * resulting track.
   */
  bind(patch: Partial<AnimeTrack> & { bgmId: number }, binding: AnimeBinding): AnimeTrack {
    const map = this.ensure()
    const prev = map.get(patch.bgmId)
    const prevBindings = prev?.bindings ?? []
    const exists = prevBindings.some(
      b => b.source === binding.source && b.sourceKey.trim() === binding.sourceKey.trim(),
    )
    const bindings = exists ? prevBindings : [...prevBindings, binding]
    return this.upsert({ ...patch, bindings })
  }

  /**
   * Edit an existing binding in place by (source, sourceKey). Caller can patch
   * sourceTitle / sourceKey / sourceUrl together. Used by EditBindingsModal so
   * users can rename custom labels and fix typo'd URLs without losing the
   * binding's position. No-op if no matching binding exists.
   */
  updateBinding(
    bgmId: number,
    oldSource: AnimeBinding['source'],
    oldSourceKey: string,
    patch: Partial<Pick<AnimeBinding, 'sourceTitle' | 'sourceKey' | 'sourceUrl'>>,
  ): boolean {
    const map = this.ensure()
    const prev = map.get(bgmId)
    if (!prev) return false
    const oldKey = oldSourceKey.trim()
    let changed = false
    const next = prev.bindings.map(b => {
      if (b.source === oldSource && b.sourceKey.trim() === oldKey) {
        changed = true
        return { ...b, ...patch }
      }
      return b
    })
    if (!changed) return false
    this.upsert({ bgmId, bindings: next })
    return true
  }

  /**
   * Patch a single binding's `sourceUrl` in place. Used by lazy migrations —
   * e.g. resolving Aowu's synthetic /v/{id} URL to the user-facing /w/{token}
   * form on first chip render, so subsequent clicks have a working link.
   * No-op if no matching binding is found.
   */
  setBindingSourceUrl(
    bgmId: number,
    source: AnimeBinding['source'],
    sourceKey: string,
    sourceUrl: string,
  ): void {
    const map = this.ensure()
    const prev = map.get(bgmId)
    if (!prev) return
    const key = sourceKey.trim()
    let changed = false
    const next = prev.bindings.map(b => {
      if (b.source === source && b.sourceKey.trim() === key && b.sourceUrl !== sourceUrl) {
        changed = true
        return { ...b, sourceUrl }
      }
      return b
    })
    if (!changed) return
    this.upsert({ bgmId, bindings: next })
  }

  /**
   * Remove a single binding by (source, sourceKey). No-op if the track or the
   * matching binding doesn't exist. Returns true if a binding was removed.
   */
  removeBinding(bgmId: number, source: AnimeBinding['source'], sourceKey: string): boolean {
    const map = this.ensure()
    const prev = map.get(bgmId)
    if (!prev) return false
    const key = sourceKey.trim()
    const next = prev.bindings.filter(b => !(b.source === source && b.sourceKey.trim() === key))
    if (next.length === prev.bindings.length) return false
    this.upsert({ bgmId, bindings: next })
    return true
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

  /**
   * Wholesale replace — used by the WebDAV pull path. Input is normalized so
   * partial / legacy entries still land cleanly. Persists + notifies subscribers.
   */
  replaceAll(tracks: AnimeTrack[]): void {
    const next = new Map<number, AnimeTrack>()
    for (const t of tracks) next.set(t.bgmId, t)
    this.cache = next
    this.persist()
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }
}

export const animeTrackStore = new AnimeTrackStore()

/**
 * React hook — subscribes to the full list of tracked anime. Used by the
 * aggregate "我的追番" page. Returns a stable snapshot per change event.
 */
export function useAnimeTrackList(): AnimeTrack[] {
  const [tracks, setTracks] = useState<AnimeTrack[]>(() => animeTrackStore.list())
  useEffect(() => {
    setTracks(animeTrackStore.list())
    return animeTrackStore.subscribe(() => setTracks(animeTrackStore.list()))
  }, [])
  return tracks
}

/**
 * React hook — subscribes to a single track entry by BGM id.
 * Returns null when the user has not added this anime to their list yet.
 */
export function useAnimeTrack(bgmId: number | null | undefined): AnimeTrack | null {
  const [track, setTrack] = useState<AnimeTrack | null>(() =>
    bgmId != null ? animeTrackStore.getByBgmId(bgmId) : null
  )
  useEffect(() => {
    if (bgmId == null) { setTrack(null); return }
    setTrack(animeTrackStore.getByBgmId(bgmId))
    return animeTrackStore.subscribe(() => {
      setTrack(animeTrackStore.getByBgmId(bgmId))
    })
  }, [bgmId])
  return track
}

/**
 * React hook — subscribes to a track entry by (source, sourceKey) binding.
 * Re-renders when the underlying binding list changes (e.g. user just linked
 * the card on this page). Returns null when no track owns this binding yet.
 */
export function useAnimeTrackByBinding(
  source: AnimeBinding['source'] | null | undefined,
  sourceKey: string | null | undefined,
): AnimeTrack | null {
  const [track, setTrack] = useState<AnimeTrack | null>(() =>
    source && sourceKey ? animeTrackStore.findByBinding(source, sourceKey) : null
  )
  useEffect(() => {
    if (!source || !sourceKey) { setTrack(null); return }
    setTrack(animeTrackStore.findByBinding(source, sourceKey))
    return animeTrackStore.subscribe(() => {
      setTrack(animeTrackStore.findByBinding(source, sourceKey))
    })
  }, [source, sourceKey])
  return track
}
