import type Database from 'better-sqlite3'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { AgentRunError } from '../../shared/agent-run'
import { estimateCost, type PriceCard } from './policy'
import { logAgentIssue } from './diagnostics'

export interface ExternalLimits {
  globalDailyCost:number; userDailyCost:number; guestDailyCost:number; turnCost:number; guestTurnCost:number
  warningCost:number; userTurns:number; guestTurns:number; concurrency:number; dailyTokens:number; turnTokens:number
}
// 按 DeepSeek 峰时价（in $0.44/M、out $1.32/M）与修正后的 token 估算实测标定，USD：
//   单次模型调用：预授权 $0.0065、实际结算 $0.0038
//   普通问答（2 次调用）$0.010 ／ 一次工具+回答（4 次）$0.018
//   设计允许的最长回合（AGENT_LIMITS.toolRounds=12，即 13 次调用）峰值 $0.052
//   userTurns=30 的一天 ≈ $0.225
// 上限必须装得下设计上合法的最长回合，否则额度表和工具轮数自相矛盾——旧值 turnCost=$0.03
// 连 13 次调用的一半都装不下，userDailyCost=$0.1 也装不下自己允许的 30 轮，正常用就会 COST_LIMIT。
// 每项都留约 1.5 倍余量给更长的上下文与工具结果；需要更严可用 AGENT_LIMITS_JSON 覆盖。
export const CONSERVATIVE_LIMITS:ExternalLimits={globalDailyCost:5,userDailyCost:0.5,guestDailyCost:0.15,turnCost:0.08,guestTurnCost:0.04,
  warningCost:0.02,userTurns:30,guestTurns:10,concurrency:2,dailyTokens:3_000_000,turnTokens:400_000}
