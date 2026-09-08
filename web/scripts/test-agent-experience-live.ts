import { mkdirSync,writeFileSync } from 'node:fs'
import { resolve,join } from 'node:path'
import { randomUUID } from 'node:crypto'
if(!process.argv.includes('--live'))throw new Error('EXPLICIT_LIVE_FLAG_REQUIRED')
const evidence=resolve('../ops/verification/agent-external-phase6-20260908/chat-experience'),data=join(evidence,'live-data');mkdirSync(data,{recursive:true})
await import('../server/secrets')
process.env.DATA_DIR=data;delete process.env.AGENT_AI_ENABLED;delete process.env.AGENT_DEV_FAKE_IP
process.env.AGENT_ANSWER_OUTPUT_TOKENS='512';process.env.AGENT_LIMITS_JSON=JSON.stringify({globalDailyCost:0.01,guestDailyCost:0.01})
const {prepareExternal,externalBinding,guestOwner}=await import('../server/agent/external-runtime')
const {currentGuestKnowledge,guestDataTools}=await import('../server/agent/run-runtime')
const {guestTurn}=await import('../server/agent/guest-service')
const {db}=await import('../server/db')
const owner=guestOwner('experience-small-sample'),signal=AbortSignal.timeout(120000),events:{type:string;atMs:number;value:unknown}[]=[]
const started=Date.now()
try{
 const initial=(db.prepare('SELECT count(*) n FROM agent_ai_usage').get() as {n:number}).n
 await Promise.all([prepareExternal(null,owner,signal),prepareExternal(null,owner,signal)])
 const after=(db.prepare('SELECT count(*) n FROM agent_ai_usage').get() as {n:number}).n
 if(after-initial!==2)throw new Error('PROBE_NOT_DEDUPED')
 const binding=externalBinding(null,owner),requestStart=Date.now()
 await binding.execute(()=>guestTurn({requestId:randomUUID(),body:'用 Markdown 简短介绍网站：加粗一个名称，列两点，再给一个两行表格和一个很短的 TypeScript 代码块。不要调用工具。',history:[]},{provider:binding.provider,knowledge:currentGuestKnowledge,tools:guestDataTools()},signal,async(type,value)=>{if(type!=='knowledge')events.push({type,atMs:Date.now()-requestStart,value})}))
 const deltas=events.filter(e=>e.type==='delta'),answer=events.find(e=>e.type==='answer')
 if(deltas.length<2||!answer||deltas[0].atMs>=answer.atMs)throw new Error('NO_INCREMENTAL_EVIDENCE')
 const result={passed:true,probeCalls:after-initial,concurrentWarmups:2,deltaEvents:deltas.length,firstDeltaMs:deltas[0].atMs,answerMs:answer.atMs,totalMs:Date.now()-started,events,usage:db.prepare('SELECT operation,input_tokens,output_tokens,cost,state FROM agent_ai_usage').all()}
 writeFileSync(join(evidence,'live.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:true,probeCalls:2,deltaEvents:deltas.length,firstDeltaMs:deltas[0].atMs,answerMs:answer.atMs}))
}finally{db.close()}
