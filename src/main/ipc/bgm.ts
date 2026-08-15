import { ipcMain, BrowserWindow } from 'electron'
import { searchBgm, type BgmSearchCat } from '../bgm/search'
import { searchBgmOffline } from '../bgm/offline-index'
import { getBgmDetail } from '../bgm/detail'
import { getBgmCalendar } from '../bgm/calendar'
import { cacheCover } from '../bgm/cover-cache'
import {
  getBgmAuthStatus,
  setBgmToken,
  openBgmLogin,
  clearBgmCookie,
  verifyBgmLogin,
  getBgmCredentials,
  setBgmCredentials,
} from '../bgm/credentials'

/** 把渲染层传来的 cat 收敛成合法类目(动画 2 / 书籍 1),非法或缺失回落到动画。 */
function coerceCat(raw: unknown): BgmSearchCat {
  if (raw === 1) return 1
  if (raw === 2) return 2
  return 2
}

export function registerBgmIpc(): void {
  // 默认搜索只查主进程已加载的离线快照；这条 IPC 绝不触发 BGM 请求。
  ipcMain.handle('bgm:search-offline', (_event, keyword: unknown, cat?: number) =>
    searchBgmOffline(typeof keyword === 'string' ? keyword : '', coerceCat(cat)),
  )

  // 在线搜索是独立、显式的通道，只由用户点「在线搜索」后调用。
  ipcMain.handle(
    'bgm:search',
    async (event, keyword: string, update?: boolean, cat?: number) => {
      // `update=true` 绕过缓存强制重新抓取(用户点刷新时)。
      // 进度走**单独的频道**广播而不是塞进 invoke 的返回值 —— 多页搜索会在十几秒里发好几次事件
      // 一个 resolve 只能给最终结果、送不了中间态。
      return searchBgm(
        keyword,
        update ?? false,
        (current, total) => {
          event.sender.send('bgm:search-progress', current, total)
        },
        coerceCat(cat),
      )
    },
  )
  ipcMain.handle('bgm:detail', async (_event, subjectId: number) => getBgmDetail(subjectId))
  // `update=true` 绕过 24h 缓存重新抓,对应周历页那个刷新按钮。
  ipcMain.handle('bgm:calendar', async (_event, update?: boolean) =>
    getBgmCalendar(update ?? false),
  )
  // 封面本地化:下到 userData 下并返回 archivist:// 路径;失败返回 null,渲染层回落到原 url。
  ipcMain.handle(
    'bgm:cache-cover',
    async (_event, key: string, url: string, maxWidth?: number) =>
      cacheCover(key, url, maxWidth),
  )

  // ── 鉴权(令牌 + 网页登录) ────────────────────────────────────────────────
  // 状态查询:只回 hasToken / loggedIn 等布尔,不回 token / cookie 明文。
  ipcMain.handle('bgm:auth-status', () => getBgmAuthStatus())
  // 设置令牌(粘贴即用);传空串 = 清除。设置后回最新状态供 UI 刷新。
  ipcMain.handle('bgm:set-token', (_event, token: string) => {
    setBgmToken(typeof token === 'string' ? token : '')
    return getBgmAuthStatus()
  })
  // 弹内嵌登录窗口,父窗口设为触发它的窗口。登录成功捕获 cookie 后 resolve。
  ipcMain.handle('bgm:login', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    return openBgmLogin(parent)
  })
  // 退出网页登录(清 cookie),令牌不动。
  ipcMain.handle('bgm:logout', () => {
    clearBgmCookie()
    return getBgmAuthStatus()
  })
  // 主动校验登录态是否过期(带 cookie 拉首页看 /logout)。失效会清 cookie。
  ipcMain.handle('bgm:verify-login', () => verifyBgmLogin())
  // 登录邮箱/密码:供内嵌登录窗自动填充。纯本地存储(不同步、不入库),所以
  // 明文回传给设置页做回显/小眼睛(和 WebDAV getConfig 回传应用密码同一处理)。
  ipcMain.handle('bgm:get-credentials', () => getBgmCredentials())
  ipcMain.handle('bgm:set-credentials', (_event, em: string, pw: string) => {
    setBgmCredentials(typeof em === 'string' ? em : '', typeof pw === 'string' ? pw : '')
    return getBgmCredentials()
  })
}
