import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { createAgentUiFixture } from './agent-ui-fixture'
import { createAgentDataTools,GUEST_DATA_TOOLS,READ_DATA_TOOLS } from '../server/agent/data-tools'
import { createAnswerProvider,meteredTransport } from '../server/agent/external-provider'
import { estimateContextTokens } from '../server/agent/context-provider'
import { ExternalQuota,CONSERVATIVE_LIMITS } from '../server/agent/external-quota'
import { AgentKnowledgeRegistry,AGENT_FEATURES,AGENT_FEATURE_REGISTRATIONS } from '../server/agent/knowledge'
import { guestTurn } from '../server/agent/guest-service'
import { estimateCost } from '../server/agent/policy'
process.env.NODE_ENV='test';process.env.AGENT_UI_FIXTURE='1'
const fixture=await createAgentUiFixture(),memory=new Database(':memory:'),quota=new ExternalQuota(memory,CONSERVATIVE_LIMITS)
const price={currency:'USD',version:'baseline-peak',inputPerMillion:0.44,cachedInputPerMillion:0.014,outputPerMillion:1.32}
const calls:{bytes:number;ceiling:number|null}[]=[]
try{
 const registry=new AgentKnowledgeRegistry('budget-test',AGENT_FEATURE_REGISTRATIONS,AGENT_FEATURES,READ_DATA_TOOLS)
 const knowledge=()=>registry.guestSnapshot({enabled:true,permissionVersion:'guest',features:AGENT_FEATURES.map(f=>f.id),tools:GUEST_DATA_TOOLS,conditions:{answerModelReady:true}})
 const provider=createAnswerProvider({source:'server',model:'deepseek-v4-flash-vision-exp',fingerprint:'budget-fixture',capabilities:{protocol:'chat_completions',contextTokens:1000000,maxOutputTokens:8192,toolCalling:true,verified:true,tokenCounting:'estimate',nativeCompaction:'none',nativeMinimumTokens:0}},meteredTransport(async(_p,body)=>{
  const material=JSON.parse((body.messages as {content:string}[])[1].content)
  if(material.toolResults.length)assert(material.toolResults.every((r:{result:{sources:Record<string,unknown>[]}})=>r.result.sources.every(s=>!Object.hasOwn(s,'aggregate'))))
  calls.push({bytes:estimateContextTokens(body),ceiling:estimateCost(estimateContextTokens(body),0,Number(body.max_tokens),price)})
  const output=material.toolResults.length?{kind:'answer',text:'已查询四项公开统计。',sourceIds:material.toolResults.flatMap((r:{result:{sources:{sourceId:string}[]}})=>r.result.sources.map(s=>s.sourceId))}:{kind:'tool_calls',calls:['public_users','public_tracks','public_reviews','public_recommendations'].map(metric=>({name:'aggregatePublicData',arguments:{metric,filters:{}}}))}
  return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:Math.ceil(estimateContextTokens(body)/3),completion_tokens:200,prompt_cache_hit_tokens:Math.max(0,Math.ceil(estimateContextTokens(body)/3)-256)}}
 },quota,price,1000000),price,2048)
 const events:{type:string;value:unknown}[]=[]
 await quota.turn('source-budget-guest',true,true,()=>guestTurn({requestId:randomUUID(),body:'追番大厅有哪些公开信息？',history:[]},{provider,knowledge,tools:createAgentDataTools({db:fixture.db,index:()=>null,calendar:()=>null},{kind:'guest'})},new AbortController().signal,async(type,value)=>{events.push({type,value})}))
 assert.equal(calls.length,2);const answer=events.find(e=>e.type==='answer')!.value as {sources:{aggregate?:unknown}[]};assert.equal(answer.sources.length,4);assert(answer.sources.every(s=>s.aggregate))
 console.log('PASS SB01 四指标来源明细不重复占用模型上下文，原额度完成（缓存用量夹具）')
 console.log(JSON.stringify({checks:1,failed:0,passed:true,usageFixture:'cached-prefix',calls,realAiCalls:0,guestTurnLimit:CONSERVATIVE_LIMITS.guestTurnCost}))
}catch(error){console.log(JSON.stringify({calls,usage:quota.status('source-budget-guest')}));throw error}finally{memory.close();await fixture.close()}
