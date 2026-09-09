import { AgentConnection } from './connection'
import { agentActivity } from './AgentActivity'
import type { ContextSummary,CompactJob,PreferenceCard,PreferenceSettings,PreferenceValues } from '../../shared/agent-context'
import type { PageAnimeContext,HistorySession,HistoryMessage,HistorySnapshot,HistoryAction } from '../../shared/agent-history'
import type { ContextTier } from '../../shared/agent-contracts'
import type { RunView,RunEvent } from '../../shared/agent-run'
import type { KnowledgeSnapshot } from '../../server/agent/knowledge'
import { subscribeAgentEvents } from '../../shared/agent-stream'
import { pageContext,activeCompact,applyDelta,idValid,mergeMessages,type AnimeContext,type AgentIssue,type ActionPreview,type PlaybackActionPreview,isTrackPreview,isPlaybackPreview } from './model'

// 确认/取消变更的响应回执:服务端只回传状态字段,summary 等留用本地已有的。
type TerminalMessage={id:string;seq:number;status:HistoryMessage['status'];sources:HistoryMessage['sources'];toolSummaries:HistoryMessage['toolSummaries'];actions:HistoryMessage['actions'];usage:HistoryMessage['usage']}
type ActionReceiptPatch={actionId:string;state:HistoryAction['state'];evidence:HistoryAction['evidence'];errorCode:HistoryAction['errorCode'];eventSeq:number;updatedAt:number}

