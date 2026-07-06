/**
 * BGM 鉴权信息(令牌 + 网页登录 cookie)的持久化与内嵌登录。
 *
 * 两套身份、两个用途,缺一不可:
 *   - **token**(个人访问令牌)：给 `api.bgm.tv` 用,作 `Authorization: Bearer`。
 *     管「详情 / 按别名搜索」走登录态(更宽松更稳)。用户在设置里粘贴。
 *   - **cookie**(bgm.tv 网页登录态)：给 `bgm.tv` HTML 抓取用,作 `Cookie` 头。
 *     管「主搜索」—— 匿名搜索被 BGM 故意拖慢到 ~16s,登录态则 ~0.6s 秒回。
 *     由「登录 BGM」按钮弹出的内嵌窗口在登录成功后自动捕获。
 *
 * 都存进 userData/bgm_auth.json。token 不回传明文给 renderer(只回 hasToken,
 * 对齐邮件授权码的处理);cookie 同理不外泄。
 */
import { BrowserWindow, session } from 'electron'
import { join } from 'path'
import { JsonStore } from '../shared/json-store'
import { netRequest } from '../shared/net-request'
import { DESKTOP_USER_AGENT } from '../shared/download-types'
import { logInfo, logError } from '../shared/logger'

interface BgmAuth {
  token?: string
  /** 形如 "chii_auth=...; chii_sid=..." 的整串,直接当 Cookie 头用 */
  cookie?: string
  cookieSavedAt?: number
  /** 登录用邮箱 —— 仅供内嵌登录窗自动填充,纯本地、不同步、不入库 */
  email?: string
  /** 登录用密码 —— 同上。明文存本地(和 WebDAV 应用密码、SMTP 授权码同一处理) */
  password?: string
}

const store = new JsonStore<BgmAuth>('bgm_auth.json', (raw) =>
  raw && typeof raw === 'object' ? (raw as BgmAuth) : {},
)

let token = (store.current().token ?? '').trim()
let cookie = (store.current().cookie ?? '').trim()
let email = store.current().email ?? ''
let password = store.current().password ?? ''

export function getBgmToken(): string {
  // 令牌只走「设置里填、存本地 bgm_auth.json」这一条路(getBgmCredentials 同款)。
  return token
}

export function setBgmToken(next: string): void {
  token = (next ?? '').trim()
  store.update((s) => { s.token = token })
}

/** 当前网页登录 cookie 串(没登录则空串)。HTML 抓取用它当 Cookie 头。 */
export function getBgmCookie(): string {
  return cookie
}

function setBgmCookie(next: string): void {
  cookie = (next ?? '').trim()
  store.update((s) => {
    s.cookie = cookie
    s.cookieSavedAt = cookie ? Date.now() : undefined
  })
}

export function clearBgmCookie(): void {
  setBgmCookie('')
  // 分区一起清:登录窗分区里残留的旧 chii_auth 若已被服务端作废,存在本身就有害——
  // captureIfLoggedIn 只看「cookie 存在」,残留会让下次点「登录」秒判成功、把死
  // cookie 原样存回来(实测复现的「启动掉登录→点登录假成功」死循环就是它)。
  void clearLoginPartitionCookies()
}

/** 清掉登录窗分区(persist:bgm-login)里的全部 bgm.tv cookie,让下次登录真的走一遍登录页。 */
async function clearLoginPartitionCookies(): Promise<void> {
  try {
    const part = session.fromPartition('persist:bgm-login')
    const cookies = await part.cookies.get({ domain: 'bgm.tv' })
    await Promise.all(
      cookies.map((c) =>
        part.cookies.remove(
          `https://${(c.domain ?? 'bgm.tv').replace(/^\./, '')}${c.path ?? '/'}`,
          c.name,
        ),
      ),
    )
  } catch (err) {
    logError('bgm-auth', err)
  }
}

export interface BgmCredentials {
  email: string
  password: string
}

/** 读已保存的登录邮箱/密码(供设置回显 + 登录窗自动填充)。纯本地,明文无妨。 */
export function getBgmCredentials(): BgmCredentials {
  return { email, password }
}

export function setBgmCredentials(nextEmail: string, nextPassword: string): void {
  email = nextEmail ?? ''
  password = nextPassword ?? ''
  store.update((s) => {
    s.email = email || undefined
    s.password = password || undefined
  })
}

