import { ipcMain, BrowserWindow } from 'electron'
import { searchBgm, type BgmSearchCat } from '../bgm/search'
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

/**
 * 把 renderer 传来的 cat 值收敛到 `BgmSearchCat`（动画 2 / 书籍 1）。
 * 非法值或者缺失 → 默认 2（动画），保留与旧 IPC 调用方的兼容性。
 */
function coerceCat(raw: unknown): BgmSearchCat {
  if (raw === 1) return 1
  if (raw === 2) return 2
  return 2
}

export function registerBgmIpc(): void {
  ipcMain.handle(
    'bgm:search',
    async (event, keyword: string, update?: boolean, cat?: number) => {
      // `update=true` forces a fresh fetch through the rate-limiter, bypassing
      // any cached HTML. Renderer triggers this when the user clicks the
      // refresh affordance.
      //
      // `cat` 是 BGM 类目数字：2=动画（默认）/ 1=书籍（漫画+小说混合，由
      // detail 的 platform 字段细分到 manga / novel）。其他类目（音乐/游戏
      // /三次元）未启用，coerceCat 会回退到 2。
      //
      // Progress is broadcast back on a separate channel rather than as part of
      // the invoke response — multi-page searches can fire ~5 events over ~10s,
      // and a single resolved Promise can't deliver intermediates.
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
  // `update=true` bypasses the 24h cache and refetches. Renderer wires this
  // up to a small refresh button on the calendar page.
  ipcMain.handle('bgm:calendar', async (_event, update?: boolean) =>
    getBgmCalendar(update ?? false),
  )
  // 封面本地化：下载 url 到 userData/covers/{key}，返回 archivist:// 路径。
  // 失败返回 null，renderer fallback 到原 url。详见 bgm/cover-cache.ts。
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
