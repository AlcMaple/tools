import { createAgentDataTools,READ_DATA_TOOLS } from './data-tools'
import { enabledSiteFeatures } from './site-features'
import { openOfflineIndex } from '../bgm/anime-index'
import { readCalendarSnapshot } from '../bgm/calendar'
import { rewardsEnabled,invitesEnabled,lotteryEnabled } from '../rewards'
import { emailDeliveryConfigured } from '../email-delivery'
import { agentContextService } from './context-runtime'
import type { RunProvider,RunBinding } from './run-service'
import { db } from '../db'
import { normalizeAiConfig } from '../auth'
import { AI_API_KEY,GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET } from '../secrets'
import { AgentRunError } from '../../shared/agent-run'
import { AGENT_FEATURES, AGENT_FEATURE_REGISTRATIONS, AgentKnowledgeRegistry, knowledgeHash } from './knowledge'
import { readLoadedRelease } from './release'
import { AgentRunStore } from './run-store'
import { AgentRunService } from './run-service'

const loaded=readLoadedRelease()
const registry=new AgentKnowledgeRegistry(loaded.release,AGENT_FEATURE_REGISTRATIONS,AGENT_FEATURES,READ_DATA_TOOLS,loaded.matches)
export function currentAgentKnowledge(uid:number){
  const row=db.prepare('SELECT token_version,ai_config FROM users WHERE id=?').get(uid) as {token_version:number;ai_config:string}|undefined
  if(!row)throw new AgentRunError('AUTH_REQUIRED',401)
  return registry.snapshot(uid,{enabled:true,permissionVersion:knowledgeHash({tv:row.token_version,aiConfig:row.ai_config,contextEnabled:process.env.AGENT_CONTEXT_AI_ENABLED==='1'}),
    features:[...AGENT_FEATURES.filter(f=>f.id.startsWith('agent.')).map(f=>f.id),...enabledSiteFeatures({email:emailDeliveryConfigured(),google:Boolean(GOOGLE_CLIENT_ID&&GOOGLE_CLIENT_SECRET),rewards:rewardsEnabled(uid),invites:invitesEnabled(uid),lottery:lotteryEnabled(uid)})],tools:[...READ_DATA_TOOLS],conditions:{answerModelReady:false,dataToolsReady:true,chatUiReady:true,
      contextModelReady:process.env.AGENT_CONTEXT_AI_ENABLED==='1'&&Boolean(AI_API_KEY)&&normalizeAiConfig(row.ai_config).provider!=='byok'}})
}
export const agentRunStore=new AgentRunStore(db)
// 测试通过显式依赖注入接入脚本 provider / 只读工具；生产入口从不导入测试夹具。
export const agentRunService=new AgentRunService(agentRunStore,()=>{throw new AgentRunError('AGENT_RUNTIME_NOT_READY',503)})

// 阶段 6 只需接入 provider；工具与会话/账号绑定不依赖模型提供身份参数。
export function bindAgentDataRun(uid:number,sessionId:string,provider:RunProvider):RunBinding {
 const row=db.prepare('SELECT token_version FROM users WHERE id=?').get(uid) as {token_version:number}|undefined
 if(!row)throw new AgentRunError('AUTH_REQUIRED',401)
 return {provider,context:agentContextService,knowledge:()=>currentAgentKnowledge(uid),assertIdentity(){const current=db.prepare('SELECT token_version FROM users WHERE id=?').get(uid) as {token_version:number}|undefined;if(!current||current.token_version!==row.token_version)throw new AgentRunError('AUTH_REQUIRED',401)},tools:createAgentDataTools({db,index:openOfflineIndex,calendar:readCalendarSnapshot},{kind:'user',uid,sessionId,tokenVersion:row.token_version})}
}
