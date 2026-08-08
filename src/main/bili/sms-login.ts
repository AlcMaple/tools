// B 站短信登录编排 —— API 参数/顺序照搬 Biu，主进程只负责 MapleTools 的安全边界：
// 1. HTTP 与 cookie 全走 persist:bili；2. 极验运行在无 Node 权限的独立小窗；
// 3. captcha_key 留在主进程，用一次性 flowId 让 renderer 完成第二步。
import { BrowserWindow } from 'electron'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  BILI_PARTITION,
  getWebLoginCaptcha,
  loginWithWebSms,
  sendWebSmsCode,
  type BiliGeetestChallenge,
  type BiliGeetestResult,
} from './api'

const FLOW_TTL_MS = 10 * 60_000
const PHONE_CN = /^1\d{10}$/
const SMS_CODE = /^\d{6}$/

interface SmsFlow {
  phone: string
  captchaKey: string
  expiresAt: number
}

type GeetestWindowResult =
  | { kind: 'success'; validate: string; seccode: string; challenge: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

const flows = new Map<string, SmsFlow>()
let geetestWindow: BrowserWindow | null = null

function pruneFlows(): void {
  const now = Date.now()
  for (const [id, flow] of flows) {
    if (flow.expiresAt <= now) flows.delete(id)
  }
}

function normalizePhone(raw: unknown): string {
  const phone = typeof raw === 'string' ? raw.replace(/\D/g, '') : ''
  if (!PHONE_CN.test(phone)) throw new Error('请输入正确的中国大陆手机号')
  return phone
}

function normalizeCode(raw: unknown): string {
  const code = typeof raw === 'string' ? raw.replace(/\D/g, '') : ''
  if (!SMS_CODE.test(code)) throw new Error('请输入 6 位短信验证码')
  return code
}

function geetestPage(challenge: BiliGeetestChallenge): string {
  const nonce = randomBytes(18).toString('base64url')
  const safeChallenge = JSON.stringify({ gt: challenge.gt, challenge: challenge.challenge })
    .replaceAll('<', '\\u003c')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https: 'unsafe-eval'; connect-src https:; frame-src https:; img-src https: data: blob:; style-src 'unsafe-inline' https:; font-src https: data:">
  <title>完成安全验证</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #171717; color: #ece7e8; }
    main { width: min(360px, calc(100vw - 40px)); text-align: center; }
    .icon { width: 48px; height: 48px; margin: 0 auto 18px; display: grid; place-items: center; border-radius: 14px; background: rgba(244, 173, 188, .12); color: #f4adbc; font-size: 24px; }
    h1 { margin: 0 0 8px; font-size: 17px; }
    p { min-height: 20px; margin: 0; color: #a9a2a4; font-size: 13px; line-height: 1.6; }
    button { margin-top: 22px; border: 1px solid #494345; border-radius: 10px; padding: 9px 22px; color: #c9c1c3; background: #242122; cursor: pointer; }
    button:hover { background: #302c2d; color: #fff; }
  </style>
</head>
<body>
  <main>
    <div class="icon">✓</div>
    <h1>安全验证</h1>
    <p id="status">正在加载验证组件…</p>
    <button id="cancel" type="button">取消</button>
  </main>
  <script nonce="${nonce}">
    const options = ${safeChallenge}
    window.__mapleGeetestResult = new Promise((resolve) => {
      let done = false
      let loadTimer = 0
      const finish = (result) => {
        if (done) return
        done = true
        if (loadTimer) clearTimeout(loadTimer)
        resolve(result)
      }
      document.getElementById('cancel').addEventListener('click', () => finish({ kind: 'cancelled' }))
      const script = document.createElement('script')
      script.src = 'https://static.geetest.com/static/tools/gt.js'
      script.async = true
      script.onerror = () => finish({ kind: 'error', message: '安全验证组件加载失败' })
      script.onload = () => {
        if (typeof window.initGeetest !== 'function') {
          finish({ kind: 'error', message: '安全验证组件初始化失败' })
          return
        }
        window.initGeetest({
          gt: options.gt,
          challenge: options.challenge,
          offline: false,
          new_captcha: true,
          product: 'bind',
          https: true,
        }, (captcha) => {
          captcha.onReady(() => {
            // 15 秒只约束「组件有没有加载好」，不能把真人操作验证码的时间也算进去。
            // 否则图片验证码停留稍久就会被误判为加载超时并强制关窗。
            if (loadTimer) clearTimeout(loadTimer)
            loadTimer = 0
            document.getElementById('status').textContent = '请完成滑块验证'
            captcha.verify()
          })
          captcha.onSuccess(() => {
            const result = captcha.getValidate()
            if (!result || typeof result === 'boolean') {
              finish({ kind: 'error', message: '没有取得安全验证结果' })
              return
            }
            finish({
              kind: 'success',
              validate: result.geetest_validate || '',
              seccode: result.geetest_seccode || '',
              challenge: result.geetest_challenge || options.challenge,
            })
          })
          captcha.onError(() => finish({ kind: 'error', message: '安全验证失败,请重试' }))
          if (captcha.onClose) captcha.onClose(() => finish({ kind: 'cancelled' }))
        })
      }
      document.head.appendChild(script)
      loadTimer = setTimeout(() => finish({ kind: 'error', message: '安全验证组件加载超时' }), 15000)
    })
  </script>
</body>
</html>`
}

async function openGeetest(parent: BrowserWindow | undefined, challenge: BiliGeetestChallenge): Promise<BiliGeetestResult | null> {
  if (geetestWindow && !geetestWindow.isDestroyed()) {
    geetestWindow.focus()
    throw new Error('安全验证窗口已经打开')
  }

  return new Promise<BiliGeetestResult | null>((resolve, reject) => {
    const win = new BrowserWindow({
      width: 440,
      height: 620,
      minWidth: 400,
      minHeight: 520,
      parent,
      modal: !!parent,
      show: false,
      title: '完成 B 站安全验证',
      backgroundColor: '#171717',
      autoHideMenuBar: true,
      webPreferences: {
        partition: BILI_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    geetestWindow = win
    let settled = false

    const finish = (result: BiliGeetestResult | null, error?: unknown): void => {
      if (settled) return
      settled = true
      geetestWindow = null
      if (!win.isDestroyed()) win.close()
      if (error) reject(error)
      else resolve(result)
    }

    win.on('page-title-updated', (event) => event.preventDefault())
    win.once('ready-to-show', () => win.show())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.once('closed', () => {
      geetestWindow = null
      if (!settled) {
        settled = true
        resolve(null)
      }
    })
    win.webContents.once('did-finish-load', () => {
      // 初始 data URL 必须先加载完；之后禁止验证页把顶层窗口带去外站。
      win.webContents.on('will-navigate', (event) => event.preventDefault())
      void win.webContents.executeJavaScript('window.__mapleGeetestResult', true)
        .then((raw: unknown) => {
          const result = raw as GeetestWindowResult | undefined
          if (!result || result.kind === 'cancelled') {
            finish(null)
            return
          }
          if (result.kind === 'error') {
            finish(null, new Error(result.message))
            return
          }
          if (!result.validate || !result.seccode || !result.challenge) {
            finish(null, new Error('安全验证结果不完整'))
            return
          }
          finish({
            validate: result.validate,
            seccode: result.seccode,
            challenge: result.challenge,
            token: challenge.token,
          })
        })
        .catch((error: unknown) => finish(null, error))
    })

    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(geetestPage(challenge))}`
    void win.loadURL(dataUrl).catch((error: unknown) => finish(null, error))
  })
}

export async function requestSmsCode(
  parent: BrowserWindow | undefined,
  rawPhone: unknown,
): Promise<{ cancelled: true } | { cancelled: false; flowId: string }> {
  const phone = normalizePhone(rawPhone)
  pruneFlows()
  const challenge = await getWebLoginCaptcha()
  const verified = await openGeetest(parent, challenge)
  if (!verified) return { cancelled: true }

  const captchaKey = await sendWebSmsCode(phone, verified)
  for (const [id, flow] of flows) {
    if (flow.phone === phone) flows.delete(id)
  }
  const flowId = randomUUID()
  flows.set(flowId, { phone, captchaKey, expiresAt: Date.now() + FLOW_TTL_MS })
  return { cancelled: false, flowId }
}

export async function completeSmsLogin(rawFlowId: unknown, rawCode: unknown): Promise<{ loggedIn: true }> {
  pruneFlows()
  const flowId = typeof rawFlowId === 'string' ? rawFlowId : ''
  const flow = flows.get(flowId)
  if (!flow) throw new Error('验证码已失效,请重新获取')

  const code = normalizeCode(rawCode)
  await loginWithWebSms(flow.phone, code, flow.captchaKey)
  flows.delete(flowId)
  return { loggedIn: true }
}

export function clearSmsLoginFlows(): void {
  flows.clear()
  if (geetestWindow && !geetestWindow.isDestroyed()) geetestWindow.close()
  geetestWindow = null
}
