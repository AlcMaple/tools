import type { ContextSummary,CompactJob,PreferenceCard,PreferenceSettings,PreferenceValues } from '../../shared/agent-context'
import type { PageAnimeContext,HistorySession,HistoryMessage,HistorySnapshot } from '../../shared/agent-history'
import type { ContextTier } from '../../shared/agent-contracts'
import type { RunView,RunEvent } from '../../shared/agent-run'
import type { KnowledgeSnapshot } from '../../server/agent/knowledge'
import { subscribeAgentEvents } from '../../shared/agent-stream'
import { pageContext,activeCompact,applyDelta,idValid,mergeMessages,type AnimeContext,type AgentIssue } from './model'

type Cursor={beforeUpdatedAt:number;beforeId:string}
export interface ContextInfo {session:HistorySession;adaptive:boolean;active:ContextSummary|null;versions:Omit<ContextSummary,'state'>[];job:CompactJob|null}
export interface AgentUiState {
  ready:boolean;loading:boolean;syncing:boolean;busy:string|null;error:AgentIssue|null;authExpired:boolean;open:boolean
  knowledge:KnowledgeSnapshot|null;sessions:HistorySession[];cursor:Cursor|null;archived:boolean
  session:HistorySession|null;messages:HistoryMessage[];beforeSeq:number|null;context:ContextInfo|null;preferences:PreferenceCard[];preferenceSettings:PreferenceSettings|null
  run:RunView|null;watchingRun:RunView|null;job:CompactJob|null;connection:'idle'|'connected'|'disconnected'
  draft:string;anime:AnimeContext|null;unread:number;status:string
}
const initial=():AgentUiState=>({ready:false,loading:false,syncing:false,busy:null,error:null,authExpired:false,open:false,knowledge:null,sessions:[],cursor:null,archived:false,
  session:null,messages:[],beforeSeq:null,context:null,preferences:[],preferenceSettings:null,run:null,watchingRun:null,job:null,connection:'idle',draft:'',anime:null,unread:0,status:''})
