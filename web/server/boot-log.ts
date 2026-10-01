import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

const bootLog = new Hono()
bootLog.use('*', bodyLimit({ maxSize: 4096 }))
bootLog.post('/', async (c) => {
  const body: unknown = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || !('detail' in body) || typeof body.detail !== 'string') {
    return c.body(null, 400)
  }
  // JSON 转义换行，避免浏览器上报内容伪造额外的终端日志行。
  console.error('[boot:client] ' + JSON.stringify({
    detail: body.detail.slice(0, 2000),
    ua: c.req.header('user-agent')?.slice(0, 200),
  }))
  return c.body(null, 204)
})
export default bootLog
