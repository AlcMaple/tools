import { useSyncExternalStore } from 'react'

/**
 * 极简全局 UI 状态。目前只装手机版导航抽屉的开合。
 *
 * 为什么单独开个 store：抽屉的触发器（TopBar 里的 ☰）和抽屉本体（Sidebar）
 * 处在组件树的两个不同位置，没有共同父级方便提状态。沿用项目里 store 的
 * `subscribe(listener) => unsubscribe` 习惯，用一个模块级订阅源把两端连起来，
 * 不引入 context、不写进 localStorage（纯瞬时 UI 态）。
 */
type Listener = () => void

let drawerOpen = false
const listeners = new Set<Listener>()

function emit(): void {
  listeners.forEach((l) => l())
}

export const uiStore = {
  isDrawerOpen(): boolean {
    return drawerOpen
  },
  openDrawer(): void {
    if (drawerOpen) return
    drawerOpen = true
    emit()
  },
  closeDrawer(): void {
    if (!drawerOpen) return
    drawerOpen = false
    emit()
  },
  toggleDrawer(): void {
    drawerOpen = !drawerOpen
    emit()
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
}

/** 订阅抽屉开合状态。getSnapshot 返回布尔原始值，按值比较，无需缓存。 */
export function useDrawerOpen(): boolean {
  return useSyncExternalStore(uiStore.subscribe, uiStore.isDrawerOpen)
}
