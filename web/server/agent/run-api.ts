import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { streamSSE } from 'hono/streaming'
import { getSession, rateLimited } from '../auth'
import { AgentHistoryError, HISTORY_LIMITS } from '../../shared/agent-history'
import { AgentRunError, RUN_LIMITS } from '../../shared/agent-run'
import { AGENT_LIMITS } from './policy'
import type { AgentRunService } from './run-service'
import type { KnowledgeSnapshot } from './knowledge'

const messages: Record<string,string> = {
  AUTH_REQUIRED:'登录状态已更新，请重新登录。', NOT_FOUND:'这次对话记录没有找到。', INVALID_ARGUMENT:'参数没有读懂，请检查后再试。',
  INVALID_CURSOR:'进度游标不完整，请重新读取这次对话。', RUN_BUSY:'还有一轮对话正在进行，先等它结束或取消吧。',
  AGENT_RUNTIME_NOT_READY:'真实回答模型尚未接入，当前只提供历史和阶段验收接口。', KNOWLEDGE_PENDING_SYNC:'当前功能说明待同步，这轮尚未启动。',
  CAPABILITY_CHANGED:'服务器功能或权限已更新，请读取最新说明后继续。', RATE_LIMITED:'请求有点密，稍等一下再来吧。',
}
async function readBody(c:Context):Promise<unknown>{
  if(!/^application\/json(?:;|$)/i.test(c.req.header('content-type')??''))throw new AgentRunError('INVALID_ARGUMENT',400)
  try{return await c.req.json()}catch{throw new AgentRunError('INVALID_ARGUMENT',400)}
}
export function createAgentRunApi(service:AgentRunService,knowledge:(uid:number)=>KnowledgeSnapshot,
  timings:{heartbeatMs:number;idleMs:number}={heartbeatMs:AGENT_LIMITS.heartbeatMs,idleMs:AGENT_LIMITS.idleMs}) {
  const app=new Hono<{Variables:{runUid:number;runTv:number}}>(),subscribers=new Map<number,number>()
  app.use('*',async(c,next)=>{
    c.header('Cache-Control','no-store')
    const session=await getSession(c)
    if(!session)throw new AgentRunError('AUTH_REQUIRED',401)
    c.set('runUid',session.uid);c.set('runTv',session.tv)
    if(rateLimited(`agent-run:${c.req.method==='GET'?'read':'write'}:${session.uid}`,c.req.method==='GET'?120:30,60_000)){
      c.header('Retry-After','60');throw new AgentRunError('RATE_LIMITED',429)
    }
    await next()
  })
  app.use('*',bodyLimit({maxSize:HISTORY_LIMITS.requestBytes,onError:c=>c.json({code:'MESSAGE_TOO_LARGE'},413)}))
  app.onError((error,c)=>{
    if(error instanceof AgentRunError)return c.json({code:error.code,error:messages[error.code]??'这次操作已停止，原有记录仍然保留。'},error.status)
    if(error instanceof AgentHistoryError)return c.json({code:error.code,error:error.message},error.status)
    return c.json({code:'INTERNAL_ERROR',error:'这次操作遇到问题，原有记录仍然保留。'},500)
  })
  app.get('/knowledge',c=>c.json(knowledge(c.get('runUid'))))
  app.get('/sessions/:sessionId/runs',c=>{
    const query=c.req.queries()
    if(Object.entries(query).some(([key,values])=>!['limit','beforeCreatedAt','beforeId'].includes(key)||values.length!==1)
      ||['limit','beforeCreatedAt'].some(key=>query[key]&&!/^(0|[1-9]\d*)$/.test(query[key][0])))throw new AgentRunError('INVALID_ARGUMENT',400)
    return c.json(service.store.list(c.get('runUid'),c.req.param('sessionId'),{limit:query.limit?Number(query.limit[0]):undefined,
      beforeCreatedAt:query.beforeCreatedAt?Number(query.beforeCreatedAt[0]):undefined,beforeId:query.beforeId?.[0]}))
  })
  app.post('/sessions/:sessionId/runs',async c=>{
    const run=await service.start(c.get('runUid'),c.req.param('sessionId'),await readBody(c),c.get('runTv'))
    try{c.executionCtx.waitUntil(service.wait(run.id))}catch{}
    return c.json({run},202)
  })
  app.get('/runs/:runId',c=>c.json({run:service.status(c.get('runUid'),c.req.param('runId'))}))
  app.post('/runs/:runId/resume',async c=>{
    const run=await service.resume(c.get('runUid'),c.req.param('runId'),await readBody(c),c.get('runTv'))
    try{c.executionCtx.waitUntil(service.wait(run.id))}catch{}
    return c.json({run},202)
  })
  app.post('/runs/:runId/cancel',async c=>{
    const body=await readBody(c)
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw new AgentRunError('INVALID_ARGUMENT',400)
    const uid=c.get('runUid'),id=c.req.param('runId');service.cancel(uid,id);await service.wait(id)
    return c.json({run:service.status(uid,id)})
  })
  app.get('/runs/:runId/events',c=>{
    const uid=c.get('runUid'),id=c.req.param('runId'),query=c.req.queries(),header=c.req.header('Last-Event-ID')
    if(Object.entries(query).some(([key,value])=>!['afterSeq','reconnectAttempt'].includes(key)||value.length!==1))throw new AgentRunError('INVALID_ARGUMENT',400)
    const raw=query.afterSeq?.[0]??header??'0',attempt=query.reconnectAttempt?.[0]??'0'
    if(!/^(0|[1-9]\d*)$/.test(raw)||!Number.isSafeInteger(Number(raw))||!/^([012])$/.test(attempt)
      ||(header!==undefined&&query.afterSeq!==undefined&&header!==raw))throw new AgentRunError('INVALID_CURSOR',400)
    let cursor=Number(raw);const initial=service.status(uid,id);service.store.events(uid,id,cursor)
    c.header('X-Agent-Run-Attempt',String(initial.attempt))
    if(initial.state!=='running'&&cursor===initial.lastEventSeq)return c.newResponse(null,204)
    if((subscribers.get(uid)??0)>=RUN_LIMITS.subscribersPerUser)throw new AgentRunError('RATE_LIMITED',429)
    subscribers.set(uid,(subscribers.get(uid)??0)+1)
    c.header('X-Accel-Buffering','no');c.header('Content-Encoding','identity')
    return streamSSE(c,async stream=>{
      const stopped=new AbortController();let wake:()=>void=()=>{},notice=0,nextHeartbeat=Date.now()
      const unsubscribe=service.store.subscribe(id,()=>{notice++;wake()})
      stream.onAbort(()=>{stopped.abort();wake()})
      const write=async(operation:Promise<unknown>)=>{
        let timer:ReturnType<typeof setTimeout>|undefined
        try{await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('STREAM_IDLE')),timings.idleMs)})])}
        finally{if(timer)clearTimeout(timer)}
      }
      try{
        while(!stopped.signal.aborted){
          const observed=notice
          const session=await getSession(c)
          if(!session||session.uid!==uid||session.tv!==c.get('runTv'))break
          const run=service.status(uid,id),events=service.store.events(uid,id,cursor)
          for(const event of events){
            if(stopped.signal.aborted)break
            await write(stream.writeSSE({id:String(event.seq),event:event.type,data:JSON.stringify(event)}));cursor=event.seq
          }
          if(run.state!=='running'&&cursor>=run.lastEventSeq)break
          if(events.length===RUN_LIMITS.eventPage)continue
          if(Date.now()>=nextHeartbeat){await write(stream.write(': heartbeat\n\n'));nextHeartbeat=Date.now()+timings.heartbeatMs}
          if(observed!==notice)continue
          await new Promise<void>(resolve=>{
            const timer=setTimeout(()=>{wake=()=>{};resolve()},Math.max(1,nextHeartbeat-Date.now()))
            wake=()=>{clearTimeout(timer);resolve()}
            if(stopped.signal.aborted||observed!==notice)wake()
          })
        }
      }finally{
        stopped.abort();wake();unsubscribe();const remaining=Math.max(0,(subscribers.get(uid)??1)-1);if(remaining)subscribers.set(uid,remaining);else subscribers.delete(uid)
      }
    },async()=>{})
  })
  return app
}
