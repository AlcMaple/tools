import { CONTEXT_TIERS, SUMMARY_STATE_SCHEMA, type AgentUsage, type ContextTier, type JsonValue, type SummaryState } from '../../shared/agent-contracts'
import { AgentHistoryError } from '../../shared/agent-history'
import { CONTEXT_LIMITS, VERIFICATION_SCHEMA, type CompactStage, type CompactRequest, type ContextSummary, type NativeWindow, type SummaryQuality } from '../../shared/agent-context'
import { AGENT_SYSTEM_RULES, contextBudget, DEFAULT_AGENT_MODEL, type ProviderCapabilities } from './policy'
import { AgentContextStore, contextError, contextHash, isCompactActive } from './context-store'
import { authority, buildActiveContext, injectionPattern, materialChunks, nativeInput, normalizeSummary, readContextLedger, summaryAnchors, type ContextLedger } from './context-engine'
import { estimateContextTokens, SUMMARY_INSTRUCTIONS, type ContextProvider, type ProviderResult } from './context-provider'
import { matchesContract } from './validation'

export type ProviderResolver = (uid: number) => ContextProvider | Promise<ContextProvider>
type ContextView = ReturnType<typeof buildActiveContext>
const portableCaps = (tier: ContextTier): ProviderCapabilities => ({ protocol:'chat_completions',contextTokens:CONTEXT_TIERS[tier],maxOutputTokens:8192,toolCalling:true,tokenCounting:'estimate',nativeCompaction:'none',nativeMinimumTokens:0,verified:true })

