import type { SearchCard, Source } from "../types/search";

const DAY = 24 * 60 * 60 * 1000;

const TTL_BY_SOURCE: Record<string, number> = {
  xifan: 30 * DAY,
  girigiri: 30 * DAY,
  aowu: 30 * DAY,
  // 稀饭/Girigiri/嗷呜是站内已收录的固定条目,新老关键词命中的都是同一批老番,长 TTL 没问题。
  // B 站是全站实时投稿索引,同一关键词随时可能冒出新视频,缓存太久等于让新投稿"隐身",
  // 只给 1 天——命中缓存图个"秒出结果"的快,但不该压过"能搜到新东西"。
  bilibili: 1 * DAY,
  bgm: 14 * DAY,
};

/**
 * 缓存桶版本号。只有当某个源的 SearchCard 归一化逻辑变了(字段含义变化,不只是新增可选字段)
 * 才需要给它加版本——旧版本号写入的缓存桶会被当作"不存在",不再读取,相当于强制失效,
 * 不用等 TTL 过期。默认版本 1,不出现在 key 里,保持旧数据继续可读。
 */
const CACHE_VERSION_BY_SOURCE: Record<string, number> = {
  // v2: 封面改走 mtmedia:// 代理(之前是裸 https 链接,拿不到 Referer 会 403)+ 补了
  // "BILI_<数字>"僵尸账号过滤——v1 缓存里的条目两个都没有,必须失效重搜。
  bilibili: 2,
};

function cacheKeyFor(source: Source): string {
  const s = source.toLowerCase()
  const v = CACHE_VERSION_BY_SOURCE[s] ?? 1
  return v > 1 ? `search_cache_${s}_v${v}` : `search_cache_${s}`
}

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
    const key = cacheKeyFor(source);
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
  const key = cacheKeyFor(source);
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
