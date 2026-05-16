// 邮件相关 IPC 通道。
//
// 渲染器读到的配置永远不带明文 authCode —— 通过 hasAuthCode 布尔位告诉 UI
// 「已存过一份」即可，UI 上授权码字段显示占位符。用户重新输入会再走 set-config
// 完整覆盖。这样即便 renderer DevTools 被打开，也看不到原始授权码。

import { ipcMain } from 'electron'
import { loadMailConfig, saveMailConfig, type MailConfig } from '../mail/config'
import { sendCalendarMail, sendTestMail } from '../mail/calendar-mailer'
import { sendAnimeReportMail } from '../mail/anime-report-mailer'

export interface MailConfigForUI {
  enabled: boolean
  qqEmail: string
  hasAuthCode: boolean
}

interface SetConfigInput {
  enabled: boolean
  qqEmail: string
  /** 空串表示「不改」，沿用磁盘上已加密的旧值；非空表示「改成这个新值」。 */
  authCode: string
}

export function registerMailIpc(): void {
  ipcMain.handle('mail:get-config', async (): Promise<MailConfigForUI> => {
    const cfg = await loadMailConfig()
    return {
      enabled: cfg.enabled,
      qqEmail: cfg.qqEmail,
      hasAuthCode: !!cfg.authCode,
    }
  })

  ipcMain.handle('mail:set-config', async (_e, input: SetConfigInput) => {
    const old = await loadMailConfig()
    const next: MailConfig = {
      enabled: !!input.enabled,
      qqEmail: (input.qqEmail || '').trim(),
      authCode: input.authCode ? input.authCode : old.authCode,
    }
    await saveMailConfig(next)
    return true
  })

  // 周历刷新触发自动发件 —— 渲染器只调用、不传配置；主进程自己读磁盘。
  // 返回 { sent: boolean, reason?: string }，reason 用于让 renderer 在 console
  // 留个排错线索（比如「未启用」「未配置」），不会弹给用户。
  ipcMain.handle('mail:send-calendar', async (): Promise<{ sent: boolean; reason?: string }> => {
    const cfg = await loadMailConfig()
    if (!cfg.enabled) return { sent: false, reason: 'disabled' }
    if (!cfg.qqEmail || !cfg.authCode) return { sent: false, reason: 'incomplete-config' }
    try {
      await sendCalendarMail(cfg)
      return { sent: true }
    } catch (err) {
      console.error('[mail:send-calendar] 发送失败', err)
      return { sent: false, reason: String(err instanceof Error ? err.message : err) }
    }
  })

  // MyAnime 「发送极简报告」按钮触发 —— renderer 已经拼好完整 HTML 正文,
  // 主进程只负责 SMTP。跟 send-calendar 一样返回 { sent, reason? },
  // 让 UI 根据结果决定 toast / 错误提示。
  ipcMain.handle('mail:send-anime-report', async (_e, html: string): Promise<{ sent: boolean; reason?: string }> => {
    const cfg = await loadMailConfig()
    if (!cfg.enabled) return { sent: false, reason: 'disabled' }
    if (!cfg.qqEmail || !cfg.authCode) return { sent: false, reason: 'incomplete-config' }
    if (typeof html !== 'string' || html.length === 0) return { sent: false, reason: 'empty-html' }
    try {
      await sendAnimeReportMail(cfg, html)
      return { sent: true }
    } catch (err) {
      console.error('[mail:send-anime-report] 发送失败', err)
      return { sent: false, reason: String(err instanceof Error ? err.message : err) }
    }
  })

  // 测试发送：跟 send-calendar 不同，这个**总是**抛错而不是吞掉
  // —— 用户点测试就是来看错信息的。
  ipcMain.handle('mail:test-send', async () => {
    const cfg = await loadMailConfig()
    if (!cfg.qqEmail || !cfg.authCode) throw new Error('请先填写邮箱和授权码')
    await sendTestMail(cfg)
    return true
  })
}
