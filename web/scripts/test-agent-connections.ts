import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import Database from 'better-sqlite3'
import { ExternalQuota, CONSERVATIVE_LIMITS } from '../server/agent/external-quota'
import { AgentRunError } from '../shared/agent-run'
import type { ProviderProfile } from '../server/agent/context-provider'
import { checkPlan } from './agent-fixtures'

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
const settlePlan = checkPlan('C', 17, () => checks)
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
// 这两条原本等一个 DAILY_QUOTA：那是 connectExternal 还会消耗每日轮次时的写法。
// 「探测不再消耗每日轮次」（见 perf(web): 减少 Agent 请求预算并修复限流）之后 counted=false，
// DAILY_QUOTA 再也不会从这条路出现，两条用例就死等一个不会来的拒绝——探测也没人 resolve，
// 于是永久挂起，把它们后面 7 条用例一起静默带走（进程以 13 退出，套件却没人发现）。
// 改成断言现在真正成立的语义。
await check('探测不消耗每日轮次：轮次用光的访客仍能建立连接，并被下一访客复用',async f=>{
 await f.quota.turn('spent',true,true,async()=>{})
 assert.equal(f.quota.status('spent').turns,1)
 const a=f.prepareExternal(null,'spent',signal());await tick()
 assert.equal(f.probes.length,1);f.probes[0].resolve();assert((await a).ready)
 assert.equal(f.quota.status('spent').turns,1)
 // 全站共享这一条：下一访客直接复用，不再发第二次付费探测
 assert((await f.prepareExternal(null,'fresh',signal())).ready);assert.equal(f.calls(),1)
})
await check('同时等待者不继承发起者的非共享错误，也不自动补一次付费探测',async f=>{
 const a=f.prepareExternal(null,'first',signal()),b=f.prepareExternal(null,'second',signal());await tick()
 assert.equal(f.calls(),1)
 f.probes[0].reject(new AgentRunError('DAILY_QUOTA',429))
 await Promise.all([assert.rejects(a,/DAILY_QUOTA/),assert.rejects(b,/PROVIDER_CONNECTION_REQUIRED/)])
 assert.equal(f.calls(),1)
})
await check('共享准备仅一次探测，完成后两名等待者就绪',async f=>{
 const a=f.prepareExternal(null,'first',signal()),b=f.prepareExternal(null,'second',signal());await tick()
 assert.equal(f.calls(),1);f.probes[0].resolve();assert((await a).ready);assert((await b).ready)
})
// 这条原本断言「发起者取消 → 共享探测一起 abort」。改掉了，因为那个语义有两处站不住：
//  1. 发起者只是碰巧第一个到的人，凭什么他刷新页面就把全站共用的那条连接掐掉；
//  2. abort 根本不省钱 —— reserve 已经付过，settle(null) 按 unknown 保留整笔预留，
//     中途取消等于「照付全款、什么也没换到」，下次加载还得再付一次。
// 现在共享探测跑在自己的超时信号上，谁都可以停止等待，活照做完并缓存 30 分钟。
await check('发起者离开不再掐断共享探测：等待者照常拿到连接，钱不白花',async f=>{
 const c=new AbortController(),a=f.prepareExternal(null,'first',c.signal),b=f.prepareExternal(null,'second',signal());await tick()
 c.abort(new AgentRunError('CANCELLED'));await assert.rejects(a,/CANCELLED/)
 assert(!f.probes[0].signal.aborted)
 f.probes[0].resolve();assert((await b).ready);assert.equal(f.calls(),1)
 // 已经缓存，后来者不再触发第二次付费探测
 assert((await f.prepareExternal(null,'third',signal())).ready);assert.equal(f.calls(),1)
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
settlePlan()
console.log(`Agent connection regression: ${checks} passed; real API calls: 0`)
