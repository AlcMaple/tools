export type Source = "Xifan" | "Girigiri" | "Aowu";

/** Normalized card for display — works for all sources */
export interface SearchCard {
  title: string;
  cover: string;
  year: string;
  tag: string; // region (girigiri) / area (xifan, aowu)
  count: string; // episode count (xifan) or empty
  key: string; // watch_url (xifan, aowu) or play_url (girigiri)
  source: Source;
}
