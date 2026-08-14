import { BrowserWindow, session } from 'electron'
import { DESKTOP_USER_AGENT } from '../shared/download-types'
import type { NetResult } from '../shared/net-request'
import { isScrapeChallengePage } from '../shared/scrape-guard'
import { logInfo } from '../shared/logger'

const XIFAN_PARTITION = 'persist:xifan-browser-check'
// 这条链路没有需要用户在外部窗口里完成的步骤:正常安全检查约 5 秒,但站点偶尔会把首个
// 无登录态页面拖到约 28 秒。45 秒是给最终 refresh 留的余量;超时后**不自动重试**。
const PAGE_TIMEOUT_MS = 45_000
const DOCUMENT_SETTLE_DELAY_MS = 120
const CHALLENGE_POLL_DELAY_MS = 250
export const XIFAN_ORIGIN = 'https://anime.xifanacg.com'

export interface XifanBrowserPage {
  html: string
}

// 所有页面读取和同源接口请求顺序执行,避免一个 WebContents 同时被多次导航。
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
    installSubresourceFilter(cachedSession)
  }
  return cachedSession
}

/** 当前这张页还没结束的请求（超时时点名用，见 dumpInflight）。 */
const inflightRequests = new Map<string, number>()

/**
 * 后台页只用来**读 HTML**：页面的图片、字体、第三方脚本一个都不需要。
 *
 * 2026-08-14 实测：稀饭页里挂着 `https://polyfill-js.cn/v3/polyfill.min.js`，这个域名连不上，
 * 而它是同步脚本 —— `DOMContentLoaded`（也就是 `dom-ready`）会一直等它，整整卡满 45 秒超时，
 * 而稀饭自己的 HTML 首字节只用了 1.2 秒。用户在浏览器里同样的操作早就播上了。
 *
 * 因此：**跨源子资源一律拦掉，同源一律放行**。稀饭自己的 UAM 脚本、Cloudflare 的
 * `/cdn-cgi/` 挑战都是同源，不会被误伤；主文档、子框架、XHR/fetch 也一律放行，
 * 免得挡掉安全检查要用的接口。顺带：polyfill.io 那条线 2024 年出过供应链投毒，
 * 不去连它本身也是安全上的净收益。
 */
