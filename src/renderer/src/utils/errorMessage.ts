/**
 * Translate a raw error (usually from IPC / network) into a user-friendly pair:
 * - title:   what went wrong, in plain language
 * - hint:    who likely caused it and what to do
 * - raw:     the original message, shown small for support / debugging
 *
 * IPC errors usually come through as
 *   `Error: Error invoking remote method 'xxx:yyy': Error: <real message>`
 * so we strip those wrappers before classifying.
 */

export interface FriendlyError {
  title: string
  hint: string
  raw: string
}

function unwrap(raw: string): string {
  return raw.replace(/^Error:\s*/i, '').replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, '')
}

export function friendlyError(err: unknown): FriendlyError {
  const raw = err instanceof Error ? err.message : String(err)
  const msg = unwrap(raw)
  const lower = msg.toLowerCase()

  // Network / TLS failures — not the user's content, the network can't reach the site
  if (
    lower.includes('socket disconnected') ||
    lower.includes('tls connection') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('etimedout') ||
    lower.includes('enotfound') ||
    lower.includes('getaddrinfo') ||
    lower.includes('network') ||
    lower.includes('fetch failed') ||
    lower.includes('request timeout')
  ) {
    return {
      title: '连不上服务器',
      hint: '可能是网站挂了或你网络有问题，过会儿再试，或检查代理设置',
      raw: msg,
    }
  }

  // HTTP status hints
  const statusMatch = msg.match(/\b(4\d{2}|5\d{2})\b/)
  if (statusMatch) {
    const code = parseInt(statusMatch[1])
    if (code >= 500) {
      return { title: '服务器异常', hint: `网站暂时有问题（HTTP ${code}），不是你的操作问题`, raw: msg }
    }
    if (code === 429) return { title: '请求太频繁', hint: '被网站限流了，歇一会儿再试', raw: msg }
    if (code === 403) return { title: '被网站拒绝', hint: '网站拒绝访问（HTTP 403），可能需要刷新验证码或换个时间再试', raw: msg }
    if (code === 404) return { title: '找不到资源', hint: '这个条目在网站上可能已被删除或链接变了', raw: msg }
    return { title: '网站返回错误', hint: `HTTP ${code}，通常是网站那边的问题`, raw: msg }
  }

  if (lower.includes('parse') || lower.includes('unexpected token') || lower.includes('json')) {
    return {
      title: '解析失败',
      hint: '网站返回的数据和预期不一致，可能它改版了。可以联系开发者',
      raw: msg,
    }
  }

  if (lower.includes('captcha')) {
    return { title: '需要验证码', hint: '按提示输入验证码继续', raw: msg }
  }

  // Windows file ACL / permission errors — surfaced from PowerShell stderr
  if (
    lower.includes('access is denied') ||
    lower.includes('access to the path') ||
    lower.includes('unauthorizedaccessexception') ||
    lower.includes('does not have ownership') ||
    msg.includes('拒绝访问') ||
    msg.includes('权限') ||
    msg.includes('需要管理员')
  ) {
    return {
      title: '权限不足',
      hint: '系统拒绝了删除/修改操作。这通常意味着该文件需要管理员权限——可以用 Windows 资源管理器手动删除（按 UAC 提示授权），或以管理员身份重新运行 Maple Tools 后再试。',
      raw: msg,
    }
  }

  if (lower.includes('eperm') || lower.includes('eacces')) {
    return {
      title: '权限不足',
      hint: '当前账户没有权限对这个文件执行该操作。',
      raw: msg,
    }
  }

  return {
    title: '出错了',
    hint: '这个错误暂时没法自动判断来源，可以参考下方信息',
    raw: msg,
  }
}
