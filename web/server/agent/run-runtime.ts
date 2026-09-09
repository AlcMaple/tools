import { createAgentDataTools,READ_DATA_TOOLS,GUEST_DATA_TOOLS,PROPOSAL_DATA_TOOLS } from './data-tools'
import { AgentActionStore,initializeAgentActionSchema,proposeTrackChangeTool } from './actions-store'
import { AgentPlaybackStore,initializeAgentPlaybackSchema,proposePlaybackOpenTool } from './playback-store'
import { locate as locateXifan } from '../xifan/locate'
import { putBinding as bindXifan } from '../xifan/bindings'
import { searchXifan,getXifanCaptcha,verifyXifanCaptcha } from '../xifan/search'
import { enabledSiteFeatures } from './site-features'
import { openOfflineIndex } from '../bgm/anime-index'
import { borrowDeployedOfflineSearch } from '../bgm/dev-index-borrow'
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
const AUTHENTICATED_TOOLS=[...READ_DATA_TOOLS,...PROPOSAL_DATA_TOOLS] as const
const registry=new AgentKnowledgeRegistry(loaded.release,AGENT_FEATURE_REGISTRATIONS,AGENT_FEATURES,AUTHENTICATED_TOOLS,loaded.matches)
export function currentAgentKnowledge(uid:number){
  const row=db.prepare('SELECT token_version,ai_config FROM users WHERE id=?').get(uid) as {token_version:number;ai_config:string}|undefined
  if(!row)throw new AgentRunError('AUTH_REQUIRED',401)
  return registry.snapshot(uid,{enabled:true,permissionVersion:knowledgeHash({tv:row.token_version,aiConfig:row.ai_config,modelReady:externalReady(uid)}),
    features:[...AGENT_FEATURES.filter(f=>f.id.startsWith('agent.')).map(f=>f.id),...enabledSiteFeatures({email:emailDeliveryConfigured(),google:Boolean(GOOGLE_CLIENT_ID&&GOOGLE_CLIENT_SECRET),rewards:rewardsEnabled(uid),invites:invitesEnabled(uid),lottery:lotteryEnabled(uid)})],tools:[...AUTHENTICATED_TOOLS],conditions:{answerModelAutoConnect:externalCanPrepare(uid),answerModelReady:externalReady(uid),dataToolsReady:true,chatUiReady:true,trackChangeReady:true,playbackOpenReady:true,
      contextModelReady:externalReady(uid)}})
}
export const agentRunStore=new AgentRunStore(db)
initializeAgentActionSchema(db)
export const agentActionStore=new AgentActionStore(db,Date.now,uid=>currentAgentKnowledge(uid).version)
initializeAgentPlaybackSchema(db)
// 认源能力在组装根注入：playback-store 自己不 import 稀饭，「Agent 会打哪些外站请求」这一问
// 只需要看这一处。locate 只读周表（免验证码、不落库），bind 写全局绑定表、只在用户确认那一下调用。
export const agentPlaybackStore=new AgentPlaybackStore(db,Date.now,uid=>currentAgentKnowledge(uid).version,agentActionStore,{
  locate:(bgmId,titles)=>locateXifan(bgmId,titles),
  bind:(bgmId,id,name)=>{bindXifan(bgmId,Number(id),name)},
  // 站内搜索与验证码走的是用户自己的源站会话（xifanSessionFor(uid)），和页面上手点时同一条；
  // 这里只透传，验证码图片和用户输入的数字都不经过模型。
  search:async(uid,keyword)=>{
    const found=await searchXifan(uid,keyword)
    return found.needsCaptcha?{needsCaptcha:true}:{needsCaptcha:false,
      data:found.data.map(h=>({xifanId:h.xifanId,xifanName:h.xifanName,note:[h.episode,h.year,h.area].filter(Boolean).join(' · ')}))}
  },
  captcha:uid=>getXifanCaptcha(uid),
  verifyCaptcha:(uid,code)=>verifyXifanCaptcha(uid,code),
})
// 测试通过显式依赖注入接入脚本 provider / 只读工具；生产入口从不导入测试夹具。
export const agentRunService=new AgentRunService(agentRunStore,(uid,sessionId)=>{const binding=externalBinding(uid,`user:${uid}`);return {...bindAgentDataRun(uid,sessionId,binding.provider),execute:binding.execute}})

// 工具身份固定绑定服务端会话，不接受模型提供的账号参数。
export function bindAgentDataRun(uid:number,sessionId:string,provider:RunProvider):RunBinding {
 const row=db.prepare('SELECT token_version FROM users WHERE id=?').get(uid) as {token_version:number}|undefined
 if(!row)throw new AgentRunError('AUTH_REQUIRED',401)
 return {provider,context:agentContextService,knowledge:()=>currentAgentKnowledge(uid),assertIdentity(){const current=db.prepare('SELECT token_version FROM users WHERE id=?').get(uid) as {token_version:number}|undefined;if(!current||current.token_version!==row.token_version)throw new AgentRunError('AUTH_REQUIRED',401)},tools:[...createAgentDataTools({db,index:openOfflineIndex,calendar:readCalendarSnapshot,devIndexFallback:borrowDeployedOfflineSearch},{kind:'user',uid,sessionId,tokenVersion:row.token_version}),proposeTrackChangeTool(agentActionStore,uid,sessionId),proposePlaybackOpenTool(agentPlaybackStore,uid,sessionId)]}
}

export function currentGuestKnowledge(){
 return registry.guestSnapshot({enabled:true,permissionVersion:knowledgeHash({modelReady:externalReady(null)}),features:AGENT_FEATURES.map(f=>f.id),tools:GUEST_DATA_TOOLS,
  conditions:{answerModelAutoConnect:externalCanPrepare(null),answerModelReady:externalReady(null),dataToolsReady:true,chatUiReady:true,contextModelReady:false}})
}
export function guestDataTools(){return createAgentDataTools({db,index:openOfflineIndex,calendar:readCalendarSnapshot},{kind:'guest'})}
