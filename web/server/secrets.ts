export const DEV_AUTH_SECRET = 'dev-insecure-secret-change-me'
if (process.env.NODE_ENV === 'production' && !process.env.AUTH_SECRET) {
  throw new Error('生产环境必须设置 AUTH_SECRET')
}
export const AUTH_SECRET = process.env.AUTH_SECRET || DEV_AUTH_SECRET
