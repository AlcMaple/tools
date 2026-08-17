// B 站 IPC 面 —— 登录态(扫码/短信/查/退出)、稿件分 P 列表、DASH 播放地址。
// 站点逻辑与签名全在 ../bili/api.ts,这里只做 handler 接线。
import { app, BrowserWindow, ipcMain } from 'electron'
import QRCode from 'qrcode'
import {
  biliSession, getDash, getVideoInfo, isLoggedIn, logout, search, tvAuthCode, tvPoll,
} from '../bili/api'
import { clearSmsLoginFlows, completeSmsLogin, requestSmsCode } from '../bili/sms-login'

export function registerBiliIpc(): void {
  // ready 后立刻预热分区(设 UA),赶在任何请求用到它之前
  void app.whenReady().then(() => { biliSession() })

  ipcMain.handle('bili:status', async () => ({ loggedIn: await isLoggedIn() }))

  ipcMain.handle('bili:qr-create', async () => {
    const { url, auth_code } = await tvAuthCode()
    // 白边(margin)直接烤进 PNG —— 深色主题下 UI 不用再垫白底,也就不会出现
    // 「反色导致手机扫不出来」。
    const qrDataUrl = await QRCode.toDataURL(url, { margin: 2, width: 256 })
    return { authCode: auth_code, qrDataUrl }
  })

  ipcMain.handle('bili:qr-poll', async (_e, authCode: string) => {
    const state = await tvPoll(authCode)
    return { state, loggedIn: state === 'ok' ? await isLoggedIn() : false }
  })

  ipcMain.handle('bili:sms-send', async (event, phone: unknown) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    return requestSmsCode(parent, phone)
  })

  ipcMain.handle('bili:sms-login', async (_event, flowId: unknown, code: unknown) =>
    completeSmsLogin(flowId, code))

  ipcMain.handle('bili:logout', async () => {
    clearSmsLoginFlows()
    await logout()
    return { loggedIn: await isLoggedIn() }
  })

  ipcMain.handle('bili:video-info', async (_e, bvid: string) => getVideoInfo(bvid))
  ipcMain.handle('bili:dash', async (_e, aid: number, cid: number) => getDash(aid, cid))
  // 关联番剧用:关键词搜视频,渲染层挑一条落地成 binding。
  ipcMain.handle('bili:search', async (_e, keyword: string, page?: number) => search(keyword, page))
}
