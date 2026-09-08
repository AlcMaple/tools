import { mkdirSync,readFileSync,writeFileSync } from 'node:fs'
import { resolve,join } from 'node:path'
import { randomUUID } from 'node:crypto'

// 显式小样本入口；不在常规测试、构建或启动时调用。
if(!process.argv.includes('--live'))throw new Error('EXPLICIT_LIVE_FLAG_REQUIRED')
const evidence=resolve('../ops/verification/agent-external-phase6-20260908'),data=join(evidence,'live-data')
mkdirSync(data,{recursive:true})
const {AI_API_KEY}=await import('../server/secrets')
if(!AI_API_KEY)throw new Error('PROVIDER_NOT_CONFIGURED')
process.env.DATA_DIR=data;delete process.env.AGENT_AI_ENABLED;delete process.env.AGENT_DEV_FAKE_IP;process.env.AGENT_ANSWER_OUTPUT_TOKENS='512'
process.env.AGENT_LIMITS_JSON=JSON.stringify({globalDailyCost:0.02,userDailyCost:0.02,guestDailyCost:0.02,turnCost:0.02,guestTurnCost:0.01})
const {externalQuota,connectExternal,prepareExternal,externalBinding,externalStatus,guestOwner}=await import('../server/agent/external-runtime')
const {guestTurn}=await import('../server/agent/guest-service')
const {currentGuestKnowledge,guestDataTools,agentRunService}=await import('../server/agent/run-runtime')
const {agentContextService}=await import('../server/agent/context-runtime')
const {AgentHistoryStore}=await import('../server/agent/history-store')
const {db}=await import('../server/db')
const results:Record<string,unknown>[]=[]
const owner=guestOwner('live-smoke-local'),signal=AbortSignal.timeout(120000)
async function step(name:string,action:()=>Promise<unknown>){const started=Date.now();try{const value=await action();results.push({name,ok:true,durationMs:Date.now()-started,value})}catch(e){const code=e&&typeof e==='object'&&'code' in e?String(e.code):e instanceof Error&&/^[A-Z_0-9]+$/.test(e.message)?e.message:e instanceof Error?e.name:'ERROR';results.push({name,ok:false,durationMs:Date.now()-started,code});throw new Error(code)}}
try{
 await step('server-json-and-tool-probe',async()=>{await prepareExternal(null,owner,signal);return externalStatus(null)})
 if(!process.argv.includes('--account-only'))for(const question of ['这个网站怎么用？只用一句话回答。','请用周历缓存工具查今天的更新；缓存缺失就说明缺失，不联网。'])await step('guest:'+question,async()=>{
  const binding=externalBinding(null,owner),events:unknown[]=[]
  await binding.execute(()=>guestTurn({requestId:randomUUID(),body:question,history:[]},{provider:binding.provider,knowledge:currentGuestKnowledge,tools:guestDataTools()},signal,async(type,value)=>{if(type!=='knowledge'&&type!=='delta')events.push({type,value})}))
  return events
 })
 const uid=Number(db.prepare('INSERT INTO users(username,pass_hash,created_at) VALUES(?,?,?)').run('live-'+randomUUID().slice(0,8),'unused-test-only',new Date().toISOString()).lastInsertRowid)
 const history=new AgentHistoryStore(db)
 await step('account-production-resolver',async()=>{const session=history.createSession(uid,{requestId:randomUUID()});const run=await agentRunService.start(uid,session.id,{requestId:randomUUID(),expectedRevision:session.revision,body:'请简短介绍网站，别调用工具。'},0);await agentRunService.wait(run.id);const result=agentRunService.status(uid,run.id);if(result.state!=='completed')throw new Error(result.code??result.state);return {run:result,messages:history.exportSession(uid,session.id).messages}})
 await step('byok-same-baseline-probe',async()=>{await connectExternal(uid,`user:${uid}`,{source:'byok',endpoint:'https://api.deepseek.com',model:'deepseek-v4-flash-vision-exp',key:AI_API_KEY},signal);const s=externalStatus(uid);return {ready:s.ready,source:s.source,model:s.model}})
 await step('byok-account-answer',async()=>{const session=history.createSession(uid,{requestId:randomUUID()});const run=await agentRunService.start(uid,session.id,{requestId:randomUUID(),expectedRevision:session.revision,body:'一句话说明如何查看历史对话，不要调用工具。'},0);await agentRunService.wait(run.id);const result=agentRunService.status(uid,run.id);if(result.state!=='completed')throw new Error(result.code??result.state);return {run:result,messages:history.exportSession(uid,session.id).messages}})
}catch(e){process.exitCode=1;console.log('LIVE_STOPPED',e instanceof Error?e.message:'ERROR')}
finally{
 await agentRunService.close();await agentContextService.close()
 const result={at:new Date().toISOString(),results,guestUsage:externalQuota.status(owner),ledger:db.prepare('SELECT day,tokens,cost,turns FROM agent_ai_budget').all(),globalCeilingUSD:0.02,productionDataTouched:false,byok:'same-project-key-in-memory-same-baseline-not-independent-provider'}
 let previous:unknown[]=[];try{previous=JSON.parse(readFileSync(join(evidence,'live-results.json'),'utf8'))}catch{}
 writeFileSync(join(evidence,'live-results.json'),JSON.stringify([...previous,result],null,2)+'\n')
 console.log(JSON.stringify({checks:results.map(({name,ok,code})=>({name,ok,code})),ledger:result.ledger,globalCeilingUSD:0.02}))
 db.close()
}