export interface BgmAuthStatus {
  /** 设置里已配置令牌(存在本地 bgm_auth.json) */
  hasToken: boolean
  /** 已捕获网页登录 cookie */
  loggedIn: boolean
  /** 上次登录(捕获 cookie)的时间戳 */
  cookieSavedAt?: number
}

export function getBgmAuthStatus(): BgmAuthStatus {
  return {
    hasToken: getBgmToken().length > 0,
    loggedIn: cookie.length > 0,
    cookieSavedAt: store.current().cookieSavedAt,
  }
}

/**
 * 主动校验网页登录是否仍有效 —— 怎么判断「过期」靠这个,不靠猜 cookie 寿命。
 * 带 cookie 拉一次 bgm.tv 首页,看 HTML 里有没有登录态标志 `/logout`
 * (实测:登录页有、匿名/过期页没有)。失效就清掉 cookie,让状态如实回落成
 * 「未登录」,UI 据此提示重新登录。网络失败不动 cookie(可能只是网络抖,别误清)。
 */
export async function verifyBgmLogin(): Promise<BgmAuthStatus> {
  if (!cookie) return getBgmAuthStatus()
  try {
    const res = await netRequest('https://bgm.tv/', {
      headers: {
        'User-Agent': DESKTOP_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Cookie: cookie,
      },
      timeoutMs: 12000,
    })
    if (res.status !== 200) {
      // 非 200(限流/502/CF 拦截)的错误页同样没有 /logout,不能当「过期」证据——
      // 否则 BGM 偶发故障会把还有效的登录态误清掉。保持原状态,下次再查。
      logInfo('bgm-auth', `verify 探测无效(HTTP ${res.status}),保持原登录状态`)
      return getBgmAuthStatus()
    }
    const html = res.body.toString('utf-8')
    if (!html.includes('/logout')) {
      // 200 且无「退出」入口 = 服务端确实不认这份 cookie(实测失效时返回的首页
      // 和匿名访客逐字节一致)。本地 + 登录窗分区一起清,见 clearBgmCookie 注释。
      logInfo('bgm-auth', 'verify 判定登录已失效(200 页无 /logout),清除本地与分区 cookie')
      clearBgmCookie()
    } else {
      logInfo('bgm-auth', 'verify 确认登录有效')
    }
  } catch {
    /* 网络失败:保持原状态,不误判为过期 */
  }
  return getBgmAuthStatus()
}

// ── 内嵌登录窗口 ────────────────────────────────────────────────────────────

let loginWin: BrowserWindow | null = null

