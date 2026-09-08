import { randomUUID } from 'node:crypto'
import { AGENT_TOOLS, MODEL_OUTPUT_SCHEMA, type AgentToolName, type AgentUsage, type JsonValue } from '../../shared/agent-contracts'
import { ASSISTANT_UPDATE_SCHEMA, AgentHistoryError, type AssistantMessageContent, type HistorySource } from '../../shared/agent-history'
import { AgentRunError, RUN_LIMITS, START_RUN_SCHEMA, RESUME_RUN_SCHEMA, type StartRun, type ResumeRun, type ReadToolCall, type RunCheckpoint } from '../../shared/agent-run'
import { AGENT_LIMITS, AGENT_SYSTEM_RULES } from './policy'
import type { AgentContextService } from './context-service'
import { estimateContextTokens } from './context-provider'
import { AgentRunStore, type RunRow } from './run-store'
import { knowledgeHash, requireSameKnowledge, type KnowledgeSnapshot } from './knowledge'
import { matchesContract, parseToolRequest, validateModelOutput, validateToolResult } from './validation'

export interface RunModelRequest {
  system: string; knowledge: KnowledgeSnapshot; layers: unknown[]; nativeState: unknown
  tools: Partial<typeof AGENT_TOOLS>; results: RunCheckpoint['results']; outputSchema: typeof MODEL_OUTPUT_SCHEMA
}
export type RunProviderEvent = { type: 'delta'; text: string } | { type: 'output'; value: unknown } | { type: 'usage'; usage: AgentUsage }
export interface RunProvider {
  source: 'server' | 'byok'; model: string; fingerprint: string
  stream(request: RunModelRequest, signal: AbortSignal): AsyncIterable<RunProviderEvent>
}
export interface ReadTool {
  name: AgentToolName
  execute(args: Record<string,JsonValue>, actor: {uid:number;knowledgeVersion:string;signal:AbortSignal}): Promise<unknown>
}
export interface RunBinding {
  provider: RunProvider; context: AgentContextService; tools: readonly ReadTool[]
  knowledge(): KnowledgeSnapshot
  assertIdentity(): void
}
export type RunResolver = (uid:number,sessionId:string) => RunBinding | Promise<RunBinding>
type Controls = { heartbeatMs: number; idleMs: number; softTargetMs: number; longTaskMs: number; activeTurnMs: number; toolRounds: number }
const outputError = (): never => { throw new AgentRunError('INVALID_OUTPUT') }
function json(value: unknown): JsonValue {
  let encoded: string
  try { encoded=JSON.stringify(value) } catch { return outputError() }
  if(typeof encoded!=='string'||Buffer.byteLength(encoded)>RUN_LIMITS.modelOutputBytes)return outputError()
  return JSON.parse(encoded) as JsonValue
}
function waitBounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if(signal.aborted)return Promise.reject(signal.reason)
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason)}
    signal.addEventListener('abort',abort,{once:true})
    promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value)},error=>{signal.removeEventListener('abort',abort);reject(error)})
  })
}
const emptyContent = (): AssistantMessageContent => ({body:'',status:'streaming',sources:[],toolSummaries:[],actions:[],usage:[]})

