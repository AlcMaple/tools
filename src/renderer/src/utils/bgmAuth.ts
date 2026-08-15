// BGM 登录状态的渲染进程共享缓存。
// 默认搜索不访问 BGM；组件挂载只读取本地状态，登录与重新校验由用户主动触发。

import type { BgmAuthStatus } from '../types/bgm'

let cachedStatus: BgmAuthStatus | null = null

export function getCachedAuth(): BgmAuthStatus | null {
  return cachedStatus
}

/** 任何一次拿到的状态都回填缓存，让各处显示一致。 */
export function setCachedAuth(s: BgmAuthStatus): void {
  cachedStatus = s
}
