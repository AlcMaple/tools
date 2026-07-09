// B 站登录态(011 在线观看)。播放页用 <webview partition="persist:bili"> 嵌
// 官方外链播放器 —— webview 里 B 站页面是顶层文档,cookie 是第一方,登录态
// 直接生效(iframe 会被第三方 cookie 分区拦住,所以不用 iframe)。
// 这里只管三件事:弹登录窗 / 查登录态 / 退出清分区。
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { DESKTOP_USER_AGENT } from '../shared/download-types'

export const BILI_PARTITION = 'persist:bili'

// session 只能在 app ready 后创建(registerAllIpc 在模块加载期就跑),所以
// 惰性初始化;首次拿到分区时顺手固定 UA —— 沿用 BGM 的教训:登录态和 UA
// 必须一致,登录窗、webview、后续请求都走这同一个分区同一个 UA。
let cachedSession: Electron.Session | null = null
function biliSession(): Electron.Session {
  if (!cachedSession) {
    cachedSession = session.fromPartition(BILI_PARTITION)
    cachedSession.setUserAgent(DESKTOP_USER_AGENT)
  }
  return cachedSession
}

// SESSDATA 是 B 站的关键登录态 cookie(等价 BGM 的 chii_auth)。
async function biliStatus(): Promise<{ loggedIn: boolean }> {
  const cookies = await biliSession().cookies.get({ name: 'SESSDATA' })
  return { loggedIn: cookies.some((c) => c.domain?.includes('bilibili.com') && c.value) }
}

let loginWin: BrowserWindow | null = null

function openBiliLogin(): Promise<{ loggedIn: boolean }> {
  // 已有登录窗时聚焦复用,不叠开第二个
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.focus()
    return biliStatus()
  }
  return new Promise((resolve) => {
    const part = biliSession()
    const win = new BrowserWindow({
      width: 1000,
      height: 720,
      title: '登录 B 站',
      autoHideMenuBar: true,
      backgroundColor: '#131313',
      webPreferences: { partition: BILI_PARTITION, sandbox: true },
    })
    loginWin = win

    // 检测到 SESSDATA 落地就自动关窗;真正的结论在 closed 里统一查一次,
    // 用户手动关窗(放弃登录)也走同一条路。
    const onCookieChanged = (
      _e: unknown,
      cookie: Electron.Cookie,
      _cause: unknown,
      removed: boolean,
    ): void => {
      if (removed || cookie.name !== 'SESSDATA' || !cookie.domain?.includes('bilibili.com')) return
      // 稍缓一拍,容纳同批 Set-Cookie 里的其余凭证(bili_jct 等)落完
      setTimeout(() => { if (!win.isDestroyed()) win.close() }, 800)
    }
    part.cookies.on('changed', onCookieChanged)

    win.on('closed', () => {
      part.cookies.removeListener('changed', onCookieChanged)
      loginWin = null
      void biliStatus().then(resolve)
    })
    void win.loadURL('https://passport.bilibili.com/login')
  })
}

export function registerBiliIpc(): void {
  // ready 后立刻预热分区(设 UA),赶在播放页 webview 首次使用它之前
  void app.whenReady().then(() => { biliSession() })

  ipcMain.handle('bili:status', async () => biliStatus())
  ipcMain.handle('bili:login', async () => openBiliLogin())
  ipcMain.handle('bili:logout', async () => {
    await biliSession().clearStorageData({ storages: ['cookies'] })
    return biliStatus()
  })
}
