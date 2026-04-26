import type { XifanSearchResult } from "../types/xifan";
import type { GirigiriSearchResult } from "../types/girigiri";
import type { AowuSearchResult } from "../types/aowu";
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
