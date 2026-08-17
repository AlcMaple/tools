import type { XifanSearchResult } from "../types/xifan";
import type { GirigiriSearchResult } from "../types/girigiri";
import type { AowuSearchResult } from "../types/aowu";
import type { BiliSearchResult } from "../types/bili";
import type { SearchCard } from "../types/search";

export function normalizeXifan(r: XifanSearchResult): SearchCard {
  return {
    title: r.title,
    cover: r.cover,
    year: r.year,
    tag: r.area,
    count: r.episode,
    key: r.watch_url,
    source: "Xifan",
  };
}

export function normalizeGirigiri(r: GirigiriSearchResult): SearchCard {
  return {
    title: r.title,
    cover: r.cover,
    year: r.year,
    tag: r.region,
    count: "",
    key: r.play_url,
    source: "Girigiri",
  };
}

export function normalizeAowu(r: AowuSearchResult): SearchCard {
  return {
    title: r.title,
    cover: r.cover,
    year: r.year,
    tag: r.area,
    count: "",
    key: r.watch_url,
    source: "Aowu",
  };
}

export function normalizeBilibili(r: BiliSearchResult): SearchCard {
  return {
    title: r.title,
    cover: r.cover,
    year: "",
    tag: r.author,
    count: r.duration,
    // 落地成 binding 的 sourceKey 就是这条完整 URL——biliBvid() 用正则从里面抠 BV 号,
    // 播放页的匹配逻辑不用为 Bilibili 另开一条判断分支。
    key: `https://www.bilibili.com/video/${r.bvid}`,
    source: "Bilibili",
  };
}
