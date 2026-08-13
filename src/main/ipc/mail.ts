// 邮件相关的 IPC。
//
// 渲染层读到的配置**永远不带明文授权码** —— 只给一个「已存过」的布尔位,UI 上显示占位符;
// 用户重新输入会走完整覆盖。这样即便渲染层的 DevTools 被打开,也看不到原始授权码。

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
  /** 空串表示「不改」,沿用磁盘上已加密的旧值;非空表示改成这个新值。 */
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

  // 周历刷新触发的自动发件 —— 渲染层只负责调用,配置由主进程自己读盘。
  // reason 只是给渲染层留个排错线索(「未启用」「未配置」),不弹给用户。
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

  // 「发送追番报告」按钮触发 —— 渲染层已经拼好完整 HTML,主进程只负责 SMTP。
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

  // 测试发送:与自动发件不同,这个**总是**抛错而不是吞掉
  ipcMain.handle('mail:test-send', async () => {
    const cfg = await loadMailConfig()
    if (!cfg.qqEmail || !cfg.authCode) throw new Error('请先填写邮箱和授权码')
    await sendTestMail(cfg)
    return true
  })
}
