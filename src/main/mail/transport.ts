// 邮件发送的公共底座 —— nodemailer transporter 工厂 + 共用的日期标签。
//
// 抽出来让 calendar-mailer / anime-report-mailer 共享同一份 SMTP 连接逻辑,
// 避免两份 createTransport 配置漂移（QQ smtp 端口 / secure 这种细节改一处
// 漏掉另一处会很难排查）。

import nodemailer from 'nodemailer'
import type { MailConfig } from './config'

export function buildTransporter(cfg: MailConfig): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    auth: { user: cfg.qqEmail, pass: cfg.authCode },
  })
}

/** YYYY-MM-DD 日期标签，用在邮件主题 / 文件名上。 */
export function todayLabel(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
