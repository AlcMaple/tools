import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 本地开发的密钥入口 —— 读 `web/.env.local`（被 .gitignore 忽略）填进 process.env。
// 生产（Vercel / VPS）由运维直接给环境变量，不会走到这里（文件不存在即跳过）。
// 只补「尚未设置」的键，绝不覆盖真实环境变量。
for (const name of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(join(process.cwd(), name), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
      if (!m || process.env[m[1]] !== undefined) continue
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    /* 文件不存在：正常 */
  }
}

export const IS_PRODUCTION = process.env.NODE_ENV === 'production'
export const DEV_AUTH_SECRET = 'dev-insecure-secret-change-me'

const configuredSecret = process.env.AUTH_SECRET?.trim() ?? ''
if (IS_PRODUCTION && configuredSecret.length < 32) {
  throw new Error('[auth] 生产必须设置至少 32 个字符的随机 AUTH_SECRET')
}

export const AUTH_SECRET = configuredSecret || DEV_AUTH_SECRET

// 服务器 AI（推荐与点评助手）—— DeepSeek，OpenAI 兼容格式。key 只从环境变量读，绝不入库 / 入 git。
// 未配置 AI_API_KEY 时 server/ai.ts 走 fake 流程，助手仍可用（手写 / 保存 / 发布不依赖 AI）。
export const AI_API_KEY = process.env.AI_API_KEY?.trim() ?? ''
export const AI_BASE_URL = process.env.AI_BASE_URL?.trim() || 'https://api.deepseek.com'
export const AI_MODEL = process.env.AI_MODEL?.trim() || 'deepseek-v4-flash-vision-exp'

// Google OIDC 登录凭据 —— 二者都配置才启用入口；缺任一即视为未接入，前端也不显示按钮。
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim() ?? ''
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? ''
