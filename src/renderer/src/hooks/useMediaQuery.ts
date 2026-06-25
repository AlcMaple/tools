import { useSyncExternalStore } from 'react'

/**
 * 订阅一条 CSS media query 的匹配状态。matchMedia + useSyncExternalStore，
 * 拖动窗口跨过阈值时触发重渲染。Electron 渲染端纯 CSR，第三个
 * getServerSnapshot 仅为接口完整性兜底（永不命中 SSR 路径）。
 */
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
 * 是否「精简布局」档（视口 < 1200）—— 平板 + 手机 + 窄桌面共用一套精简卡片。
 * 阈值取 1200 而非 lg/1024：桌面富信息卡片把 状态/集数/好看集/星级 挤在一行，
 * 宽度 <~1130 就会换行、卡片高度突变（用户反馈「突然放大」）。所以宽度撑不下
 * 富卡片时就提前切精简卡片；默认窗口（外框 1280、视口≈1264）仍是富卡片。
 */
export function useIsCompact(): boolean {
  return useMediaQuery('(max-width: 1199px)')
}

/** 是否手机档（视口 < md / 768）—— 顶部过滤改下拉抽屉。对齐 Tailwind md 断点。 */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 767.98px)')
}

/**
 * 是否窄手机档（视口 < sm / 640）—— 锦囊妙计卡片组头在此把右侧「日期 + 4 个操作
 * 图标」收成单个「更多 ⋯」菜单、日期挪到备注后面，给防守方角色名腾出整行宽度
 * （否则 390 窄屏角色名会被挤成一字一行）。比 useIsMobile 更窄：640–768 的平板
 * 抽屉态行内图标仍放得下，不必提前收。 */
export function useIsPhone(): boolean {
  return useMediaQuery('(max-width: 639.98px)')
}
