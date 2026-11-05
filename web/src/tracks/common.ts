// 追番页拆分后跨文件共用的小常量与观看入口。组件、样式语义都不在这儿。
import type { Track, TrackStatus } from '../api'
import { toast } from '../Toast'
import { auth } from '../auth'
import { recentWatchEpisode } from '../../shared/watch-episode-history'

export const SHORT_DAY: Record<number, string> = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' }

export const STATUS_META: { key: TrackStatus; label: string }[] = [
  { key: 'watching', label: '在看' },
  { key: 'plan', label: '想看' },
  { key: 'considering', label: '观望' },
  { key: 'done', label: '看完' },
]
// 状态分段的展示顺序（想看 → 观望 → 在看 → 看完）与印章配色（银 / 薰衣草 / 青 / 金）
export const SEG_ORDER: TrackStatus[] = ['plan', 'considering', 'watching', 'done']
export const SEG_CLS: Record<TrackStatus, string> = { plan: 'wish', considering: 'watch', watching: 'doing', done: 'done' }
export const STAMP_CLS: Record<TrackStatus, string> = { plan: 'st-silver', considering: 'st-lav', watching: 'st-teal', done: 'st-gold' }

export const allTagsOf = (t: Track): string[] => [...t.bgmTags, ...t.userTags]

// 与 server/tracks.ts 的 USER_TAG_MAX_COUNT 对齐。前端先拦一道：不拦的话乐观更新会先
// 贴上第 13 个标签、再被后端 400 回滚，用户看到的是「贴上了又消失」。
export const USER_TAG_MAX = 12
/** 超限时的统一反馈：走便签 Toast（红字警示条离标签输入太远，看不见） */
export function tagLimitToast(): void {
  toast(`这部番的自定义标签已经贴满 ${USER_TAG_MAX} 个啦，先撕掉一张再贴吧`, { err: true })
}

// 续看与手帐计数分开；手帐被编辑后旧续看失效，用户的新记录优先。
export function watchEp(t: Track, useRecent = true): number {
  if (useRecent && typeof window !== 'undefined') {
    try {
      const recent = recentWatchEpisode(window.localStorage, auth.user?.id ?? null, t)
      if (recent != null) return recent
    } catch { /* 浏览器禁用存储时仍按手帐打开 */ }
  }
  const n = t.totalEpisodes != null ? Math.min(t.totalEpisodes, t.episode) : t.episode
  return Math.max(1, n)
}
