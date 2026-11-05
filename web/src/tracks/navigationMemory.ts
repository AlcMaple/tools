import type { TrackStatus } from '../api'

export type TrackFilter = 'all' | TrackStatus

export interface TracksNavigationMemory {
  readonly ownerId: number | null
  filter: TrackFilter
  query: string
}

export function tracksNavigationForOwner(previous: TracksNavigationMemory | null, ownerId: number | null): TracksNavigationMemory {
  if (previous?.ownerId === ownerId) return previous
  return { ownerId, filter: 'all', query: '' }
}
