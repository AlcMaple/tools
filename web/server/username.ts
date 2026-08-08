export const USERNAME_MIN = 2
// 12 个字符（中英文都算 1 个）：顶栏用户名 chip 能稳定容纳，不挤压导航。
export const USERNAME_MAX = 12

// 用户名是身份数据，不是路由。仍在注册入口封住当前及可预见的一级路径名，避免未来新增
// `/u/:username` 或改成 history 路由时，把系统命名空间重新暴露给用户占用。
const RESERVED_ROUTE_SEGMENTS = new Set([
  'admin',
  'api',
  'assets',
  'auth',
  'calendar',
  'login',
  'logout',
  'play',
  'register',
  'settings',
  'tracks',
  'u',
  'user',
  'users',
])

const USERNAME_RE = /^[\p{L}\p{M}\p{N}_-]+$/u

/** 只用于新账号；已有账号保持原样，避免升级后无法登录。 */
export function usernameError(username: string): string | null {
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return `用户名需 ${USERNAME_MIN}–${USERNAME_MAX} 个字符`
  }
  if (!USERNAME_RE.test(username)) {
    return '用户名只能包含中文、字母、数字、下划线或连字符'
  }
  if (RESERVED_ROUTE_SEGMENTS.has(username.normalize('NFKC').toLowerCase())) {
    return '该用户名不可使用，请换一个'
  }
  return null
}
