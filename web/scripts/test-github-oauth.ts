import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, createHash, createHmac } from 'node:crypto'

const cwd = process.cwd(), directory = mkdtempSync(join(tmpdir(), 'github-oauth-'))
process.chdir(directory)
Object.assign(process.env, { NODE_ENV:'production', DATA_DIR:directory, MAPLETOOLS_ENV_FILE:'', AUTH_SECRET:randomBytes(48).toString('hex'), GITHUB_CLIENT_ID:process.argv.includes('--disabled')?'':'fixture-client', GITHUB_CLIENT_SECRET:'fixture-secret', GOOGLE_CLIENT_ID:'google-fixture', GOOGLE_CLIENT_SECRET:'google-secret', REWARDS_ENABLED:'1', INVITES_ENABLED:'1', REWARD_TEST_USERS:'' })
const { default: oauth } = await import('../server/oauth')
const { db } = await import('../server/db')
const { getSession } = await import('../server/auth')
const { Hono } = await import('hono')
const app = new Hono().route('/api/auth/oauth',oauth).get('/session',async c=>c.json(await getSession(c)))
const root='https://fixture.test', prefix='/api/auth/oauth'
let serial=0, checks=0, calls=0
let emailBody: unknown=[{email:'new@example.com',verified:true,primary:true,visibility:'private'}]
let tokenBody: unknown={access_token:'fixture-access-token',token_type:'bearer'}
let upstreamStatus=200, expectedVerifier=''
const originalFetch=globalThis.fetch
const codeUsed=new Set<string>()
globalThis.fetch=async(input,init)=>{
  calls++
  const url=String(input)
  assert.equal(init?.redirect,'error')
  assert.ok(init?.signal)
  if(url==='https://github.com/login/oauth/access_token'){
    const body=new URLSearchParams(String(init?.body))
    assert.equal(body.get('client_secret'),'fixture-secret')
    assert.equal(body.get('code_verifier'),expectedVerifier)
    assert.equal(body.get('redirect_uri'),root+prefix+'/github/callback')
    const code=body.get('code')!
    if(codeUsed.has(code))return Response.json({error:'bad_verification_code'})
    codeUsed.add(code)
    return Response.json(tokenBody,{status:upstreamStatus})
  }
  assert.equal(url,'https://api.github.com/user/emails?per_page=100')
  assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer fixture-access-token')
  return Response.json(emailBody,{status:upstreamStatus})
}
const cookieOf=(res:Response)=>res.headers.getSetCookie().find(c=>c.startsWith('mt_oauth_tx='))!.split(';')[0]
function unpack(cookie:string){return JSON.parse(Buffer.from(decodeURIComponent(cookie.split('=')[1]).split('.')[0],'base64url').toString()) as {s:string;v:string;exp:number;r:string;p?:string}}
function signTx(tx:ReturnType<typeof unpack>){const value=Buffer.from(JSON.stringify(tx)).toString('base64url');return 'mt_oauth_tx='+value+'.'+createHmac('sha256',process.env.AUTH_SECRET!).update(value).digest('base64url')}
async function start(returnTo='/#/tracks',provider='github',ip=`192.0.2.${++serial}`){
  const headers={host:'fixture.test','x-forwarded-for':ip}
  const res=await app.request(root+prefix+`/${provider}/start?`+new URLSearchParams({returnTo,invite:'INVITE01'}),{headers})
  assert.equal(res.status,302)
  const cookie=cookieOf(res),tx=unpack(cookie),url=new URL(res.headers.get('location')!)
  expectedVerifier=tx.v
  return {cookie,tx,url,headers}
}
async function callback(flow:Awaited<ReturnType<typeof start>>,query:Record<string,string>={}){
  expectedVerifier=flow.tx.v
  return app.request(root+prefix+'/github/callback?'+new URLSearchParams({state:flow.tx.s,code:'code-'+flow.tx.s,...query}),{headers:{...flow.headers,cookie:flow.cookie}})
}
async function check(name:string,run:()=>unknown|Promise<unknown>){await run();console.log(`PASS ${++checks} ${name}`)}
try{
  if(process.argv.includes('--disabled')){
    await check('未配置时 capability=false，入口404',async()=>{
      assert.equal((await (await app.request(root+prefix+'/providers')).json()).github,false)
      assert.equal((await app.request(root+prefix+'/github/start')).status,404)
      assert.equal(calls,0)
    })
  }else{
    await check('配置后开启 GitHub，与 Google 并存',async()=>{
      const {enabledSiteFeatures}=await import('../server/agent/site-features')
      const flags={email:false,google:false,github:false,rewards:false,invites:false,lottery:false}
      assert.ok(!enabledSiteFeatures(flags).includes('web.github'))
      assert.ok(enabledSiteFeatures({...flags,github:true},true).includes('web.github'))
      const data=await (await app.request(root+prefix+'/providers')).json()
      assert.equal(data.github,true);assert.equal(data.google,true)
      assert.ok(!JSON.stringify(data).includes('secret'))
    })
    await check('state + PKCE + 最小邮箱权限与安全 Cookie',async()=>{
      const f=await start();assert.equal(f.url.origin,'https://github.com');assert.equal(f.url.searchParams.get('scope'),'user:email')
      assert.equal(f.url.searchParams.get('code_challenge'),createHash('sha256').update(f.tx.v).digest('base64url'))
      assert.equal(f.url.searchParams.get('code_challenge_method'),'S256');assert.equal(f.tx.p,'github')
      const response=await app.request(root+prefix+'/github/start',{headers:f.headers})
      assert.match(response.headers.get('set-cookie')!,/HttpOnly/);assert.match(response.headers.get('set-cookie')!,/Secure/);assert.match(response.headers.get('set-cookie')!,/SameSite=Lax/)
    })
    const inviter=Number(db.prepare("INSERT INTO users(username,pass_hash,created_at) VALUES('inviter','unused','2026-09-12')").run().lastInsertRowid)
    db.prepare('INSERT INTO invite_codes(user_id,code,created_at) VALUES(?,?,?)').run(inviter,'INVITE01',Date.now())
    await check('私密已核验主邮箱注册、会话签发和邀请奖励',async()=>{
      const f=await start();const r=await callback(f);assert.equal(r.headers.get('location'),'/#/tracks')
      const cookie=r.headers.getSetCookie().find(c=>c.startsWith('__Host-mt_session='))!.split(';')[0]
      const session=await (await app.request(root+'/session',{headers:{cookie}})).json()
      assert.ok(session.uid)
      const user=db.prepare('SELECT * FROM users WHERE id=?').get(session.uid) as {email:string;password_enabled:number}
      assert.equal(user.email,'new@example.com');assert.equal(user.password_enabled,0)
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM invite_relations').get() as {n:number}).n,1)
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM reward_ledger').get() as {n:number}).n,2)
      assert.match(r.headers.getSetCookie().find(c=>c.startsWith('mt_oauth_tx='))!,/Max-Age=0/)
      const replay=await callback(f);assert.match(replay.headers.get('location')!,/github_failed/)
    })
    await check('再次登录同邮箱不重复注册或发奖励',async()=>{
      emailBody=[{email:'NEW@example.com',verified:true,primary:true}]
      const f=await start();assert.equal((await callback(f)).headers.get('location'),'/#/tracks')
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM users').get() as {n:number}).n,2)
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM reward_ledger').get() as {n:number}).n,2)
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM oauth_identity').get() as {n:number}).n,0)
    })
    for(const [name,body] of [['未核验主邮箱',[{email:'bad@example.com',primary:true,verified:false}]],['仅次邮箱',[{email:'bad@example.com',primary:false,verified:true}]],['无邮箱',[]],['noreply邮箱',[{email:'a@users.noreply.github.com',primary:true,verified:true}]]] as const){
      await check(name+'不建号',async()=>{emailBody=body;const f=await start();assert.match((await callback(f)).headers.get('location')!,/github_email_required/);assert.equal((db.prepare('SELECT COUNT(*) AS n FROM users').get() as {n:number}).n,2)})
    }
    await check('state 不匹配与签名篡改不请求上游',async()=>{
      const f=await start(),before=calls;assert.match((await callback(f,{state:'wrong'})).headers.get('location')!,/github_failed/)
      assert.match((await callback({...f,cookie:f.cookie+'tamper'})).headers.get('location')!,/github_failed/);assert.equal(calls,before)
    })
    await check('过期票据不请求上游',async()=>{const f=await start(),before=calls;f.cookie=signTx({...f.tx,exp:Date.now()-1});assert.match((await callback(f)).headers.get('location')!,/github_failed/);assert.equal(calls,before)})
    await check('Google 与 GitHub 票据不混用',async()=>{
      const f=await start('/','google'),before=calls;assert.match((await callback(f)).headers.get('location')!,/github_failed/)
      const g=await start();await app.request(root+prefix+'/google/callback?'+new URLSearchParams({state:g.tx.s,code:'fake'}),{headers:{...g.headers,cookie:g.cookie}});assert.equal(calls,before)
    })
    await check('取消授权静默返回原 hash 页面',async()=>{const f=await start('/?view=1#/settings'),before=calls;assert.equal((await callback(f,{error:'access_denied'})).headers.get('location'),'/?view=1#/settings');assert.equal(calls,before)})
    await check('上游503不重试、不创建账号',async()=>{upstreamStatus=503;const f=await start(),before=calls;assert.match((await callback(f)).headers.get('location')!,/github_failed/);assert.equal(calls,before+1);upstreamStatus=200})
    await check('OAuth 错误响应不读取邮箱',async()=>{tokenBody={error:'bad_verification_code'};const f=await start(),before=calls;assert.match((await callback(f)).headers.get('location')!,/github_failed/);assert.equal(calls,before+1);tokenBody={access_token:'fixture-access-token',token_type:'bearer'}})
    await check('外站和反斜杠 returnTo 收口到首页',async()=>{for(const value of ['//evil.example','/\\evil.example','https://evil.example','/\n/evil.example'])assert.equal((await start(value)).tx.r,'/')})
    await check('已有密码账号按同邮箱登录，保留密码和原账号',async()=>{
      const id=Number(db.prepare("INSERT INTO users(username,pass_hash,password_enabled,email,email_verified_at,created_at) VALUES('existing','password-placeholder',1,'existing@example.com','2026-09-12','2026-09-12')").run().lastInsertRowid)
      emailBody=[{email:'existing@example.com',primary:true,verified:true}]
      const f=await start();const r=await callback(f)
      const cookie=r.headers.getSetCookie().find(c=>c.startsWith('__Host-mt_session='))!.split(';')[0]
      assert.equal((await (await app.request(root+'/session',{headers:{cookie}})).json()).uid,id)
      assert.equal((db.prepare('SELECT pass_hash FROM users WHERE id=?').get(id) as {pass_hash:string}).pass_hash,'password-placeholder')
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM invite_relations').get() as {n:number}).n,1)
    })
    await check('注册额度耗尽不阻碍老账号登录，新邮箱不建号',async()=>{
      const {rateLimited,REGISTER_MAX_PER_IP,REGISTER_WINDOW}=await import('../server/auth')
      for(let i=0;i<REGISTER_MAX_PER_IP;i++)rateLimited('reg:203.0.113.1',REGISTER_MAX_PER_IP,REGISTER_WINDOW)
      emailBody=[{email:'existing@example.com',primary:true,verified:true}]
      const f=await start('/','github','203.0.113.1');assert.equal((await callback(f)).headers.get('location'),'/')
      emailBody=[{email:'limited@example.com',primary:true,verified:true}]
      const g=await start('/','github','203.0.113.1');assert.match((await callback(g)).headers.get('location')!,/github_busy/)
      assert.equal(db.prepare('SELECT id FROM users WHERE email=?').get('limited@example.com'),undefined)
    })
    await check('连续发起授权触发限流',async()=>{for(let i=0;i<20;i++)await start('/','github','198.51.100.1');assert.equal((await app.request(root+prefix+'/github/start',{headers:{'x-forwarded-for':'198.51.100.1'}})).status,429)})
  }
  console.log(`RESULT ${checks} checks passed; external network calls=0`)
}finally{globalThis.fetch=originalFetch;db.close();process.chdir(cwd);rmSync(directory,{recursive:true,force:true})}