// 登录页首字节常要等好几秒,先放这个内联加载页占位(秒显),避免久等黑屏像没反应。
// 深色底对齐 app 主题;真页面提交后会自动盖掉它。
const LOGIN_SPLASH =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:#0f0f0f;color:#9aa0a6;font:14px system-ui,'Segoe UI',sans-serif">
<div style="width:34px;height:34px;border:3px solid #2a2a2a;border-top-color:#ec6a8c;border-radius:50%;animation:s .8s linear infinite"></div>
<div>正在打开 Bangumi 登录页…</div>
<style>@keyframes s{to{transform:rotate(360deg)}}</style></body>`,
  )

/**
 * 弹一个内嵌的 BGM 登录窗口(就是真的 bgm.tv 登录页,验证码/二步验证都由用户
 * 自己完成)。检测到登录成功(出现 chii_auth cookie)即捕获全部 bgm.tv cookie
 * 存好、自动关窗。窗口已开则聚焦,避免重复弹(「防止一直刷重复登录」)。
 */
export async function openBgmLogin(parent?: BrowserWindow): Promise<BgmAuthStatus> {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.focus()
    return getBgmAuthStatus()
  }

  return new Promise<BgmAuthStatus>((resolve) => {
    // 独立持久化 session 分区:不沾 app 默认 session 的自定义协议(archivist)/
    // 残留 cookie —— 行为像一个全新浏览器。cookie 也在此分区,登录态可持久,
    // 下次少重登。注:BGM 验证码是「密码框聚焦才显示」的(实测),且
    // 验证码图**点一下即换一张**(BGM 原生支持)。偶发「裂图」是换图请求被该 IP
    // 限流/源站 502 所致,缓一会再点即可 —— 不做整页重载(那样重且会丢已填内容)。
    const part = session.fromPartition('persist:bgm-login')
    // 关键:BGM 把登录会话**绑定在登录那一刻的 User-Agent 上**(实测矩阵:同
    // jar 同 IP,仅换 UA 即被当匿名)。登录窗必须用和 verify / 带登录 cookie 的
    // 搜索完全相同的 UA,否则领到的令牌只在窗口里有效,拿出来全是匿名——
    // 这就是「登录提速从上线起从未生效 + 启动即掉登录」的总根因。
    part.setUserAgent(DESKTOP_USER_AGENT)
    const win = new BrowserWindow({
      width: 480,
      height: 720,
      parent,
      // 静态标题 + 下面 page-title-updated 拦截,避免 splash 期短暂显示后被页面标题
      // (登录至 Bangumi / 502)覆盖、来回闪。换图提示放在验证码旁的按钮上,不进标题。
      title: '登录 Bangumi（登录成功后自动关闭）',
      icon: join(__dirname, '../../resources/icon.png'), // 用应用图标,不要原生 Electron 图标
      backgroundColor: '#0f0f0f', // 深色底,消除加载时的白屏(以前白屏久得像没反应)
      autoHideMenuBar: true,
      webPreferences: { partition: 'persist:bgm-login', nodeIntegration: false, contextIsolation: true },
    })
    loginWin = win
    // 不让页面 <title> 覆盖窗口标题 —— 保持稳定的「登录 Bangumi」。
    win.on('page-title-updated', (e) => e.preventDefault())
    let settled = false
    let finalizeScheduled = false

    // 真正取 cookie 入库并关窗 —— 只能在登录后的落地页**加载完成**后调用。
    const capture = async (): Promise<void> => {
      if (settled || win.isDestroyed()) return
      const cookies = await part.cookies.get({ domain: 'bgm.tv' })
      const hasAuth = cookies.some((c) => c.name === 'chii_auth' && c.value)
      if (!hasAuth) return
      settled = true
      const str = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
      setBgmCookie(str)
      logInfo('bgm-auth', `登录窗捕获登录 cookie(${cookies.length} 条),已存储`)
      if (!win.isDestroyed()) win.close()
    }

    // 看到 chii_auth ≠ 可以立刻收工。实测(2026-07-04):「即见即存即关窗」拿到的
    // 令牌服务端**不认**——关窗掐断了登录后的落地页导航,令牌没完成服务端的
    // 激活/轮换,存下来的是半成品(同值重放,原生 jar / 手工头 / 同 IP 全是匿名)。
    // 必须等落地页 did-finish-load 再缓 800ms(容纳尾部 Set-Cookie/二跳),取
    // **最终** cookie,让窗口像真实浏览器一样走完整个登录流程。10s 兜底防悬死。
    const scheduleFinalize = (): void => {
      if (finalizeScheduled || settled || win.isDestroyed()) return
      finalizeScheduled = true
      if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', () => {
          setTimeout(() => { void capture() }, 800)
        })
        setTimeout(() => { void capture() }, 10000)
      } else {
        setTimeout(() => { void capture() }, 800)
      }
    }

    const onCookieChanged = (
      _e: unknown,
      c: Electron.Cookie,
      _cause: unknown,
      removed: boolean,
    ): void => {
      if (!removed && (c.domain ?? '').includes('bgm.tv') && c.name === 'chii_auth') {
        scheduleFinalize()
      }
    }
    part.cookies.on('changed', onCookieChanged)
    // 导航完成(登录提交后会跳走)时也兜一次检测,防止 cookie 事件漏接
    win.webContents.on('did-navigate', () => {
      void part.cookies.get({ domain: 'bgm.tv' }).then((cs) => {
        if (cs.some((c) => c.name === 'chii_auth' && c.value)) scheduleFinalize()
      })
    })

    // dom-ready(比 did-finish-load 早,自动填充更快)时注入脚本,做三件事,**每件只做一遍**:
    //   ① 填邮箱/密码,并在自动填了密码后「轻轻聚焦密码框一次」触发 BGM 显示验证码
    //      ——只焦一次、且仅当用户还没点进任何输入框时才焦,绝不抢用户正在编辑的框;
    //      验证码到底出不出来取决于 BGM(限流/502 时手动聚焦也不出,不是这里能救的)。
    //   ② 验证码图 <p id="captcha_img"> 旁注入「看不清，换一张」按钮(点击=BGM 原生换图)。
    //   ③ 给登录表单挂 submit → 全屏「正在登录…」遮罩,免得点完登录像卡住。
    // 用很短的轮询只是兜「表单在 dom-ready 时还没就绪」,做完即停;不反复抢焦点。
    // 只在 bgm.tv 页面跑(跳过 splash 的 data: 页)。
    win.webContents.on('dom-ready', () => {
      if (!win.webContents.getURL().includes('bgm.tv')) return
      const code = `(() => {
        if (window.__mtBgmInit) return
        window.__mtBgmInit = true
        const E = ${JSON.stringify(email)}, P = ${JSON.stringify(password)}
        let filled = false, btnDone = false, overlayDone = false, tries = 0
        const injectBtn = () => {
          const box = document.getElementById('captcha_img')
          if (box && !document.getElementById('mt-captcha-refresh')) {
            const btn = document.createElement('button')
            btn.id = 'mt-captcha-refresh'
            btn.type = 'button'
            btn.textContent = '看不清，换一张'
            btn.title = '点这里(或直接点验证码图)换一张验证码'
            btn.style.cssText = 'display:block;margin:6px 0 0;padding:0;font-size:12px;color:#0084b4;background:transparent;border:none;cursor:pointer;text-decoration:underline'
            btn.addEventListener('click', () => { const im = box.querySelector('img') || box; if (im) im.click() })
            box.insertAdjacentElement('afterend', btn)
          }
          if (document.getElementById('mt-captcha-refresh')) btnDone = true
        }
        const bindOverlay = () => {
          const form = document.getElementById('loginForm')
          if (form && !form.__mtBound) {
            form.__mtBound = true
            form.addEventListener('submit', () => {
              if (document.getElementById('mt-login-overlay')) return
              const o = document.createElement('div')
              o.id = 'mt-login-overlay'
              o.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:rgba(15,15,15,.8);color:#eee;font:14px system-ui,sans-serif'
              o.innerHTML = '<div style="width:34px;height:34px;border:3px solid #444;border-top-color:#ec6a8c;border-radius:50%;animation:mtspin .8s linear infinite"></div><div>正在登录，请稍候…</div><style>@keyframes mtspin{to{transform:rotate(360deg)}}</style>'
              document.body.appendChild(o)
            })
            overlayDone = true
          }
        }
        const tick = () => {
          tries++
          const em = document.getElementById('email')
          const pw = document.getElementById('password')
          if (em && pw && !filled) {
            if (E) { em.value = E; em.dispatchEvent(new Event('input', { bubbles: true })) }
            if (P) { pw.value = P; pw.dispatchEvent(new Event('input', { bubbles: true })) }
            filled = true
            // 只聚焦一次,且仅当用户没在别的输入框里 —— 触发 BGM 显示验证码,但绝不抢焦点
            if (P) {
              const ae = document.activeElement
              if (!ae || ae === document.body || ae === pw) pw.focus()
            }
          }
          injectBtn()
          bindOverlay()
          if ((filled && btnDone && overlayDone) || tries > 10) clearInterval(timer)
        }
        const timer = setInterval(tick, 300)
        tick()
      })()`
      win.webContents.executeJavaScript(code).catch(() => { /* 页面无表单/被拦,忽略 */ })
    })

    win.on('closed', () => {
      part.cookies.removeListener('changed', onCookieChanged)
      loginWin = null
      if (settled) {
        // 捕获成功后立刻实测一次令牌在窗口外能否复用,日志立辨真伪。若服务端
        // 仍不认(200 匿名页),verify 会如实清掉,UI 不会再显示假登录态。
        void verifyBgmLogin().then(resolve)
      } else {
        resolve(getBgmAuthStatus())
      }
    })

    // 先秒显加载页:bgm.tv 首字节常要等好几秒,期间 Chromium 会一直把当前文档
    // (这个 spinner)留在画面上,直到真页面提交才替换 —— 黑屏久等变成「转圈+提示」。
    void win.loadURL(LOGIN_SPLASH).then(async () => {
      // 本地状态是「未登录」却打开了登录窗,说明分区里残留的 chii_auth 多半已被
      // 服务端作废(verify 判失效才会走到这一步)。必须先清干净再进登录页,否则
      // captureIfLoggedIn 一看到残留 cookie 就秒判成功、把死 cookie 存回来,登录
      // 形同虚设。清掉后用户真登一次,拿到的才是服务端新发的凭证。
      if (!cookie) await clearLoginPartitionCookies()
      if (!win.isDestroyed()) void win.loadURL('https://bgm.tv/login')
    })
  })
}
