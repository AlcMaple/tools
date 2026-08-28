// 播放页专用的浏览器监控入口 —— **不属于 SPA bundle**。
//
// 播放页是服务端返回的一张裸 HTML（见 server/xifan.ts 的 PLAY_PAGE），加载不到 SPA 的
// 那份监控；在这之前它是个盲区：页面里任何未捕获异常一条都不会出现在任何地方。
// 这个文件由 scripts/build-player-monitor.ts 单独打成一个 IIFE 自托管（不走 CDN，
// 国内加载不到），路子跟 /api/xifan/hls.js 一样。
//
// 只要「异常 + 上下文」，**不要 Replay**：它录的是 DOM，而 currentTime / buffered 是
// <video> 的内部状态，恰恰录不到播放页最常见的那类问题；移动端流量和配额也不划算。
import {
  addBreadcrumb,
  captureMessage,
  init,
  setTag,
  type BrowserOptions,
  type ErrorEvent,
} from '@sentry/browser'

interface PlayerMonitorConfig {
  dsn?: string
  environment?: string
  release?: string
}

interface PlayerMonitor {
  breadcrumb: (message: string) => void
  report: (message: string, extra?: Record<string, unknown>) => void
}

declare global {
  interface Window {
    __PLAYER_MONITOR__?: PlayerMonitorConfig
    playerMonitor?: PlayerMonitor
  }
}

/** 播放页地址带 animeId / ep / bgmId，跟 SPA 那边一样只留路径，不把 query 送出去。 */
function cleanUrl(raw: string | undefined): string | undefined {
  if (!raw) return raw
  try {
    const url = new URL(raw, window.location.origin)
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return raw.split(/[?#]/, 1)[0]
  }
}

const beforeSend: NonNullable<BrowserOptions['beforeSend']> = (event) => {
  const typed = event as ErrorEvent & { request?: { url?: string; headers?: unknown } }
  typed.user = undefined
  if (typed.request) {
    typed.request.url = cleanUrl(typed.request.url)
    typed.request.headers = undefined
  }
  for (const crumb of typed.breadcrumbs ?? []) {
    const data = crumb.data as { url?: unknown } | undefined
    if (data && typeof data.url === 'string') data.url = cleanUrl(data.url)
  }
  return typed
}

const config = window.__PLAYER_MONITOR__

if (config?.dsn) {
  init({
    dsn: config.dsn,
    environment: config.environment || 'production',
    release: config.release || undefined,
    sendDefaultPii: false,
    // 播放页不需要性能追踪：一个页面、几个接口，采上来也没人看；<video> 的耗时它测不到。
    tracesSampleRate: 0,
    // 只保留「抓未捕获异常 + 记面包屑」那几个默认集成，明确剔掉体积大的性能 / 回放类。
    integrations: (defaults) =>
      defaults.filter((integration) => !/Replay|Tracing|Feedback|Profiling/i.test(integration.name)),
    beforeSend,
  })
  setTag('surface', 'xifan-player')

  window.playerMonitor = {
    breadcrumb(message) {
      addBreadcrumb({ category: 'player', level: 'info', message })
    },
    report(message, extra) {
      captureMessage(message, { level: 'warning', tags: { channel: 'xifan-client' }, extra })
    },
  }
}