interface Scope {id:string;owner:string;guest:boolean;project:boolean;day:string;lease:string}
export class ExternalQuota {
  private readonly scope=new AsyncLocalStorage<Scope>()
  constructor(private readonly db:Database.Database,readonly limits:ExternalLimits,private readonly now=Date.now){
    if(Object.keys(limits).some(k=>!Object.hasOwn(CONSERVATIVE_LIMITS,k))||Object.values(limits).some(n=>!Number.isFinite(n)||n<=0)||['userTurns','guestTurns','concurrency','dailyTokens','turnTokens'].some(k=>!Number.isSafeInteger(limits[k as keyof ExternalLimits]))||limits.warningCost>limits.turnCost||limits.warningCost>limits.guestTurnCost)throw new Error('INVALID_QUOTA')
    db.exec(`CREATE TABLE IF NOT EXISTS agent_ai_budget (day TEXT NOT NULL,owner TEXT NOT NULL,tokens INTEGER NOT NULL DEFAULT 0,cost REAL NOT NULL DEFAULT 0,turns INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,owner));
      CREATE TABLE IF NOT EXISTS agent_ai_leases (id TEXT PRIMARY KEY,owner TEXT NOT NULL UNIQUE,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_ai_turn_budget (id TEXT PRIMARY KEY,day TEXT NOT NULL,tokens INTEGER NOT NULL DEFAULT 0,cost REAL NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS agent_ai_usage (id TEXT PRIMARY KEY,turn_id TEXT NOT NULL,day TEXT NOT NULL,operation TEXT NOT NULL,model TEXT NOT NULL,input_tokens INTEGER,output_tokens INTEGER,cached_tokens INTEGER,duration_ms INTEGER NOT NULL DEFAULT 0,cost REAL NOT NULL,price_version TEXT NOT NULL,state TEXT NOT NULL);`)
  }
  // counted=false:连接探测。仍占并发租约、仍计 token 与费用,但不消耗「每日对话轮次」——
  // 用户没发消息也会因连接过期(30 分钟)自动重连,把探测算成一轮会凭空吃光额度。
  async turn<T>(owner:string,guest:boolean,project:boolean,action:()=>Promise<T>,counted=true):Promise<T>{
    const active=this.scope.getStore();if(active){if(active.owner!==owner||active.guest!==guest||active.project!==project)throw new AgentRunError('AUTH_REQUIRED',401);return action()}
    const day=new Date(this.now()).toISOString().slice(0,10),id=randomUUID(),lease=randomUUID()
    this.db.transaction(()=>{
      this.db.prepare('DELETE FROM agent_ai_leases WHERE expires<=?').run(this.now())
      this.db.prepare('DELETE FROM agent_ai_budget WHERE day<?').run(day)
      this.db.prepare('DELETE FROM agent_ai_turn_budget WHERE day<?').run(day)
      this.db.prepare('DELETE FROM agent_ai_usage WHERE day<?').run(day)
      if(this.db.prepare('SELECT 1 FROM agent_ai_leases WHERE owner=?').get(owner))throw new AgentRunError('RUN_BUSY')
      if((this.db.prepare('SELECT count(*) n FROM agent_ai_leases').get() as {n:number}).n>=this.limits.concurrency)throw new AgentRunError('GLOBAL_BUSY',429)
      const row=this.read(day,owner)
      if(counted&&row.turns>=(guest?this.limits.guestTurns:this.limits.userTurns))throw new AgentRunError('DAILY_QUOTA',429)
      this.db.prepare('INSERT INTO agent_ai_leases VALUES(?,?,?)').run(lease,owner,this.now()+660_000)
      this.add(day,owner,0,0,counted?1:0)
      logAgentIssue('quota',{kind:counted?'turn':'probe',owner,day,
        turns:`${row.turns+(counted?1:0)}/${guest?this.limits.guestTurns:this.limits.userTurns}`,
        cost:`${row.cost.toFixed(4)}/${guest?this.limits.guestDailyCost:this.limits.userDailyCost}`})
      this.db.prepare('INSERT INTO agent_ai_turn_budget(id,day) VALUES(?,?)').run(id,day)
    })()
    try{return await this.scope.run({id,owner,guest,project,day,lease},action)}finally{this.db.prepare('DELETE FROM agent_ai_leases WHERE id=?').run(lease)}
  }
  private read(day:string,owner:string){return this.db.prepare('SELECT tokens,cost,turns FROM agent_ai_budget WHERE day=? AND owner=?').get(day,owner) as {tokens:number;cost:number;turns:number}|undefined??{tokens:0,cost:0,turns:0}}
  private add(day:string,owner:string,tokens:number,cost:number,turns=0){this.db.prepare(`INSERT INTO agent_ai_budget VALUES(?,?,?,?,?) ON CONFLICT(day,owner) DO UPDATE SET tokens=tokens+excluded.tokens,cost=cost+excluded.cost,turns=turns+excluded.turns`).run(day,owner,tokens,cost,turns)}
  reserve(input:number,output:number,price:PriceCard,meta:{operation:string;model:string}={operation:'unspecified',model:'unspecified'}){
    const s=this.scope.getStore();if(!s)throw new AgentRunError('BUDGET_CONTEXT_REQUIRED',503)
    if(new Date(this.now()).toISOString().slice(0,10)!==s.day)throw new AgentRunError('DAILY_QUOTA',429)
    const recordId=randomUUID(),started=this.now()
    const tokens=input+output,cost=estimateCost(input,0,output,price)!
    this.db.transaction(()=>{
      if(!(this.db.prepare('SELECT 1 FROM agent_ai_leases WHERE id=? AND expires>?').get(s.lease,this.now())))throw new AgentRunError('ACTIVE_LIMIT')
      const day=this.read(s.day,s.owner),global=this.read(s.day,'project'),turn=this.db.prepare('SELECT tokens,cost FROM agent_ai_turn_budget WHERE id=?').get(s.id) as {tokens:number;cost:number}
      if(turn.tokens+tokens>this.limits.turnTokens||day.tokens+tokens>this.limits.dailyTokens||turn.cost+cost>(s.guest?this.limits.guestTurnCost:this.limits.turnCost)
        ||day.cost+cost>(s.guest?this.limits.guestDailyCost:this.limits.userDailyCost)||s.project&&global.cost+cost>this.limits.globalDailyCost)throw new AgentRunError('COST_LIMIT',429)
      this.add(s.day,s.owner,tokens,cost);if(s.project)this.add(s.day,'project',tokens,cost)
      this.db.prepare('UPDATE agent_ai_turn_budget SET tokens=tokens+?,cost=cost+? WHERE id=?').run(tokens,cost,s.id)
      this.db.prepare('INSERT INTO agent_ai_usage(id,turn_id,day,operation,model,cost,price_version,state) VALUES(?,?,?,?,?,?,?,?)').run(recordId,s.id,s.day,meta.operation,meta.model,cost,price.version,'reserved')
    })()
    let settled=false
    return (actual:{input:number;output:number;cached:number}|null)=>{
      if(settled)return;settled=true
      // 取消、网络中断或供应商未报 usage 保留整笔预留，避免未知费用被当成免费。
      if(!actual){this.db.prepare("UPDATE agent_ai_usage SET duration_ms=?,state='unknown' WHERE id=?").run(this.now()-started,recordId);return}
      const actualCost=estimateCost(actual.input,actual.cached,actual.output,price)!,deltaTokens=actual.input+actual.output-tokens,deltaCost=actualCost-cost
      this.db.transaction(()=>{this.add(s.day,s.owner,deltaTokens,deltaCost);if(s.project)this.add(s.day,'project',deltaTokens,deltaCost)
        this.db.prepare('UPDATE agent_ai_turn_budget SET tokens=tokens+?,cost=cost+? WHERE id=?').run(deltaTokens,deltaCost,s.id)
        this.db.prepare("UPDATE agent_ai_usage SET input_tokens=?,output_tokens=?,cached_tokens=?,duration_ms=?,cost=?,state='reported' WHERE id=?").run(actual.input,actual.output,actual.cached,this.now()-started,actualCost,recordId)})()
    }
  }
  status(owner:string){const day=new Date(this.now()).toISOString().slice(0,10);return{...this.read(day,owner),currency:'USD',warningCost:this.limits.warningCost,limits:this.limits}}
}
