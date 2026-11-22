import { AGENT_BYOK_ACCESS_SCHEMA, AI_SETTINGS_MESSAGES, type AgentByokAccess } from '../../shared/agent-ai'
import { Hono,type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getSession,rateLimited } from '../auth'
import type { ContractSchema } from '../../shared/agent-contracts'
import { AgentRunError } from '../../shared/agent-run'
import { AgentHistoryError } from '../../shared/agent-history'
import { connectExternal,externalStatus,forgetConnection } from './external-runtime'
import { matchesContract } from './validation'
import { logAgentIssue, logAgentRequest } from './diagnostics'

export const externalMessages:Record<string,string>={...AI_SETTINGS_MESSAGES,AGENT_AI_DISABLED:'服务器 AI 尚未启用。',PROVIDER_NOT_CONFIGURED:'模型凭据尚未配置。',
  KNOWLEDGE_PENDING_SYNC:'当前功能说明待同步，请稍后再发',
  PROVIDER_UNAVAILABLE:'模型连接失败，请检查连接后手动重试。',
  COST_LIMIT:'已达到费用或 token 上限，这次调用已停止。',DAILY_QUOTA:'今日对话额度已用完。',GLOBAL_BUSY:'AI 正忙，请稍后手动重试。',GUEST_BUSY:'临时对话名额已满，登录后可直接使用。',GUEST_POOL_LIMIT:'今日临时对话额度已用完，登录后可继续使用。',CONNECTION_BUSY:'连接检查正在进行。',
  RUN_BUSY:'当前已有请求正在运行。',GUEST_CONTEXT_LIMIT:'本次临时对话已达到长度上限，请刷新后重新开始。',ROUND_LIMIT:'已达到本轮查询上限。',
  INVALID_OUTPUT:'模型回复格式未通过检查，未执行额外操作。',REQUEST_ALREADY_USED:'这个请求已发送过，不会重复调用模型。',AUTH_CHANGED:'身份已变化，请重新打开助手。',
  IMAGE_UNSUPPORTED:'当前 AI 连接看不了图片，去掉图片再发，或换一个能看图的模型。',IMAGE_INVALID:'这张图没有读懂，换一张再试。',IMAGE_MISSING:'附的图找不到了，请重新添加后再发。',
  IMAGE_STORAGE_LIMIT:'存的图片太多了，删掉一些旧对话再发图吧。',SESSION_ARCHIVED:'此对话已归档。'}
export function externalError(error:unknown){
  const code=error instanceof AgentRunError||error instanceof AgentHistoryError?error.code:'PROVIDER_UNAVAILABLE'
  const http=/^PROVIDER_HTTP_(\d+)$/.exec(code)
  return {code,error:externalMessages[code]??(http?`模型服务返回 HTTP ${http[1]}，未自动重试。`:'这次请求已停止，请检查后手动重试。')}
}
export async function externalBody(c:Context){if(!/^application\/json(?:;|$)/i.test(c.req.header('content-type')??''))throw new AgentRunError('INVALID_ARGUMENT',400);try{return await c.req.json() as unknown}catch{throw new AgentRunError('INVALID_ARGUMENT',400)}}
export function legacyConnectionStatus<T extends {ready:boolean;canPrepare?:boolean}>(c:Context,status:T){
  // 已打开的旧页面仍会单独请求准备；只回读，不把空请求当成付费操作。
  if(!status.ready&&status.canPrepare)return c.json({...status,code:'AI_CLIENT_REFRESH_REQUIRED',error:'纱雾已更新，请刷新页面后再发送'},409)
  return c.json(status)
}
export function parseConnection(value:unknown):AgentByokAccess|{source:'server'|'byok';uid?:never}{
  if(matchesContract(AGENT_BYOK_ACCESS_SCHEMA,value))return value as AgentByokAccess
  const legacy:ContractSchema={anyOf:[{type:'object',properties:{source:{type:'string',enum:['server']}},required:['source'],additionalProperties:false},
    {type:'object',properties:{source:{type:'string',enum:['byok']},endpoint:{type:'string',maxLength:300},model:{type:'string',maxLength:100},key:{type:'string',minLength:1,maxLength:4096}},required:['source','endpoint','model','key'],additionalProperties:false}]}
  if(!matchesContract(legacy,value))throw new AgentRunError('INVALID_ARGUMENT',400)
  return {source:(value as {source:'server'|'byok'}).source}
}
// 挂载点必须是 '/provider'(见 history-api)。Hono 的 route('/',sub) 会把 sub 的 use('*') 合并成父路由的
// 全局中间件 —— 曾经因此让这里的限流和 8KB body 上限套在**每一条** /api/agent 请求上。
export function createExternalApi(){
  const api=new Hono<{Variables:{uid:number}}>()
  api.use('*',async(c,next)=>{c.header('Cache-Control','no-store');const s=await getSession(c);if(!s)throw new AgentRunError('AUTH_REQUIRED',401);c.set('uid',s.uid);c.header('X-Agent-Owner',String(s.uid));logAgentRequest('provider',c.req.method,c.req.path,s.uid);
    // 兼容的 prepare 仍按原 POST 频率收口，避免旧页面请求挤占状态查询。
    const write=c.req.method!=='GET'
    if(rateLimited(`agent-provider:${write?'write':'read'}:${s.uid}`,write?20:120,60000)){
      c.header('Retry-After','60')
      logAgentIssue('provider',{limit:write?'write 20/min':'read 120/min',method:c.req.method,path:c.req.path,uid:s.uid})
      throw new AgentRunError('RATE_LIMITED',429)
    }
    await next()})
  api.use('*',bodyLimit({maxSize:8192,onError:c=>c.json({code:'MESSAGE_TOO_LARGE'},413)}))
  api.onError((error,c)=>{logAgentIssue('provider',{method:c.req.method,path:c.req.path,uid:c.get('uid')},error)
    return c.json(externalError(error),error instanceof AgentRunError?error.status:503)})
  api.get('/',c=>c.json(externalStatus(c.get('uid'))))
  api.post('/prepare',async c=>{
    const input=await externalBody(c)
    if(!matchesContract({type:'object',properties:{},required:[],additionalProperties:false},input))throw new AgentRunError('INVALID_ARGUMENT',400)
    return legacyConnectionStatus(c,externalStatus(c.get('uid')))
  })
  api.post('/connect',async c=>{
    const uid=c.get('uid'),input=parseConnection(await externalBody(c))
    // 旧面板的手动连接入口只读；新版接单评估只在用户开始整理时带账号办理。
    if(input.uid===undefined){
      const status=externalStatus(uid)
      return c.json({...status,code:'AI_CLIENT_REFRESH_REQUIRED',error:'AI 设置入口已更新，请刷新页面后再试'},409)
    }
    if(input.uid!==uid)throw new AgentRunError('AUTH_CHANGED',409)
    return c.json(await connectExternal(uid,`user:${uid}`,input,AbortSignal.any([c.req.raw.signal,AbortSignal.timeout(30000)])))
  })
  api.delete('/connection',c=>{forgetConnection(c.get('uid'));return c.json({ok:true})})
  return api
}
