import { Hono } from 'hono'
import { CURRENT_ANNOUNCEMENT_ID } from '../shared/announcement'
import { getSession } from './auth'
import { db } from './db'

const announcements = new Hono()

const dismissalStmt = db.prepare<[number, string]>(
  'SELECT 1 FROM announcement_dismissals WHERE user_id = ? AND announcement_id = ?',
)
const dismissStmt = db.prepare<[number, string, number]>(`
  INSERT INTO announcement_dismissals (user_id, announcement_id, dismissed_at)
  VALUES (?, ?, ?)
  ON CONFLICT(user_id, announcement_id) DO UPDATE SET dismissed_at = excluded.dismissed_at
`)

// 公告本身是公开文案；登录用户额外拿到自己是否已静音当前版本。这样首次打开首页时不需要
// 因为尚未登录而失败，且不会把任何用户标识暴露给浏览器。
announcements.get('/current', async (c) => {
  const session = await getSession(c)
  const muted = session
    ? !!dismissalStmt.get(session.uid, CURRENT_ANNOUNCEMENT_ID)
    : false
  return c.json({ id: CURRENT_ANNOUNCEMENT_ID, muted, authenticated: !!session })
})

// “近期不再出现”只静音当前公告版本；未来换新公告 id 后，用户仍会看到新的通知。
announcements.post('/current/dismiss', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '登录后才能为账号保存公告偏好' }, 401)
  dismissStmt.run(session.uid, CURRENT_ANNOUNCEMENT_ID, Date.now())
  return c.json({ ok: true, id: CURRENT_ANNOUNCEMENT_ID })
})

export default announcements
