// 桌面端 Umami 活跃度上报 —— 只发送匿名的应用会话摘要。
//
// 这条链路必须留在主进程：渲染进程不能直连网络，且主进程的 net() 才会沿用
// Electron 的系统代理 / PAC。上报失败只记本地日志，不阻塞启动、播放或退出。
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { netRequest } from './net-request'
import { logError } from './logger'

const UMAMI_ENDPOINT = 'https://user.alcmaple.cn/api/send'
// anime.alcmaple.cn 已有的 Umami 网站；桌面端用固定 hostname 区分于网页端。
const UMAMI_WEBSITE = '6d38f531-a7ce-4e4a-8860-d23d0cfb4512'
const UMAMI_HOSTNAME = 'mapletools-desktop'
const UMAMI_TITLE = 'MapleTools Desktop'
const HEARTBEAT_MS = 5 * 60 * 1000

type EventValue = string | number | boolean
type EventData = Record<string, EventValue>

let initialized = false
let activeSince: number | null = null
let activeMs = 0
let heartbeat: ReturnType<typeof setInterval> | null = null
let failureLogged = false
const sessionId = randomUUID()

function baseData(): EventData {
  return {
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  }
}

function activeSeconds(now = Date.now()): number {
  const current = activeMs + (activeSince === null ? 0 : Math.max(0, now - activeSince))
  return Math.floor(current / 1000)
}

function report(name: string, data: EventData = {}): void {
  const payload = {
    hostname: UMAMI_HOSTNAME,
    language: 'zh-CN',
    title: UMAMI_TITLE,
    url: '/desktop',
    website: UMAMI_WEBSITE,
    id: sessionId,
    name,
    data: { ...baseData(), ...data },
  }

  // Umami 要求有效的 User-Agent；Electron 自带的 fallback 是浏览器式 UA，保留它比
  // 伪造一个与实际运行环境矛盾的固定 UA 更稳。这里只追加应用版本便于排查版本差异。
  const userAgent = `${app.userAgentFallback || 'Mozilla/5.0'} MapleTools/${app.getVersion()}`
  void netRequest(UMAMI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
    },
    body: JSON.stringify({ type: 'event', payload }),
    timeoutMs: 5000,
    maxBytes: 4096,
  }).then((result) => {
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`HTTP ${result.status}`)
    }
  }).catch((error: unknown) => {
    // 统计服务不可达不能影响应用本身；同一进程只记一条，避免断网时刷屏。
    if (failureLogged) return
    failureLogged = true
    logError('analytics:umami', error)
  })
}

function markActive(): void {
  if (activeSince !== null) return
  activeSince = Date.now()
  report('desktop-focus')
}

function markInactive(): void {
  if (activeSince === null) return
  const now = Date.now()
  activeMs += Math.max(0, now - activeSince)
  activeSince = null
  report('desktop-blur', { activeSeconds: activeSeconds(now) })
}

function sendHeartbeat(): void {
  if (activeSince === null) return
  report('desktop-active', { activeSeconds: activeSeconds() })
}

/**
 * 初始化一次桌面活跃会话。
 *
 * 仅打包版默认上报；开发联调可显式设置 `MAPLETOOLS_UMAMI=1`，避免本地开发把
 * 热重载 / 自动重启误记成真实用户。没有重试，网络错误也不会阻断应用生命周期。
 */
export function initUmamiActivity(): void {
  if (initialized) return
  initialized = true
  if (process.env.MAPLETOOLS_DISABLE_UMAMI === '1') return
  if (!app.isPackaged && process.env.MAPLETOOLS_UMAMI !== '1') return

  report('desktop-open')
  app.on('browser-window-focus', markActive)
  app.on('browser-window-blur', markInactive)
  heartbeat = setInterval(sendHeartbeat, HEARTBEAT_MS)
  heartbeat.unref()
  app.once('before-quit', () => {
    markInactive()
    report('desktop-close', { activeSeconds: activeSeconds() })
    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
  })
}
