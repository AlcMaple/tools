import { assertXifanResponse, BASE_URL, xifanSessionFor } from './session'

export interface XifanAuthStatus {
  loggedIn: boolean
}

export interface XifanLoginResult {
  success: boolean
  message: string
}

interface XifanAjaxResult {
  code?: unknown
  msg?: unknown
}

function parseAjaxResult(body: string): XifanAjaxResult {
  try {
    return JSON.parse(body) as XifanAjaxResult
  } catch {
    return {}
  }
}

function isLoggedOutPage(html: string): boolean {
  return html.includes('亲爱的：未登录')
    || html.includes('class="mac_login_form')
    || html.includes('<h1>账号登录</h1>')
}

function isLoggedInPage(html: string): boolean {
  return html.includes('用户中心')
    || html.includes('退出登录')
    || /\/user\/logout(?:\.html)?/.test(html)
}

export async function getXifanAuthStatus(uid: number): Promise<XifanAuthStatus> {
  const session = xifanSessionFor(uid)
  if (!session.loggedIn) return { loggedIn: false }
  const response = await session.get(`${BASE_URL}/user/index.html`)
  const html = assertXifanResponse(response, '稀饭登录状态校验')
  if (isLoggedOutPage(html)) {
    session.clear()
    return { loggedIn: false }
  }
  if (!isLoggedInPage(html)) throw new Error('稀饭返回了无法确认登录状态的页面')
  return { loggedIn: true }
}

export async function loginXifan(
  uid: number,
  username: string,
  password: string,
  verify: string,
): Promise<XifanLoginResult> {
  const session = xifanSessionFor(uid)
  const body = new URLSearchParams({ user_name: username, user_pwd: password, verify }).toString()
  // 2026-08-15 实查登录页的 data-api；字段名与桌面端当前协议一致。
  const response = await session.post(`${BASE_URL}/user/login.html`, body, {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json, text/javascript, */*; q=0.01',
  })
  const text = assertXifanResponse(response, '稀饭登录')
  const result = parseAjaxResult(text)
  const apiSucceeded = Number(result.code) === 1
  const success = apiSucceeded && session.loggedIn
  return {
    success,
    message: success
      ? typeof result.msg === 'string' ? result.msg : '登录成功'
      : apiSucceeded
        ? '稀饭未返回有效登录会话，请刷新验证码重试'
        : typeof result.msg === 'string' ? result.msg : '登录失败',
  }
}

export async function logoutXifan(uid: number): Promise<XifanAuthStatus> {
  const session = xifanSessionFor(uid)
  try {
    await session.post(`${BASE_URL}/index.php/user/logout`, '', {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    })
  } catch {
    // 本地 cookie 清掉后，本服务已无法继续使用该上游会话；退出不被上游瞬时故障卡住。
  } finally {
    session.clear()
  }
  return { loggedIn: false }
}
