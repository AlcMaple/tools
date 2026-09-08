import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import Database from 'better-sqlite3'
import { ExternalQuota, CONSERVATIVE_LIMITS } from '../server/agent/external-quota'
import { AgentRunError } from '../shared/agent-run'
import type { ProviderProfile } from '../server/agent/context-provider'

type Runtime = Pick<typeof import('../server/agent/external-runtime'), 'connectExternal'|'forgetConnection'|'prepareExternal'|'externalStatus'>
const names=['selection','selectedConnection','externalReady','externalStatus','forgetConnection','connectExternal','sharedPreparationError','prepareExternal']
function extract(path:string,functions:string[],variables:string[]=[]){
 const source=readFileSync(new URL(path,import.meta.url),'utf8'),tree=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true)
 return tree.statements.filter(node=>ts.isFunctionDeclaration(node)&&functions.includes(node.name?.text??'')||ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>variables.includes(d.name.getText(tree)))).map(n=>n.getText(tree)).join('\n')
}
// 执行生产函数原文而非重写算法；只替换账号、供应商和时钟边界，额度使用真实 SQLite。
const code=ts.transpileModule(extract('../server/agent/external-runtime.ts',names,['connections','serverPreparation','serverPreparationFailure'])+'\n'+extract('../server/agent/run-service.ts',['waitBounded']),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const price={currency:'USD',version:'fixture',inputPerMillion:0.44,cachedInputPerMillion:0.014,outputPerMillion:1.32}
function fixture(){
 const memory=new Database(':memory:'),quota=new ExternalQuota(memory,{...CONSERVATIVE_LIMITS,guestTurns:1})
 const accounts=new Map<number,{token_version:number;ai_config:string}>()
 for(const id of [1,2])accounts.set(id,{token_version:0,ai_config:JSON.stringify({provider:'server',endpoint:'',model:''})})
 const probes:{signal:AbortSignal;resolve:()=>void;reject:(e:Error)=>void;model:string}[]=[]
 let enabled=true,clock=Date.now(),calls=0
 const sandbox={exports:{},Error,Map,Set,Promise,AbortController,AbortSignal,Date:class extends Date{static now(){return clock}},AgentRunError,
  account:(uid:number)=>{const row=accounts.get(uid);if(!row)throw new AgentRunError('AUTH_REQUIRED',401);return {...row}},normalizeAiConfig:JSON.parse,
  externalEnabled:()=>enabled,agentEnabled:()=>enabled,externalCanPrepare:()=>enabled,approvedProfiles:()=>[],process:{env:{}},AI_API_KEY:'fixture-only',AI_BASE_URL:'https://server.example',AI_MODEL:'model-server',
  selectServerModel:(model:string)=>model,parseConfig:(_key:string,value:unknown)=>value,
  db:{prepare:()=>({run:(value:string,uid:number)=>{accounts.get(uid)!.ai_config=value}})},externalQuota:quota,
  matchEndpoint:(endpoint:string,model:string)=>{if(!endpoint||model==='invalid')throw new AgentRunError('ENDPOINT_NOT_ALLOWED',400);return{endpoint,model,contextTokens:64000,maxOutputTokens:2048,price}},
  protectedTransport:()=>{calls++;return{}},providerFingerprint:(_source:string,model:string)=>model,meteredTransport:(transport:unknown)=>transport,
  createProtocolProvider:(profile:ProviderProfile)=>({probe:(signal:AbortSignal)=>new Promise((resolve,reject)=>{probes.push({signal,model:profile.model,resolve:()=>resolve({value:{...profile.capabilities,verified:true}}),reject})})})
 }
 vm.runInNewContext(code,sandbox)
 const runtime=sandbox.exports as Runtime
 return {...runtime,probes,quota,accounts,close:()=>memory.close(),disable:()=>{enabled=false},advance:()=>{clock+=31000},calls:()=>calls}
}
const input=(model='model-a')=>({source:'byok' as const,endpoint:`https://${model}.example`,model,key:'fixture-only'})
const signal=()=>new AbortController().signal
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve()}
let checks=0
async function check(name:string,action:(f:ReturnType<typeof fixture>)=>Promise<void>){const f=fixture();try{await action(f);console.log(`PASS C${++checks} ${name}`)}finally{f.close()}}
await check('并发 BYOK B 被拒且不写配置，A 的配置/模型一致',async f=>{
 const a=f.connectExternal(1,'user:1',input(),signal());await tick()
 await assert.rejects(f.connectExternal(1,'user:1',input('model-b'),signal()),/CONNECTION_BUSY/)
 assert.equal(JSON.parse(f.accounts.get(1)!.ai_config).model,'model-a');f.probes[0].resolve();await a
 assert.equal(f.externalStatus(1).model,'model-a');assert(f.externalStatus(1).ready);assert.equal(f.calls(),1)
})
await check('BYOK 探测期间切服务器也不改变账号选择',async f=>{
 const a=f.connectExternal(1,'user:1',input(),signal());await tick()
 await assert.rejects(f.connectExternal(1,'user:1',{source:'server'},signal()),/CONNECTION_BUSY/)
 assert.equal(JSON.parse(f.accounts.get(1)!.ai_config).provider,'byok');f.probes[0].resolve();await a
})
await check('其他配置入口在探测中修改配置，旧结果被丢弃',async f=>{
 const a=f.connectExternal(1,'user:1',input(),signal());await tick()
 f.accounts.get(1)!.ai_config=JSON.stringify({provider:'byok',endpoint:'https://model-b.example',model:'model-b'})
 f.probes[0].resolve();await assert.rejects(a,/PROVIDER_CHANGED/);assert(!f.externalStatus(1).ready)
})
await check('退出/清除连接中止信号，忽略取消的供应商晚到也不复活',async f=>{
 const a=f.connectExternal(1,'user:1',input(),signal());await tick();f.forgetConnection(1)
 assert(f.probes[0].signal.aborted);await assert.rejects(a,/PROVIDER_CHANGED/)
 f.probes[0].resolve();await tick();assert(!f.externalStatus(1).ready)
})
await check('撤销旧请求后新连接成功，旧探测晚到不覆盖新模型或释放新锁',async f=>{
 const a=f.connectExternal(1,'user:1',input(),signal());await tick();f.forgetConnection(1);await assert.rejects(a,/PROVIDER_CHANGED/)
 const b=f.connectExternal(1,'user:1',input('model-b'),signal());await tick();f.probes[0].resolve();await tick()
 await assert.rejects(f.connectExternal(1,'user:1',input('model-c'),signal()),/CONNECTION_BUSY/)
 f.probes[1].resolve();await b;assert.equal(f.externalStatus(1).model,'model-b')
})
await check('已完成连接可撤销，其他账号连接保持独立',async f=>{
 const a=f.connectExternal(1,'user:1',input(),signal()),b=f.connectExternal(2,'user:2',input('model-b'),signal());await tick()
 f.probes.forEach(p=>p.resolve());await Promise.all([a,b]);f.forgetConnection(1)
 assert(!f.externalStatus(1).ready);assert(f.externalStatus(2).ready)
})
await check('token version 改变阻止旧探测激活',async f=>{
 const a=f.connectExternal(1,'user:1',input(),signal());await tick();f.accounts.get(1)!.token_version++;f.probes[0].resolve()
 await assert.rejects(a,/AUTH_REQUIRED/);assert(!f.externalStatus(1).ready)
})
await check('管理员在探测中关闭 AI，结果不激活',async f=>{
 const a=f.connectExternal(1,'user:1',input(),signal());await tick();f.disable();f.probes[0].resolve();await assert.rejects(a,/AGENT_AI_DISABLED/)
 assert(!f.externalStatus(1).ready)
})
await check('无效 BYOK 选择保持 BYOK，不回落服务器且释放锁',async f=>{
 await assert.rejects(f.connectExternal(1,'user:1',input('invalid'),signal()),/ENDPOINT_NOT_ALLOWED/)
 assert.equal(f.externalStatus(1).source,'byok');await assert.rejects(f.prepareExternal(1,'user:1',signal()),/PROVIDER_CONNECTION_REQUIRED/)
 const a=f.connectExternal(1,'user:1',input(),signal());await tick();f.probes[0].resolve();await a
})
await check('已取消的请求无配置或额度副作用',async f=>{
 const c=new AbortController();c.abort(new AgentRunError('CANCELLED'))
 await assert.rejects(f.connectExternal(1,'user:1',input(),c.signal),/CANCELLED/)
 assert.equal(f.externalStatus(1).source,'server');assert.equal(f.quota.status('user:1').turns,0);assert.equal(f.calls(),0)
})
await check('真实 SQLite 单访客日额度失败不毒化下一访客',async f=>{
 await f.quota.turn('spent',true,true,async()=>{})
 await assert.rejects(f.prepareExternal(null,'spent',signal()),/DAILY_QUOTA/);await tick()
 const b=f.prepareExternal(null,'fresh',signal());await tick();assert.equal(f.probes.length,1);f.probes[0].resolve();await b
 assert.equal(f.quota.status('spent').turns,1);assert.equal(f.quota.status('fresh').turns,1)
})
await check('同时等待者不继承他人额度错误，且不自动发付费请求',async f=>{
 await f.quota.turn('spent',true,true,async()=>{})
 const a=f.prepareExternal(null,'spent',signal()),b=f.prepareExternal(null,'fresh',signal())
 await Promise.all([assert.rejects(a,/DAILY_QUOTA/),assert.rejects(b,/PROVIDER_CONNECTION_REQUIRED/)])
 assert.equal(f.calls(),0);assert.equal(f.quota.status('fresh').turns,0)
})
await check('共享准备仅一次探测，完成后两名等待者就绪',async f=>{
 const a=f.prepareExternal(null,'first',signal()),b=f.prepareExternal(null,'second',signal());await tick()
 assert.equal(f.calls(),1);f.probes[0].resolve();assert((await a).ready);assert((await b).ready)
})
await check('发起者取消不缓存成全局失败；等待者不继承取消也不重试',async f=>{
 const c=new AbortController(),a=f.prepareExternal(null,'first',c.signal),b=f.prepareExternal(null,'second',signal());await tick()
 c.abort(new AgentRunError('CANCELLED'));await Promise.all([assert.rejects(a,/CANCELLED/),assert.rejects(b,/PROVIDER_CONNECTION_REQUIRED/)])
 assert(f.probes[0].signal.aborted);assert.equal(f.calls(),1);await tick()
 const next=f.prepareExternal(null,'third',signal());await tick();f.probes[1].resolve();await next
})
await check('等待者取消不终止发起者探测',async f=>{
 const c=new AbortController(),a=f.prepareExternal(null,'first',signal()),b=f.prepareExternal(null,'second',c.signal);await tick()
 c.abort(new AgentRunError('CANCELLED'));await assert.rejects(b,/CANCELLED/);assert(!f.probes[0].signal.aborted)
 f.probes[0].resolve();await a;assert.equal(f.calls(),1)
})
await check('供应商 HTTP 错误仍短期共享，过期仅手动请求触发一次探测',async f=>{
 const a=f.prepareExternal(null,'first',signal());await tick();f.probes[0].reject(new AgentRunError('PROVIDER_HTTP_429',503));await assert.rejects(a,/PROVIDER_HTTP_429/);await tick()
 await assert.rejects(f.prepareExternal(null,'second',signal()),/PROVIDER_HTTP_429/);assert.equal(f.calls(),1)
 f.advance();const b=f.prepareExternal(null,'third',signal());await tick();assert.equal(f.calls(),2);f.probes[1].resolve();await b
})
await check('账号退出中止其服务器准备，下一访客不继承身份错误',async f=>{
 const a=f.prepareExternal(1,'user:1',signal());await tick();f.forgetConnection(1);await assert.rejects(a,/PROVIDER_CHANGED/);await tick()
 assert(f.probes[0].signal.aborted);const b=f.prepareExternal(null,'fresh',signal());await tick();f.probes[1].resolve();await b
})
console.log(`Agent connection regression: ${checks} passed; real API calls: 0`)
