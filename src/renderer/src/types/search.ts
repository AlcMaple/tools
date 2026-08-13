export type Source = "Xifan" | "Girigiri" | "Aowu";

/** 归一化后的展示卡片 —— 三个源共用同一种形状。 */
export interface SearchCard {
  title: string;
  cover: string;
  year: string;
  tag: string; // region (girigiri) / area (xifan, aowu)
  count: string; // episode count (xifan) or empty
  key: string; // watch_url (xifan, aowu) or play_url (girigiri)
  source: Source;
}
