import { BrowserWindow, session } from 'electron'
import { DESKTOP_USER_AGENT } from '../shared/download-types'
import type { NetResult } from '../shared/net-request'
import { isScrapeChallengePage } from '../shared/scrape-guard'
import { logInfo } from '../shared/logger'

const XIFAN_PARTITION = 'persist:xifan-browser-check'
// 这条链路没有用户要在外部窗口里完成的步骤：正常安全检查约 5 秒，但实测站点偶尔
// 会把首个无登录态页面拖到约 28 秒。45 秒给最终 refresh 留余量，仍不沿用可见验证
// 时代的 90 秒挂起，也不在超时后自动重试。
const PAGE_TIMEOUT_MS = 45_000
const DOCUMENT_SETTLE_DELAY_MS = 120
const CHALLENGE_POLL_DELAY_MS = 250
export const XIFAN_ORIGIN = 'https://anime.xifanacg.com'

export interface XifanBrowserPage {
  html: string
}

// 所有页面读取和同源接口请求顺序执行，避免一个 WebContents 同时被多次导航。
let pageQueue: Promise<void> = Promise.resolve()
let cachedSession: Electron.Session | null = null
let activeBrowserWindow: BrowserWindow | null = null
let browserSessionVerified = false

/** 供应用壳层排除后台页面，绝不能把它当作可唤回的主窗口。 */
export function isXifanBackgroundWindow(win: BrowserWindow): boolean {
  return activeBrowserWindow === win
}

/** 主窗口真正销毁时一并结束后台页面，避免它单独留住应用进程。 */
export function disposeXifanBackgroundWindow(): void {
  const win = activeBrowserWindow
  if (!win || win.isDestroyed()) {
    activeBrowserWindow = null
    browserSessionVerified = false
    return
  }
  win.destroy()
}

/** 所有稀饭页面和同域接口都固定使用一个持久 Chromium 分区，cookie 不再分叉。 */
export function getXifanBrowserSession(): Electron.Session {
  if (!cachedSession) {
    cachedSession = session.fromPartition(XIFAN_PARTITION)
    cachedSession.setUserAgent(DESKTOP_USER_AGENT)
  }
  return cachedSession
}

function isXifanHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'xifanacg.com' || host.endsWith('.xifanacg.com')
}

