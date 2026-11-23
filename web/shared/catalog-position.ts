import { EPISODE_LIMITS } from './catalog-planning'

export const CATALOG_POSITION_IDS = 12

export interface CatalogFilters {
  year: number
  sort: 'score' | 'date'
  include: string[]
  exclude: string[]
  maxEps: number
  finished: boolean
}

export interface CatalogPosition {
  id: number
  offset: number
}

export interface CatalogBookmark {
  filters: CatalogFilters
  ids: number[]
}

export function isCatalogPositionIds(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= CATALOG_POSITION_IDS
    && value.every(id => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
}

export function isCatalogBookmark(value: unknown): value is CatalogBookmark {
  if (!value || typeof value !== 'object' || !('ids' in value) || !isCatalogPositionIds(value.ids)
    || !('filters' in value) || !value.filters || typeof value.filters !== 'object') return false
  const { year, sort, include, exclude, maxEps, finished } = value.filters as Partial<CatalogFilters>
  const tags = (items: unknown): items is string[] => Array.isArray(items) && items.length <= 5
    && items.every(tag => typeof tag === 'string' && !!tag.trim() && tag.length <= 20)
  return typeof year === 'number' && Number.isSafeInteger(year) && year >= 0
    && (sort === 'score' || sort === 'date') && tags(include) && tags(exclude)
    && EPISODE_LIMITS.some(limit => limit === maxEps) && typeof finished === 'boolean'
}
