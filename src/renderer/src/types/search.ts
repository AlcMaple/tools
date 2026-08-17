export type Source = "Xifan" | "Girigiri" | "Aowu" | "Bilibili";

/** 归一化后的展示卡片 —— 四个源共用同一种形状。 */
export interface SearchCard {
  title: string;
  cover: string;
  year: string;
  tag: string; // region (girigiri) / area (xifan, aowu) / UP 主 (bilibili)
  count: string; // episode count (xifan) or empty / 时长文本 (bilibili)
  key: string; // watch_url (xifan, aowu) / play_url (girigiri) / 稿件 URL (bilibili)
  source: Source;
}
