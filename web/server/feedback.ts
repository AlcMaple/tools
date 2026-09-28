import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCookie, setCookie } from 'hono/cookie'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { db } from './db'
import { clientIp, getSession, rateLimited } from './auth'
import { sendFeedbackMail, emailDeliveryConfigured } from './email-delivery'
import { FEEDBACK_CATEGORIES, FEEDBACK_STATUSES, type FeedbackContext, type FeedbackDetail, type FeedbackSummary } from '../shared/feedback'

// 图片和正文同一事务落库，避免附件上传成功、反馈失败时产生无人管理的文件。
db.exec(`
CREATE TABLE IF NOT EXISTS feedback_threads (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 email TEXT NOT NULL DEFAULT '', context TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 user_seen INTEGER NOT NULL DEFAULT 0, admin_seen INTEGER NOT NULL DEFAULT 0, create_key TEXT NOT NULL,
 UNIQUE(owner,create_key)
);
CREATE TABLE IF NOT EXISTS feedback_messages (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES feedback_threads(id) ON DELETE CASCADE,
 author TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, request_key TEXT NOT NULL,
 UNIQUE(thread_id,author,request_key)
);
CREATE TABLE IF NOT EXISTS feedback_images (
 id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES feedback_messages(id) ON DELETE CASCADE,
 mime TEXT NOT NULL, bytes BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback_notifications (
 id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL REFERENCES feedback_threads(id) ON DELETE CASCADE,
 recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS feedback_owner_updated ON feedback_threads(owner,updated_at DESC);
`)
interface Thread { id: string; owner: string; category: keyof typeof FEEDBACK_CATEGORIES; status: keyof typeof FEEDBACK_STATUSES; email: string; context: string | null; created_at: number; updated_at: number; user_seen: number; admin_seen: number }
interface Message { id: string; author: 'user' | 'admin'; body: string; created_at: number }
const feedback = new Hono<{ Variables: { owner: string; admin: boolean } }>()
const emailPattern = /^[^\s@<>,;:"()\\]+@[^\s@<>,;:"()\\]+\.[a-zA-Z]{2,63}$/
const hash = (s: string): string => createHash('sha256').update(s).digest('hex')
const admins = (): Set<number> => new Set((process.env.FEEDBACK_ADMIN_USER_IDS ?? '').split(',').map(v => Number(v.trim())).filter(v => Number.isSafeInteger(v) && v > 0))
const notifyTo = (): string => { const s = process.env.FEEDBACK_NOTIFY_TO?.trim() ?? ''; return emailPattern.test(s) ? s : '' }
feedback.use('*', bodyLimit({ maxSize: 5 * 1024 * 1024, onError: c => c.json({ error: '图片总大小超出限制，请减少图片' }, 413) }))
feedback.use('*', async (c, next) => {
 c.header('Cache-Control', 'no-store')
 if (c.req.method === 'POST') {
  if (c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: '请求来源不合法' }, 403)
  if (!(c.req.header('content-type') ?? '').startsWith('application/json')) return c.json({ error: '请求格式不正确' }, 415)
 }
 const session = await getSession(c)
 let guest = getCookie(c, 'mt_feedback_guest')
 if (!guest || !/^[a-f0-9]{64}$/.test(guest)) {
  guest = randomBytes(32).toString('hex')
  setCookie(c, 'mt_feedback_guest', guest, { httpOnly: true, secure: process.env.NODE_ENV === 'production' || new URL(c.req.url).protocol === 'https:', sameSite: 'Strict', path: '/api/feedback', maxAge: 30 * 86400 })
 }
 c.set('owner', session ? `user:${session.uid}` : `guest:${hash(guest)}`)
 const configuredEmail=process.env.FEEDBACK_ADMIN_EMAIL?.trim().toLowerCase()
 const emailAdmin=session&&configuredEmail?db.prepare("SELECT 1 FROM users WHERE id=? AND lower(email)=? AND email_verified_at IS NOT NULL AND email_verified_at <> ''").get(session.uid,configuredEmail):undefined
 c.set('admin', !!session && (admins().has(session.uid)||!!emailAdmin))
 await next()
})
function thread(c: Context, id: string): Thread | undefined {
 const row = db.prepare('SELECT * FROM feedback_threads WHERE id=?').get(id) as Thread | undefined
 return row && (row.owner === c.get('owner') || c.get('admin')) ? row : undefined
}
function summary(row: Thread, admin: boolean): FeedbackSummary {
 const first = db.prepare('SELECT body FROM feedback_messages WHERE thread_id=? ORDER BY created_at,id LIMIT 1').get(row.id) as { body: string }
 const lastOther = db.prepare('SELECT MAX(created_at) AS at FROM feedback_messages WHERE thread_id=? AND author=?').get(row.id, admin ? 'user' : 'admin') as { at: number | null }
 return { id: row.id, category: row.category, status: row.status, preview: first.body.slice(0, 100), createdAt: row.created_at, updatedAt: row.updated_at, unread: (lastOther.at ?? 0) > (admin ? row.admin_seen : row.user_seen) }
}
class FeedbackInputError extends Error {}
function object(v: unknown): Record<string, unknown> { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {} }
function imageSize(bytes: Buffer, mime: string): [number, number] {
 if (mime === 'image/png' && bytes.length >= 24) return [bytes.readUInt32BE(16),bytes.readUInt32BE(20)]
 if (mime === 'image/webp' && bytes.length >= 30) {
  const kind=bytes.toString('ascii',12,16)
  if(kind==='VP8X')return [bytes.readUIntLE(24,3)+1,bytes.readUIntLE(27,3)+1]
  if(kind==='VP8 ')return [bytes.readUInt16LE(26)&16383,bytes.readUInt16LE(28)&16383]
  if(kind==='VP8L'&&bytes[20]===47){const bits=bytes.readUInt32LE(21);return [(bits&16383)+1,((bits>>>14)&16383)+1]}
 }
 if(mime==='image/jpeg'){
  let offset=2
  while(offset+9<bytes.length){
   if(bytes[offset]!==255)break
   const marker=bytes[offset+1],length=bytes.readUInt16BE(offset+2)
   if(length<2||offset+2+length>bytes.length)break
   if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker))return [bytes.readUInt16BE(offset+7),bytes.readUInt16BE(offset+5)]
   offset+=length+2
  }
 }
 throw new FeedbackInputError('图片数据不完整，请重新选择截图')
}
function input(raw: unknown): { requestId: string; body: string; images: { mime: string; bytes: Buffer }[] } {
 const v = object(raw)
 if (typeof v.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(v.requestId)) throw new FeedbackInputError('请刷新页面后重新提交')
 if (typeof v.body !== 'string' || !v.body.trim() || v.body.length > 3000) throw new FeedbackInputError('请填写 1–3000 字的内容')
 const images: { mime: string; bytes: Buffer }[] = []
 if (v.images !== undefined && !Array.isArray(v.images)) throw new FeedbackInputError('图片格式不正确')
 const rawImages = v.images as unknown[] | undefined ?? []
 if (rawImages.length > 3) throw new FeedbackInputError('最多添加 3 张截图')
 for (const raw of rawImages) {
  if (typeof raw !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(raw)) throw new FeedbackInputError('截图仅支持 PNG、JPEG、WebP')
  const bytes = Buffer.from(raw.slice(raw.indexOf(',') + 1), 'base64')
  if (bytes.length > 1024 * 1024 || bytes.length < 12) throw new FeedbackInputError('单张截图需小于 1 MB')
  const mime = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
   : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
   : bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' ? 'image/webp' : ''
  if (!mime || !raw.startsWith(`data:${mime};`)) throw new FeedbackInputError('图片内容与格式不符')
  const [width,height]=imageSize(bytes,mime)
  if(width<1||height<1||width>4096||height>4096||width*height>8_000_000)throw new FeedbackInputError('图片尺寸过大，请裁剪后上传')
  images.push({ mime, bytes })
 }
 return { requestId: v.requestId, body: v.body.trim(), images }
}
function diagnostic(raw: unknown): FeedbackContext | null {
 if (!raw) return null
 const v = object(raw)
 const page = typeof v.page === 'string' && /^\/(?:#[/\w-]*|api\/player\/page)?$/.test(v.page) ? v.page.slice(0,100) : '/'
 const safe = (key: string): string => typeof v[key] === 'string' ? v[key].replace(/[^a-zA-Z0-9_. -]/g,'').slice(0,60) : ''
 return { page, platform: safe('platform'), version: safe('version'), errorCode: safe('errorCode') }
}
function addMessage(id: string, author: 'user' | 'admin', data: ReturnType<typeof input>, at: number): void {
 const messageId = randomUUID()
 db.prepare('INSERT INTO feedback_messages VALUES(?,?,?,?,?,?)').run(messageId,id,author,data.body,at,data.requestId)
 for (const image of data.images) db.prepare('INSERT INTO feedback_images VALUES(?,?,?,?)').run(randomUUID(),messageId,image.mime,image.bytes)
}
function enqueue(id: string, to: string, body: string): number | null {
 if (!to) return null
 return Number(db.prepare('INSERT INTO feedback_notifications(thread_id,recipient,subject,body) VALUES(?,?,?,?)').run(id,to,'MapleTools 反馈通知',body).lastInsertRowid)
}
async function deliver(id: number | null): Promise<void> {
 if (id === null) return
 const changed = db.prepare("UPDATE feedback_notifications SET state='sending' WHERE id=? AND state IN ('pending','failed')").run(id)
 if (!changed.changes) return
 const row = db.prepare('SELECT recipient,subject,body FROM feedback_notifications WHERE id=?').get(id) as { recipient: string; subject: string; body: string }
 try {
  await sendFeedbackMail(row.recipient,row.subject,row.body)
  db.prepare("UPDATE feedback_notifications SET state='sent' WHERE id=?").run(id)
 } catch (error) {
  console.error('[feedback:mail] 通知发送失败，反馈已保存：',error)
  db.prepare("UPDATE feedback_notifications SET state='failed' WHERE id=?").run(id)
 }
}
feedback.get('/context', c => {
 const admin=c.get('admin')
 const unread=admin?db.prepare("SELECT COUNT(*) n FROM feedback_threads t WHERE EXISTS(SELECT 1 FROM feedback_messages m WHERE m.thread_id=t.id AND m.author='user' AND m.created_at>t.admin_seen)").get()
  :db.prepare("SELECT COUNT(*) n FROM feedback_threads t WHERE t.owner=? AND EXISTS(SELECT 1 FROM feedback_messages m WHERE m.thread_id=t.id AND m.author='admin' AND m.created_at>t.user_seen)").get(c.get('owner'))
 return c.json({ admin, unread:(unread as {n:number}).n, ...(admin ? { mailConfigured: !!notifyTo() && emailDeliveryConfigured() } : {}) })
})
feedback.get('/', c => {
 const admin = c.req.query('view') === 'admin'
 if (admin && !c.get('admin')) return c.json({ error: '需要反馈管理权限' },403)
 const offset=Number(c.req.query('offset')??0)
 if(!Number.isSafeInteger(offset)||offset<0||offset>100000)return c.json({error:'页码无效'},400)
 const rows = (admin ? db.prepare('SELECT * FROM feedback_threads ORDER BY updated_at DESC,id DESC LIMIT 31 OFFSET ?').all(offset)
  : db.prepare('SELECT * FROM feedback_threads WHERE owner=? ORDER BY updated_at DESC,id DESC LIMIT 31 OFFSET ?').all(c.get('owner'),offset)) as Thread[]
 return c.json({ items: rows.slice(0,30).map(row => summary(row,admin)), more:rows.length>30 })
})
feedback.post('/', async c => {
 try {
  const raw = object(await c.req.json().catch(()=>{throw new FeedbackInputError('请求格式不正确')})); const data = input(raw)
  if (!Object.hasOwn(FEEDBACK_CATEGORIES,String(raw.category))) throw new FeedbackInputError('请选择反馈类型')
  const email = typeof raw.email === 'string' ? raw.email.trim() : ''
  if (email && (email.length > 254 || !emailPattern.test(email))) throw new FeedbackInputError('请填写正确的邮箱')
  const old = db.prepare('SELECT id FROM feedback_threads WHERE owner=? AND create_key=?').get(c.get('owner'),data.requestId) as { id: string } | undefined
  if (old) return c.json({ id: old.id })
  if (rateLimited(`feedback:ip:${clientIp(c)}`,20,86400000) || rateLimited(`feedback:owner:${c.get('owner')}`,10,86400000)) return c.json({ error: '今天提交的反馈较多，请明天再试' },429)
  const id = randomUUID(); const now = Date.now()
  const notification = db.transaction(() => {
   db.prepare('INSERT INTO feedback_threads(id,owner,category,email,context,created_at,updated_at,create_key) VALUES(?,?,?,?,?,?,?,?)').run(id,c.get('owner'),String(raw.category),email,JSON.stringify(diagnostic(raw.context)),now,now,data.requestId)
   addMessage(id,'user',data,now)
   return enqueue(id,notifyTo(),`收到一条新反馈（${FEEDBACK_CATEGORIES[raw.category as keyof typeof FEEDBACK_CATEGORIES]}）。\n编号：${id}\n请在站内「反馈管理」查看。`)
  })()
  await deliver(notification)
  return c.json({ id },201)
 } catch (error) { console.error('[feedback:create]',error); return c.json({ error: error instanceof FeedbackInputError ? error.message : '反馈保存失败，请稍后重试' },error instanceof FeedbackInputError?400:500) }
})
feedback.get('/:id', c => {
 const row = thread(c,c.req.param('id')); if (!row) return c.json({ error: '反馈不存在或无访问权限' },404)
 const messages = db.prepare('SELECT id,author,body,created_at FROM feedback_messages WHERE thread_id=? ORDER BY created_at,id').all(row.id) as Message[]
 const result: FeedbackDetail = { ...summary(row,c.get('admin')), context: JSON.parse(row.context ?? 'null') as FeedbackContext | null,
  messages: messages.map(m => ({ id:m.id, author:m.author, body:m.body, createdAt:m.created_at, images:(db.prepare('SELECT id FROM feedback_images WHERE message_id=?').all(m.id) as {id:string}[]).map(i=>`/api/feedback/${row.id}/images/${i.id}`) })),
  ...(c.get('admin') ? {email:row.email,notifications:db.prepare('SELECT id,state FROM feedback_notifications WHERE thread_id=? ORDER BY id DESC LIMIT 10').all(row.id) as {id:number;state:string}[]} : {}) }
 return c.json(result)
})
feedback.post('/:id/seen', c => {
 const row = thread(c,c.req.param('id')); if (!row) return c.json({ error:'反馈不存在或无访问权限' },404)
 db.prepare(`UPDATE feedback_threads SET ${c.get('admin') ? 'admin_seen' : 'user_seen'}=? WHERE id=?`).run(Date.now(),row.id)
 return c.json({ok:true})
})
feedback.get('/:id/images/:imageId', c => {
 const row = thread(c,c.req.param('id')); if (!row) return c.json({error:'无访问权限'},404)
 const image = db.prepare('SELECT i.mime,i.bytes FROM feedback_images i JOIN feedback_messages m ON m.id=i.message_id WHERE m.thread_id=? AND i.id=?').get(row.id,c.req.param('imageId')) as {mime:string;bytes:Buffer}|undefined
 if (!image) return c.json({error:'图片不存在'},404)
 c.header('Content-Type',image.mime); c.header('X-Content-Type-Options','nosniff')
 c.header('Content-Security-Policy',"default-src 'none'; sandbox")
 return c.body(new Uint8Array(image.bytes))
})
feedback.post('/:id/replies', async c => {
 const row = thread(c,c.req.param('id')); if (!row) return c.json({error:'反馈不存在或无访问权限'},404)
 try {
  const raw = object(await c.req.json().catch(()=>{throw new FeedbackInputError('请求格式不正确')})); const data = input(raw); const author = raw.asAdmin === true && c.get('admin') ? 'admin' : 'user'
  if (author === 'user' && row.owner !== c.get('owner')) return c.json({error:'需要明确以管理员身份回复'},403)
  if (db.prepare('SELECT id FROM feedback_messages WHERE thread_id=? AND author=? AND request_key=?').get(row.id,author,data.requestId)) return c.json({ok:true})
  if (rateLimited(`feedback:reply:${c.get('owner')}`,30,3600000) || rateLimited(`feedback:reply-ip:${clientIp(c)}`,60,3600000)) return c.json({error:'回复较多，请稍后再试'},429)
  const at = Math.max(Date.now(),row.updated_at+1)
  const notification = db.transaction(() => {
   addMessage(row.id,author,data,at)
   db.prepare("UPDATE feedback_threads SET updated_at=?,status=CASE WHEN ?='user' THEN 'pending' ELSE status END WHERE id=?").run(at,author,row.id)
   const to = author === 'admin' ? row.email : notifyTo()
   if (author === 'admin' && to && rateLimited(`feedback:mail:${hash(to.toLowerCase())}`,5,86400000)) return null
   return enqueue(row.id,to,author === 'admin' ? `你的 MapleTools 反馈有了回复：\n\n${data.body}\n\n请回到提交反馈的账号或浏览器，在「我的反馈」中继续补充。` : `反馈 ${row.id} 有新补充，请在站内查看。`)
  })()
  await deliver(notification)
  return c.json({ok:true},201)
 } catch(error) {console.error('[feedback:reply]',error);return c.json({error:error instanceof FeedbackInputError?error.message:'回复保存失败，请稍后重试'},error instanceof FeedbackInputError?400:500)}
})
feedback.post('/:id/status', async c => {
 if (!c.get('admin')) return c.json({error:'需要反馈管理权限'},403)
 const row = thread(c,c.req.param('id')); if (!row) return c.json({error:'反馈不存在'},404)
 const raw = object(await c.req.json().catch(()=>{throw new FeedbackInputError('请求格式不正确')}).catch(()=>null))
 if (typeof raw.status !== 'string' || !Object.hasOwn(FEEDBACK_STATUSES,raw.status)) return c.json({error:'状态无效'},400)
 db.prepare('UPDATE feedback_threads SET status=?,updated_at=? WHERE id=?').run(raw.status,Date.now(),row.id)
 return c.json({ok:true})
})
feedback.post('/:id/notifications/:notificationId/retry', async c => {
 if (!c.get('admin')) return c.json({error:'需要反馈管理权限'},403)
 const id = Number(c.req.param('notificationId'))
 const row = db.prepare('SELECT id FROM feedback_notifications WHERE id=? AND thread_id=?').get(id,c.req.param('id'))
 if (!row) return c.json({error:'通知不存在'},404)
 if (rateLimited(`feedback:retry:${c.get('owner')}`,10,3600000)) return c.json({error:'重发较多，请稍后再试'},429)
 await deliver(id); return c.json({ok:true})
})
export default feedback