function installSubresourceFilter(ses: Electron.Session): void {
  ses.webRequest.onBeforeRequest((details, callback) => {
    const passthrough = details.resourceType === 'mainFrame' ||
      details.resourceType === 'subFrame' ||
      details.resourceType === 'xhr'
    let sameOrigin = false
    try {
      sameOrigin = isXifanHost(new URL(details.url).hostname)
    } catch { /* 非 http(s) 的怪地址,当跨源处理 */ }
    if (!passthrough && !sameOrigin) {
      callback({ cancel: true })
      return
    }
    inflightRequests.set(details.url, Date.now())
    callback({})
  })
  const clear = (d: { url: string }): void => { inflightRequests.delete(d.url) }
  ses.webRequest.onCompleted(clear)
  ses.webRequest.onErrorOccurred(clear)
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
 * 站点自己的倒计时刷新会主动取消旧文档。macOS 上 Electron 有时只报成 `(-3) loading ...`、
 * 不带 ERR_ABORTED 文本 —— 两种写法都是同一次正常的导航交接,不能当成页面打不开
 * 更不能因此重新 loadURL 多发一次请求。
 */
function isNavigationAbort(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /ERR_ABORTED|\(\s*-3\s*\)/i.test(message)
}

/**
 * 后台页面,**始终不显示**:站点脚本仍在真实 WebContents 里执行,播放页只留
 * 「解析播放地址中…」这一层应用 UI。
 *
 * 生命周期见 closeBrowserWindowIfIdle —— 默认读完就销毁,只有验证码/登录会显式续期。
 * 续期期间**不要为验证码另开一张首页**,那可能被站点当成新的首次访问。
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
  // show:false 的页面可能被 Chromium 降低定时器优先级,而站点的检查正是靠倒计时和脚本刷新
  // 完成的,所以明确保持它的正常节奏,不去等前台窗口。
  win.webContents.setBackgroundThrottling(false)
  // **必须静音**:加载的 watch 页里有站点自己的播放器会自动播。窗口不可见,于是表现为
  // 「只有声音没画面」,而且渲染层的暂停 / detachVideo / media:release 都够不着它。
  // 这是纯抓取窗口,任何平台上都不该出声。真正停播靠下面的 stopPageMedia,静音只是兜底。
  win.webContents.setAudioMuted(true)
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

/**
 * 停掉后台页里站点自己的播放器。
 *
 * watch 页里有站点自己的播放器会自动播。窗口现在读完即销毁,但验证码/登录会让它多活
 * 10 分钟 —— 那段时间里它会一直播、一直下,和我们自己的播放器一人一份流。静音只解决
 * 听感,这里才是真的停掉。
 *
 * 只动媒体元素、不导航:一导航就是给站点多发一次请求,也会丢掉已验证的文档上下文。
 */
function stopPageMedia(webContents: Electron.WebContents): void {
  webContents.executeJavaScript(`(() => {
    for (const el of document.querySelectorAll('video,audio')) {
      try { el.pause(); el.removeAttribute('src'); el.load() } catch {}
    }
    return document.querySelectorAll('video,audio').length
  })()`).then(
    (n) => logInfo('xifan-challenge', `已停掉后台页内置播放器（${n} 个媒体元素）`),
    () => undefined, // 文档正在被站点刷新走 —— 下一次任务结束时还会再停一次
  )
}

/**
 * 后台窗口的存活策略:**默认用完就销毁**。
 *
 * 它是一张真实的站点页面(watch 页里就有站点自己的播放器),留着 = 白占一个 Chromium
 * 进程 + 继续播继续下,和播放器抢带宽。cookie 存在持久分区里,**销毁窗口不会丢掉已通过的
 * 检查**,只是 browserSessionVerified 归 false —— 而那个标志只被验证码/登录用到。
 *
 * 唯一必须跨任务留住文档的是 requestXifanBrowser(复用当前文档发同源 fetch,见其注释),
 * 它会显式续期。播放链路(loadXifanBrowserPage)全程用不到,读完 HTML 就该关。
 */
let pendingTasks = 0
let keepAliveUntil = 0

/**
 * 验证码/登录那条路要复用同一张文档连着发好几个同源 fetch，显式把窗口留住。
 *
 * 时长要覆盖的**不是几个请求，而是人**:getCaptcha 取到图 → 用户盯着看、输入 → verifyCaptcha
 * 提交,中间整段是人的速度。取太短会正好卡在用户输入的中途把窗口销毁,验证码上下文就没了。
 * 10 分钟是给「看图 + 输入 + 输错重来」留的余量;窗口里此时是验证码/设置页,已被
 * stopPageMedia 停掉媒体,留着几乎不耗资源。**别为了「省资源」把它调回秒级。**
 */
function keepBrowserWindowAlive(ms = 10 * 60_000): void {
  keepAliveUntil = Math.max(keepAliveUntil, Date.now() + ms)
}

let idleCloseTimer: ReturnType<typeof setTimeout> | null = null

function closeBrowserWindowIfIdle(): void {
  if (idleCloseTimer) {
    clearTimeout(idleCloseTimer)
    idleCloseTimer = null
  }
  if (pendingTasks > 0) return
  // 还在续期内(验证码/登录):等到期再来收一次,否则没有后续任务时窗口会一直留到退出应用。
  const remain = keepAliveUntil - Date.now()
  if (remain > 0) {
    idleCloseTimer = setTimeout(closeBrowserWindowIfIdle, remain + 100)
    return
  }
  const win = activeBrowserWindow
  if (!win || win.isDestroyed()) return
  logInfo('xifan-challenge', '任务结束，销毁后台窗口')
  win.destroy() // closed 回调里会清 activeBrowserWindow / browserSessionVerified
}

function queueXifanBrowserTask<T>(task: () => Promise<T>): Promise<T> {
  pendingTasks++
  const queued = pageQueue.then(task)
  pageQueue = queued.then(() => undefined, () => undefined).then(() => {
    pendingTasks--
    closeBrowserWindowIfIdle()
  })
  return queued
}

/**
 * 在这张持久的同源 WebContents 里完成一次页面读取或 fetch。`targetUrl` 为空时不导航
 * 直接在上一次已验证的页面里发接口请求。
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
    // 阶段日志只在**切换**时落一行,不跟着 250ms 轮询刷屏。
    let challengeLogged = false
    const stageLabel = targetUrl ?? '(复用当前页)'
    // 超时那句话必须说**当时真的卡在哪**。旧代码不管什么原因都报「安全检查未完成」,
    // 而 inspect() 里有两条静默重排路径(URL 还没落到稀饭域 / JS 上下文被刷新销毁)
    // 根本没判定过安全检查 —— 用户看到的是一个程序自己都不知道的结论。
    let stage = '等待页面首次加载'
    const setStage = (next: string): void => {
      if (stage === next) return
      stage = next
      logInfo('xifan-challenge', `${stageLabel} → ${next}`)
    }
    const cleanup = (): void => {
      clearTimeout(timeout)
      if (checkTimer) clearTimeout(checkTimer)
      checkTimer = null
      win.webContents.removeListener('dom-ready', onLoad)
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
      // 我们要的 HTML 已经拿到,页面接下来只用于同源 fetch —— 立刻停掉它的播放器,
      // 别让它和播放页的 <video> 各下一份。
      if (!win.isDestroyed()) stopPageMedia(win.webContents)
      logInfo('xifan-challenge', `页面就绪：${stageLabel}`)
      resolve(value)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      browserSessionVerified = false
      cleanup()
      hide()
      // 失败同样要停:超时那 45 秒里页面很可能一直在播、一直在下。
      if (!win.isDestroyed()) stopPageMedia(win.webContents)
      logInfo('xifan-challenge', `失败：${stageLabel} —— ${error.message}`)
      reject(error)
    }
    // 超时时把还没结束的请求点名打出来。2026-08-14 就是靠它抓到 polyfill-js.cn 卡了 43 秒;
    // 只在失败时打一次,不刷屏,下次再有第三方资源拖垮加载也能立刻看出是谁。
    const dumpInflight = (): void => {
      const now = Date.now()
      const rows = [...inflightRequests.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, 8)
        .map(([url, t]) => `\n    ${now - t}ms 未完成  ${url.slice(0, 120)}`)
      logInfo('xifan-challenge', rows.length ? `超时时仍在等的请求：${rows.join('')}` : '超时时没有未完成的请求')
    }
    const timeout = setTimeout(() => {
      dumpInflight()
      fail(new Error(`稀饭后台页在 ${Math.round(timeoutMs / 1000)} 秒内没能就绪（卡在：${stage}），请稍后重试`))
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
        setStage('等待导航落到稀饭域名')
        scheduleInspect(DOCUMENT_SETTLE_DELAY_MS)
        return
      }
      try {
        const html = String(await win.webContents.executeJavaScript(
          'document.documentElement ? document.documentElement.outerHTML : ""',
        ))
        if (settled) return
        if (isScrapeChallengePage(html)) {
          setStage('站点安全检查中，等它自行放行')
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
          setStage('页面正在被站点刷新，等新文档稳定')
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
    // **不能只等 did-finish-load**:它要主框架连同子资源全部加载完才触发,而 watch 页里
    // 有个自动播放的视频,只要它还在拉流这个事件就可能一直不来 —— 表现为卡在「等待页面
    // 首次加载」直到 45 秒超时,而页面其实早就能读了(2026-08-14 日志实证)。
    // dom-ready 在文档解析完就触发,和子资源无关,正是我们要的时机。
    win.webContents.on('dom-ready', onLoad)
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

/**
 * 首次设置页直接拿验证码时，也先加载真实页面完成 UAM。
 *
 * 这里**必须先续期**:后面的同源 fetch 要复用这次加载出来的文档,不续期的话首页读完
 * 队列就空了,窗口会被 closeBrowserWindowIfIdle 销毁,fetch 那步就没有文档可用了。
 */
async function ensureXifanBrowserSession(): Promise<void> {
  getXifanBrowserSession()
  keepBrowserWindowAlive()
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
