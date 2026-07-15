// Vercel serverless 适配层 —— 把同一个 Hono 应用挂成一个 catch-all 函数，
// Vercel 会把所有 /api/* 请求路由到这里。仅此文件是 Vercel 专属胶水，业务全在 server/。
import { handle } from 'hono/vercel'
import app from '../server/index'

export default handle(app)
