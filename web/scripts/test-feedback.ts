import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'maple-feedback-test-'))
process.env.AUTH_SECRET='feedback-fixture-secret-only'
process.env.EMAIL_MODE='smtp'
process.env.SMTP_HOST='127.0.0.1';process.env.SMTP_PORT='1';process.env.SMTP_FROM='fixture@example.test'
process.env.FEEDBACK_NOTIFY_TO='developer@example.test'
process.env.FEEDBACK_ADMIN_USER_IDS='';process.env.FEEDBACK_ADMIN_EMAIL=''
const {Hono}=await import('hono')
const {db}=await import('../server/db')
const {issueSession}=await import('../server/auth')
const {sameOriginGuard}=await import('../server/security')
const {default:feedback}=await import('../server/feedback')
const app=new Hono()
app.use('/api/*',sameOriginGuard())
app.get('/fixture-login/:uid',async c=>{const uid=Number(c.req.param('uid'));await issueSession(c,{uid,username:`user${uid}`,tv:0});return c.json({ok:true})})
app.route('/api/feedback',feedback)
const user=(name:string):number=>Number(db.prepare('INSERT INTO users(username,pass_hash,created_at) VALUES(?,?,?)').run(name,'unused',new Date().toISOString()).lastInsertRowid)
const alice=user('alice'),bob=user('bob'),admin=user('admin')
async function login(uid:number):Promise<string>{return (await app.request(`http://localhost/fixture-login/${uid}`)).headers.get('set-cookie')!.split(';')[0]}
const a=await login(alice),b=await login(bob),staff=await login(admin)
const req=(path:string,cookie='',body?:unknown)=>app.request(`http://localhost/api/feedback${path==='/'?'':path.startsWith('/?')?path.slice(1):path}`,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:'http://localhost','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
let checks=0
function ok(value:unknown):void{assert(value);checks++}
const initial=await req('/context');const guest=initial.headers.get('set-cookie')!.split(';')[0]
ok((await (await req('/context',staff)).json()).admin===false)
ok((await req('/?view=admin',staff)).status===403)
process.env.FEEDBACK_ADMIN_EMAIL='maintainer@example.test'
db.prepare('UPDATE users SET email=? WHERE id=?').run('maintainer@example.test',bob)
ok((await (await req('/context',b)).json()).admin===false)
db.prepare('UPDATE users SET email_verified_at=? WHERE id=?').run(new Date().toISOString(),bob)
ok((await (await req('/context',b)).json()).admin===true)
process.env.FEEDBACK_ADMIN_EMAIL=''
process.env.FEEDBACK_ADMIN_USER_IDS=String(admin)
ok((await (await req('/context',staff)).json()).admin===true)
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7S8AAAAASUVORK5CYII='
const key=randomUUID();const submission={requestId:key,category:'problem',body:'搜索报错 <script>alert(1)</script>',email:'reply@example.test',images:[image],context:{page:'/#/tracks?token=secret',errorCode:'SEARCH_ERROR',platform:'macOS',version:'test',cookie:'secret',conversation:'private'}}
const created=await req('/',a,submission);ok(created.status===201)
const {id}=await created.json() as {id:string}
ok((await req('/',a,submission)).status===200)
ok((db.prepare('SELECT COUNT(*) n FROM feedback_threads').get() as {n:number}).n===1)
ok((db.prepare('SELECT state FROM feedback_notifications').get() as {state:string}).state==='failed')
const own=await (await req(`/${id}`,a)).json()
ok(own.messages.length===1);ok(own.context.page==='/');ok(!JSON.stringify(own.context).includes('secret'));ok(!('email' in own));ok(!('notifications' in own))
ok((await req(`/${id}`,b)).status===404)
ok((await req(`/${id}`,guest)).status===404)
ok((await req(`/${id}/status`,a,{status:'resolved'})).status===403)
const screenshotPath=own.messages[0].images[0].replace('/api/feedback','')
ok((await req(screenshotPath,a)).status===200)
ok((await req(screenshotPath,b)).status===404)
ok((await req(screenshotPath,staff)).headers.get('x-content-type-options')==='nosniff')
const replyKey=randomUUID();const reply={requestId:replyKey,body:'已处理，请重新尝试',asAdmin:true}
ok((await req(`/${id}/replies`,staff,reply)).status===201)
ok((await req(`/${id}/replies`,staff,reply)).status===200)
ok((await (await req('/',a)).json()).items[0].unread===true)
await req(`/${id}/seen`,a,{})
ok((await (await req('/',a)).json()).items[0].unread===false)
ok((await req(`/${id}/status`,staff,{status:'resolved'})).status===200)
ok((await req(`/${id}/replies`,a,{requestId:randomUUID(),body:'仍然有问题'})).status===201)
ok((await (await req(`/${id}`,staff)).json()).status==='pending')
ok((await req(`/${id}/replies`,b,{requestId:randomUUID(),body:'越权'})).status===404)
ok((await req(`/${id}/replies`,staff,{requestId:randomUUID(),body:'冒充用户'})).status===403)
const anon=await req('/',guest,{requestId:randomUUID(),category:'suggestion',body:'匿名建议'})
ok(anon.status===201);const anonId=(await anon.json()).id
ok((await req(`/${anonId}`,guest)).status===200)
ok((await req(`/${anonId}`,a)).status===404)
for(const patch of [{category:'__proto__'},{body:''},{email:'a@example.test,b@example.test'},{images:['data:image/svg+xml;base64,PHN2Zz4=']},{images:[image,image,image,image]}]){
 ok((await req('/',a,{...submission,requestId:randomUUID(),...patch})).status===400)
}
const cross=await app.request('http://localhost/api/feedback',{method:'POST',headers:{Origin:'https://evil.test','Content-Type':'application/json',Cookie:a},body:JSON.stringify(submission)})
ok(cross.status===403)
const tooLarge=await app.request('http://localhost/api/feedback',{method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json',Cookie:a},body:JSON.stringify({body:'a'.repeat(6*1024*1024)})})
ok(tooLarge.status===413)
process.env.FEEDBACK_NOTIFY_TO=''
let last=0
for(let i=0;i<11;i++)last=(await req('/',b,{requestId:randomUUID(),category:'other',body:`限流测试${i}`})).status
ok(last===429)
console.log(`PASS feedback: ${checks} assertions; owner/admin/guest isolation, image authorization, validation, idempotency, replies, unread, status, CSRF, size/rate limits; SMTP failure preserves submission`)
db.close()
