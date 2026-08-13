// 追番报告邮件 —— 与周历邮件不同,这里**完全不截图、不开隐藏窗口**:渲染层拼好 HTML 经 IPC
// 传过来,主进程只负责套上收发件人和主题、走 SMTP 发出去。
//
// 理由:报告是给「手机扫读」用的,HTML 比 PNG 友好得多(自适应字号、可复制可搜索、体积 KB 级)
// 同时省掉了截图链路里等渲染、等布局、等抓帧那一堆细节。

import { app } from 'electron'
import type { MailConfig } from './config'
import { buildTransporter, todayLabel } from './transport'

/**
 * 发一封追番报告邮件。`html` 是渲染层拼好的完整正文(含内联样式和页脚),主题固定带上日期。
 * 调用方需自行确保邮件功能已启用且配置完整。
 */
export async function sendAnimeReportMail(cfg: MailConfig, html: string): Promise<void> {
  if (!cfg.qqEmail || !cfg.authCode) {
    throw new Error('邮箱或授权码未配置')
  }
  const transporter = buildTransporter(cfg)
  const label = todayLabel()
  console.log(`[anime-report-mailer] 准备通过 smtp.qq.com 发送给 ${cfg.qqEmail}`)
  await transporter.sendMail({
    from: `MapleTools <${cfg.qqEmail}>`,
    to: cfg.qqEmail,
    subject: `我的追番 — ${label}`,
    html: html + `
      <p style="font:12px/1.6 -apple-system,sans-serif;color:#999;margin:24px 0 0;text-align:center;">
        来自 MapleTools v${app.getVersion()} · ${label}
      </p>
    `,
  })
  console.log('[anime-report-mailer] 邮件发送成功')
}
