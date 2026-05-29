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
  /**
   * 限流错误专用：站点要求等待的秒数。UI（ErrorPanel）据此显示倒计时,
   * 倒计时归零前 Try again 按钮禁用，避免用户在限流窗口期内重复触发。
   * 普通错误（非限流）此字段为 undefined。
   */
  retryAfterSec?: number
}

function unwrap(raw: string): string {
  return raw.replace(/^Error:\s*/i, '').replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, '')
}

export function friendlyError(err: unknown): FriendlyError {
  const raw = err instanceof Error ? err.message : String(err)
  const msg = unwrap(raw)
  const lower = msg.toLowerCase()

  // Source-specific error markers — emitted by site adapters when they detect
  // unreachable / structure-changed conditions. Match BEFORE generic classifiers
  // so the user sees the right cause.
  if (msg.startsWith('AOWU_UNREACHABLE')) {
    return {
      title: '嗷呜动漫无法访问',
      hint: '该站点对境外节点屏蔽，挂 VPN 时会触发 523 / 源站超时。请关闭 VPN（或对该域名设置代理直连）后再试。',
      raw: msg,
    }
  }
  if (msg.startsWith('AOWU_STRUCTURE_CHANGED')) {
    return {
      title: '嗷呜动漫已改版',
      hint: '页面结构变了，旧解析器抓不到结果。需要根据新 UI 更新搜索 / 详情页解析代码。',
      raw: msg,
    }
  }
  if (msg.startsWith('AOWU_RATE_LIMITED')) {
    return {
      title: '嗷呜动漫触发限流',
      hint: '请求太频繁被站点限流（HTTP 429）。先停一会儿（错误里若带 Retry-After 秒数即等那么久），再继续操作。',
      raw: msg,
    }
  }
  if (msg.startsWith('AOWU_RESOLVE_FAILED')) {
    return {
      title: '播放链接解析失败',
      hint: '站点返回的 play 响应里没有可用的 mp4 URL，可能是该集刚上线还没切片完，或换源 idx 试试。',
      raw: msg,
    }
  }

  // BGM 限流 —— 主进程抛 `RateLimitError`，message 形如：
  //   "BGM 触发限流，请等 30 秒后再试"
  //   "BGM API 触发限流（HTTP 429），请等 30 秒后再试"
  //   "BGM 返回 HTTP 429，触发限流"
  //   "您在 30 秒内只能进行一次搜索"（BGM 搜索的中文限流页内容直透）
  // UI 据 `retryAfterSec` 显示倒计时，倒计时归零前禁用 Try again 按钮,
  // 防止用户在限流窗口期内反复点击加重限流。
  if (
    msg.includes('BGM') && (msg.includes('限流') || msg.includes('429')) ||
    msg.includes('您在') && msg.includes('秒') && msg.includes('搜索') ||
    msg.includes('已触发限流')
  ) {
    const waitMatch = msg.match(/(\d+)\s*秒/)
    const waitSec = waitMatch ? parseInt(waitMatch[1]) : 30
    return {
      title: 'BGM 触发限流',
      hint: 'Bangumi 站点限制了我们的请求频率，按下方倒计时等待自然解除即可。期间反复点击会加重限流。',
      raw: msg,
      retryAfterSec: waitSec,
    }
  }

  // Windows file operations are classified FIRST. PowerShell stderr often
  // contains paths like "...\electron\network\..." which would trip the
  // network-keyword match below. Detect file-op markers and branch out early.
  const isFileOp =
    lower.includes('microsoft.visualbasic.fileio') ||
    lower.includes('sendtorecyclebin') ||
    lower.includes('remove-item') ||
    lower.includes('move-item') ||
    /\btakeown\b/.test(lower) ||
    /\bicacls\b/.test(lower) ||
    msg.includes('拒绝访问') ||
    msg.includes('正在使用') ||
    msg.includes('被占用') ||
    msg.includes('另一进程') ||
    msg.includes('另一程序')

  if (isFileOp) {
    if (
      lower.includes('being used by another') ||
      lower.includes('process cannot access') ||
      lower.includes('used by another process') ||
      msg.includes('正在使用') ||
      msg.includes('被占用') ||
      msg.includes('另一进程') ||
      msg.includes('另一程序')
    ) {
      return {
        title: '文件被占用',
        hint: '有别的程序还打开着这个文件夹/文件（资源管理器、终端、编辑器等），先把它们关掉再试。Windows 不允许删除被占用的文件。',
        raw: msg,
      }
    }
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
    return {
      title: '文件操作失败',
      hint: '这次文件操作没成功，可以展开查看原始错误判断原因。',
      raw: msg,
    }
  }

  // Network / TLS failures — not the user's content, the network can't reach the site.
  //
  // 注意 `timeout` 单独一行：api-client 在 10s 超时时抛的 message 就是裸字符串
  // "timeout"（不是 "request timeout"），早期没把这条算进来，结果用户看到的
  // 是兜底「这个错误暂时没法自动判断来源」—— 现在覆盖到。
  //
  // 另：BGM 频繁 timeout 时往往不是物理网络断了，而是该 IP 在 BGM 的滑动惩罚
  // 窗口里被悄悄丢包。文案点一下「过会儿再试」，引导用户先停手让窗口自然
  // 衰减，而不是疯狂 Try again 把惩罚拉得更长。
  if (
    lower === 'timeout' ||
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
    // connect ETIMEDOUT / ECONNREFUSED / DNS 失败 = TCP 连接都建立不起来，即站点
    // 根本不可达（站点自己挂了 / 被墙 / 本机网络或代理问题）。这和「连上了但 10s
    // 没回包」的 request timeout 不是一回事 —— 用户看到 girigiri/xifan 官网都打不开
    // 时就是这一类，得给「网站连不上」而不是带限速口吻的「请求超时」。
    const isConnFailure =
      lower.includes('connect etimedout') ||
      lower.includes('connect timeout') ||
      lower.includes('econnrefused') ||
      lower.includes('enotfound') ||
      lower.includes('getaddrinfo')
    if (isConnFailure) {
      return {
        title: '网站连不上',
        hint: '这个站点现在打不开 —— 可能是它自己挂了 / 被墙，也可能是你的网络或代理有问题。先用浏览器打开该网站确认：能打开就过会儿再试，打不开就是站点本身的问题。',
        raw: msg,
      }
    }
    const isTimeout = lower === 'timeout' || lower.includes('timeout') || lower.includes('etimedout')
    return {
      title: isTimeout ? '请求超时' : '连不上服务器',
      hint: isTimeout
        ? '服务器 10 秒内没响应。如果浏览器能打开网站，多半是该网站对你这个 IP 暂时限速 / 丢包；先停手几分钟让窗口自然衰减，再 Try again。'
        : '可能是网站挂了或你网络有问题，过会儿再试，或检查代理设置',
      raw: msg,
    }
  }

  // HTTP status hints
  const statusMatch = msg.match(/\b(4\d{2}|5\d{2})\b/)
  if (statusMatch) {
    const code = parseInt(statusMatch[1])
    if (code >= 500) {
      // BGM-specific 5xx —— 用户经常报告"网页能开但 app 失败"，措辞不能让
      // 用户误以为 BGM 全站挂了。说清楚是"针对这次请求的偶发故障"，已经
      // 重试过几次仍不行，建议稍候再来。
      const isBgm = /\bBGM\b/.test(msg)
      if (isBgm && code === 502) {
        return {
          title: 'BGM 偶发故障',
          hint: 'BGM 那边某个 CDN 节点这会儿没响应（HTTP 502），已经替你自动重试了几次。这通常一两分钟自己就好；浏览器能打开 BGM 是因为浏览器命中了其他节点。歇一会儿再来。',
          raw: msg,
        }
      }
      if (isBgm) {
        return {
          title: 'BGM 站点异常',
          hint: `BGM 暂时无响应（HTTP ${code}），已自动重试。是 BGM 那边的问题，不是你的网络。稍候再试。`,
          raw: msg,
        }
      }
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
