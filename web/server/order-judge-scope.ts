// 客户确认需求的公开接口：不要登录，token 就是凭证。挂在自己的前缀下，和 /api/order-judge 的登录中间件互不相干。
// 口径见 docs/ideas/022-客户确认需求与长期合作.md

import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { clientIp, rateLimited } from './auth'
import { judgeData, type ScopeTarget } from './order-judge-data'
import { judgeEvents } from './order-judge-events'
import { SCOPE_MAX_BODY, SCOPE_TOKEN_RE, normalizeSubmission, scopeView } from '../shared/order-judge-scope'

const ERRORS: Record<string, [404 | 410 | 413 | 400 | 429, string]> = {
  SCOPE_NOT_FOUND: [404, '这个链接不存在或已经收回，请向对方要新链接'],
  SCOPE_EXPIRED: [410, '这个链接已过期，请向对方要新链接'],
  SCOPE_APPLIED: [410, '这份需求已经确认完成，有变化请直接联系对方'],
  SCOPE_OUTDATED: [410, '需求清单已经更新，请向对方要新链接'],
  SCOPE_BAD_INPUT: [400, '至少要选一项或加一项'],
  SCOPE_TOO_LARGE: [413, '内容太长，删掉一些再提交'],
  RATE_LIMITED: [429, '操作太频繁了，一分钟后再试'],
}
const fail = (c: Context, code: string): Response => { const [status, error] = ERRORS[code]; return c.json({ code, error }, status) }

function liveTarget(token: string): { target: ScopeTarget } | { code: string } {
  const target = SCOPE_TOKEN_RE.test(token) ? judgeData.scopeByToken(token) : null
  if (!target) return { code: 'SCOPE_NOT_FOUND' }
  if (target.appliedAt) return { code: 'SCOPE_APPLIED' }
  if (Date.now() > target.link.expiresAt) return { code: 'SCOPE_EXPIRED' }
  if (target.latestVersionId !== target.link.versionId) return { code: 'SCOPE_OUTDATED' }
  return { target }
}

const briefOf = (t: ScopeTarget) => judgeData.project(t.uid, t.projectId)?.versions.find(v => v.id === t.link.versionId)?.brief ?? null

const api = new Hono()
api.onError((e, c) => {
  console.error('[order-judge-scope] 请求失败', e)
  return c.json({ code: 'UNEXPECTED', error: '服务异常，请稍后手动重试' }, 500)
})

// IP 挡猜 token，token 挡一个链接被人反复提交；两个都要
api.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('X-Robots-Tag', 'noindex')
  const write = c.req.method !== 'GET'
  const limited = rateLimited(`order-judge-scope:ip:${write ? 'w' : 'r'}:${clientIp(c)}`, write ? 20 : 60, 60_000)
    || (write && rateLimited(`order-judge-scope:token:${c.req.param('token') ?? c.req.path}`, 10, 60_000))
  if (limited) {
    c.header('Retry-After', '60')
    console.warn(`[order-judge-scope] 限流 ip=${clientIp(c)} ${c.req.method}`)
    return fail(c, 'RATE_LIMITED')
  }
  await next()
})

api.get('/:token', (c) => {
  const r = liveTarget(c.req.param('token'))
  if ('code' in r) return fail(c, r.code)
  const brief = briefOf(r.target)
  return brief ? c.json({ view: scopeView(brief, r.target.link) }) : fail(c, 'SCOPE_NOT_FOUND')
})

api.put('/:token', bodyLimit({ maxSize: SCOPE_MAX_BODY, onError: (c) => fail(c, 'SCOPE_TOO_LARGE') }), async (c) => {
  const token = c.req.param('token')
  const r = liveTarget(token)
  if ('code' in r) return fail(c, r.code)
  const brief = briefOf(r.target)
  if (!brief) return fail(c, 'SCOPE_NOT_FOUND')
  const submission = normalizeSubmission(await c.req.json().catch(() => null), brief)
  if (!submission) return fail(c, 'SCOPE_BAD_INPUT')
  const submittedAt = judgeData.submitScope(token, submission)
  judgeData.bump(r.target.uid); judgeEvents.changed(r.target.uid, judgeData.seq(r.target.uid))
  console.info(`[order-judge-scope] uid=${r.target.uid} 客户提交 ${submission.picked.length} 条 + 新增 ${submission.custom.length} 条`)
  return c.json({ view: scopeView(brief, { submission, submittedAt }) })
})

export default api
