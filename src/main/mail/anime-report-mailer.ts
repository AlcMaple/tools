// 追番极简报告邮件 —— 跟 calendar-mailer 不同，这里完全不截图、不开隐藏
// 窗口；renderer 拼好 HTML 直接通过 IPC 传过来，主进程只负责套上 from/to/
// subject 把 SMTP 发出去。
//
// 这么设计的理由：报告是为"手机扫读"服务的，文字 / HTML 比 PNG 更友好
// （手机邮件 app 自适应字号、可复制可搜索、邮件体积 KB 级）。同时省掉了
// 截图链路所有的等渲染就绪 / 等 layout / 等 capture 细节。

import { app } from 'electron'
import type { MailConfig } from './config'
import { buildTransporter, todayLabel } from './transport'

/**
 * 发送一封追番极简报告邮件。
 * - html: renderer 拼好的完整邮件正文（已含内联样式 + footer）
 * - 主题固定为「我的追番 — YYYY-MM-DD」
 *
 * 调用方应自行确保 cfg.enabled === true 且 qqEmail/authCode 都已填。
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
