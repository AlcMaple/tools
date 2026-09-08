import { Hono,type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { streamSSE } from 'hono/streaming'
import { getConnInfo } from '@hono/node-server/conninfo'
import { isIP } from 'node:net'
import { db } from '../db'
import { getSession,rateLimited } from '../auth'
import { AgentRunError } from '../../shared/agent-run'
import { connectExternal,prepareExternal,externalBinding,externalStatus,guestOwner } from './external-runtime'
import { externalBody,externalError } from './external-api'
import { currentGuestKnowledge,guestDataTools } from './run-runtime'
import { waitBounded } from './run-service'
import { GUEST_LIMITS,guestTurn,parseGuestInput } from './guest-service'

export function guestIp(c:Context):string{
  let remote='local';try{remote=getConnInfo(c).remote.address??'local'}catch{}
  // 只有显式启用且 socket 对端为回环反代时信任 nginx 覆写的单一头；开发直连忽略全部转发头。
  if(process.env.AGENT_TRUST_LOOPBACK_PROXY==='1'&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)){
    const ip=c.req.header('x-real-ip');if(ip&&isIP(ip))return ip
  }
  return remote
}
export function createGuestApi(deps:{database:typeof db;connect:typeof connectExternal;binding:typeof externalBinding;status:typeof externalStatus;knowledge:typeof currentGuestKnowledge;tools:typeof guestDataTools}={database:db,connect:(uid,owner,_input,signal)=>prepareExternal(uid,owner,signal),binding:externalBinding,status:externalStatus,knowledge:currentGuestKnowledge,tools:guestDataTools}){
const db=deps.database
const guest=new Hono<{Variables:{owner:string}}>()
db.exec('CREATE TABLE IF NOT EXISTS agent_guest_requests(owner TEXT NOT NULL,id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(owner,id))')
guest.use('/guest/*',async(c,next)=>{
  c.header('Cache-Control','no-store');c.header('X-Agent-Owner','guest')
  if(await getSession(c))throw new AgentRunError('AUTH_CHANGED',409)
  const owner=guestOwner(guestIp(c));c.set('owner',owner)
  if(rateLimited(`agent-guest:${owner}`,30,60000))throw new AgentRunError('RATE_LIMITED',429)
  await next();c.header('Cache-Control','no-store')
})
guest.use('/guest/*',bodyLimit({maxSize:64*1024,onError:c=>c.json({code:'MESSAGE_TOO_LARGE'},413)}))
guest.onError((error,c)=>c.json(externalError(error),error instanceof AgentRunError?error.status:503))
guest.get('/guest/status',c=>c.json({provider:deps.status(null),knowledge:deps.knowledge()}))
guest.post('/guest/connect',async c=>{
  const body=await externalBody(c);if(JSON.stringify(body)!=='{}')throw new AgentRunError('INVALID_ARGUMENT',400)
  return c.json(await deps.connect(null,c.get('owner'),{source:'server'},AbortSignal.any([c.req.raw.signal,AbortSignal.timeout(30000)])))
})
guest.post('/guest/turns',async c=>{
  const input=parseGuestInput(await externalBody(c)),owner=c.get('owner'),binding=deps.binding(null,owner)
  db.transaction(()=>{
    db.prepare('DELETE FROM agent_guest_requests WHERE created_at<?').run(Date.now()-86400000)
    if(db.prepare('SELECT 1 FROM agent_guest_requests WHERE owner=? AND id=?').get(owner,input.requestId))throw new AgentRunError('REQUEST_ALREADY_USED',409)
    if((db.prepare('SELECT count(*) n FROM agent_guest_requests WHERE owner=?').get(owner) as {n:number}).n>=100)throw new AgentRunError('DAILY_QUOTA',429)
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
    catch(error){if(!signal.aborted)await emit('failed',externalError(error))}
    finally{clearInterval(timer);controller.abort()}
  })
})
return guest
}
export default createGuestApi()
