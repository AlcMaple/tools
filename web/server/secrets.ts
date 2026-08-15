export const IS_PRODUCTION = process.env.NODE_ENV === 'production'
export const DEV_AUTH_SECRET = 'dev-insecure-secret-change-me'

const configuredSecret = process.env.AUTH_SECRET?.trim() ?? ''
if (IS_PRODUCTION && configuredSecret.length < 32) {
  throw new Error('[auth] 生产必须设置至少 32 个字符的随机 AUTH_SECRET')
}

export const AUTH_SECRET = configuredSecret || DEV_AUTH_SECRET
