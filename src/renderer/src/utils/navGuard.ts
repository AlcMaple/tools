/**
 * 模块级的导航拦截 —— 设置页有未保存改动时注册监听,侧栏在跳转前先询问
 * 好让设置页弹出「有未保存的更改」对话框。
 */
type Listener = (to: string) => void

let _listener: Listener | null = null

export const navGuard = {
  setListener: (fn: Listener | null): void => {
    _listener = fn
  },
  isActive: (): boolean => _listener !== null,
  /** 返回 true 表示可以跳转,false 表示被拦下。 */
  requestNavigation: (to: string): boolean => {
    if (_listener) {
      _listener(to)
      return false
    }
    return true
  },
}
