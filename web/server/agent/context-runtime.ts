import { db } from '../db'
import { normalizeAiConfig } from '../auth'
import { AI_API_KEY, AI_BASE_URL, AI_MODEL } from '../secrets'
import { AgentContextStore, contextError } from './context-store'
import { AgentContextService } from './context-service'
import { createProtocolProvider, createTrustedServerTransport, providerFingerprint } from './context-provider'
import { selectServerModel } from './policy'

export const agentContextStore=new AgentContextStore(db)
export const agentContextService=new AgentContextService(agentContextStore,uid=>{
  const row=db.prepare('SELECT ai_config FROM users WHERE id = ?').get(uid) as {ai_config:string}|undefined
  if(!row)contextError('NOT_FOUND','账号已失效，请重新登录。',404)
  const configured=normalizeAiConfig(row.ai_config)
  // 当前仅连接维护者配置的服务器地址；不把用户 endpoint 变成任意服务端代理。
  if(configured.provider==='byok')contextError('BYOK_CONNECTION_REQUIRED','用户自配 API 的连接入口将在外部 AI 阶段接入，未切换到服务器模型。')
  if(process.env.AGENT_CONTEXT_AI_ENABLED!=='1')contextError('CONTEXT_AI_DISABLED','上下文模型联调尚未开启，原有聊天历史保持不变。')
  if(!AI_API_KEY)contextError('PROVIDER_NOT_CONFIGURED','服务器模型尚未配置，原有聊天历史保持不变。')
  let model:string
  try{model=selectServerModel(AI_MODEL,null)}catch{contextError('MODEL_APPROVAL_REQUIRED','Agent 服务器模型需要基线失败记录与升级审批。')}
  return createProtocolProvider({source:'server',model,fingerprint:providerFingerprint('server',model,AI_BASE_URL,AI_API_KEY),capabilities:{
    protocol:'chat_completions',contextTokens:1_000_000,maxOutputTokens:384_000,toolCalling:true,tokenCounting:'estimate',nativeCompaction:'none',nativeMinimumTokens:0,verified:false,
  }},createTrustedServerTransport(AI_BASE_URL,AI_API_KEY))
})