type Cursor={beforeUpdatedAt:number;beforeId:string}
export interface ContextInfo {session:HistorySession;adaptive:boolean;active:ContextSummary|null;versions:Omit<ContextSummary,'state'>[];job:CompactJob|null}
export interface AgentUiState {
  ready:boolean;loading:boolean;syncing:boolean;busy:string|null;error:AgentIssue|null;authExpired:boolean;open:boolean
  knowledge:KnowledgeSnapshot|null;sessions:HistorySession[];cursor:Cursor|null;archived:boolean
  session:HistorySession|null;messages:HistoryMessage[];beforeSeq:number|null;context:ContextInfo|null;preferences:PreferenceCard[];preferenceSettings:PreferenceSettings|null
  run:RunView|null;watchingRun:RunView|null;job:CompactJob|null;connection:'idle'|'connected'|'disconnected'
  pendingBody:string|null;draft:string;anime:AnimeContext|null;unread:number;status:string
  actionPreviews:Record<string,ActionPreview>;editingSeq:number|null
}
const initial=():AgentUiState=>({ready:false,loading:false,syncing:false,busy:null,error:null,authExpired:false,open:false,knowledge:null,sessions:[],cursor:null,archived:false,
  session:null,messages:[],beforeSeq:null,context:null,preferences:[],preferenceSettings:null,run:null,watchingRun:null,job:null,connection:'idle',pendingBody:null,draft:'',anime:null,unread:0,status:'',actionPreviews:{},editingSeq:null})
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
  private readonly actionFetches=new Set<string>()
  private readonly providerConnection=new AgentConnection(()=>this.connectProvider())
  private alive=true
  private selection=0
  private listSerial=0
  private refreshSerial=0
  private preferenceSerial=0
  private stream:AbortController|null=null
  private streamRunId:string|null=null
  // 本次订阅是否从头到尾没断过。断过就说明可能漏了 delta,收尾必须整套回读正文。
  private streamClean=false
  // 终态事件是否带全了收尾所需的三样(会话/回合/消息)。
  private settled=false
  private reconnectTimer:ReturnType<typeof setTimeout>|null=null
  private reconnectN=0
  private poll:ReturnType<typeof setTimeout>|null=null
  private failedSend:{requestId:string;body:string;sessionId:string}|null=null
  private pendingCreate:{requestId:string;title?:string;currentBgmId:number|null;pageContext:PageAnimeContext|null}|null=null
  private lastRefresh=0
  constructor(readonly uid:number,readonly clientVersion:string,private readonly options:{fetchImpl?:typeof fetch;onAuthExpired?:()=>void;pollMs?:number;remember?:Storage}={}){}
  getSnapshot=():AgentUiState=>this.state
  subscribe=(listener:()=>void)=>(()=>{this.listeners.add(listener);return()=>this.listeners.delete(listener)})()
  private set(patch:Partial<AgentUiState>){if(this.alive){this.state={...this.state,...patch};for(const listener of this.listeners)listener()}}
  private fail(error:unknown){if(!this.alive||error instanceof DOMException&&error.name==='AbortError')return;this.set({error:issue(error),status:''})}
  // 回合恢复/收尾后，清掉之前那条「进度连接断开」的旧横幅，别让它一直吓人。
  private clearStale(){if(this.state.error?.code==='STREAM_DISCONNECTED')this.set({error:null})}
  private expire(){this.set({...initial(),authExpired:true,ready:true});this.options.onAuthExpired?.();this.dispose()}
  dispose(){this.alive=false;for(const controller of this.requests)controller.abort();this.requests.clear();this.viewRequests.clear();this.stream?.abort();if(this.poll)clearTimeout(this.poll);if(this.reconnectTimer)clearTimeout(this.reconnectTimer);this.drafts.clear();this.titles.clear();this.buffers.clear();this.cursors.clear();this.seen.clear();this.unreadMessages.clear();this.actionFetches.clear();this.failedSend=null;this.pendingCreate=null;this.state={...initial(),authExpired:this.state.authExpired,ready:this.state.authExpired}}
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
      // 429：服务端把「点太快」「今日额度用完」「费用上限」「AI 正忙」全塞在同一个状态码里。
      // 只有真的 RATE_LIMITED 才说「点得有点快」，其余原样透出服务端文案，否则用户永远查不出真正卡在哪。
      if(response.status===429){
        const value=data as {code?:unknown;error?:unknown}
        const code=typeof value?.code==='string'?value.code:'RATE_LIMITED'
        throw new UiError(code,code==='RATE_LIMITED'?'刚才点得有点快，等几秒再试就好。'
          :typeof value?.error==='string'?value.error.slice(0,300):`这次请求被限制了（${code}）。`)
      }
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
      const list=await this.api<{sessions:HistorySession[];nextCursor:Cursor|null;knowledge:KnowledgeSnapshot}>('/bootstrap')
      const knowledge=list.knowledge
      this.set({knowledge,sessions:list.sessions,cursor:list.nextCursor,ready:true})
      if(knowledge.conditions.answerModelAutoConnect)void this.prepareProvider().catch(()=>{})
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
    this.set({loading:true,error:null,session:null,messages:[],context:null,run:null,beforeSeq:null,draft:this.drafts.get(id)??'',anime:null,status:'',editingSeq:null})
    try{
      const opened=await this.api<HistorySnapshot&{context:ContextInfo;runs:RunView[]}>(`/sessions/${id}?limit=50&include=context,runs`,'GET',undefined,true)
      const snapshot=opened,context=opened.context,runs={runs:opened.runs}
      if(turn!==this.selection)return
      const session=context.session.revision>snapshot.session.revision?context.session:snapshot.session
      const run=runs.runs.find(r=>r.state==='running')??runs.runs[0]??null
      this.set({session,messages:snapshot.messages,beforeSeq:snapshot.nextBeforeSeq,context,run,anime:session.currentBgmId===null?null:this.titles.get(session.currentBgmId)??session.pageContext??{bgmId:session.currentBgmId,title:`条目 #${session.currentBgmId}`}})
      this.remember(id);this.syncActions()
      if(run?.state==='running')this.follow(run)
      if(context.job&&activeCompact(context.job))this.watchCompact(context.job)
      if(this.state.open)this.markRead()
    }catch(error){if(turn===this.selection)this.fail(error)}finally{if(turn===this.selection)this.set({loading:false})}
  }
  // silent=true 用于切标签页回来这类后台对账：失败就静默，绝不弹横幅（数据留在屏上，下次交互再拉）。
  // 只有用户点「重新读取」才走非静默、失败弹提示。
  async refresh(silent=false){
    if(!this.alive||this.state.loading||this.state.busy)return
    // 切回标签页触发的静默对账:回合在跑时 SSE 已经是最新的;否则 30s 内不重复拉。
    if(silent&&(this.state.connection==='connected'||Date.now()-this.lastRefresh<30_000))return
    if(!silent)this.set({error:null})
    try{const knowledge=await this.api<KnowledgeSnapshot>('/knowledge');this.set({knowledge});await this.refreshCurrent();if(!this.reconnectTimer&&this.state.watchingRun?.state==='running'&&this.state.connection==='disconnected'){this.reconnectN=0;this.follow(this.state.watchingRun,true)}}catch(error){if(!silent)this.fail(error)}
  }
  // 收尾。流全程没断、且终态事件把会话/回合/消息都带全了 —— 该知道的都已经在本地,一个请求都不发。
  // 任何一条不成立(中途重连过、事件不完整)就整套回读,绝不用可能有洞的本地状态糊弄过去。
  private async settle(){
    if(this.streamClean&&this.settled){this.lastRefresh=Date.now();if(this.state.open)this.markRead();this.syncActions();return}
    await this.refreshCurrent(!this.streamClean)
  }
  // withRuns=false:回合刚从**没断过**的流里结束,权威 run 已由终态事件和 follow() 的收尾读取给到,
  // 不必再拉一次 /runs。正文仍要回读——sources、工具摘要、用量只存在于落库的消息里,delta 不带。
  private async refreshCurrent(withRuns=true){
    const id=this.state.session?.id,turn=this.selection,serial=++this.refreshSerial;if(!id)return
    const read=await this.api<HistorySnapshot&{context:ContextInfo;runs?:RunView[]}>(`/sessions/${id}?limit=50&include=${withRuns?'context,runs':'context'}`,'GET',undefined,true)
    const snapshot=read,context=read.context,runs=withRuns?{runs:read.runs??[]}:null
    if(turn!==this.selection||serial!==this.refreshSerial)return
    this.lastRefresh=Date.now()
    const session=context.session.revision>snapshot.session.revision?context.session:snapshot.session
    const minSeq=(snapshot.messages.at(-1)?.seq??0)-session.messageCount+1
    const kept=this.state.messages.filter(message=>message.seq>=minSeq)
    const known=this.state.watchingRun?.sessionId===id?this.state.watchingRun:this.state.run
    const freshRun=runs?runs.runs[0]??null:known
    let messages=session.messageCount?mergeMessages(kept,snapshot.messages):[]
    // 权威 run 已终态，但本地还有它的流式消息没收尾（SSE 掉线漏了收尾事件）——按 run 状态定型，别一直转圈。
    if(freshRun&&freshRun.state!=='running'&&freshRun.state!=='paused')
      messages=messages.map(m=>m.status==='streaming'&&(m.id===freshRun.messageId||m.seq>=(snapshot.messages.at(-1)?.seq??0))?{...m,status:freshRun.state==='completed'?'completed':freshRun.state==='cancelled'?'cancelled':'failed'}:m)
    this.set({session,messages,beforeSeq:session.messageCount?this.state.beforeSeq??snapshot.nextBeforeSeq:null,context,run:freshRun,...this.state.pendingBody&&snapshot.messages.some(m=>m.id===this.state.run?.userMessageId)?{pendingBody:null}:{}})
    // 万能自愈：任何一次对账，只要权威 run 已终态而 watchingRun 还卡在 running，就拉平并清掉「连接断开」横幅。
    if(freshRun&&freshRun.state!=='running'&&this.state.watchingRun?.id===freshRun.id&&this.state.watchingRun.state==='running'){
      if(this.reconnectTimer){clearTimeout(this.reconnectTimer);this.reconnectTimer=null}
      this.reconnectN=0;this.clearStale();this.set({watchingRun:freshRun,connection:'idle',syncing:false,status:''})
    }
    if(this.state.open)this.markRead()
    this.syncActions()
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
    this.set({session:null,messages:[],beforeSeq:null,context:null,run:null,draft:this.drafts.get('new')??'',status:'',error:null,editingSeq:null})
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
    if(!this.state.knowledge?.conditions.answerModelReady&&!this.state.knowledge?.conditions.answerModelAutoConnect){this.set({error:{code:'AGENT_RUNTIME_NOT_READY',message:'回答模型尚未接入，消息未发送。'}});return}
    const retryConnection=Boolean(this.state.error)
    await this.mutate('发送',async()=>{
      this.set({pendingBody:body,draft:'',status:agentActivity('thinking')})
      try{
      if(retryConnection&&this.state.knowledge?.conditions.answerModelAutoConnect)await this.providerConnection.retry()
      else await this.prepareProvider()
      let session=this.state.session??await this.create()
      const editingSeq=this.state.editingSeq
      if(editingSeq!==null&&session.startedAt){
        const {session:cut}=await this.api<{session:HistorySession}>(`/sessions/${session.id}/truncate`,'POST',{expectedRevision:session.revision,fromSeq:editingSeq})
        for(const message of this.state.messages)if(message.seq>=editingSeq)this.buffers.delete(message.id)
        this.updateSession(cut);session=cut
        this.set({messages:this.state.messages.filter(message=>message.seq<editingSeq),beforeSeq:null,run:null,watchingRun:null,context:null,editingSeq:null})
        this.failedSend=null
      }
      const retry=this.failedSend?.sessionId===session.id&&this.failedSend.body===body?this.failedSend:{requestId:crypto.randomUUID(),sessionId:session.id,body}
      this.failedSend=retry
      const started=await this.api<{run:RunView;session:HistorySession|null;userMessage:HistoryMessage|null}>(`/sessions/${session.id}/runs`,'POST',{requestId:retry.requestId,expectedRevision:session.revision,body,clientVersion:this.clientVersion})
      const run=started.run
      if(!session.startedAt)this.drafts.delete('new')
      this.failedSend=null;this.drafts.set(session.id,'');this.set({draft:'',run,status:agentActivity('thinking')});this.follow(run)
      // 响应已经带回落库后的会话和用户消息,直接用它们更新;只有幂等重放(两者为 null)才回退到整套对账。
      if(started.session&&started.userMessage){
        this.updateSession(started.session)
        this.set({session:started.session,messages:mergeMessages(this.state.messages,[started.userMessage]),pendingBody:null})
      }else{
        try{await this.refreshCurrent();await this.list()}catch{/* follow() 会补上进度 */}
      }
      }catch(error){if(!this.state.draft)this.set({draft:body});throw error}finally{this.set({pendingBody:null})}
    })
  }
  private async prepareProvider(){
    if(this.state.knowledge?.conditions.answerModelAutoConnect)await this.providerConnection.ensure()
  }
  private async connectProvider(){
    // prepare 的响应本身就带 ready，不必再拉一次 /knowledge 才知道连上没有。
    const status=await this.api<{ready:boolean}>('/provider/prepare','POST',{})
    if(!status.ready)throw new UiError('PROVIDER_CONNECTION_REQUIRED','模型连接尚未就绪，请检查 AI 配置。')
    const knowledge=this.state.knowledge
    if(knowledge)this.set({knowledge:{...knowledge,conditions:{...knowledge.conditions,answerModelReady:true}}})
  }
  private follow(run:RunView,reconnect=false){
    if(this.streamRunId===run.id&&!reconnect&&this.state.connection==='connected'&&this.state.watchingRun?.attempt===run.attempt)return
    if(this.reconnectTimer){clearTimeout(this.reconnectTimer);this.reconnectTimer=null}
    if(!reconnect)this.reconnectN=0
    this.stream?.abort();const controller=new AbortController();this.stream=controller;this.streamRunId=run.id;this.streamClean=!reconnect;this.settled=false
    this.set({watchingRun:run,connection:'connected',syncing:false})
    void(async()=>{
      try{
        for await(const event of subscribeAgentEvents({runId:run.id,afterSeq:this.cursors.get(run.id)??0,signal:controller.signal,fetchImpl:async(input,init)=>{const response=await(this.options.fetchImpl??fetch)(input,init);if(response.status===401||response.headers.get('X-Agent-Owner')!==String(this.uid)){this.expire();throw stopped()}return response}})){
          if(!this.alive||controller.signal.aborted)return;this.reconnectN=0;this.clearStale();this.cursors.set(run.id,event.seq);this.event(run,event)
        }
        if(!controller.signal.aborted){
          // 终态帧就是权威记录:回合状态已由 event() 落到 watchingRun,不再回读。
          // 帧不完整或中途断过时才读一次权威回合 —— 这条晚到的读仍受下面的守卫保护。
          //
          // 关于那两处 stream!==controller 守卫:**目前没有测试覆盖**,而且我找不到能触发它的路径 ——
          // 终态事件会把 syncing 置为 true,而 mutate() 在 syncing 期间拒绝一切用户操作(send/resume),
          // 所以这次读悬着的时候建不出新通道,也就没有可被覆盖的状态。用变异测试确认过:
          // 拆掉这两行,整套 UI 测试仍然全绿(改动前的版本同样如此)。
          // 保留它们是廉价保险 —— 一旦 syncing 的串行化被放宽,这里就是唯一的兜底。改动请连带重估。
          const complete=this.streamClean&&this.settled
          const latest=complete?null:(await this.api<{run:RunView}>(`/runs/${run.id}`)).run
          if(controller.signal.aborted||this.stream!==controller)return
          if(this.state.session?.id===run.sessionId)await this.settle()
          if(controller.signal.aborted||this.stream!==controller)return
          this.reconnectN=0;this.clearStale();this.set({...latest?{watchingRun:latest}:{},connection:'idle',syncing:false})
        }
      }catch(error){
        if(!this.alive||controller.signal.aborted||this.stream!==controller)return
        if(error instanceof Error&&error.message==='HTTP_401'){this.expire();return}
        // 流断开：交给 retryFollow 退避轮询。绝不在这里连打 GET，绝不立刻弹横幅。
        this.retryFollow(run)
      }
    })()
  }
  // SSE 在 dev 无反代（@hono/vite-dev-server）下会偶发掉线。退避轮询直到回合终态：
  // 每次只发 1 个 GET /runs/:id；终态→对账收尾并解锁；还在跑且服务器可达→重开 SSE 拿实时；
  // 不可达（含 429）→加倍退避后继续，绝不永久卡死。GET 连续失败很久才给一次温和提示（仍继续轮询）。
  private retryFollow(run:RunView){
    if(!this.alive||this.reconnectTimer)return
    const attempt=++this.reconnectN
    this.stream?.abort();this.streamRunId=null
    const streamAt=this.stream
    this.set({watchingRun:run,connection:'disconnected',syncing:false,status:''})
    const superseded=()=>!this.alive||this.stream!==streamAt||this.state.watchingRun?.id!==run.id
    this.reconnectTimer=setTimeout(async()=>{
      this.reconnectTimer=null
      if(superseded())return
      let latest:RunView|null=null
      try{latest=(await this.api<{run:RunView}>(`/runs/${run.id}`)).run}catch{/* 含 429 / 网络错误：latest 留空，继续退避 */}
      if(superseded())return
      if(latest&&latest.state!=='running'){
        this.reconnectN=0
        try{if(this.state.session?.id===run.sessionId)await this.refreshCurrent()}catch{/* 正文以下次对账为准 */}
        if(!superseded()){this.clearStale();this.set({watchingRun:latest,connection:'idle',syncing:false,status:''})}
        return
      }
      if(latest){this.reconnectN=0;this.follow(latest,true);return}
      // 服务器没答上来：退避后继续轮，别放弃。攒够多次才提示一次（不锁死、仍自愈）。
      if(this.reconnectN>=6&&this.state.error?.code!=='STREAM_DISCONNECTED')this.fail(new UiError('STREAM_DISCONNECTED','网络好像不太稳，还在自动重连…'))
      this.retryFollow(run)
    },Math.min(1500*attempt,8000))
  }
  private event(run:RunView,event:RunEvent){
    const current=this.state.session?.id===run.sessionId,data=event.data&&typeof event.data==='object'&&!Array.isArray(event.data)?event.data:{}
    if(typeof data.attempt==='number'&&data.attempt<run.attempt)return
    if(current&&event.type==='delta')this.set({messages:applyDelta(this.state.messages,this.buffers,event,run.sessionId),status:agentActivity('writing')})
    if(event.type==='delta'&&(!this.state.open||!current)&&typeof data.messageId==='string'){const messages=this.unreadMessages.get(run.sessionId)??new Set<string>();messages.add(data.messageId);this.unreadMessages.set(run.sessionId,messages);this.set({unread:Math.min(99,[...this.unreadMessages.values()].reduce((n,set)=>n+set.size,0))})}
    if(current&&event.type==='model_started')this.set({status:agentActivity('thinking')})
    if(current&&event.type==='tool_started')this.set({status:agentActivity('tool',typeof data.name==='string'?data.name:undefined)})
    if(current&&event.type==='tool_finished')this.set({status:agentActivity('thinking')})
    if(current&&event.type==='context'&&data.state==='compacting')this.set({status:agentActivity('compact')})
    if(current&&event.type==='knowledge'&&data.refreshRequired===true)this.set({status:'页面版本已更新。'})
    if(current&&event.type==='context'&&data.state==='price_warning')this.set({status:`本次调用最高估算 US$${Number(data.estimatedCost).toFixed(4)}`})
    if(current&&event.type==='soft_limit')this.set({status:'处理时间较长…'})
    if(current&&event.type==='long_task')this.set({status:'任务仍在运行，可取消。'})
    // 这里刻意**不**对账。SSE 是权威数据源，事件已经把正文、状态、活动都带上了；
    // 回合进终态时 follow() 收尾对账一次，断线时 retryFollow() 补一次，足够且不重复。
    if(['completed','failed','cancelled','paused'].includes(event.type)){
      if(event.type==='completed')this.clearStale()
      // 终态事件自带「会话 + 权威回合 + 定型的回答消息」。三样齐全就地收尾,不再回读。
      // 缺任何一样(旧服务端、消息找不到)都记为不完整,由 settle() 回退到整套回读。
      const ended=data.session as unknown as HistorySession|undefined
      const authoritative=data.run as unknown as RunView|undefined
      const finalized=data.message as unknown as TerminalMessage|null|undefined
      this.settled=Boolean(ended&&authoritative&&finalized&&Array.isArray(finalized.actions))
      if(ended&&current&&ended.revision>=(this.state.session?.revision??0)){this.updateSession(ended);this.set({session:ended})}
      if(finalized&&current){this.set({messages:this.state.messages.map(m=>m.id===finalized.id
        ?{...m,status:finalized.status,sources:finalized.sources,toolSummaries:finalized.toolSummaries,actions:finalized.actions??[],usage:finalized.usage}:m)})
        // 动作卡靠这一帧才知道自己存在；立刻去取预览详情，别等下一次全量刷新。
        this.syncActions()}
      const next={...(data.run as unknown as RunView|undefined)??run,state:event.type as RunView['state'],lastEventSeq:event.seq,canResume:event.type==='paused'}
      this.set({watchingRun:next,syncing:true,...current?{run:next,status:event.type==='completed'?'':event.type==='cancelled'?'已停止回复':event.type==='paused'?'已暂停':'回复失败，已保留生成内容'}:{}})
    }
  }
  async cancel(){const run=this.state.watchingRun?.state==='running'?this.state.watchingRun:this.state.run;if(!run)return;await this.mutate('停止回复',async()=>{const response=await this.api<{run:RunView}>(`/runs/${run.id}/cancel`,'POST',{});this.set({watchingRun:response.run,...this.state.session?.id===run.sessionId?{run:response.run}:{}});await this.refreshCurrent()})}
  async resume(){const session=this.state.session,run=this.state.run;if(!session||!run?.canResume)return;await this.mutate('继续',async()=>{await this.prepareProvider();const response=await this.api<{run:RunView}>(`/runs/${run.id}/resume`,'POST',{requestId:crypto.randomUUID(),expectedRevision:session.revision,clientVersion:this.clientVersion});this.set({run:response.run});this.follow(response.run);try{await this.refreshCurrent()}catch{/* follow() 会补上进度 */}})}
  // 编辑并重新提问：把该用户消息放回输入框；发送时截断这条之后的对话再重新生成（见 send）。
  startEdit(message:HistoryMessage){
    if(message.role!=='user'||!this.state.session?.startedAt||this.state.busy||this.state.loading||this.state.syncing)return
    if(this.state.watchingRun?.state==='running')return
    this.drafts.set(this.state.session.id,message.body)
    this.set({draft:message.body,editingSeq:message.seq,error:null,status:''})
  }
  cancelEdit(){this.set({editingSeq:null,draft:'',error:null})}
  async compact(){
    const session=this.state.session;if(!session)return
    if(!this.state.knowledge?.conditions.contextModelReady&&!this.state.knowledge?.conditions.answerModelAutoConnect){this.set({error:{code:'CONTEXT_AI_DISABLED',message:'压缩模型尚未接入。'}});return}
    await this.mutate('压缩上下文',async()=>{await this.prepareProvider();const response=await this.api<{job:CompactJob}>(`/sessions/${session.id}/compact`,'POST',{requestId:crypto.randomUUID(),expectedRevision:session.revision});if(this.state.draft.trim()==='/compact')this.set({draft:''});this.watchCompact(response.job)})
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
    if(operation==='delete'){await this.api(base,'DELETE',{expectedRevision:session.revision});this.selection++;this.set({session:null,messages:[],context:null,run:null,draft:'',anime:null,editingSeq:null});this.drafts.delete(session.id);try{this.options.remember?.removeItem(`maple-agent-session:${this.uid}`)}catch{}}
    else{const response=await this.api<{session:HistorySession}>(operation==='clear'?`${base}/clear`:base,operation==='clear'?'POST':'PATCH',{expectedRevision:session.revision,...operation==='rename'?{title}:operation==='archive'?{archived:session.archivedAt===null}:{}});this.updateSession(response.session);if(operation==='clear'){this.buffers.clear();this.set({messages:[],context:null,run:null,beforeSeq:null,editingSeq:null});this.seen.delete(session.id)}}
    if(operation==='clear'||operation==='delete'){this.unreadMessages.delete(session.id);this.set({unread:[...this.unreadMessages.values()].reduce((n,messages)=>n+messages.size,0)})}
    await this.list()
  })}
  async tier(contextTier:ContextTier,adaptive:boolean){const session=this.state.session;if(!session)return;await this.mutate('上下文档位',async()=>{const response=await this.api<{session:HistorySession}>(`/sessions/${session.id}/context`,'PATCH',{expectedRevision:session.revision,contextTier,adaptive});this.updateSession(response.session);await this.refreshCurrent()})}
  async restore(summaryVersion:number){const session=this.state.session;if(!session)return;await this.mutate('恢复摘要',async()=>{await this.api(`/sessions/${session.id}/summaries/restore`,'POST',{expectedRevision:session.revision,summaryVersion});await this.refreshCurrent()})}
  async export():Promise<unknown>{const session=this.state.session;if(!session)return null;try{return await this.api(`/sessions/${session.id}/export`)}catch(error){this.fail(error);return null}}
  // 追番变更 / 播放打开：预览随消息卡片出现，凭 owner 身份的 REST 接口取回详情
  // （追番的确认凭证、播放的目标页面）；确认前不写、不打开任何页面，取消即作废。
  private syncActions(){
    const ids=new Set(this.state.messages.flatMap(m=>m.actions.map(a=>a.actionId)))
    const previews={...this.state.actionPreviews}
    let changed=false
    for(const key of Object.keys(previews))if(!ids.has(key)){delete previews[key];changed=true}
    if(changed)this.set({actionPreviews:previews})
    for(const message of this.state.messages){
      for(const action of message.actions){
        if(this.actionFetches.has(action.actionId))continue
        const known=this.state.actionPreviews[action.actionId]
        if(known&&(action.state!=='prepared'||isPlaybackPreview(known)||known.confirmationToken))continue
        this.actionFetches.add(action.actionId)
        void this.api<ActionPreview>(`/actions/${action.actionId}`).then(preview=>{
          this.actionFetches.delete(action.actionId)
          if(this.state.messages.some(m=>m.actions.some(a=>a.actionId===action.actionId)))this.set({actionPreviews:{...this.state.actionPreviews,[action.actionId]:preview}})
        }).catch(()=>{this.actionFetches.delete(action.actionId)})
      }
    }
  }
  // 确认/取消的结果是**已知**的状态变化:服务端把新回执和新会话一起给了回来,
  // 就地改写那张卡片即可,不必为了一个已知结果再拉一整套快照。
  private applyReceipt(action:ActionReceiptPatch,session:HistorySession){
    this.updateSession(session)
    // 回执视图不含 summary / userReportedSuccess,只覆盖服务端确实改动的字段。
    this.set({session,messages:this.state.messages.map(message=>message.actions.some(a=>a.actionId===action.actionId)
      ?{...message,actions:message.actions.map(a=>a.actionId===action.actionId?{...a,state:action.state,evidence:action.evidence,errorCode:action.errorCode,eventSeq:action.eventSeq,updatedAt:action.updatedAt}:a)}:message)})
    this.syncActions()
  }
  async confirmAction(actionId:string){
    const preview=this.state.actionPreviews[actionId]
    if(!isTrackPreview(preview)||!preview.confirmationToken)return
    await this.mutate('确认变更',async()=>{
      if(!isTrackPreview(preview))return
      const result=await this.api<{action:ActionReceiptPatch;session:HistorySession}>(`/actions/${actionId}/apply`,'POST',{actionId,requestId:`apply:${actionId}`,expectedRevision:preview.preview.expectedRevision,confirmationToken:preview.confirmationToken})
      this.applyReceipt(result.action,result.session)
    })
  }
  async cancelAction(actionId:string){
    const preview=this.state.actionPreviews[actionId]
    await this.mutate('取消变更',async()=>{
      const result=await this.api<{action:ActionReceiptPatch;session:HistorySession}>(`/actions/${actionId}/cancel`,'POST',isTrackPreview(preview)?{expectedRevision:preview.preview.expectedRevision}:{})
      this.applyReceipt(result.action,result.session)
    })
  }
  // 播放打开：已认过片源的那张卡是原生 <a>，浏览器在用户手势里自己开标签、服务端 302 前推进回执，
  // 这里只负责稍后把播放页回报的状态拉回卡片上（回执由播放页事件签发，不是这次点击的返回值）。
  followPlayback(actionId:string){
    if(!this.state.actionPreviews[actionId])return
    for(const delay of [3000,20000])setTimeout(()=>{if(this.alive&&this.state.messages.some(m=>m.actions.some(a=>a.actionId===actionId)))void this.refreshCurrent()},delay)
  }
  // 走 POST 的播放确认：组合动作（要先写追番）必须用它，因为同源守卫只覆盖写方法；
  // 没认过片源的那种也用它，拿到导航意图后把用户送进既有的「继续看 → 选片源」弹窗。
  //
  // **标签页必须在用户手势里先开出来**：等 POST 回来再 window.open 一定被弹窗拦截。
  // 同源播放页，所以不加 noopener —— 加了按规范 window.open 返回 null，就没法再给它导航。
  async openPlayback(actionId:string):Promise<{bgmId:number;source:'xifan'|'girigiri'}|null>{
    const preview=this.state.actionPreviews[actionId]
    if(!isPlaybackPreview(preview))return null
    const tab=preview.preview.target==='web_player'?window.open('about:blank','_blank'):null
    let target:{bgmId:number;source:'xifan'|'girigiri'}|null=null
    const done=await this.mutate('打开播放',async()=>{
      const result=await this.api<{action:ActionReceiptPatch;session:HistorySession;url:string|null
        navigate:{bgmId:number;source:'xifan'|'girigiri'}|null;track:{action:ActionReceiptPatch}|null}>(`/actions/${actionId}/open`,'POST',{})
      // 追番那一步的权威回执随响应回来，先就地更新那张卡，再更新播放卡。
      if(result.track)this.applyReceipt(result.track.action,result.session)
      this.applyReceipt(result.action,result.session)
      target=result.navigate
      if(result.url){
        if(tab)tab.location.replace(result.url)
        else if(!window.open(result.url,'_blank'))this.set({error:{code:'POPUP_BLOCKED',message:'浏览器拦下了新标签。追番已经记好了，去「我的追番」点继续看即可。'}})
      }
    })
    // 写入失败就别留一个空白标签在那儿。
    if(!done&&tab)tab.close()
    return target
  }

  // ── 就地认源：搜索 / 验证码 / 挑一个 ─────────────────────────────────────────
  //
  // 验证码图片和用户敲进去的数字都只在「浏览器 ↔ 我们服务端 ↔ 源站会话」这条线上走，
  // 不进对话历史、不进模型上下文 —— 验证码要证明的正是「此刻有个人在」。
  private replacePreview(actionId:string,preview:PlaybackActionPreview['preview']):void{
    const old=this.state.actionPreviews[actionId]
    if(!isPlaybackPreview(old))return
    this.set({actionPreviews:{...this.state.actionPreviews,[actionId]:{...old,preview}}})
  }
  async searchSource(actionId:string):Promise<{needsCaptcha:boolean}>{
    let needsCaptcha=false
    await this.mutate('找片源',async()=>{
      const r=await this.api<{needsCaptcha:boolean;preview:PlaybackActionPreview['preview']}>(`/actions/${actionId}/source-search`,'POST',{})
      needsCaptcha=r.needsCaptcha
      this.replacePreview(actionId,r.preview)
    })
    return {needsCaptcha}
  }
  async loadCaptcha(actionId:string):Promise<string|null>{
    let src:string|null=null
    await this.mutate('取验证码',async()=>{
      const r=await this.api<{imageB64:string;mime:string}>(`/actions/${actionId}/captcha`,'POST',{})
      // 只接受位图 MIME：源站返回 SVG / HTML 时服务端已经拦掉，这里再兜一次，
      // 不把可执行矢量内容当成图片交给浏览器。
      src=/^image\/(png|jpe?g|gif|webp)$/i.test(r.mime)?`data:${r.mime};base64,${r.imageB64}`:null
    })
    return src
  }
  async submitCaptcha(actionId:string,code:string):Promise<boolean>{
    let ok=false
    await this.mutate('校验验证码',async()=>{
      const r=await this.api<{success:boolean;preview:PlaybackActionPreview['preview']}>(`/actions/${actionId}/captcha/verify`,'POST',{code})
      ok=r.success
      this.replacePreview(actionId,r.preview)
    })
    return ok
  }
  async pickSource(actionId:string,index:number):Promise<void>{
    await this.mutate('认片源',async()=>{
      const r=await this.api<{preview:PlaybackActionPreview['preview']}>(`/actions/${actionId}/pick-source`,'POST',{index})
      this.replacePreview(actionId,r.preview)
    })
  }
}
