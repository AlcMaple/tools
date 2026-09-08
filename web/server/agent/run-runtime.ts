import { createAgentDataTools,READ_DATA_TOOLS,GUEST_DATA_TOOLS } from './data-tools'
import { enabledSiteFeatures } from './site-features'
import { openOfflineIndex } from '../bgm/anime-index'
import { readCalendarSnapshot } from '../bgm/calendar'
import { rewardsEnabled,invitesEnabled,lotteryEnabled } from '../rewards'
import { emailDeliveryConfigured } from '../email-delivery'
import { agentContextService } from './context-runtime'
import type { RunProvider,RunBinding } from './run-service'
import { db } from '../db'
import { externalBinding,externalReady,externalCanPrepare } from './external-runtime'
import { GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET } from '../secrets'
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
  return registry.snapshot(uid,{enabled:true,permissionVersion:knowledgeHash({tv:row.token_version,aiConfig:row.ai_config,modelReady:externalReady(uid)}),
    features:[...AGENT_FEATURES.filter(f=>f.id.startsWith('agent.')).map(f=>f.id),...enabledSiteFeatures({email:emailDeliveryConfigured(),google:Boolean(GOOGLE_CLIENT_ID&&GOOGLE_CLIENT_SECRET),rewards:rewardsEnabled(uid),invites:invitesEnabled(uid),lottery:lotteryEnabled(uid)})],tools:[...READ_DATA_TOOLS],conditions:{answerModelAutoConnect:externalCanPrepare(uid),answerModelReady:externalReady(uid),dataToolsReady:true,chatUiReady:true,
      contextModelReady:externalReady(uid)}})
}
export const agentRunStore=new AgentRunStore(db)
// 测试通过显式依赖注入接入脚本 provider / 只读工具；生产入口从不导入测试夹具。
export const agentRunService=new AgentRunService(agentRunStore,(uid,sessionId)=>{const binding=externalBinding(uid,`user:${uid}`);return {...bindAgentDataRun(uid,sessionId,binding.provider),execute:binding.execute}})

// 工具身份固定绑定服务端会话，不接受模型提供的账号参数。
export function bindAgentDataRun(uid:number,sessionId:string,provider:RunProvider):RunBinding {
 const row=db.prepare('SELECT token_version FROM users WHERE id=?').get(uid) as {token_version:number}|undefined
 if(!row)throw new AgentRunError('AUTH_REQUIRED',401)
 return {provider,context:agentContextService,knowledge:()=>currentAgentKnowledge(uid),assertIdentity(){const current=db.prepare('SELECT token_version FROM users WHERE id=?').get(uid) as {token_version:number}|undefined;if(!current||current.token_version!==row.token_version)throw new AgentRunError('AUTH_REQUIRED',401)},tools:createAgentDataTools({db,index:openOfflineIndex,calendar:readCalendarSnapshot},{kind:'user',uid,sessionId,tokenVersion:row.token_version})}
}

export function currentGuestKnowledge(){
 return registry.guestSnapshot({enabled:true,permissionVersion:knowledgeHash({modelReady:externalReady(null)}),features:AGENT_FEATURES.map(f=>f.id),tools:GUEST_DATA_TOOLS,
  conditions:{answerModelAutoConnect:externalCanPrepare(null),answerModelReady:externalReady(null),dataToolsReady:true,chatUiReady:true,contextModelReady:false}})
}
export function guestDataTools(){return createAgentDataTools({db,index:openOfflineIndex,calendar:readCalendarSnapshot},{kind:'guest'})}
