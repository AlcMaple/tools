import type { SearchCard, Source } from "../types/search";

const DAY = 24 * 60 * 60 * 1000;

const TTL_BY_SOURCE: Record<string, number> = {
  xifan: 30 * DAY,
  girigiri: 30 * DAY,
  bgm: 14 * DAY,
};

export function isSearchCacheEnabled(): boolean {
  try {
    return (
      JSON.parse(localStorage.getItem("xifan_settings") || "{}")
        .searchCacheEnabled !== false
    );
  } catch {
    return true;
  }
}

export interface CachedSearchHit {
  data: SearchCard[];
  isStale: boolean;
}

type Entry<T> = { data: T; updatedAt: number };

export function readCacheEntry<T>(raw: unknown): Entry<T> | null {
  if (
    raw &&
    typeof raw === "object" &&
    "data" in (raw as Record<string, unknown>)
  ) {
    const r = raw as { data: T; updatedAt?: number };
    return {
      data: r.data,
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
    };
  }
  return null;
}

function ttlFor(source: Source): number {
  return TTL_BY_SOURCE[source.toLowerCase()] ?? 7 * DAY;
}

export async function getCachedSearch(
  keyword: string,
  source: Source,
): Promise<CachedSearchHit | null> {
  try {
    const key = `search_cache_${source.toLowerCase()}`;
    const all = (await window.systemApi.cacheGet(key)) as Record<
      string,
      unknown
    > | null;
    if (!all) return null;
    const entry = readCacheEntry<SearchCard[]>(all[keyword]);
    if (!entry) return null;
    return {
      data: entry.data,
      isStale: Date.now() - entry.updatedAt > ttlFor(source),
    };
  } catch {
    return null;
  }
}

export async function setCachedSearch(
  keyword: string,
  source: Source,
  cards: SearchCard[],
): Promise<void> {
  const key = `search_cache_${source.toLowerCase()}`;
  try {
    await window.systemApi.cacheSet(key, keyword, {
      data: cards,
      updatedAt: Date.now(),
    });
  } catch {
    /* ignore */
  }
}

const inflight = new Map<string, Promise<void>>();

export function dedupRefresh(
  key: string,
  run: () => Promise<void>,
): Promise<void> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function getSavePath(): string | undefined {
  try {
    return (
      JSON.parse(localStorage.getItem("xifan_settings") || "{}").downloadPath ||
      undefined
    );
  } catch {
    return undefined;
  }
}
