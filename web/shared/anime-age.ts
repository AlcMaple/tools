// 「新番 / 老番」的唯一判据 —— 前后端共用，避免两边各写一份然后悄悄漂移。
//
// 为什么单独抽一个文件：这把尺子同时决定三件事，口径必须完全一致 ——
//   1. 追番「继续看」是走源站周表定位（只列在播番）还是直连全站搜索（TracksPage.continueWatch）
//   2. 加番时要不要自动写 total_episodes（server/tracks.ts）
//   3. 卡片上的「今天更新」贴纸算不算数（TracksPage.todayIds）
//
// **判据只看 airDate，绝不看 totalEpisodes。** 这是刻意的：用户手填了总集数，系统照样要认得出
// 它是新番。反过来用「total 为空 = 连载中」的话，一旦开始给老番自动补集数，判据就自我污染了。
//
// 纯函数、零依赖，所以 server（tsx 直接跑）和 src（vite 打包）都能直接 import。

/** 首播距今多久之内算「新番」。180 天 ≈ 两季，跨季续看的番也兜得住。 */
export const RECENT_AIR_MS = 180 * 24 * 60 * 60 * 1000

/**
 * 判断是否「新番」（当季 / 近季在播）。
 *
 * - 日期解析不出（空串、老记录没回填、格式异常）→ 一律当**新番**。
 *   这是安全的一侧：新番路径是「不自动填集数 + 走周表定位」，判错只是回到现状，不会写错数据。
 * - 未来日期（还没播）算负值，自然落在新番一侧。
 */
export function isRecentAir(airDate: string): boolean {
  const ms = Date.parse(airDate)
  if (Number.isNaN(ms)) return true
  return Date.now() - ms < RECENT_AIR_MS
}
