// 邮箱验证码投递。网页版只接 SMTP，不把第三方邮件云 SDK 的密钥或账号再引入一层。
// 开发环境默认把验证码打到服务端控制台，方便本地走完整流程；生产必须显式配置 SMTP。
import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'

const IS_PRODUCTION = process.env.NODE_ENV === 'production'
const MODE = (process.env.EMAIL_MODE?.trim().toLowerCase() || (IS_PRODUCTION ? 'smtp' : 'console'))
const SMTP_HOST = process.env.SMTP_HOST?.trim() || ''
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587
const SMTP_SECURE = process.env.SMTP_SECURE === 'true' || SMTP_PORT === 465
const SMTP_USER = process.env.SMTP_USER?.trim() || ''
const SMTP_PASS = process.env.SMTP_PASS || ''
const SMTP_FROM = process.env.SMTP_FROM?.trim() || SMTP_USER
// 显示名让收件箱列表里显示「MapleTools」而不是裸地址；行业里的 noreply@ 是发信域名所有者
// 自己配的地址，个人邮箱冒充 noreply 会被 SPF/DKIM 判为伪造进垃圾箱，所以这里只加显示名。
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME?.trim() || 'MapleTools'

let transporter: Transporter | null = null

function smtpReady(): boolean {
  return !!SMTP_HOST && !!SMTP_FROM
}

function getTransporter(): Transporter {
  if (!smtpReady()) throw new Error('邮箱服务尚未配置')
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    })
  }
  return transporter
}

/** 邮箱是可选增强，没配 SMTP 时不影响原有用户名 / 密码注册登录。 */
export function emailDeliveryConfigured(): boolean {
  return (MODE === 'console' && !IS_PRODUCTION) || (MODE === 'smtp' && smtpReady())
}

export async function sendEmailCode(email: string, code: string): Promise<void> {
  if (MODE === 'console' && !IS_PRODUCTION) {
    // 只在开发控制台显示完整验证码，生产配置错误不能退化成把凭证写进日志。
    console.info(`[auth-email] ${email} 的验证码是 ${code}（仅开发模式）`)
    return
  }

  await getTransporter().sendMail({
    from: `"${SMTP_FROM_NAME.replace(/["\\]/g, '')}" <${SMTP_FROM}>`,
    to: email,
    subject: 'MapleTools 邮箱验证码',
    text: `你的 MapleTools 邮箱验证码是：${code}\n\n验证码 10 分钟内有效，且只能使用一次。如果不是你本人操作，请忽略此邮件。`,
    html: `<p>你的 MapleTools 邮箱验证码是：</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>验证码 10 分钟内有效，且只能使用一次。如果不是你本人操作，请忽略此邮件。</p>`,
  })
}

export async function sendSlowPlaybackReady(email: string, link: string, expiresAt: number): Promise<void> {
  const expires = new Intl.DateTimeFormat('zh-CN', {
    timeZone: process.env.REWARD_TIME_ZONE || 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(expiresAt))
  const safeLink = link.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  if (MODE === 'console' && !IS_PRODUCTION) {
    console.info(`[slow-playback-email] ${email} 的慢源名额已保留到 ${expires}：${link}`)
    return
  }
  await getTransporter().sendMail({
    from: `"${SMTP_FROM_NAME.replace(/["\\]/g, '')}" <${SMTP_FROM}>`,
    to: email,
    subject: 'MapleTools 慢源名额已经轮到你了',
    text: `你的慢源观看名额已经空出来，并为你保留到 ${expires}。\n\n请在五分钟内打开：${link}\n\n链接不会自动登录，需使用排队时的 MapleTools 账号。`,
    html: `<p>你的慢源观看名额已经空出来，并为你保留到 <b>${expires}</b>。</p><p><a href="${safeLink}">五分钟内返回观看</a></p><p>链接不会自动登录，需使用排队时的 MapleTools 账号。</p>`,
  })
}
