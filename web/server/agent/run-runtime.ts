import { db } from '../db'
import { normalizeAiConfig } from '../auth'
import { AI_API_KEY } from '../secrets'
import { AgentRunError } from '../../shared/agent-run'
import { AGENT_FEATURES, AGENT_FEATURE_REGISTRATIONS, AgentKnowledgeRegistry, knowledgeHash } from './knowledge'
import { readLoadedRelease } from './release'
import { AgentRunStore } from './run-store'
import { AgentRunService } from './run-service'

const loaded=readLoadedRelease()
const registry=new AgentKnowledgeRegistry(loaded.release,AGENT_FEATURE_REGISTRATIONS,AGENT_FEATURES,[],loaded.matches)
export function currentAgentKnowledge(uid:number){
  const row=db.prepare('SELECT token_version,ai_config FROM users WHERE id=?').get(uid) as {token_version:number;ai_config:string}|undefined
  if(!row)throw new AgentRunError('AUTH_REQUIRED',401)
  return registry.snapshot(uid,{enabled:true,permissionVersion:knowledgeHash({tv:row.token_version,aiConfig:row.ai_config,contextEnabled:process.env.AGENT_CONTEXT_AI_ENABLED==='1'}),
    features:AGENT_FEATURES.map(f=>f.id),tools:[],conditions:{answerModelReady:false,chatUiReady:false,
      contextModelReady:process.env.AGENT_CONTEXT_AI_ENABLED==='1'&&Boolean(AI_API_KEY)&&normalizeAiConfig(row.ai_config).provider!=='byok'}})
}
export const agentRunStore=new AgentRunStore(db)
// 测试通过显式依赖注入接入脚本 provider / 只读工具；生产入口从不导入测试夹具。
export const agentRunService=new AgentRunService(agentRunStore,()=>{throw new AgentRunError('AGENT_RUNTIME_NOT_READY',503)})
