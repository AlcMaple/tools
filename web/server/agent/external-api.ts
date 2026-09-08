import { Hono,type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getSession,rateLimited } from '../auth'
import type { ContractSchema } from '../../shared/agent-contracts'
import { AgentRunError } from '../../shared/agent-run'
import { AgentHistoryError } from '../../shared/agent-history'
import { connectExternal,prepareExternal,externalStatus,forgetConnection } from './external-runtime'
import { matchesContract } from './validation'

export const externalMessages:Record<string,string>={AGENT_AI_DISABLED:'服务器 AI 尚未启用。',PROVIDER_CONNECTION_REQUIRED:'请先连接 AI。',PROVIDER_NOT_CONFIGURED:'模型凭据尚未配置。',
  ENDPOINT_NOT_ALLOWED:'此端点或型号尚未核准，请选择已支持的连接。',PROVIDER_CAPABILITY:'模型的 JSON 或工具能力探测未通过，请检查配置。',PROVIDER_UNAVAILABLE:'模型连接失败，请检查连接后手动重试。',
  COST_LIMIT:'已达到费用或 token 上限，这次调用已停止。',DAILY_QUOTA:'今日对话额度已用完。',GLOBAL_BUSY:'AI 正忙，请稍后手动重试。',CONNECTION_BUSY:'连接检查正在进行。',
  RUN_BUSY:'当前已有请求正在运行。',GUEST_CONTEXT_LIMIT:'本次临时对话已达到长度上限，请刷新后重新开始。',ROUND_LIMIT:'已达到本轮查询上限。',
  INVALID_OUTPUT:'模型回复格式未通过检查，未执行额外操作。',REQUEST_ALREADY_USED:'这个请求已发送过，不会重复调用模型。',AUTH_CHANGED:'身份已变化，请重新打开助手。'}
export function externalError(error:unknown){
  const code=error instanceof AgentRunError||error instanceof AgentHistoryError?error.code:'PROVIDER_UNAVAILABLE'
  const http=/^PROVIDER_HTTP_(\d+)$/.exec(code)
  return {code,error:http?`模型服务返回 HTTP ${http[1]}，未自动重试。`:externalMessages[code]??'这次请求已停止，请检查后手动重试。'}
}
export async function externalBody(c:Context){if(!/^application\/json(?:;|$)/i.test(c.req.header('content-type')??''))throw new AgentRunError('INVALID_ARGUMENT',400);try{return await c.req.json() as unknown}catch{throw new AgentRunError('INVALID_ARGUMENT',400)}}
export function parseConnection(value:unknown):{source:'server'|'byok';endpoint?:string;model?:string;key?:string}{
  const schema:ContractSchema={anyOf:[{type:'object' as const,properties:{source:{type:'string' as const,enum:['server']}},required:['source'],additionalProperties:false as const},
    {type:'object' as const,properties:{source:{type:'string' as const,enum:['byok']},endpoint:{type:'string' as const,maxLength:300},model:{type:'string' as const,maxLength:100},key:{type:'string' as const,minLength:1,maxLength:4096}},required:['source','endpoint','model','key'],additionalProperties:false as const}]}
  if(!matchesContract(schema,value))throw new AgentRunError('INVALID_ARGUMENT',400)
  return value as {source:'server'|'byok';endpoint?:string;model?:string;key?:string}
}
export function createExternalApi(){
  const api=new Hono<{Variables:{uid:number}}>()
  api.use('*',async(c,next)=>{c.header('Cache-Control','no-store');const s=await getSession(c);if(!s)throw new AgentRunError('AUTH_REQUIRED',401);c.set('uid',s.uid);c.header('X-Agent-Owner',String(s.uid));if(rateLimited(`agent-provider:${s.uid}`,10,60000))throw new AgentRunError('RATE_LIMITED',429);await next()})
  api.use('*',bodyLimit({maxSize:8192,onError:c=>c.json({code:'MESSAGE_TOO_LARGE'},413)}))
  api.onError((error,c)=>c.json(externalError(error),error instanceof AgentRunError?error.status:503))
  api.get('/provider',c=>c.json(externalStatus(c.get('uid'))))
  api.post('/provider/prepare',async c=>{
    const input=await externalBody(c)
    if(!matchesContract({type:'object',properties:{},required:[],additionalProperties:false},input))throw new AgentRunError('INVALID_ARGUMENT',400)
    const uid=c.get('uid')
    return c.json(await prepareExternal(uid,`user:${uid}`,AbortSignal.any([c.req.raw.signal,AbortSignal.timeout(30000)])))
  })
  api.post('/provider/connect',async c=>{
    const uid=c.get('uid'),input=parseConnection(await externalBody(c))
    return c.json(await connectExternal(uid,`user:${uid}`,input,AbortSignal.any([c.req.raw.signal,AbortSignal.timeout(30000)])))
  })
  api.delete('/provider/connection',c=>{forgetConnection(c.get('uid'));return c.json({ok:true})})
  return api
}
