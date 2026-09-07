import { Hono, type Context } from 'hono'
import type { ContractSchema, ContextTier, SummaryState } from '../../shared/agent-contracts'
import { AgentHistoryError } from '../../shared/agent-history'
import {
  COMPACT_SCHEMA, PREPARE_CONTEXT_SCHEMA, PREFERENCE_CREATE_SCHEMA, PREFERENCE_EDIT_SCHEMA, CONFIRM_PREFERENCE_SCHEMA,
  PIN_MESSAGE_SCHEMA, CONTEXT_SETTINGS_SCHEMA, SUMMARY_EDIT_SCHEMA, SUMMARY_RESTORE_SCHEMA,
  type CompactJob, type CompactRequest, type PreferenceCard,
} from '../../shared/agent-context'
import { matchesContract } from './validation'
import { contextError } from './context-store'
import type { AgentContextService } from './context-service'

async function input<T>(c:Context,schema:ContractSchema):Promise<T> {
  if(!/^application\/json(?:;|$)/i.test(c.req.header('content-type')??'')) contextError('INVALID_ARGUMENT','请使用 JSON 格式提交。',400)
  let value:unknown
  try {value=await c.req.json()} catch {contextError('INVALID_ARGUMENT','提交的 JSON 没有读完整。',400)}
  if(!matchesContract(schema,value)) contextError('INVALID_ARGUMENT','参数格式不正确，请检查后再试。',400)
  return value as T
}
const noQuery=(c:Context)=>{if(Object.keys(c.req.query()).length) contextError('INVALID_ARGUMENT','这个入口不接受额外查询参数。',400)}
function keepJob(c:Context,service:AgentContextService,job:CompactJob) {
  try {c.executionCtx.waitUntil(service.wait(job.id))} catch { /* Node 由进程持有任务；支持 waitUntil 的宿主延续同一任务。 */ }
  return c.json({job},202)
}
export function createAgentContextApi(service:AgentContextService) {
  const api=new Hono<{Variables:{agentUid:number}}>(),store=service.store
  api.use('*',async(c,next)=>{c.header('Cache-Control','no-store');if(!Number.isSafeInteger(c.get('agentUid'))||c.get('agentUid')<=0)return c.json({code:'AUTH_REQUIRED',error:'先登录，再整理手帐吧。'},401);await next()})
  api.onError((error,c)=>{if(error instanceof AgentHistoryError)return c.json({code:error.code,error:error.message},error.status);throw error})
  api.post('/capabilities/probe',async c=>{
    await input(c,{type:'object',properties:{},required:[],additionalProperties:false})
    return c.json(await service.capabilities(c.get('agentUid')))
  })
  api.get('/preferences',c=>{noQuery(c);return c.json({preferences:store.preferences(c.get('agentUid'))})})
  api.post('/preferences',async c=>{
    const p=await input<{category:PreferenceCard['category'];value:string;sourceMessageId?:string}>(c,PREFERENCE_CREATE_SCHEMA)
    if(!p.value.trim()) contextError('INVALID_ARGUMENT','先写下想保存的偏好吧。',400)
    return c.json({preference:store.proposePreference(c.get('agentUid'),p)},201)
  })
  api.post('/preferences/:id/confirm',async c=>{const p=await input<{expectedRevision:number}>(c,CONFIRM_PREFERENCE_SCHEMA);return c.json({preference:store.changePreference(c.get('agentUid'),c.req.param('id'),p.expectedRevision,'confirm')})})
  api.patch('/preferences/:id',async c=>{
    const p=await input<{expectedRevision:number;value:string}>(c,PREFERENCE_EDIT_SCHEMA)
    if(!p.value.trim()) contextError('INVALID_ARGUMENT','偏好内容还空着呢。',400)
    return c.json({preference:store.changePreference(c.get('agentUid'),c.req.param('id'),p.expectedRevision,'edit',p.value)})
  })
  api.delete('/preferences/:id',async c=>{const p=await input<{expectedRevision:number}>(c,CONFIRM_PREFERENCE_SCHEMA);store.changePreference(c.get('agentUid'),c.req.param('id'),p.expectedRevision,'delete');return c.json({deleted:true})})
  api.get('/sessions/:id/context',c=>{
    noQuery(c);const uid=c.get('agentUid'),id=c.req.param('id');service.expire()
    return c.json({session:store.session(uid,id),adaptive:Boolean(store.settings(uid,id).adaptive),active:store.active(uid,id)?.view??null,
      versions:store.versions(uid,id).map(({state,...meta})=>meta),job:store.activeJob(uid)})
  })
  api.patch('/sessions/:id/context',async c=>{
    const p=await input<{expectedRevision:number;contextTier:ContextTier;adaptive?:boolean}>(c,CONTEXT_SETTINGS_SCHEMA)
    return c.json({session:store.setContext(c.get('agentUid'),c.req.param('id'),p.expectedRevision,p)})
  })
  api.patch('/sessions/:id/messages/:messageId/pin',async c=>{
    const p=await input<{expectedRevision:number;pinned:boolean}>(c,PIN_MESSAGE_SCHEMA)
    return c.json({session:store.setContext(c.get('agentUid'),c.req.param('id'),p.expectedRevision,{messageId:c.req.param('messageId'),pinned:p.pinned})})
  })
  api.post('/sessions/:id/compact',async c=>keepJob(c,service,service.start(c.get('agentUid'),c.req.param('id'),await input<CompactRequest>(c,COMPACT_SCHEMA))))
  api.post('/sessions/:id/context/prepare',async c=>{
    const p=await input<CompactRequest&{question:string}>(c,PREPARE_CONTEXT_SCHEMA)
    const result=await service.prepare(c.get('agentUid'),c.req.param('id'),p)
    if(result.job) {try{c.executionCtx.waitUntil(service.wait(result.job.id))}catch{}}
    return c.json({state:result.state,job:result.job,context:result.view?{estimatedTokens:result.view.estimatedTokens,budget:result.view.budget,
      summaryVersion:result.view.summaryVersion,protectedMessageIds:result.view.protectedMessageIds,retrievedMessageIds:result.view.retrievedMessageIds}:null},result.job?202:200)
  })
  api.get('/sessions/:id/context/retrieve',c=>{
    if(Object.keys(c.req.query()).some(k=>k!=='q')||c.req.queries('q')?.length!==1) contextError('INVALID_ARGUMENT','请输入一个检索条件。',400)
    const q=c.req.query('q')??'';if(!q.trim()||q.length>240)contextError('INVALID_ARGUMENT','检索条件为空或太长。',400)
    return c.json({messages:store.retrieve(c.get('agentUid'),c.req.param('id'),q)})
  })
  api.get('/compactions/:id',c=>{noQuery(c);service.expire();return c.json({job:store.job(c.get('agentUid'),c.req.param('id'))})})
  api.post('/compactions/:id/cancel',async c=>{await input(c,{type:'object',properties:{},required:[],additionalProperties:false});return c.json({job:service.cancel(c.get('agentUid'),c.req.param('id'))})})
  api.get('/sessions/:id/summaries/:version',c=>{
    noQuery(c);const v=c.req.param('version');if(!/^[1-9]\d*$/.test(v)||!Number.isSafeInteger(Number(v)))contextError('INVALID_ARGUMENT','摘要版本号格式不正确。',400)
    return c.json({summary:store.version(c.get('agentUid'),c.req.param('id'),Number(v)).view})
  })
  api.post('/sessions/:id/summaries/edit',async c=>{const p=await input<{expectedRevision:number;state:SummaryState}>(c,SUMMARY_EDIT_SCHEMA);return keepJob(c,service,service.edit(c.get('agentUid'),c.req.param('id'),p.expectedRevision,p.state))})
  api.post('/sessions/:id/summaries/restore',async c=>{const p=await input<{expectedRevision:number;summaryVersion:number}>(c,SUMMARY_RESTORE_SCHEMA);return c.json({summary:service.restore(c.get('agentUid'),c.req.param('id'),p.expectedRevision,p.summaryVersion)})})
  return api
}
