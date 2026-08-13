// 周历邮件 —— 开一个隐藏窗口把周历页渲染到完整高度后截图,PNG 内嵌进邮件正文并附带附件发出。
//
//   1. 隐藏窗口加载渲染器 URL,带上 `?screenshot=calendar`
//   2. 渲染层看到这个参数就只渲染截图专用组件(不要侧栏 / 顶栏 / sticky 工具栏),数据走已有缓存
//   3. 所有 <img> 加载完后通过 IPC 上报页面实际高度
//   4. 主进程按这个高度 setBounds 再截图
//   5. 走 SMTP 发信,最后关掉隐藏窗口
//
// 任何一环失败都抛错,由调用方决定要不要记水印。

import { BrowserWindow, ipcMain, app } from 'electron'
import { join } from 'path'
import type { MailConfig } from './config'
import { buildTransporter, todayLabel } from './transport'

const SCREENSHOT_WIDTH = 1280
const DEFAULT_HEIGHT = 800
const MAX_HEIGHT = 12000          // 12k 高度足够当下任何 7 列 × N 行的布局
const READY_TIMEOUT_MS = 15_000   // 等渲染器 ready 信号的总超时
const POST_RESIZE_DELAY_MS = 250  // resize 之后给浏览器一个 layout/paint 的缓冲

let busy = false

// 兼容老 preload(直接传 number)和新 preload(传 { height })两种形态,在下游统一归一化。
type ReadyPayload = number | { height: number }

// ── 隐藏窗口工厂 ────────────────────────────────────────────────────────────────

function createOffscreenWindow(): BrowserWindow {
  return new BrowserWindow({
    width: SCREENSHOT_WIDTH,
    height: DEFAULT_HEIGHT,
    show: false,
    frame: false,
    transparent: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      offscreen: false,
      backgroundThrottling: false,
    },
  })
}

function loadScreenshotRoute(win: BrowserWindow): void {
  if (process.env['ELECTRON_RENDERER_URL']) {
    // dev：Vite dev server URL，直接拼 query
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    url.searchParams.set('screenshot', 'calendar')
    void win.loadURL(url.toString())
  } else {
    // prod：file:// 加载，loadFile 的 query 参数走第二个参数
    void win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { screenshot: 'calendar' },
    })
  }
}

// ── 等渲染器 ready（带超时） ────────────────────────────────────────────────────

function waitForReady(): Promise<ReadyPayload> {
  return new Promise<ReadyPayload>((resolve, reject) => {
    const timer = setTimeout(() => {
      ipcMain.removeHandler('screenshot:calendar-ready')
      reject(new Error('screenshot ready 超时'))
    }, READY_TIMEOUT_MS)

    ipcMain.handleOnce('screenshot:calendar-ready', (_e, payload: ReadyPayload) => {
      clearTimeout(timer)
      resolve(payload)
      return true
    })
  })
}

// ── 主流程 ─────────────────────────────────────────────────────────────────────

async function capturePageBuffer(): Promise<Buffer> {
  if (busy) throw new Error('已经有一个截图任务在跑了')
  busy = true

  // **窗口必须在 try 块内创建**:写在外面的话,一旦 new BrowserWindow 本身抛错就会跳过 finally
  // busy 永久卡在 true,之后所有发送都会被「已经有一个截图任务在跑」挡掉。
  let win: BrowserWindow | null = null
  try {
    console.log('[calendar-mailer] 开始截图：打开隐藏窗口')
    win = createOffscreenWindow()
    loadScreenshotRoute(win)

    const payload = await waitForReady()
    // 兼容旧 preload 传单数字 + 新 preload 传 { height } 两种 payload 形态
    const rawHeight = typeof payload === 'number' ? payload : payload?.height
    const clamped = Math.min(Math.max(Number(rawHeight) || DEFAULT_HEIGHT, DEFAULT_HEIGHT), MAX_HEIGHT)
    console.log(`[calendar-mailer] 渲染器上报 height=${rawHeight}，clamp 后=${clamped}`)
    win.setBounds({ x: 0, y: 0, width: SCREENSHOT_WIDTH, height: clamped })

    // 给浏览器 layout/paint 一拍喘息时间，否则 capturePage 偶尔截到半渲染态
    await new Promise<void>(r => setTimeout(r, POST_RESIZE_DELAY_MS))

    const image = await win.webContents.capturePage()
    const png = image.toPNG()
    console.log(`[calendar-mailer] 截图完成 ${png.length} bytes`)
    return png
  } finally {
    busy = false
    if (win) {
      try { win.destroy() } catch { /* ignore */ }
    }
    // 清理可能残留的一次性 handler（waitForReady 超时分支也会清，这里二次保险）
    try { ipcMain.removeHandler('screenshot:calendar-ready') } catch { /* ignore */ }
  }
}

// ── nodemailer ────────────────────────────────────────────────────────────────
//
// transporter + todayLabel 已抽到 ./transport.ts 共享给 anime-report-mailer。

/**
 * 用当前的邮件配置发送一封带周历截图的邮件。
 * 调用方应自行确保 cfg.enabled === true 且 qqEmail/authCode 都已填。
 */
export async function sendCalendarMail(cfg: MailConfig): Promise<void> {
  if (!cfg.qqEmail || !cfg.authCode) {
    throw new Error('邮箱或授权码未配置')
  }

  const png = await capturePageBuffer()
  const transporter = buildTransporter(cfg)

  console.log(`[calendar-mailer] 准备通过 smtp.qq.com 发送给 ${cfg.qqEmail}`)

  const label = todayLabel()
  await transporter.sendMail({
    from: `MapleTools <${cfg.qqEmail}>`,
    to: cfg.qqEmail,
    subject: `番剧周历更新 — ${label}`,
    html: `
      <p style="font:14px/1.6 -apple-system,sans-serif;color:#333;margin:0 0 12px;">
        本周番剧周历已从 Bangumi 刷新，截图如下：
      </p>
      <img src="cid:calendar" alt="番剧周历" style="display:block;max-width:100%;border:1px solid #eee;border-radius:8px;" />
      <p style="font:12px/1.6 -apple-system,sans-serif;color:#999;margin:16px 0 0;">
        来自 MapleTools v${app.getVersion()} · ${label}
      </p>
    `,
    attachments: [
      {
        filename: `calendar-${label}.png`,
        content: png,
        cid: 'calendar',
      },
    ],
  })
  console.log('[calendar-mailer] 邮件发送成功')
}

/**
 * 发一封不带截图的纯文本测试邮件，用于让用户验证授权码 / SMTP 连通性。
 */
export async function sendTestMail(cfg: MailConfig): Promise<void> {
  if (!cfg.qqEmail || !cfg.authCode) {
    throw new Error('邮箱或授权码未配置')
  }
  const transporter = buildTransporter(cfg)
  await transporter.sendMail({
    from: `MapleTools <${cfg.qqEmail}>`,
    to: cfg.qqEmail,
    subject: 'MapleTools 邮件配置测试',
    text: `如果你收到了这封邮件，说明 QQ 邮箱 SMTP 配置成功，番剧周历刷新后将自动发件。\n\n时间：${new Date().toLocaleString('zh-CN')}`,
  })
}
