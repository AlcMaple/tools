/**
 * 抓取响应「可读性」断言 —— 在把 HTML 丢给解析器之前,先认出那些
 * 既不是验证码门、也不是正常结果页的「异常页面」,直接抛出可辨认的错误,
 * 而不是让解析器解出 0 条结果、最终在 UI 上显示成误导性的「搜索不到结果」。
 *
 * 背景(为什么需要):稀饭(anime.xifanacg.com)/旗木等站点都在 Cloudflare
 * 后面。CF 会偶发下发人机校验(Just a moment / challenge-platform),或在
 * 限流/故障时直接返回 4xx/5xx。这些页面里既没有 `name="verify"`,也没有
 * search-list —— 旧逻辑会把它当成「0 结果」吞掉,用户看到的是「搜索不到
 * 结果」而非真正原因,再搜一次 CF 放行了又正常出验证码。这正是「有时没出
 * 验证码、报错给得不对」的根因。
 *
 * 处理方式遵守项目红线:**不做应用层自动重试 / 探活**,只把异常显式抛到
 * UI,由用户看清原因后手动点重试。
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
  // CF 拦截不管状态码先认:它可能是 200(JS 挑战页)、也可能是 403/503。
  if (CF_BLOCK_MARKERS.some((m) => html.includes(m))) {
    throw new Error(`${siteLabel}被 Cloudflare 拦截(人机校验或风控),请稍后再点重试`)
  }
  // 非 2xx:把状态码带进 message,渲染层 friendlyError 据此分类 4xx/5xx。
  if (status < 200 || status >= 300) {
    throw new Error(`${siteLabel}搜索失败:服务器返回 HTTP ${status}`)
  }
}
