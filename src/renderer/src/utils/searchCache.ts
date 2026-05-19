import type { SearchCard, Source } from "../types/search";

const DAY = 24 * 60 * 60 * 1000;

const TTL_BY_SOURCE: Record<string, number> = {
  xifan: 30 * DAY,
  girigiri: 30 * DAY,
  aowu: 30 * DAY,
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
    // Treat empty-result entries as a cache MISS. They are commonly artifacts
    // of transient failures (site改版 / network blip) that produced 0 cards
    // without throwing; serving such an entry locks the user out of real
    // results until TTL. Force a re-fetch by returning null.
    if (!Array.isArray(entry.data) || entry.data.length === 0) return null;
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
  // Don't cache empty results — see getCachedSearch comment for rationale.
  if (!Array.isArray(cards) || cards.length === 0) return;
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

/**
 * 同一 key 的并发后台刷新去重 —— 一个 keyword 的 SWR 正在跑时，第二个用户
 * 的 stale 命中复用同一个 Promise，不再发第二个请求。
 *
 * **失败不重试**：`run()` 内部已经 try/catch swallow 异常，inflight 清理
 * 在 .finally 里所以下次会重新发起；具体重试时机由调用方决定（典型是
 * "下次用户搜索同一关键词"），不在这一层做。
 */
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
