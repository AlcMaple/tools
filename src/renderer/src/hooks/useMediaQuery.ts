import { useSyncExternalStore } from 'react'

/** 订阅一条 CSS media query 的匹配状态,拖动窗口跨过阈值时触发重渲染。 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/**
 * 是否「精简布局」档 —— 平板 + 手机 + 窄桌面共用一套精简卡片。
 * 阈值取 1200 而不是 1024:桌面的富信息卡片把状态/集数/好看集/星级挤在一行,宽度不到约 1130
 * 就会换行、卡片高度突变(用户反馈「突然放大」)。所以撑不下富卡片时就提前切精简卡片;
 * 默认窗口宽度仍是富卡片。
 */
export function useIsCompact(): boolean {
  return useMediaQuery('(max-width: 1199px)')
}

/** 是否手机档 —— 顶部过滤改成下拉抽屉。对齐 Tailwind 的 md 断点。 */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 767.98px)')
}

/**
 * 是否窄手机档 —— 卡片组头在这一档把右侧的日期和操作图标收进「更多」菜单
 * 给角色名腾出整行宽度(否则窄屏上角色名会被挤成一字一行)。
 */
export function useIsPhone(): boolean {
  return useMediaQuery('(max-width: 639.98px)')
}