/** 只允许后台页面加载稀饭自己的 https 页面，避免 IPC 传入任意外站时被放大。 */
export function isXifanPageUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && isXifanHost(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * 稀饭自己的倒计时刷新会主动取消旧文档。macOS 的 Electron 有时只把它报成
 * `(-3) loading ...`，不带 `ERR_ABORTED` 文本；两种写法都是同一个正常导航交接，
 * 不能当作页面打不开，更不能因此重新 loadURL 额外发一次请求。
 */
function isNavigationAbort(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /ERR_ABORTED|\(\s*-3\s*\)/i.test(message)
}

/**
 * 复用通过验证的同一张后台页面。它始终不显示：站点自己的脚本仍在真实 Chromium
 * WebContents 中执行，但播放页只保留「解析播放地址中…」这一层应用 UI。
 * 正常页面与后续 fetch 都留在这里，不能为验证码再新开一张首页，否则站点可能把它
 * 当新的首次访问。
 */
function getXifanBrowserWindow(): BrowserWindow {
  if (activeBrowserWindow && !activeBrowserWindow.isDestroyed()) return activeBrowserWindow

  getXifanBrowserSession()
  const win = new BrowserWindow({
    width: 620,
    height: 640,
    show: false,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#101010',
    webPreferences: {
      partition: XIFAN_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  // show:false 的页面可能被 Chromium 降低定时器优先级；稀饭的检查正是靠倒计时
  // 和页面脚本刷新完成，因此明确保持它的正常页面节奏，不额外等待前台窗口。
  win.webContents.setBackgroundThrottling(false)
  win.on('page-title-updated', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, nextUrl) => {
    if (!isXifanPageUrl(nextUrl)) event.preventDefault()
  })
  win.on('closed', () => {
    if (activeBrowserWindow === win) activeBrowserWindow = null
    browserSessionVerified = false
  })
  activeBrowserWindow = win
  return win
}

function queueXifanBrowserTask<T>(task: () => Promise<T>): Promise<T> {
  const queued = pageQueue.then(task)
  pageQueue = queued.then(() => undefined, () => undefined)
  return queued
}

/**
 * 在持久同源 WebContents 中完成一次页面读取或 fetch。`targetUrl` 为空时不导航，
 * 直接在前一次已验证的页面内运行接口请求。
 */
function runXifanBrowserTask<T>(
  targetUrl: string | null,
  action: (webContents: Electron.WebContents, html: string) => Promise<T>,
  timeoutMs = PAGE_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const win = getXifanBrowserWindow()
    let settled = false
    let actionStarted = false
    let checkTimer: ReturnType<typeof setTimeout> | null = null
    // 阶段日志:进度只在阶段**切换**时落一行,不跟着 250ms 轮询刷屏。
    let challengeLogged = false
    const stageLabel = targetUrl ?? '(复用当前页)'
    const cleanup = (): void => {
      clearTimeout(timeout)
      if (checkTimer) clearTimeout(checkTimer)
      checkTimer = null
      win.webContents.removeListener('did-finish-load', onLoad)
      win.webContents.removeListener('did-fail-load', onFail)
      win.removeListener('closed', onClosed)
    }
    const hide = (): void => {
      if (!win.isDestroyed() && win.isVisible()) win.hide()
    }
    const succeed = (value: T): void => {
      if (settled) return
      settled = true
      browserSessionVerified = true
      cleanup()
      hide()
      logInfo('xifan-challenge', `页面就绪：${stageLabel}`)
      resolve(value)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      browserSessionVerified = false
      cleanup()
      hide()
      logInfo('xifan-challenge', `失败：${stageLabel} —— ${error.message}`)
      reject(error)
    }
    const timeout = setTimeout(() => {
      fail(new Error('稀饭后台安全检查在限定时间内未完成，请检查网络后重试'))
    }, timeoutMs)
    const runAction = async (html: string): Promise<void> => {
      if (settled || actionStarted) return
      actionStarted = true
      try {
        const value = await action(win.webContents, html)
        if (!settled) succeed(value)
      } catch (err) {
        if (!settled) fail(err instanceof Error ? err : new Error(String(err)))
      }
    }
    const scheduleInspect = (delayMs: number): void => {
      if (settled) return
      if (checkTimer) clearTimeout(checkTimer)
      checkTimer = setTimeout(() => {
        checkTimer = null
        void inspect()
      }, delayMs)
    }
    const inspect = async (): Promise<void> => {
      if (settled || win.isDestroyed()) return
      if (!isXifanPageUrl(win.webContents.getURL())) {
        // loadURL 刚被站点自己的 refresh 接走时，WebContents 会短暂回到空 URL。
        // 此处只安排下一次本地状态查看，不再次导航、不增加站点请求。
        scheduleInspect(DOCUMENT_SETTLE_DELAY_MS)
        return
      }
      try {
        const html = String(await win.webContents.executeJavaScript(
          'document.documentElement ? document.documentElement.outerHTML : ""',
        ))
        if (settled) return
        if (isScrapeChallengePage(html)) {
          if (!challengeLogged) {
            challengeLogged = true
            logInfo('xifan-challenge', `命中安全检查页,后台轮询等待站点自行放行：${stageLabel}`)
          }
          // 稀饭有时原地替换 DOM 而不再触发 did-finish-load。只等下一次 load 会让
          // 应用停在「解析播放地址中…」直到超时；后台轮询 DOM 后，检查一结束就取
          // 同一页的最终 HTML。这里不发网络请求，也不模拟任何验证码操作。
          scheduleInspect(CHALLENGE_POLL_DELAY_MS)
          return
        }
        if (challengeLogged) logInfo('xifan-challenge', `安全检查已放行：${stageLabel}`)
        void runAction(html)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // 倒计时刷新的一瞬间，旧文档的 JS 上下文会被 Chromium 销毁；这不是读取
        // 失败。等新文档稳定后再看一次，仍不正常才由总超时收口。
        if (/execution context.*destroyed|context.*destroyed|ERR_ABORTED/i.test(message)) {
          scheduleInspect(DOCUMENT_SETTLE_DELAY_MS)
          return
        }
        if (!settled) fail(new Error(`稀饭后台安全检查页读取失败：${message}`))
      }
    }
    const onLoad = (): void => {
      if (settled || actionStarted) return
      scheduleInspect(DOCUMENT_SETTLE_DELAY_MS)
    }
    const onFail = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      _url: string,
      isMainFrame: boolean,
    ): void => {
      // UAM 重载会短暂产生 ERR_ABORTED / (-3)；等新文档接上后继续看 DOM。真正
      // 网络错误则直接交给用户重新操作，绝不在这里自动重发页面请求。
      if (!isMainFrame) return
      if (errorCode === -3) {
        scheduleInspect(DOCUMENT_SETTLE_DELAY_MS)
        return
      }
      fail(new Error(`稀饭后台安全检查页加载失败：${errorDescription}`))
    }
    const onClosed = (): void => {
      fail(new Error('稀饭后台安全检查已中断，请重新发起操作'))
    }
    win.webContents.on('did-finish-load', onLoad)
    win.webContents.on('did-fail-load', onFail)
    win.on('closed', onClosed)

    if (targetUrl) {
      logInfo('xifan-challenge', `开始加载：${targetUrl}`)
      void win.loadURL(targetUrl).catch((err: unknown) => {
        // UAM 自己 reload 会让首次 loadURL 带 ERR_ABORTED / (-3)。真正结果由当前
        // WebContents 的最终文档决定；这里只继续观察，不能再 loadURL 一次。
        if (isNavigationAbort(err)) {
          scheduleInspect(DOCUMENT_SETTLE_DELAY_MS)
          return
        }
        fail(new Error(`稀饭后台安全检查页打不开：${err instanceof Error ? err.message : String(err)}`))
      })
    } else {
      // 上一次任务已在正常同源文档结束；不导航，保留该页的浏览器身份与 JS 上下文。
      scheduleInspect(0)
    }
  })
}

