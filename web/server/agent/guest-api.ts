import { Hono,type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { streamSSE } from 'hono/streaming'
import { getConnInfo } from '@hono/node-server/conninfo'
import { isIP } from 'node:net'
import { db } from '../db'
import { getSession,rateLimited } from '../auth'
import { AgentRunError } from '../../shared/agent-run'
import { externalBindingForAction,externalStatus,guestOwner, type externalBinding } from './external-runtime'
import { externalBody,externalError,legacyConnectionStatus } from './external-api'
import { currentGuestKnowledge,guestDataTools } from './run-runtime'
import { waitBounded } from './run-service'
import { GUEST_BODY_BYTES,GUEST_LIMITS,guestTurn,parseGuestInput } from './guest-service'

// IPv6 用户通常拿到整段 /64，逐地址计数等于无限个身份；折叠到 /64 前缀。
export function ipBucket(ip:string):string{
  if(isIP(ip)!==6)return ip
  const mapped=/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);if(mapped)return mapped[1]
  const [head,tail=''] =ip.split('::'),h=head?head.split(':'):[],t=tail?tail.split(':'):[]
  const groups=[...h,...Array(Math.max(0,8-h.length-t.length)).fill('0'),...t]
  return groups.slice(0,4).map(g=>g.toLowerCase().padStart(4,'0')).join(':')+'::/64'
}
export function guestIp(c:Context):string{
  let remote='local';try{remote=getConnInfo(c).remote.address??'local'}catch{}
  // 只有显式启用且 socket 对端为回环反代时信任 nginx 覆写的单一头；开发直连忽略全部转发头。
  if(process.env.AGENT_TRUST_LOOPBACK_PROXY==='1'&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)){
    const ip=c.req.header('x-real-ip');if(ip&&isIP(ip))return ip
  }
  return remote
}
type GuestBinding=ReturnType<typeof externalBinding>
export function createGuestApi(deps:{database:typeof db;binding:(uid:null,owner:string,signal:AbortSignal,hasImages:boolean)=>GuestBinding|Promise<GuestBinding>;status:typeof externalStatus;knowledge:typeof currentGuestKnowledge;tools:typeof guestDataTools}={database:db,binding:externalBindingForAction,status:externalStatus,knowledge:currentGuestKnowledge,tools:guestDataTools}){
const db=deps.database
const guest=new Hono<{Variables:{owner:string}}>()
db.exec('CREATE TABLE IF NOT EXISTS agent_guest_requests(owner TEXT NOT NULL,id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(owner,id))')
guest.use('/guest/*',async(c,next)=>{
  c.header('Cache-Control','no-store');c.header('X-Agent-Owner','guest')
  if(await getSession(c))throw new AgentRunError('AUTH_CHANGED',409)
  const owner=guestOwner(ipBucket(guestIp(c)));c.set('owner',owner)
  if(rateLimited(`agent-guest:${owner}`,30,60000))throw new AgentRunError('RATE_LIMITED',429)
  await next();c.header('Cache-Control','no-store')
})
// 只有提问接口要装下内联的附图（≤4 张缩好的 JPEG），其余访客接口仍是 64 KB。
const smallBody=bodyLimit({maxSize:64*1024,onError:c=>c.json({code:'MESSAGE_TOO_LARGE'},413)})
const turnBody=bodyLimit({maxSize:GUEST_BODY_BYTES,onError:c=>c.json({code:'MESSAGE_TOO_LARGE',error:'这条消息连同图片太大了，少附几张再发。'},413)})
guest.use('/guest/*',(c,next)=>(c.req.method==='POST'&&c.req.path.endsWith('/guest/turns')?turnBody:smallBody)(c,next))
// 访客换不了模型，「看不了图」只能叫他去掉图片。
const guestError=(error:unknown)=>{const value=externalError(error);return value.code==='IMAGE_UNSUPPORTED'?{...value,error:'现在的 AI 看不了图片，去掉图片再发吧。'}:value}
guest.onError((error,c)=>c.json(guestError(error),error instanceof AgentRunError?error.status:503))
guest.get('/guest/status',c=>c.json({provider:deps.status(null),knowledge:deps.knowledge()}))
guest.post('/guest/connect',async c=>{
  const body=await externalBody(c);if(JSON.stringify(body)!=='{}')throw new AgentRunError('INVALID_ARGUMENT',400)
  return legacyConnectionStatus(c,deps.status(null))
})
guest.post('/guest/turns',async c=>{
  const input=parseGuestInput(await externalBody(c)),owner=c.get('owner')
  if(deps.knowledge().status!=='ready')throw new AgentRunError('KNOWLEDGE_PENDING_SYNC')
  const cutoff=Date.now()-86400000
  const checkRequest=()=>{
    if(db.prepare('SELECT 1 FROM agent_guest_requests WHERE owner=? AND id=? AND created_at>=?').get(owner,input.requestId,cutoff))throw new AgentRunError('REQUEST_ALREADY_USED',409)
    if((db.prepare('SELECT count(*) n FROM agent_guest_requests WHERE owner=? AND created_at>=?').get(owner,cutoff) as {n:number}).n>=100)throw new AgentRunError('DAILY_QUOTA',429)
  }
  checkRequest()
  const waiting=AbortSignal.any([c.req.raw.signal,AbortSignal.timeout(30_000)])
  waiting.throwIfAborted()
  const binding=await waitBounded(Promise.resolve(deps.binding(null,owner,waiting,Boolean(input.images?.length))),waiting)
  waiting.throwIfAborted()
  if(input.images?.length&&!binding.provider.vision)throw new AgentRunError('IMAGE_UNSUPPORTED',400)
  db.transaction(()=>{
    checkRequest()
    db.prepare('DELETE FROM agent_guest_requests WHERE created_at<?').run(cutoff)
    db.prepare('INSERT INTO agent_guest_requests VALUES(?,?,?)').run(owner,input.requestId,Date.now())
  })()
  c.header('X-Accel-Buffering','no')
  return streamSSE(c,async stream=>{
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,c.req.raw.signal,AbortSignal.timeout(GUEST_LIMITS.durationMs)])
    stream.onAbort(()=>controller.abort(new AgentRunError('CANCELLED')))
    let writing=Promise.resolve()
    const emit=(type:string,data:unknown)=>{writing=writing.then(()=>waitBounded(stream.writeSSE({event:type,data:JSON.stringify(data)}),signal));return writing}
    const timer=setInterval(()=>{void emit('heartbeat',{}).catch(()=>controller.abort())},15000)
    try{await binding.execute(()=>guestTurn(input,{provider:binding.provider,tools:deps.tools(),knowledge:deps.knowledge},signal,emit));await emit('completed',{})}
    catch(error){if(!signal.aborted)await emit('failed',guestError(error))}
    finally{clearInterval(timer);controller.abort()}
  })
})
return guest
}
export default createGuestApi()