export class AgentContextService {
  private readonly controllers = new Map<string, AbortController>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly probes = new Map<number, { fingerprint:string; capabilities:ProviderCapabilities; until:number; nativeVerified:boolean }>()
  constructor(readonly store: AgentContextStore, private readonly resolve: ProviderResolver) {}
  async provider(uid:number,signal:AbortSignal,onProbe?:(profile:ContextProvider['profile'])=>void) {
    const provider = await this.resolve(uid), existing = this.probes.get(uid)
    if(existing && existing.fingerprint===contextHash(provider.profile) && existing.until>Date.now()) return {provider,capabilities:existing.capabilities,usage:[] as AgentUsage[]}
    onProbe?.(provider.profile)
    const probe = await provider.probe(signal)
    try{contextBudget('128k',probe.value,Math.min(CONTEXT_LIMITS.outputTokens,probe.value.maxOutputTokens),0)}catch{contextError('PROVIDER_CAPABILITY','模型能力或窗口上限没有通过检查。')}
    this.probes.set(uid,{fingerprint:contextHash(provider.profile),capabilities:probe.value,until:Date.now()+300_000,nativeVerified:false})
    return {provider,capabilities:probe.value,usage:[probe.usage]}
  }
  async capabilities(uid:number) {
    const {provider,capabilities}=await this.provider(uid,AbortSignal.timeout(30_000))
    return {provider:provider.profile.source,model:provider.profile.model,...capabilities,
      nativeCompactionStatus:capabilities.nativeCompaction==='none'?'not_available':this.probes.get(uid)?.nativeVerified?'verified':'declared_unverified'}
  }
  async countView(provider:ContextProvider,caps:ProviderCapabilities,view:ContextView,signal:AbortSignal):Promise<ContextView> {
    if(caps.tokenCounting!=='native') return view
    const head:JsonValue[]=view.nativeState?.protocol==='openai_responses' ? view.nativeState.items as JsonValue[]
      :view.nativeState?.protocol==='anthropic_messages' ? [{role:'assistant',content:view.nativeState.content as JsonValue[]}] : []
    const input:JsonValue[]=[...head,{role:'user',content:JSON.stringify(view.layers)}]
    const tokens=await provider.count(input,signal)
    if(!Number.isSafeInteger(tokens)||tokens<0) contextError('PROVIDER_CAPABILITY','模型 token 计数结果不正确。')
    return {...view,estimatedTokens:tokens,budget:contextBudget(view.budget.tier,caps,view.budget.reservedOutputTokens,tokens)}
  }
  async prepare(uid:number,id:string,p:CompactRequest & {question:string}, options: {runId?:string;signal?:AbortSignal;additionalInput?:unknown;provider?:{source:string;model:string;fingerprint:string}} = {}) {
    this.store.assertRun(uid,id,options.runId)
    this.expire()
    let ledger=readContextLedger(this.store,uid,id)
    if(ledger.session.revision!==p.expectedRevision) contextError('REVISION_CONFLICT','手帐已更新，请刷新后再继续。')
    const current=this.store.activeJob(uid)
    if(current) return {state:'compacting' as const,job:current,view:null}
    const signal=options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), {provider,capabilities:caps}=await this.provider(uid,signal)
    signal.throwIfAborted()
    if(options.provider && (provider.profile.source!==options.provider.source || provider.profile.model!==options.provider.model || provider.profile.fingerprint!==options.provider.fingerprint)) contextError('PROVIDER_CHANGED','模型配置已变化，请重新开始这轮对话。')
    const activeView = () => {
      const base=buildActiveContext(this.store,ledger,p.question,caps,contextHash(provider.profile))
      if(options.additionalInput===undefined)return base
      const layers=[...base.layers,{kind:'server_capabilities',data:JSON.stringify(options.additionalInput)}]
      const tokens=estimateContextTokens({layers,nativeState:base.nativeState})
      return {...base,layers,estimatedTokens:tokens,budget:contextBudget(ledger.session.contextTier,caps,base.budget.reservedOutputTokens,tokens)}
    }
    let view=await this.countView(provider,caps,activeView(),signal)
    // 仅固定原文/本轮问题本身需要更大空间时扩档；旧历史过长优先压缩，避免每轮堆满窗口。
    if(this.store.settings(uid,id).adaptive && view.budget.shouldCompact) {
      const fixed=estimateContextTokens({rules:AGENT_SYSTEM_RULES,preferences:ledger.preferences,question:p.question,pinned:ledger.messages.filter(m=>ledger.pinnedIds.has(m.id))})
      const tiers=Object.keys(CONTEXT_TIERS) as ContextTier[]
      for(const tier of tiers.filter(t=>CONTEXT_TIERS[t]>CONTEXT_TIERS[ledger.session.contextTier])) {
        if(fixed<view.budget.compactAt || Math.min(CONTEXT_TIERS[tier],caps.contextTokens)<=view.budget.effectiveTokens) break
        this.store.setContext(uid,id,ledger.session.revision,{contextTier:tier,adaptive:true},options.runId)
        ledger=readContextLedger(this.store,uid,id)
        view=await this.countView(provider,caps,activeView(),signal)
        if(!view.budget.shouldCompact) break
      }
    }
    const mandatoryLayers=view.layers.map(layer=>layer.kind==='session_summary'?{...layer,data:null}:layer.kind==='transcript'
      ? {...layer,data:ledger.messages.filter(m=>ledger.pinnedIds.has(m.id))}:layer)
    const mandatory=await this.countView(provider,caps,{...view,layers:mandatoryLayers as typeof view.layers,nativeState:null,
      estimatedTokens:estimateContextTokens({layers:mandatoryLayers,nativeState:null}),budget:contextBudget(ledger.session.contextTier,caps,view.budget.reservedOutputTokens,estimateContextTokens({layers:mandatoryLayers,nativeState:null}))},signal)
    if(!mandatory.budget.fits)contextError('CONTEXT_BUDGET','本轮问题和固定原文已超过窗口，请调整档位或固定范围。')
    const active=this.store.active(uid,id)
    const reducible=ledger.messages.some(m=>!ledger.pinnedIds.has(m.id)&&(m.seq>(active?.view.transcriptRange.throughSeq??0)||active?.view.quality.restoredMessageIds.includes(m.id)))
    if(view.budget.shouldCompact&&reducible) return {state:'compacting' as const,job:this.start(uid,id,{requestId:p.requestId,expectedRevision:ledger.session.revision},'automatic',undefined,options.runId),view}
    if(!view.budget.fits) contextError('CONTEXT_BUDGET','固定原文超出窗口，原有历史仍然保留。')
    return {state:'ready' as const,job:null,view}
  }
  start(uid:number,id:string,p:CompactRequest,trigger:'manual'|'automatic'='manual',edit?:SummaryState,runId?:string) {
    this.expire()
    const started=this.store.beginJob(uid,id,p.requestId,p.expectedRevision,trigger,runId)
    if(!started.fresh) return started.job
    const controller=new AbortController(); this.controllers.set(started.job.id,controller)
    const work=Promise.resolve().then(()=>this.run(uid,id,started.job.id,controller,edit)).finally(()=>{this.controllers.delete(started.job.id);this.pending.delete(started.job.id)})
    this.pending.set(started.job.id,work)
    return started.job
  }
  async wait(jobId:string) { await this.pending.get(jobId) }
  expire() {this.store.expireJobs();for(const [id,controller] of this.controllers){const row=this.store.db.prepare('SELECT stage FROM agent_context_jobs WHERE id = ?').get(id) as {stage:CompactStage}|undefined;if(!row||!isCompactActive(row.stage))controller.abort()}}
  cancel(uid:number,jobId:string) {
    const job=this.store.job(uid,jobId)
    this.controllers.get(jobId)?.abort()
    this.store.finishJob(uid,jobId,'cancelled',job.usage,'CANCELLED')
    return this.store.job(uid,jobId)
  }
  async close() { for(const c of this.controllers.values()) c.abort(); await Promise.all(this.pending.values()) }

  private async run(uid:number,id:string,jobId:string,controller:AbortController,edit?:SummaryState) {
    const usage:AgentUsage[]=[]
    const startedAt=Date.now()
    let timedOut=false
    const timer=setTimeout(()=>{timedOut=true;controller.abort()},CONTEXT_LIMITS.jobMs); timer.unref?.()
    try {
      const ledger=readContextLedger(this.store,uid,id), previous=this.store.active(uid,id)
      const selected=ledger.messages.filter(m=>!ledger.pinnedIds.has(m.id) && (m.seq>(previous?.view.transcriptRange.throughSeq??0)||previous?.view.quality.restoredMessageIds.includes(m.id)))
      if(!edit && !selected.length) {this.store.finishJob(uid,jobId,'skipped',usage,'NOT_NEEDED');return}
      this.store.progress(uid,jobId,'budgeting',usage)
      const probeStart=Date.now()
      const resolved=await this.provider(uid,controller.signal,profile=>{
        usage.push({operation:'compact',provider:profile.source,model:profile.model,inputTokens:null,cachedInputTokens:null,outputTokens:null,durationMs:0,resultCount:0,estimatedCost:null,currency:null,priceVersion:null})
        this.store.progress(uid,jobId,'budgeting',usage)
      }), provider=resolved.provider,caps=resolved.capabilities
      if(resolved.usage.length)usage.splice(0,1,...resolved.usage)
      if(usage[0])usage[0].durationMs=Math.max(usage[0].durationMs,Date.now()-probeStart)
      const budget=contextBudget(ledger.session.contextTier,caps,Math.min(CONTEXT_LIMITS.outputTokens,caps.maxOutputTokens),0)
      const fixed=await this.countView(provider,caps,buildActiveContext(this.store,ledger,'',caps,contextHash(provider.profile),null,{state:null,throughSeq:ledger.messages.at(-1)?.seq??0,restoredMessageIds:[]}),controller.signal)
      if(!fixed.budget.fits)contextError('CONTEXT_BUDGET','固定保留的原文已经超出窗口，请调整档位或固定范围。')
      const allowance=budget.effectiveTokens*4
      let consumed=0,calls=resolved.usage.length ? 2 : 0
      const call=async<T>(stage:CompactStage,input:unknown,run:()=>Promise<ProviderResult<T>>):Promise<T>=>{
        controller.signal.throwIfAborted()
        const estimate=estimateContextTokens(input)+estimateContextTokens(SUMMARY_STATE_SCHEMA)+Buffer.byteLength(SUMMARY_INSTRUCTIONS), outputReserve=stage==='native'?caps.maxOutputTokens:budget.reservedOutputTokens, reserve=estimate+outputReserve
        if(++calls>CONTEXT_LIMITS.requestsPerJob || consumed+reserve>allowance || reserve>budget.effectiveTokens) contextError('COMPACTION_BUDGET','压缩预算不足，原有上下文保持不变。')
        consumed+=reserve
        const index=usage.length,start=Date.now()
        usage.push({operation:'compact',provider:provider.profile.source,model:provider.profile.model,inputTokens:null,cachedInputTokens:null,outputTokens:null,durationMs:0,resultCount:0,estimatedCost:null,currency:null,priceVersion:null})
        this.store.progress(uid,jobId,stage,usage)
        try {const result=await run(); usage[index]=result.usage; consumed-=outputReserve-(result.usage.outputTokens??outputReserve); controller.signal.throwIfAborted(); this.store.progress(uid,jobId,stage,usage);return result.value}
        finally {usage[index].durationMs=Math.max(usage[index].durationMs,Date.now()-start)}
      }
      const verify=async(value:unknown,evidence:unknown)=>{
        const normalized=normalizeSummary(value,ledger)
        const data={candidate:normalized.state,evidence,authority:authority(ledger),userEdit:Boolean(edit)}
        let checked=await call('checking',data,()=>provider.json('verify',data,controller.signal))
        if(!matchesContract(VERIFICATION_SCHEMA,checked)) contextError('SUMMARY_CHECK','独立核验没有返回有效结果。')
        let v=checked as {passed:boolean;missingMessageIds:string[];contradictions:string[]}
        if(v.contradictions.length) contextError('SUMMARY_CHECK','摘要仍有事实矛盾，旧版本继续生效。')
        if(v.missingMessageIds.length) {
          const known=new Map(ledger.messages.map(m=>[m.id,m]))
          if(v.missingMessageIds.some(mid=>!known.has(mid))) contextError('SUMMARY_SOURCE','核验返回了未知原文编号。')
          normalized.quality.restoredMessageIds=[...new Set([...normalized.quality.restoredMessageIds,...v.missingMessageIds])]
          const repaired={...data,restoredOriginals:v.missingMessageIds.map(mid=>known.get(mid))}
          checked=await call('checking',repaired,()=>provider.json('verify',repaired,controller.signal))
          if(!matchesContract(VERIFICATION_SCHEMA,checked)) contextError('SUMMARY_CHECK','回填后的核验格式不正确。')
          v=checked as typeof v
        }
        if(!v.passed||v.contradictions.length||v.missingMessageIds.length) contextError('SUMMARY_CHECK','摘要没有通过独立核验，旧版本继续生效。')
        normalized.quality.independentCheckPassed=true
        return normalized
      }
      let result:{state:SummaryState;quality:SummaryQuality}
      let through=previous?.view.transcriptRange.throughSeq??0
      if(edit) {
        if(!previous) contextError('NOT_FOUND','还没有可以编辑的摘要。',404)
        result=await verify(edit,{userApprovedEdit:edit,originalAnchors:summaryAnchors(edit),previous:previous.view.state})
      } else {
        const chunks=materialChunks(ledger,selected,Math.max(2048,Math.min(32_768,Math.floor((budget.maxInputTokens-10_000)/3))))
        const states:{state:SummaryState;quality:SummaryQuality}[]=[]
        if(previous) states.push({state:previous.view.state,quality:{...previous.view.quality,restoredMessageIds:previous.view.quality.restoredMessageIds.filter(mid=>!selected.some(m=>m.id===mid))}})
        for(const records of chunks) {
          const data={records,authority:authority(ledger)}
          const raw=await call('extracting',data,()=>provider.json('extract',data,controller.signal))
          states.push(await verify(raw,records))
        }
        while(states.length>1) {
          const pair=states.splice(0,2),data={summaries:pair.map(x=>x.state),authority:authority(ledger)}
          const raw=await call('merging',data,()=>provider.json('merge',data,controller.signal))
          const merged=await verify(raw,data.summaries)
          merged.quality.restoredMessageIds=[...new Set([...merged.quality.restoredMessageIds,...pair.flatMap(x=>x.quality.restoredMessageIds)])]
          states.unshift(merged)
        }
        if(!states.length) contextError('SUMMARY_EMPTY','没有可整理的原文。')
        result=states[0];through=Math.max(previous?.view.transcriptRange.throughSeq??0,selected.at(-1)!.seq)
      }
      result.quality.restoredMessageIds=[...new Set([...result.quality.restoredMessageIds,...ledger.messages.filter(m=>m.seq<=through&&ledger.pinnedIds.has(m.id)).map(m=>m.id)])]
      let native:NativeWindow|null=null,method:ContextSummary['method']='app_summary'
      if(!edit&&budget.compaction!=='app_summary') {
        const prior=previous?.profileHash===contextHash(provider.profile)&&previous.preferencesHash===ledger.preferencesHash?previous.native:null
        const input=nativeInput(ledger,selected,prior,caps.protocol), tokens=await provider.count(input,controller.signal)
        if(tokens>=caps.nativeMinimumTokens&&tokens+caps.maxOutputTokens<=budget.effectiveTokens) {
          native=await call('native',input,()=>provider.native(input,budget.compactAt,controller.signal))
          if(native && native.protocol==='anthropic_messages' && injectionPattern.test(JSON.stringify(native.content))) contextError('SUMMARY_INJECTION','原生摘要包含改变系统规则的指令。')
          if(native) {method=native.protocol==='openai_responses'?'openai_responses':'claude_compaction';const cached=this.probes.get(uid);if(cached?.fingerprint===contextHash(provider.profile))cached.nativeVerified=true}
        }
      }
      const view=await this.countView(provider,caps,buildActiveContext(this.store,ledger,'',caps,contextHash(provider.profile),native,{state:result.state,throughSeq:through,restoredMessageIds:result.quality.restoredMessageIds}),controller.signal)
      if(!view.budget.fits) contextError('CONTEXT_BUDGET','固定原文和摘要仍超出窗口，旧版本保持不变。')
      controller.signal.throwIfAborted()
      if(readContextLedger(this.store,uid,id).digest!==ledger.digest) contextError('STALE_CONTEXT','原文或权威记录已变化，这次没有覆盖旧版。')
      const version=this.store.saveVersion(uid,id,{revision:ledger.session.revision,preferencesHash:ledger.preferencesHash,state:result.state,quality:result.quality,usage,
        profileHash:contextHash(provider.profile),provider:provider.profile.source,model:provider.profile.model,method,native,throughSeq:through,
        fromSeq:previous?.view.transcriptRange.fromSeq??selected[0]?.seq??1,origin:edit?'user_edit':'model',jobId,
        validateSource:()=>{if(readContextLedger(this.store,uid,id).digest!==ledger.digest)contextError('STALE_CONTEXT','提交前原文或权威记录已变化，旧摘要继续生效。')}})
      this.store.finishJob(uid,jobId,'completed',usage,null,version.summary_version)
    } catch(error) {
      for(const item of usage)if(item.resultCount===0&&item.durationMs===0)item.durationMs=Date.now()-startedAt
      const code=timedOut?'TIMEOUT':controller.signal.aborted?'CANCELLED':error instanceof AgentHistoryError?error.code:'COMPACTION_FAILED'
      this.store.finishJob(uid,jobId,controller.signal.aborted&&!timedOut?'cancelled':'failed',usage,code)
    } finally {clearTimeout(timer)}
  }
  edit(uid:number,id:string,revision:number,state:SummaryState) {
    normalizeSummary(state,readContextLedger(this.store,uid,id))
    return this.start(uid,id,{requestId:'edit-'+contextHash({revision,state}),expectedRevision:revision},'manual',state)
  }
  restore(uid:number,id:string,revision:number,version:number) {
    this.store.assertRun(uid,id)
    if(this.store.activeJob(uid)) contextError('SESSION_BUSY','先完成或取消当前压缩，再恢复摘要吧。')
    const ledger=readContextLedger(this.store,uid,id),old=this.store.version(uid,id,version),state=structuredClone(old.view.state)
    state.confirmed_preferences=ledger.preferences.map(p=>p.id)
    const actionIds=new Set([...state.action_receipts.map(a=>a.actionId),...ledger.pending.map(p=>p.action.actionId)])
    state.action_receipts=[...ledger.latestActions.values()].filter(p=>actionIds.has(p.action.actionId)).map(p=>({actionId:p.action.actionId,state:p.action.state,revision:null}))
    const checked=normalizeSummary(state,ledger);checked.quality.independentCheckPassed=old.view.quality.independentCheckPassed
    checked.quality.restoredMessageIds=[...new Set([...checked.quality.restoredMessageIds,...old.view.quality.restoredMessageIds.filter(mid=>ledger.messages.some(m=>m.id===mid))])]
    const view=buildActiveContext(this.store,ledger,'',portableCaps(ledger.session.contextTier),'',null,{state:checked.state,throughSeq:old.view.transcriptRange.throughSeq,restoredMessageIds:checked.quality.restoredMessageIds})
    if(!view.budget.fits) contextError('CONTEXT_BUDGET','恢复后的固定原文超出所选窗口，当前摘要保持不变。')
    return this.store.saveVersion(uid,id,{revision,preferencesHash:ledger.preferencesHash,state:checked.state,quality:checked.quality,usage:[],profileHash:old.profileHash,
      provider:old.view.provider,model:old.view.model||DEFAULT_AGENT_MODEL,method:'app_summary',native:null,throughSeq:old.view.transcriptRange.throughSeq,fromSeq:old.view.transcriptRange.fromSeq,origin:'restore',restoredFromVersion:version,
      validateSource:()=>{if(readContextLedger(this.store,uid,id).digest!==ledger.digest)contextError('STALE_CONTEXT','恢复前资料发生变化，请刷新后再试。')}})
  }
}