export function loadXifanBrowserPage(targetUrl: string): Promise<XifanBrowserPage> {
  if (!isXifanPageUrl(targetUrl)) return Promise.reject(new Error('稀饭后台页面地址无效'))
  return queueXifanBrowserTask(() => runXifanBrowserTask(
    targetUrl,
    async (_webContents, html) => ({ html }),
  ))
}

/** 首次设置页直接拿验证码时，也先加载真实页面完成 UAM。 */
async function ensureXifanBrowserSession(): Promise<void> {
  getXifanBrowserSession()
  if (!browserSessionVerified) await loadXifanBrowserPage(`${XIFAN_ORIGIN}/`)
}

export interface XifanBrowserRequestOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

interface BrowserFetchResult {
  status: number
  contentType: string
  bodyBase64: string
}

/**
 * 通过当前同源页面原生 fetch 发验证码/登录等接口。它实际运行在 Chromium renderer，
 * 因此站点看到的是与安全检查相同的页面上下文；没有复制 UAM 脚本、伪造请求或
 * 模拟点击。若接口仍收到挑战页，标记会话失效并提示用户重试；下一次操作仍会在
 * 同一个后台 WebContents 中先完成站点自己的检查。
 */
export async function requestXifanBrowser(
  targetUrl: string,
  options: XifanBrowserRequestOptions = {},
): Promise<NetResult> {
  if (!isXifanPageUrl(targetUrl)) throw new Error('稀饭后台页面地址无效')
  await ensureXifanBrowserSession()
  const result = await queueXifanBrowserTask(() => runXifanBrowserTask<BrowserFetchResult>(
    null,
    async (webContents) => {
      const requestJson = JSON.stringify({
        url: targetUrl,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        body: options.body,
        hasBody: options.body !== undefined,
      })
      const raw = await webContents.executeJavaScript(`(async () => {
        const request = ${requestJson}
        const init = {
          method: request.method,
          headers: request.headers,
          credentials: 'include',
          redirect: 'follow',
        }
        if (request.hasBody) init.body = request.body
        const response = await fetch(request.url, init)
        const bytes = new Uint8Array(await response.arrayBuffer())
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
        }
        return {
          status: response.status,
          contentType: response.headers.get('content-type') || '',
          bodyBase64: btoa(binary),
        }
      })()`)
      const value = raw as Partial<BrowserFetchResult> | null
      if (
        !value ||
        typeof value.status !== 'number' ||
        typeof value.contentType !== 'string' ||
        typeof value.bodyBase64 !== 'string'
      ) {
        throw new Error('稀饭浏览器接口返回格式无效')
      }
      return {
        status: value.status,
        contentType: value.contentType,
        bodyBase64: value.bodyBase64,
      }
    },
    Math.max(options.timeoutMs ?? 15_000, 30_000),
  ))
  const body = Buffer.from(result.bodyBase64, 'base64')
  if (isScrapeChallengePage(body.toString('utf-8'))) {
    browserSessionVerified = false
    throw new Error('稀饭后台安全检查仍未完成，请稍后重试')
  }
  return {
    status: result.status,
    headers: { 'content-type': result.contentType },
    body,
  }
}
