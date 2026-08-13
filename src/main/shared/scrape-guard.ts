/**
 * 把 HTML 交给解析器之前先认出「异常页面」(Cloudflare 人机校验、4xx/5xx 错误页)
 * 抛出可辨认的错误 —— 这类页面既没有验证码表单也没有结果列表,不拦的话会被解析成
 * 「0 条结果」,用户看到的是「搜索不到结果」而不是真正的原因。
 *
 * 遵守红线:**不自动重试 / 不探活**,只把异常抛到 UI 由用户决定。
 */

// Cloudflare 人机校验 / 拦截页的特征串(大小写敏感,取 CF 模板里稳定出现的)。
const CF_BLOCK_MARKERS = [
  'Just a moment',
  'cf-browser-verification',
  'challenge-platform',
  '/cdn-cgi/challenge-platform',
  'Attention Required! | Cloudflare',
  'cf-error-details',
  'Error 1020',
  'Enable JavaScript and cookies to continue',
]

// 稀饭 2026-08 的新 UAM 页不再带 Cloudflare 特征:200 HTML 里先下发短期
// fl_ua_p cookie,由页面脚本提交一次校验后倒计时刷新。不能把这类页面交给
// Cheerio 当正常页面解析,也不能在 HTTP 层照抄它的脚本;调用方应改走后台浏览器。
const UAM_CHECK_MARKERS = [
  'Checking your Browser',
  'UAM_CHECKING',
  'X-FL-UA-Step',
]

// 稀饭挂在 Peekabo 边缘代理后面：源站过载/宕机时,代理自己渲染一页
// GATEWAY_TIMEOUT/ORIGIN_ERROR 错误页返回给浏览器（会带完整 200-like HTML,
// 不是连接失败）。这既不是人机校验,也不是站点真的改版——旧逻辑会把它交给
// parsePlayerData/cheerio 解析,解析自然失败,最终在 UI 上显示成误导性的
// 「解析失败,可能站点改版了」。这里先认出来,给用户看真实原因。
const ORIGIN_DOWN_MARKERS = [
  'GATEWAY_TIMEOUT',
  'ORIGIN_ERROR',
  'BACKEND_UNAVAILABLE',
  'ORIGIN_UNREACHABLE',
]

/** 当前响应是否仍是需要浏览器执行的安全检查页。 */
export function isScrapeChallengePage(html: string): boolean {
  if (CF_BLOCK_MARKERS.some((m) => html.includes(m))) return true
  // 至少同时命中标题与脚本标记,避免普通页面恰好提到其中一个词就被误判。
  return html.includes(UAM_CHECK_MARKERS[0]) &&
    (html.includes(UAM_CHECK_MARKERS[1]) || html.includes(UAM_CHECK_MARKERS[2]))
}

/** 当前响应是否是边缘代理渲染的"源站不可用"错误页（站点自身故障,不是本应用问题）。 */
export function isOriginDownPage(html: string): boolean {
  return ORIGIN_DOWN_MARKERS.some((m) => html.includes(m))
}

/**
 * 断言这是一页「能正常解析」的抓取响应。识别到 CF 拦截或非 2xx 状态时抛错。
 * 调用时机:拿到响应后、判断验证码门之前。正常的验证码门是站点自有页面、
 * 状态 200、不含 CF 特征,因此不会被这里误伤。
 *
 * @param status     HTTP 状态码
 * @param html       响应正文
 * @param siteLabel  站点中文名(如「稀饭」),拼进报错给用户看
 */
export function assertScrapePageOk(status: number, html: string, siteLabel: string): void {
  // 安全检查页不管状态码先认:它可能是 200(JS 挑战页)、也可能是 403/503。
  if (isScrapeChallengePage(html)) {
    throw new Error(`${siteLabel}要求浏览器安全验证(人机校验或风控),请稍后再点重试`)
  }
  // 边缘代理的源站错误页同样不管状态码先认:也可能是 200(代理直接渲染自己
  // 的错误模板)。不能让它落到下面的解析器,那会报出误导性的「解析失败」。
  if (isOriginDownPage(html)) {
    throw new Error(`${siteLabel}源站网关超时/不可用,这是站点自身故障(非本应用问题),请稍后再点重试`)
  }
  // 非 2xx:把状态码带进 message,渲染层 friendlyError 据此分类 4xx/5xx。
  if (status < 200 || status >= 300) {
    throw new Error(`${siteLabel}搜索失败:服务器返回 HTTP ${status}`)
  }
}
