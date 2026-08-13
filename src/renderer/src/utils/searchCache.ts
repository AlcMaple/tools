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
    // **空结果一律当缓存未命中**:它们多半是临时故障(站点改版 / 网络抖)产生的 0 条结果、
    // 又没有抛错;把这种条目当命中会让用户在整个 TTL 内都搜不到真结果。
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
  // 同理,空结果也不写缓存。
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
 * 同一个 key 的并发后台刷新去重:一个关键词的 SWR 正在跑时,第二次 stale 命中复用同一个
 * Promise,不再发第二个请求。
 * **失败不重试**:异常在内部被吞掉,inflight 在 finally 里清理,所以下次还会重新发起 ——
 * 具体什么时候重试由调用方决定(典型是「下次用户搜同一关键词」),不在这一层做。
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