class UiError extends Error {constructor(readonly code:string,message:string){super(message)}}
const issue=(error:unknown):AgentIssue=>error instanceof UiError?{code:error.code,message:error.message}:{code:'NETWORK_ERROR',message:'连接断开了，刚写的内容还在。'}
const stopped=()=>new DOMException('Request superseded','AbortError')
export class AgentController {
  private state:AgentUiState=initial()
  private readonly listeners=new Set<()=>void>()
  private readonly requests=new Set<AbortController>()
  private readonly viewRequests=new Set<AbortController>()
  private readonly drafts=new Map<string,string>()
  private readonly titles=new Map<number,AnimeContext>()
  private readonly buffers=new Map<string,string>()
  private readonly cursors=new Map<string,number>()
  private readonly seen=new Map<string,number>()
  private readonly unreadMessages=new Map<string,Set<string>>()
  private alive=true
  private selection=0
  private listSerial=0
  private refreshSerial=0
  private preferenceSerial=0
  private stream:AbortController|null=null
  private streamRunId:string|null=null
  private poll:ReturnType<typeof setTimeout>|null=null
  private refreshTimer:ReturnType<typeof setTimeout>|null=null
  private failedSend:{requestId:string;body:string;sessionId:string}|null=null
  private pendingCreate:{requestId:string;title?:string;currentBgmId:number|null;pageContext:PageAnimeContext|null}|null=null
  private lastRefresh=0
  constructor(readonly uid:number,readonly clientVersion:string,private readonly options:{fetchImpl?:typeof fetch;onAuthExpired?:()=>void;pollMs?:number;remember?:Storage}={}){}
  getSnapshot=():AgentUiState=>this.state
  subscribe=(listener:()=>void)=>(()=>{this.listeners.add(listener);return()=>this.listeners.delete(listener)})()
  private set(patch:Partial<AgentUiState>){if(this.alive){this.state={...this.state,...patch};for(const listener of this.listeners)listener()}}
  private fail(error:unknown){if(!this.alive||error instanceof DOMException&&error.name==='AbortError')return;this.set({error:issue(error),status:''})}
  private expire(){this.set({...initial(),authExpired:true,ready:true});this.options.onAuthExpired?.();this.dispose()}
  dispose(){this.alive=false;for(const controller of this.requests)controller.abort();this.requests.clear();this.viewRequests.clear();this.stream?.abort();if(this.poll)clearTimeout(this.poll);if(this.refreshTimer)clearTimeout(this.refreshTimer);this.drafts.clear();this.titles.clear();this.buffers.clear();this.cursors.clear();this.seen.clear();this.unreadMessages.clear();this.failedSend=null;this.pendingCreate=null;this.state={...initial(),authExpired:this.state.authExpired,ready:this.state.authExpired}}
  private async api<T>(path:string,method='GET',body?:unknown,view=false):Promise<T>{
    if(!this.alive)throw stopped()
    const controller=new AbortController();this.requests.add(controller);if(view)this.viewRequests.add(controller)
    let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort()},35_000)
    try{
      const response=await(this.options.fetchImpl??fetch)(`/api/agent${path}`,{method,credentials:'same-origin',headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal})
      if(!this.alive||controller.signal.aborted)throw stopped()
      if(response.status===401){this.expire();throw stopped()}
      if(response.headers.get('X-Agent-Owner')!==String(this.uid)){this.expire();throw stopped()}
      const data:unknown=await response.json()
      if(!this.alive||controller.signal.aborted)throw stopped()
      if(!response.ok){const value=data as {code?:unknown;error?:unknown};throw new UiError(typeof value?.code==='string'?value.code:`HTTP_${response.status}`,typeof value?.error==='string'?value.error.slice(0,300):`请求没有完成（${response.status}）。`)}
      return data as T
    }catch(error){if(timedOut)throw new UiError('REQUEST_TIMEOUT','这次等得有点久，内容已留好，请手动重试。');if(controller.signal.aborted)throw stopped();throw error}
    finally{clearTimeout(timer);this.requests.delete(controller);this.viewRequests.delete(controller)}
  }
  private async mutate(label:string,action:()=>Promise<void>){
    if(this.state.busy||this.state.loading||this.state.syncing||!this.alive)return false
    this.set({busy:label,error:null,status:''})
    try{await action();return true}catch(error){this.fail(error);return false}finally{this.set({busy:null})}
  }
  private remember(id:string){try{this.options.remember?.setItem(`maple-agent-session:${this.uid}`,id)}catch{}}
  private remembered():string|null{try{return this.options.remember?.getItem(`maple-agent-session:${this.uid}`)??null}catch{return null}}
  private updateSession(session:HistorySession){const others=this.state.sessions.filter(item=>item.id!==session.id);this.set({session,sessions:session.startedAt&&Boolean(session.archivedAt)===this.state.archived?[session,...others]:others})}
  setOpen(open:boolean){this.set({open});if(open)this.markRead()}
  setDraft(draft:string){if(draft.length<=32_000)this.set({draft,error:null})}
  dismissError(){this.set({error:null})}
  private markRead(){const id=this.state.session?.id;if(id){this.seen.set(id,this.state.messages.filter(m=>m.role==='assistant').at(-1)?.seq??0);this.unreadMessages.delete(id)}this.set({unread:[...this.unreadMessages.values()].reduce((n,messages)=>n+messages.size,0)})}
  async initialize(){
    if(this.state.loading||this.state.ready)return
    this.set({loading:true,error:null})
    try{
      const [knowledge,list]=await Promise.all([this.api<KnowledgeSnapshot>('/knowledge'),this.api<{sessions:HistorySession[];nextCursor:Cursor|null}>('/sessions')])
      this.set({knowledge,sessions:list.sessions,cursor:list.nextCursor,ready:true})
      const remembered=this.remembered(),selected=idValid(remembered)?remembered:list.sessions[0]?.id
      if(selected){await this.select(selected);if(this.state.error?.code==='NOT_FOUND'&&list.sessions[0]&&list.sessions[0].id!==selected)await this.select(list.sessions[0].id)}
    }catch(error){this.fail(error)}finally{this.set({loading:false,ready:true})}
  }
  async list(archived=this.state.archived,more=false){
    const serial=++this.listSerial
    try{const cursor=more?this.state.cursor:null,params=new URLSearchParams({archived:archived?'archived':'active'});if(cursor){params.set('beforeUpdatedAt',String(cursor.beforeUpdatedAt));params.set('beforeId',cursor.beforeId)}
      const response=await this.api<{sessions:HistorySession[];nextCursor:Cursor|null}>(`/sessions?${params}`)
      if(serial!==this.listSerial)return
      this.set({archived,sessions:more?[...this.state.sessions,...response.sessions]:response.sessions,cursor:response.nextCursor})
    }catch(error){this.fail(error)}
  }
  async select(id:string){
    if(this.state.busy)return
    const previous=this.state.session?.id??'new';this.drafts.set(previous,this.state.draft)
    const turn=++this.selection;for(const request of this.viewRequests)request.abort();this.viewRequests.clear()
    this.set({loading:true,error:null,session:null,messages:[],context:null,run:null,beforeSeq:null,draft:this.drafts.get(id)??'',anime:null,status:''})
    try{
      const [snapshot,context,runs]=await Promise.all([this.api<HistorySnapshot>(`/sessions/${id}?limit=50`,'GET',undefined,true),this.api<ContextInfo>(`/sessions/${id}/context`,'GET',undefined,true),this.api<{runs:RunView[]}>(`/sessions/${id}/runs`,'GET',undefined,true)])
      if(turn!==this.selection)return
      const session=context.session.revision>snapshot.session.revision?context.session:snapshot.session
      const run=runs.runs.find(r=>r.state==='running')??runs.runs[0]??null
      this.set({session,messages:snapshot.messages,beforeSeq:snapshot.nextBeforeSeq,context,run,anime:session.currentBgmId===null?null:this.titles.get(session.currentBgmId)??session.pageContext??{bgmId:session.currentBgmId,title:`条目 #${session.currentBgmId}`}})
      this.remember(id)
      if(run?.state==='running')this.follow(run)
      if(context.job&&activeCompact(context.job))this.watchCompact(context.job)
      if(this.state.open)this.markRead()
    }catch(error){if(turn===this.selection)this.fail(error)}finally{if(turn===this.selection)this.set({loading:false})}
  }
  async refresh(){
    if(!this.alive||this.state.loading||this.state.busy)return
    this.set({error:null})
    try{const knowledge=await this.api<KnowledgeSnapshot>('/knowledge');this.set({knowledge});await this.refreshCurrent();if(this.state.watchingRun?.state==='running'&&this.state.connection==='disconnected')this.follow(this.state.watchingRun,true)}catch(error){this.fail(error)}
  }
  private async refreshCurrent(){
    const id=this.state.session?.id,turn=this.selection,serial=++this.refreshSerial;if(!id)return
    const [snapshot,context,runs]=await Promise.all([this.api<HistorySnapshot>(`/sessions/${id}?limit=50`,'GET',undefined,true),this.api<ContextInfo>(`/sessions/${id}/context`,'GET',undefined,true),this.api<{runs:RunView[]}>(`/sessions/${id}/runs?limit=1`,'GET',undefined,true)])
    if(turn!==this.selection||serial!==this.refreshSerial)return
    this.lastRefresh=Date.now()
    const session=context.session.revision>snapshot.session.revision?context.session:snapshot.session
    const minSeq=(snapshot.messages.at(-1)?.seq??0)-session.messageCount+1
    const kept=this.state.messages.filter(message=>message.seq>=minSeq)
    this.set({session,messages:session.messageCount?mergeMessages(kept,snapshot.messages):[],beforeSeq:session.messageCount?this.state.beforeSeq??snapshot.nextBeforeSeq:null,context,run:runs.runs[0]??null})
    if(this.state.open)this.markRead()
    if(context.job&&activeCompact(context.job)&&(!this.poll||this.state.job?.id!==context.job.id))this.watchCompact(context.job)
  }
  async older(){const id=this.state.session?.id,before=this.state.beforeSeq,turn=this.selection;if(!id||before===null||this.state.busy)return;await this.mutate('翻前页',async()=>{const snapshot=await this.api<HistorySnapshot>(`/sessions/${id}?limit=50&beforeSeq=${before}`);if(turn===this.selection)this.set({messages:mergeMessages(snapshot.messages,this.state.messages),beforeSeq:snapshot.nextBeforeSeq})})}
  private async create(title?:string){
    if(!this.pendingCreate)this.pendingCreate={requestId:crypto.randomUUID(),title:title?.slice(0,100),currentBgmId:this.state.anime?.bgmId??null,pageContext:pageContext(this.state.anime)}
    const {session}=await this.api<{session:HistorySession}>('/sessions','POST',this.pendingCreate);this.pendingCreate=null;this.selection++
    this.updateSession(session);this.set({messages:[],beforeSeq:null,context:null,run:null});this.remember(session.id);return session
  }
  async newSession(){
    if(this.state.busy||this.state.loading||this.state.syncing||!this.state.session)return
    this.drafts.set(this.state.session.id,this.state.draft)
    this.selection++;for(const request of this.viewRequests)request.abort();this.viewRequests.clear()
    this.pendingCreate=null;this.failedSend=null
    this.set({session:null,messages:[],beforeSeq:null,context:null,run:null,draft:this.drafts.get('new')??'',status:'',error:null})
    try{this.options.remember?.removeItem(`maple-agent-session:${this.uid}`)}catch{}
  }
  async setAnime(anime:AnimeContext|null){
    if(anime)this.titles.set(anime.bgmId,anime)
    if(!this.state.session){this.set({anime});return}
    await this.mutate('更换番剧',async()=>{const session=this.state.session!;const response=await this.api<{session:HistorySession}>(`/sessions/${session.id}`,'PATCH',{expectedRevision:session.revision,currentBgmId:anime?.bgmId??null,pageContext:pageContext(anime)});this.updateSession(response.session);this.set({anime})})
  }
  async send(){
    const body=this.state.draft.trim();if(!body)return
    if(body==='/compact'){await this.compact();return}
    if(!this.state.knowledge?.conditions.answerModelReady){this.set({error:{code:'AGENT_RUNTIME_NOT_READY',message:'回答模型尚未接入，消息未发送。'}});return}
    await this.mutate('发送',async()=>{
      const session=this.state.session??await this.create()
      const retry=this.failedSend?.sessionId===session.id&&this.failedSend.body===body?this.failedSend:{requestId:crypto.randomUUID(),sessionId:session.id,body}
      this.failedSend=retry
      const {run}=await this.api<{run:RunView}>(`/sessions/${session.id}/runs`,'POST',{requestId:retry.requestId,expectedRevision:session.revision,body,clientVersion:this.clientVersion})
      if(!session.startedAt)this.drafts.delete('new')
      this.failedSend=null;this.drafts.set(session.id,'');this.set({draft:'',run,status:'正在查询…'});this.follow(run);await this.refreshCurrent();await this.list()
    })
  }
  private scheduleRefresh(){if(this.refreshTimer)return;this.refreshTimer=setTimeout(()=>{this.refreshTimer=null;void this.refreshCurrent().catch(error=>this.fail(error))},Math.max(100,1800-(Date.now()-this.lastRefresh)))}
  private follow(run:RunView,reconnect=false){
    if(this.streamRunId===run.id&&!reconnect&&this.state.connection==='connected'&&this.state.watchingRun?.attempt===run.attempt)return
    this.stream?.abort();const controller=new AbortController();this.stream=controller;this.streamRunId=run.id
    this.set({watchingRun:run,connection:'connected',syncing:false})
    void(async()=>{
      try{
        for await(const event of subscribeAgentEvents({runId:run.id,afterSeq:this.cursors.get(run.id)??0,signal:controller.signal,fetchImpl:async(input,init)=>{const response=await(this.options.fetchImpl??fetch)(input,init);if(response.status===401||response.headers.get('X-Agent-Owner')!==String(this.uid)){this.expire();throw stopped()}return response}})){
          if(!this.alive||controller.signal.aborted)return;this.cursors.set(run.id,event.seq);this.event(run,event)
        }
        if(!controller.signal.aborted){const result=await this.api<{run:RunView}>(`/runs/${run.id}`);if(controller.signal.aborted||this.stream!==controller)return;if(this.state.session?.id===run.sessionId)await this.refreshCurrent();if(controller.signal.aborted||this.stream!==controller)return;this.set({watchingRun:result.run,connection:'idle',syncing:false})}
      }catch(error){if(!this.alive||controller.signal.aborted)return;if(error instanceof Error&&error.message==='HTTP_401'){this.expire();return}this.set({connection:'disconnected',syncing:false});this.fail(new UiError('STREAM_DISCONNECTED','进度连接断开了。手帐还在，点“重新读取”接着看。'))}
    })()
  }
  private event(run:RunView,event:RunEvent){
    const current=this.state.session?.id===run.sessionId,data=event.data&&typeof event.data==='object'&&!Array.isArray(event.data)?event.data:{}
    if(typeof data.attempt==='number'&&data.attempt<run.attempt)return
    if(current&&event.type==='delta')this.set({messages:applyDelta(this.state.messages,this.buffers,event,run.sessionId)})
    if(event.type==='delta'&&(!this.state.open||!current)&&typeof data.messageId==='string'){const messages=this.unreadMessages.get(run.sessionId)??new Set<string>();messages.add(data.messageId);this.unreadMessages.set(run.sessionId,messages);this.set({unread:Math.min(99,[...this.unreadMessages.values()].reduce((n,set)=>n+set.size,0))})}
    if(current&&event.type==='model_started')this.set({status:'正在回复…'})
    if(current&&event.type==='tool_started')this.set({status:'正在查询资料…'})
    if(current&&event.type==='knowledge'&&data.refreshRequired===true)this.set({status:'页面版本已更新。'})
    if(current&&event.type==='soft_limit')this.set({status:'处理时间较长…'})
    if(current&&event.type==='long_task')this.set({status:'任务仍在运行，可取消。'})
    if(current&&['tool_finished','context'].includes(event.type))this.scheduleRefresh()
    if(['completed','failed','cancelled','paused'].includes(event.type)){
      const next={...run,state:event.type as RunView['state'],lastEventSeq:event.seq,canResume:event.type==='paused'}
      this.set({watchingRun:next,syncing:true,...current?{run:next,status:event.type==='completed'?'':event.type==='cancelled'?'已停止回复':event.type==='paused'?'已暂停':'回复失败，已保留生成内容'}:{}})
    }
  }
  async cancel(){const run=this.state.watchingRun?.state==='running'?this.state.watchingRun:this.state.run;if(!run)return;await this.mutate('停止回复',async()=>{const response=await this.api<{run:RunView}>(`/runs/${run.id}/cancel`,'POST',{});this.set({watchingRun:response.run,...this.state.session?.id===run.sessionId?{run:response.run}:{}});await this.refreshCurrent()})}
  async resume(){const session=this.state.session,run=this.state.run;if(!session||!run?.canResume)return;await this.mutate('继续',async()=>{const response=await this.api<{run:RunView}>(`/runs/${run.id}/resume`,'POST',{requestId:crypto.randomUUID(),expectedRevision:session.revision,clientVersion:this.clientVersion});this.set({run:response.run});this.follow(response.run);await this.refreshCurrent()})}
  retryDraft(){const last=this.state.messages.filter(m=>m.role==='user').at(-1);if(last)this.set({draft:last.body,error:null,status:''})}
  async compact(){
    const session=this.state.session;if(!session)return
    if(!this.state.knowledge?.conditions.contextModelReady){this.set({error:{code:'CONTEXT_AI_DISABLED',message:'压缩模型尚未接入。'}});return}
    await this.mutate('压缩上下文',async()=>{const response=await this.api<{job:CompactJob}>(`/sessions/${session.id}/compact`,'POST',{requestId:crypto.randomUUID(),expectedRevision:session.revision});if(this.state.draft.trim()==='/compact')this.set({draft:''});this.watchCompact(response.job)})
  }
  private watchCompact(job:CompactJob){
    if(this.poll)clearTimeout(this.poll);this.set({job})
    if(!activeCompact(job))return
    this.poll=setTimeout(()=>{this.poll=null;void this.api<{job:CompactJob}>(`/compactions/${job.id}`).then(async response=>{this.set({job:response.job});if(activeCompact(response.job))this.watchCompact(response.job);else if(this.state.session?.id===response.job.sessionId)await this.refreshCurrent()}).catch(error=>this.fail(error))},this.options.pollMs??2000)
  }
  async cancelCompact(){const job=this.state.job;if(!job)return;await this.mutate('停止整理',async()=>{const result=await this.api<{job:CompactJob}>(`/compactions/${job.id}/cancel`,'POST',{});if(this.poll)clearTimeout(this.poll);this.poll=null;this.set({job:result.job});await this.refreshCurrent()})}
  async preferences(){const serial=++this.preferenceSerial;try{const [response,settings]=await Promise.all([this.api<{preferences:PreferenceCard[]}>('/preferences'),this.api<PreferenceSettings>('/preferences/settings')]);if(serial===this.preferenceSerial)this.set({preferences:response.preferences,preferenceSettings:settings,error:null})}catch(error){this.fail(error)}}
  async savePreferences(values:PreferenceValues,expectedVersion:string){
    return this.mutate('保存偏好',async()=>{++this.preferenceSerial;const settings=await this.api<PreferenceSettings>('/preferences/settings','PUT',{values,expectedVersion});this.set({preferenceSettings:settings})})
  }
  async archiveSession(session:HistorySession){
    return this.mutate('归档对话',async()=>{const {session:updated}=await this.api<{session:HistorySession}>(`/sessions/${session.id}`,'PATCH',{expectedRevision:session.revision,archived:!session.archivedAt});if(this.state.session?.id===session.id)this.updateSession(updated);await this.list()})
  }
  async preference(operation:'create'|'confirm'|'edit'|'delete',value?:{id?:string;revision?:number;category?:PreferenceCard['category'];value?:string}){
    return this.mutate('偏好',async()=>{if(operation==='create')await this.api('/preferences','POST',{category:value?.category,value:value?.value});else{const path=`/preferences/${value!.id}${operation==='confirm'?'/confirm':''}`;await this.api(path,operation==='delete'?'DELETE':operation==='edit'?'PATCH':'POST',{expectedRevision:value!.revision,...operation==='edit'?{value:value!.value}:{}})}await this.preferences()})
  }
  async manage(operation:'rename'|'archive'|'delete'|'clear',title?:string){const session=this.state.session;if(!session)return false;return this.mutate('更新对话',async()=>{
    const base=`/sessions/${session.id}`
    if(operation==='delete'){await this.api(base,'DELETE',{expectedRevision:session.revision});this.selection++;this.set({session:null,messages:[],context:null,run:null,draft:'',anime:null});this.drafts.delete(session.id);try{this.options.remember?.removeItem(`maple-agent-session:${this.uid}`)}catch{}}
    else{const response=await this.api<{session:HistorySession}>(operation==='clear'?`${base}/clear`:base,operation==='clear'?'POST':'PATCH',{expectedRevision:session.revision,...operation==='rename'?{title}:operation==='archive'?{archived:session.archivedAt===null}:{}});this.updateSession(response.session);if(operation==='clear'){this.buffers.clear();this.set({messages:[],context:null,run:null,beforeSeq:null});this.seen.delete(session.id)}}
    if(operation==='clear'||operation==='delete'){this.unreadMessages.delete(session.id);this.set({unread:[...this.unreadMessages.values()].reduce((n,messages)=>n+messages.size,0)})}
    await this.list()
  })}
  async pin(message:HistoryMessage){const session=this.state.session;if(!session)return;await this.mutate('固定原文',async()=>{const response=await this.api<{session:HistorySession}>(`/sessions/${session.id}/messages/${message.id}/pin`,'PATCH',{expectedRevision:session.revision,pinned:!message.pinned});this.updateSession(response.session);this.set({messages:this.state.messages.map(item=>item.id===message.id?{...item,pinned:!item.pinned}:item)})})}
  async tier(contextTier:ContextTier,adaptive:boolean){const session=this.state.session;if(!session)return;await this.mutate('上下文档位',async()=>{const response=await this.api<{session:HistorySession}>(`/sessions/${session.id}/context`,'PATCH',{expectedRevision:session.revision,contextTier,adaptive});this.updateSession(response.session);await this.refreshCurrent()})}
  async restore(summaryVersion:number){const session=this.state.session;if(!session)return;await this.mutate('恢复摘要',async()=>{await this.api(`/sessions/${session.id}/summaries/restore`,'POST',{expectedRevision:session.revision,summaryVersion});await this.refreshCurrent()})}
  async export():Promise<unknown>{const session=this.state.session;if(!session)return null;try{return await this.api(`/sessions/${session.id}/export`)}catch(error){this.fail(error);return null}}
}
