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
      hint: '嗷呜源站可能挂了（523 = CDN 连不上源站），等它恢复即可，稍后可点重试。另一种少见情况：该站屏蔽境外节点，若你的网络走代理且没对嗷呜分流直连，需要先设置分流。',
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
    // 优先认「N 秒」；熔断器冷却消息用的是「约 X 分钟后自动恢复」（无"秒"），
    // 也要认，否则倒计时会错误回落成默认 30 秒（而真实冷却可能是 5/30 分钟）。
    const secMatch = msg.match(/(\d+)\s*秒/)
    const minMatch = msg.match(/(\d+)\s*分钟/)
    const waitSec = secMatch
      ? parseInt(secMatch[1])
      : minMatch
        ? parseInt(minMatch[1]) * 60
        : 30
    return {
      title: 'BGM 触发限流',
      hint: '已自动尝试了备用（网页）线路，仍失败说明各来源都在限流。下方倒计时是建议等待时长，到点会自然恢复；Try again 随时可点（提前重试可能无效或加重限流，风险自负）。',
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
    lower.includes('request timeout') ||
    // Electron net（Chromium 网络栈）传输层错误形如 `net::ERR_NAME_NOT_RESOLVED`
    // `net::ERR_CONNECTION_REFUSED` `net::ERR_INTERNET_DISCONNECTED` 等 —— 跟 Node 风格
    // 的 ECONNREFUSED/getaddrinfo 长得不一样，得单独认，否则站点不可达会掉到兜底
    // 「出错了」而不是「网站连不上」。BGM / 萌娘 都走 net，这条覆盖它们的"页面打不开"。
    lower.includes('net::err')
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
      lower.includes('getaddrinfo') ||
      // Electron net 连接层失败（DNS / 拒绝 / 断网 / 被墙 / 代理失败）——
      // 都是"TCP 都建不起来 = 站点不可达"。我们自己的 10s 超时走 Error('timeout')
      // 那条（连上了没回包），跟这里 net:: 连接失败是两回事。
      lower.includes('net::err')
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
        ? '服务器 10 秒内没响应，可能是网络抖动或站点暂时慢。先点 Try again 重试；连续多次超时才可能是该 IP 被限速，那时再停手等几分钟。'
        : '可能是网站挂了或你网络有问题，过会儿再试，或检查代理设置',
      raw: msg,
    }
  }

  // Cloudflare 真·拦截 —— 站点适配器识别到 CF 人机校验 / 风控页时抛出
  // （见 main/shared/scrape-guard.ts）。放在 HTTP 状态匹配之前:CF 的 JS 挑战页
  // 常是 200,message 里没有状态码可匹配。
  //
  // 必须严格匹配「真被 CF 拦」的信号,不能用裸 `cloudflare` 关键词 —— BGM 的
  // 诊断串里恒带 `server=cloudflare`,那只是 BGM 用了 CF,并不代表被拦;尤其
  // 502/`cf-mitigated=-` 是源站网关错误而非 CF 拦截,误判成「被 Cloudflare 拦截」
  // 会让用户以为是风控、而不是「BGM 偶发故障稍后重试」。
  const cfBlocked =
    msg.includes('被 Cloudflare 拦截') ||                    // scrape-guard 预判(稀饭/旗木)
    /cf-mitigated=\s*(challenge|block|managed)/i.test(msg) || // BGM 诊断里 CF 确实出手
    lower.includes('just a moment') ||
    lower.includes('cf-chl') ||
    lower.includes('attention required')
  if (cfBlocked) {
    return {
      title: '被 Cloudflare 拦截',
      hint: '站点的 Cloudflare 防护这会儿弹了人机校验或风控（常因冷启动 / 代理指纹，是偶发的）。点 Try again 重试通常就过；频繁出现可换个网络或代理再试。',
      raw: msg,
    }
  }

  // HTTP status hints
  const statusMatch = msg.match(/\b(4\d{2}|5\d{2})\b/)
  if (statusMatch) {
    const code = parseInt(statusMatch[1])
    if (code >= 500) {
      // BGM-specific 5xx —— 用户经常报告"网页能开但 app 失败"，措辞不能让
      // 用户误以为 BGM 全站挂了。说清楚是"针对这次请求的偶发故障"，引导
      // 用户点 Try again 重试或稍候再来。
      // 注意：5xx **不做应用层自动重试**（红线，见 bgm/search.ts、api-client.ts），
      // 所以文案不能谎称"已自动重试" —— 重试由用户点 Try again 触发。
      const isBgm = /\bBGM\b/.test(msg)
      if (isBgm && code === 502) {
        return {
          title: 'BGM 偶发故障',
          hint: 'BGM 那边某个 CDN 节点这会儿没响应（HTTP 502）。这种偶发故障通常一两分钟自己就好；浏览器能打开 BGM 是因为命中了其他节点。点 Try again 重试，或歇一会儿再来。',
          raw: msg,
        }
      }
      if (isBgm) {
        return {
          title: 'BGM 站点异常',
          hint: `BGM 暂时无响应（HTTP ${code}），是 BGM 那边的问题，不是你的网络。点 Try again 重试，或稍候再来。`,
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