export class AgentRunService {
  private readonly controllers = new Map<string,AbortController>()
  private readonly pending = new Map<string,Promise<void>>()
  private readonly controls: Controls
  constructor(readonly store:AgentRunStore,private readonly resolve:RunResolver,controls:Partial<Controls>={}) {
    this.controls={heartbeatMs:AGENT_LIMITS.heartbeatMs,idleMs:AGENT_LIMITS.idleMs,softTargetMs:AGENT_LIMITS.softTargetMs,
      longTaskMs:AGENT_LIMITS.longTaskMs,activeTurnMs:AGENT_LIMITS.activeTurnMs,toolRounds:AGENT_LIMITS.toolRounds,...controls}
    for(const [key,value] of Object.entries(this.controls))if(!Number.isSafeInteger(value)||value<1||value>AGENT_LIMITS[key as keyof Controls])throw new Error('INVALID_RUN_LIMITS')
  }
  private checkBinding(binding:RunBinding): KnowledgeSnapshot {
    binding.assertIdentity()
    const knowledge=binding.knowledge()
    if(knowledge.status!=='ready')throw new AgentRunError('KNOWLEDGE_PENDING_SYNC')
    if(new Set(binding.tools.map(t=>t.name)).size!==binding.tools.length
      ||binding.tools.some(t=>!Object.hasOwn(AGENT_TOOLS,t.name)||AGENT_TOOLS[t.name].mode!=='read')
      ||knowledge.tools.some(t=>!binding.tools.some(registered=>registered.name===t)))throw new AgentRunError('UNREGISTERED_TOOL')
    if(!['server','byok'].includes(binding.provider.source)||!binding.provider.model.trim()||binding.provider.model.length>100||!binding.provider.fingerprint)throw new AgentRunError('PROVIDER_CAPABILITY')
    return knowledge
  }
  async start(uid:number,sessionId:string,input:unknown,authVersion:number){
    if(!matchesContract(START_RUN_SCHEMA,input))throw new AgentRunError('INVALID_ARGUMENT',400)
    const p=input as StartRun
    if(!p.body.trim()||p.body.trim()==='/compact')throw new AgentRunError('INVALID_ARGUMENT',400)
    this.store.recover()
    const binding=await waitBounded(Promise.resolve(this.resolve(uid,sessionId)),AbortSignal.timeout(30_000)),knowledge=this.checkBinding(binding)
    const result=this.store.begin(uid,sessionId,p,knowledge,authVersion)
    if(result.fresh)this.launch(result.row,binding)
    return this.store.view(result.row)
  }
  async resume(uid:number,id:string,input:unknown,authVersion:number){
    if(!matchesContract(RESUME_RUN_SCHEMA,input))throw new AgentRunError('INVALID_ARGUMENT',400)
    this.store.recover();const resumed=this.store.row(uid,id)
    const binding=await waitBounded(Promise.resolve(this.resolve(uid,resumed.session_id)),AbortSignal.timeout(30_000)),knowledge=this.checkBinding(binding)
    const result=this.store.resume(uid,id,input as ResumeRun,knowledge,authVersion)
    if(result.fresh)this.launch(result.row,binding)
    return this.store.view(result.row)
  }
  private launch(row:RunRow,binding:RunBinding){
    const controller=new AbortController();this.controllers.set(row.id,controller)
    const promise=Promise.resolve().then(()=>this.run(row,binding,controller)).finally(()=>{
      if(this.controllers.get(row.id)===controller){this.controllers.delete(row.id);this.pending.delete(row.id)}
    })
    this.pending.set(row.id,promise)
  }
  async wait(id:string){await this.pending.get(id)}
  status(uid:number,id:string){this.store.recover();return this.store.view(this.store.row(uid,id))}
  cancel(uid:number,id:string){
    const row=this.store.row(uid,id)
    this.controllers.get(id)?.abort(new AgentRunError('CANCELLED'))
    if(row.state==='paused'){
      this.store.db.prepare("UPDATE agent_runs SET state='cancelled',code='CANCELLED',updated_at=? WHERE user_id=? AND id=?").run(this.store.now(),uid,id)
      this.store.event(uid,id,'cancelled',{code:'CANCELLED',attempt:row.attempt},true)
    } else if(!this.controllers.has(id))this.store.finish(uid,id,'cancelled','CANCELLED')
    return this.store.view(this.store.row(uid,id))
  }
  async close(){for(const controller of this.controllers.values())controller.abort(new AgentRunError('INTERRUPTED'));await Promise.all(this.pending.values())}

