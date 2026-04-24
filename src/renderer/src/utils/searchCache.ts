import type { XifanWatchInfo } from "../types/xifan";
import type { SearchCard, Source } from "../types/search";

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

export async function getCachedSearch(
  keyword: string,
  source: Source,
): Promise<SearchCard[] | null> {
  try {
    const key = `search_cache_${source.toLowerCase()}`;
    const cache = (await window.systemApi.cacheGet(key)) as Record<
      string,
      SearchCard[]
    > | null;
    if (cache && cache[keyword]) {
      console.log(`[Cache 读取] 成功命中关键词: "${keyword}"`);
      return cache[keyword];
    }
    console.log(`[Cache 读取] 未找到关键词: "${keyword}"`);
    return null;
  } catch (err) {
    console.error(`[Cache 读取错误] 无法读取本地缓存:`, err);
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
    console.log(
      `[Cache 写入] 正在保存 "${keyword}" 的 ${cards.length} 条数据...`,
    );
    const existingCache =
      ((await window.systemApi.cacheGet(key)) as Record<
        string,
        SearchCard[]
      >) || {};
    existingCache[keyword] = cards;
    await window.systemApi.cacheSet(key, existingCache);
    console.log(`[Cache 写入] 成功保存到本地硬盘！`);
  } catch (err) {
    console.error(
      `[Cache 写入致命错误] 缓存保存失败，可能是 Base64 数据过大或底层 API 报错:`,
      err,
    );
  }
}

export function getCachedXifanWatch(url: string): XifanWatchInfo | null {
  try {
    return (
      (
        JSON.parse(
          localStorage.getItem("xifan_watch_cache_v3") || "{}",
        ) as Record<string, XifanWatchInfo>
      )[url] ?? null
    );
  } catch {
    return null;
  }
}

export function setCachedXifanWatch(url: string, info: XifanWatchInfo): void {
  try {
    const cache = JSON.parse(
      localStorage.getItem("xifan_watch_cache_v3") || "{}",
    ) as Record<string, XifanWatchInfo>;
    cache[url] = info;
    localStorage.setItem("xifan_watch_cache_v3", JSON.stringify(cache));
  } catch {
    /* ignore */
  }
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
