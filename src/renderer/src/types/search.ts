export type Source = "Xifan" | "Girigiri";

/** Normalized card for display — works for both sources */
export interface SearchCard {
  title: string;
  cover: string;
  year: string;
  tag: string; // region (girigiri) or area (xifan)
  count: string; // episode count (xifan) or empty
  key: string; // watch_url (xifan) or play_url (girigiri)
  source: Source;
}