  private async run(initial:RunRow,binding:RunBinding,controller:AbortController){
    const uid=initial.user_id,id=initial.id,attempt=initial.attempt,signal=controller.signal,now=this.store.now
    const knowledge=this.store.knowledge(initial),checkpoint=this.store.checkpoint(initial),content=emptyContent()
    let lastProgress=now(),lastFlush=now(),flushedChars=0,soft=false,long=false,compactId:string|null=null,compactStage=''
    let messageReady=false,iterator:AsyncIterator<RunProviderEvent>|undefined,modelUsageIndex:number|null=null,modelStarted=now(),usageReported=false
    const guard=()=>{
      signal.throwIfAborted();this.store.assertActive(this.store.row(uid,id),attempt)
      this.store.assertIdentity(uid,initial.auth_version);binding.assertIdentity();requireSameKnowledge(knowledge,binding.knowledge())
      const elapsed=now()-initial.started_at
      if(!soft&&elapsed>=this.controls.softTargetMs){soft=true;this.store.event(uid,id,'soft_limit',{elapsedMs:elapsed})}
      if(!long&&elapsed>=this.controls.longTaskMs){long=true;this.store.event(uid,id,'long_task',{elapsedMs:elapsed})}
      if(initial.active_ms+elapsed>=AGENT_LIMITS.cumulativeTaskMs)throw new AgentRunError('CUMULATIVE_LIMIT')
      if(elapsed>=this.controls.activeTurnMs)throw new AgentRunError('ACTIVE_LIMIT')
      if(now()-lastProgress>=this.controls.idleMs)throw new AgentRunError('IDLE_TIMEOUT')
    }
    const progress=()=>{lastProgress=now()}
    const save=()=>this.store.save(uid,id,attempt,checkpoint)
    const persist=()=>{content.usage=[...checkpoint.usage];this.store.writeMessage(uid,id,attempt,content);messageReady=true}
    const flush=()=>{
      if(content.body.length===flushedChars)return
      persist();this.store.event(uid,id,'delta',{text:content.body.slice(flushedChars),messageId:this.store.row(uid,id).message_id})
      flushedChars=content.body.length;lastFlush=now()
    }
    const checkedUsage=(raw:AgentUsage)=>{
      const usage=json(raw) as unknown as AgentUsage
      if(!matchesContract(ASSISTANT_UPDATE_SCHEMA,{...emptyContent(),expectedRevision:0,usage:[usage]})
        ||usage.provider!==binding.provider.source||usage.model!==binding.provider.model
        ||(usage.cachedInputTokens!==null&&(usage.inputTokens===null||usage.cachedInputTokens>usage.inputTokens)))outputError()
      return usage
    }
    const pushUsage=(raw:AgentUsage)=>{if(checkpoint.usage.length>=100)outputError();checkpoint.usage.push(checkedUsage(raw));save()}
    const finishModelUsage=()=>{
      if(modelUsageIndex!==null){checkpoint.usage[modelUsageIndex].durationMs=Math.max(0,now()-modelStarted);modelUsageIndex=null;save()}
    }
    const known=new Map<string,HistorySource>()
    const addSources=(sources:HistorySource[])=>{
      for(const source of sources){const old=known.get(source.sourceId);if(old&&knowledgeHash(old)!==knowledgeHash(source))outputError();known.set(source.sourceId,source)}
    }
    const timer=setInterval(()=>{
      try {
        signal.throwIfAborted();this.store.assertActive(this.store.row(uid,id),attempt)
        if(compactId){const job=binding.context.store.job(uid,compactId);if(job.stage!==compactStage){compactStage=job.stage;progress();this.store.event(uid,id,'context',{state:'compacting',stage:job.stage})}}
        guard();this.store.renew(uid,id,attempt)
      } catch(error){controller.abort(error)}
    },this.controls.heartbeatMs)
    try {
      guard()
      this.store.event(uid,id,'knowledge',{version:knowledge.version,release:knowledge.release,status:knowledge.status,
        clientStale:initial.client_version!==null&&initial.client_version!==knowledge.release,refreshRequired:initial.client_version!==null&&initial.client_version!==knowledge.release})
      const transcript=binding.context.store.transcript(uid,initial.session_id)
      const question=transcript.messages.find(m=>m.id===initial.user_message_id)?.body
      if(!question)throw new AgentRunError('STALE_TURN')
      let prepared=await waitBounded(binding.context.prepare(uid,initial.session_id,{requestId:randomUUID(),expectedRevision:transcript.session.revision,question},
        {runId:id,signal,additionalInput:knowledge,provider:binding.provider}),signal)
      if(prepared.state==='compacting'){
        compactId=prepared.job.id;this.store.event(uid,id,'context',{state:'compacting',jobId:compactId});progress()
        await waitBounded(binding.context.wait(compactId),signal);guard()
        const job=binding.context.store.job(uid,compactId);compactId=null
        if(!['completed','skipped'].includes(job.stage))throw new AgentRunError(job.errorCode??'CONTEXT_FAILED')
        if(job.usage.length){const first=job.usage[0];pushUsage({...first,operation:'compact',inputTokens:job.usage.some(u=>u.inputTokens===null)?null:job.usage.reduce((n,u)=>n+(u.inputTokens??0),0),
          outputTokens:job.usage.some(u=>u.outputTokens===null)?null:job.usage.reduce((n,u)=>n+(u.outputTokens??0),0),cachedInputTokens:job.usage.some(u=>u.cachedInputTokens===null)?null:job.usage.reduce((n,u)=>n+(u.cachedInputTokens??0),0),
          durationMs:job.usage.reduce((n,u)=>n+u.durationMs,0),estimatedCost:null,resultCount:job.summaryVersion===null?0:1})}
        prepared=await waitBounded(binding.context.prepare(uid,initial.session_id,{requestId:randomUUID(),expectedRevision:binding.context.store.session(uid,initial.session_id).revision,question},{runId:id,signal,additionalInput:knowledge,provider:binding.provider}),signal)
        if(prepared.state!=='ready'){compactId=prepared.job.id;throw new AgentRunError('CONTEXT_BUDGET')}
      }
      guard();progress()
      const view=prepared.view
      for(const message of transcript.messages)addSources(message.sources)
      const tools=Object.fromEntries(knowledge.tools.map(name=>[name,AGENT_TOOLS[name]])) as Partial<typeof AGENT_TOOLS>
      const layers=view.layers.filter(layer=>layer.kind!=='tool_contracts'&&layer.kind!=='system_rules_and_persona'&&layer.kind!=='server_capabilities')
      const callCounts=new Map<AgentToolName,number>()
      this.store.event(uid,id,'context',{state:'ready',summaryVersion:view.summaryVersion,estimatedTokens:view.estimatedTokens})
      persist()
      for(;;){
        guard()
        if(this.store.row(uid,id).rounds>=this.controls.toolRounds)throw new AgentRunError('ROUND_LIMIT')
        const request:RunModelRequest={system:AGENT_SYSTEM_RULES,knowledge,layers,nativeState:view.nativeState,tools,results:checkpoint.results,outputSchema:MODEL_OUTPUT_SCHEMA}
        if(estimateContextTokens(request)>view.budget.maxInputTokens)throw new AgentRunError('CONTEXT_BUDGET')
        checkpoint.inFlight='model';save();this.store.event(uid,id,'model_started',{round:this.store.row(uid,id).rounds,provider:binding.provider.source,model:binding.provider.model})
        let output:JsonValue|undefined,hadDelta=false
        modelStarted=now();usageReported=false;modelUsageIndex=checkpoint.usage.length
        pushUsage({operation:'model',provider:binding.provider.source,model:binding.provider.model,inputTokens:null,cachedInputTokens:null,outputTokens:null,durationMs:0,resultCount:0,estimatedCost:null,currency:null,priceVersion:null})
        iterator=binding.provider.stream(structuredClone(request),signal)[Symbol.asyncIterator]()
        for(;;){
          const step=await waitBounded(iterator.next(),signal);guard()
          if(step.done)break
          const event=step.value
          if(!event||typeof event!=='object')outputError()
          if(event.type==='delta'){
            if(output!==undefined||typeof event.text!=='string'||!event.text.length||content.body.length+event.text.length>RUN_LIMITS.answerChars)outputError()
            content.body+=event.text;hadDelta=true
            if(content.body.length-flushedChars>=256||now()-lastFlush>=150)flush()
          }else if(event.type==='output'){
            if(output!==undefined)outputError()
            output=json(event.value);validateModelOutput(output,uid,[...known.keys()])
          }else if(event.type==='usage'){
            if(event.usage.operation!=='model'||usageReported||modelUsageIndex===null)outputError();usageReported=true;checkpoint.usage[modelUsageIndex!]=checkedUsage(event.usage);save()
          }else outputError()
          progress()
        }
        iterator=undefined;finishModelUsage();checkpoint.inFlight=null
        if(output===undefined)outputError()
        const value=output as unknown as {kind:string;text:string;sourceIds:string[];calls:ReadToolCall[]}
        if(value.kind==='answer'){
          if(hadDelta&&content.body!==value.text)outputError()
          content.body=value.text;content.sources=value.sourceIds.map(sourceId=>known.get(sourceId)!)
          guard();save();persist();flush();this.store.finish(uid,id,'completed',null);return
        }
        if(hadDelta||content.body.length)outputError()
        const calls=value.calls.map(call=>parseToolRequest(call,uid))
        for(const call of calls){
          if(!knowledge.tools.includes(call.name)||!binding.tools.some(tool=>tool.name===call.name)||AGENT_TOOLS[call.name].mode!=='read')throw new AgentRunError('UNREGISTERED_TOOL')
          const count=(callCounts.get(call.name)??0)+1
          if(count>AGENT_TOOLS[call.name].maxCallsPerTurn)throw new AgentRunError('TOOL_LIMIT')
          callCounts.set(call.name,count)
        }
        checkpoint.pendingCalls=[...calls];this.store.save(uid,id,attempt,checkpoint,this.store.row(uid,id).rounds+1)
        for(const call of calls){
          guard();checkpoint.inFlight='tool';save()
          this.store.event(uid,id,'tool_started',{name:call.name})
          const started=now(),tool=binding.tools.find(tool=>tool.name===call.name)!
          const toolSignal=AbortSignal.any([signal,AbortSignal.timeout(AGENT_TOOLS[call.name].timeoutMs)])
          let result:JsonValue
          try{result=json(await waitBounded(tool.execute(call.arguments,{uid,knowledgeVersion:knowledge.version,signal:toolSignal}),toolSignal))}
          catch(error){guard();if(toolSignal.aborted)result={ok:false,code:'TIMEOUT',message:'这次查询超时了，已保留先前记录。',retryable:false};else throw error}
          guard();validateToolResult(call.name,result)
          const envelope=result as unknown as {ok:boolean;sources?:HistorySource[];resultCount?:number;code?:string}
          if(envelope.ok)addSources(envelope.sources??[])
          checkpoint.results.push({call,result});checkpoint.pendingCalls.shift();checkpoint.inFlight=null
          const summary=envelope.ok?`已返回 ${envelope.resultCount} 条记录。`:`查询结束：${envelope.code}`
          content.toolSummaries.push({tool:call.name,status:envelope.ok?'ok':envelope.code as 'TIMEOUT',summary})
          if(content.toolSummaries.length>48)throw new AgentRunError('TOOL_LIMIT')
          const sources=[...new Map(checkpoint.results.flatMap(entry=>((entry.result as {sources?:HistorySource[]}).sources??[]).map(source=>[source.sourceId,source] as const))).values()]
          if(sources.length>30)throw new AgentRunError('SOURCE_LIMIT')
          content.sources=sources
          pushUsage({operation:'tool',provider:binding.provider.source,model:binding.provider.model,inputTokens:null,cachedInputTokens:null,outputTokens:null,durationMs:Math.max(0,now()-started),resultCount:envelope.resultCount??0,estimatedCost:null,currency:null,priceVersion:null})
          save();persist();this.store.event(uid,id,'tool_finished',{name:call.name,ok:envelope.ok,code:envelope.code??null,resultCount:envelope.resultCount??0,sources:sources as unknown as JsonValue});progress()
        }
      }
    }catch(error){
      const reason=signal.aborted?signal.reason:error
      const code=reason instanceof AgentRunError||reason instanceof AgentHistoryError?reason.code
        :reason instanceof Error&&['INVALID_OUTPUT','INVALID_ARGUMENT','UNREGISTERED_TOOL'].includes(reason.message)?reason.message:'PROVIDER_UNAVAILABLE'
      if(!compactId){const own=binding.context.store.activeJob(uid);if(own?.sessionId===initial.session_id)compactId=own.id}
      if(compactId){try{binding.context.cancel(uid,compactId)}catch{}}
      const exists=this.store.db.prepare('SELECT 1 FROM agent_runs WHERE user_id=? AND id=?').get(uid,id)
      if(!exists)return
      const row=this.store.row(uid,id)
      if(row.state==='running'&&row.attempt===attempt){
        try{finishModelUsage()}catch{}
        if(messageReady){try{flush();content.usage=[...checkpoint.usage];persist()}catch{ /* 空间不足时以最后成功落盘的内容结束。 */ }}
        const pause=['ROUND_LIMIT','TOOL_LIMIT','ACTIVE_LIMIT','CUMULATIVE_LIMIT','IDLE_TIMEOUT','INTERRUPTED','CAPABILITY_CHANGED','CONTEXT_BUDGET'].includes(code)
        this.store.finish(uid,id,code==='CANCELLED'?'cancelled':pause?'paused':'failed',code)
      }
    }finally{
      clearInterval(timer)
      if(iterator?.return)void iterator.return().catch(()=>{})
    }
  }
}
