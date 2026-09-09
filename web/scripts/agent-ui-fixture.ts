import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { randomBytes,randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import type { Server } from 'node:http'
import type { AgentUsage,SummaryState } from '../shared/agent-contracts'
import type { ContextProvider,ProviderProfile } from '../server/agent/context-provider'
import type { RunProviderEvent } from '../server/agent/run-service'

export async function createAgentUiFixture(){
  if(process.env.AGENT_UI_FIXTURE!=='1'||process.env.NODE_ENV!=='test')throw new Error('UI_FIXTURE_TEST_ONLY')
  const oldCwd=process.cwd(),oldEnv={...process.env},originalFetch=globalThis.fetch,directory=mkdtempSync(join(tmpdir(),'maple-agent-ui-'))
  mkdirSync(join(directory,'data'));process.chdir(directory)
  // 追番页会读取周历补全元数据；预置隔离缓存，测试不触发原页面的在线补全。
  writeFileSync(join(directory,'data/calendar-cache.json'),JSON.stringify({at:Date.now(),data:Array.from({length:7},(_,index)=>({id:index+1,label:['星期一','星期二','星期三','星期四','星期五','星期六','星期日'][index],items:index<3?[{id:101+index,name:['葬送的芙莉莲','摇曳露营△','夏目友人帐'][index],name_cn:['葬送的芙莉莲','摇曳露营△','夏目友人帐'][index],url:'',cover:'',airDate:'2026-09-01',episodes:[28,12,13][index],score:0}]:[]}))}))
  for(const key of Object.keys(process.env))if(/^(SENTRY_|VITE_SENTRY_|SMTP_|AI_|GOOGLE_|MAPLETOOLS_ENV_FILE$|VERCEL$)/.test(key)||/^(?:https?_proxy|all_proxy|no_proxy)$/i.test(key))delete process.env[key]
  process.env.NODE_ENV='production';process.env.DATA_DIR=join(directory,'data');process.env.AUTH_SECRET=randomBytes(48).toString('hex');process.env.EMAIL_MODE='disabled';process.env.AGENT_CONTEXT_AI_ENABLED='0'
  const metrics={externalRequests:0,apiRequests:0,modelCalls:0,toolCalls:0,connections:0}
  globalThis.fetch=async()=>{metrics.externalRequests++;throw new Error('EXTERNAL_REQUEST_BLOCKED')}
  const {MockAgent,getGlobalDispatcher,setGlobalDispatcher}=await import('undici'),oldDispatcher=getGlobalDispatcher(),network=new MockAgent();network.disableNetConnect();setGlobalDispatcher(network)
  const {Hono}=await import('hono'),{serve}=await import('@hono/node-server'),{serveStatic}=await import('@hono/node-server/serve-static')
  const {db}=await import('../server/db'),{getSession,issueSession}=await import('../server/auth'),{sameOriginGuard,securityHeaders}=await import('../server/security')
  const {AgentContextStore}=await import('../server/agent/context-store'),{AgentContextService}=await import('../server/agent/context-service'),{estimateContextTokens}=await import('../server/agent/context-provider')
  const {AgentRunStore}=await import('../server/agent/run-store'),{AgentRunService}=await import('../server/agent/run-service'),{createAgentRunApi}=await import('../server/agent/run-api'),{createAgentContextApi}=await import('../server/agent/context-api')
  const {AgentActionStore}=await import('../server/agent/actions-store')
  const {AgentPlaybackStore}=await import('../server/agent/playback-store')
  const {AgentKnowledgeRegistry,AGENT_FEATURES,AGENT_FEATURE_REGISTRATIONS}=await import('../server/agent/knowledge'),{readLoadedRelease}=await import('../server/agent/release')
  const {default:production}=await import('../server/index'),{agentContextService:productionContext}=await import('../server/agent/context-runtime')
  const createUser=(name:string)=>Number(db.prepare('INSERT INTO users(username,pass_hash,created_at,security_question,security_answer_hash) VALUES(?,?,?,?,?)').run(name,randomBytes(32).toString('hex'),new Date().toISOString(),'fixture-question',randomBytes(32).toString('hex')).lastInsertRowid)
  const alice=createUser('ui_alice'),bob=createUser('ui_bob'),empty=createUser('ui_empty'),store=new AgentContextStore(db),history=store.history
  for(const [uid,id,title,status,episode,total] of [[alice,101,'葬送的芙莉莲','watching',7,28],[alice,102,'摇曳露营△','done',12,12],[alice,103,'夏目友人帐','plan',0,13],[bob,104,'另一位用户的条目','plan',0,12]] as const){
    db.prepare('INSERT INTO tracks(user_id,bgm_id,title,title_cn,status,episode,total_episodes,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(uid,id,title,title,status,episode,total,new Date().toISOString())
  }
  const book=(title:string,uid=alice)=>history.createSession(uid,{requestId:randomUUID(),title})
  let story=book('周末，想看一点温柔的故事')
  for(let i=0;i<24;i++){
    story=history.appendUser(alice,story.id,{requestId:randomUUID(),expectedRevision:story.revision,body:i?'还想看看哪些细节值得留意？':'想找一部轻松的短番，不想看剧透。'}).session
    story=history.appendAssistant(alice,story.id,{requestId:randomUUID(),expectedRevision:story.revision,body:i?'这一条线索也放进手帐里，之后可以再慢慢翻。':'先把这两个方向夹在手帐里：\n\n日常的轻松感，或一段温柔的旅途。\n你更想靠近哪一种氛围？',status:'completed',sources:[{sourceId:`fixture-${i}`,kind:'offline_index',label:'测试离线条目 · 摇曳露营△',bgmId:102,retrievedAt:Date.now()}],toolSummaries:[],actions:[],usage:[]}).session
  }
  let actionBook=book('待确认的记录')
  actionBook=history.appendUser(alice,actionBook.id,{requestId:randomUUID(),expectedRevision:actionBook.revision,body:'先让我看看变更预览'}).session
  history.appendAssistant(alice,actionBook.id,{requestId:randomUUID(),expectedRevision:actionBook.revision,body:'把预览贴在这里，等你之后确认。',status:'completed',sources:[],toolSummaries:[],usage:[],actions:[{actionId:'fixture-preview',kind:'track_change',state:'prepared',eventSeq:1,updatedAt:Date.now(),evidence:'preview',errorCode:null,userReportedSuccess:false,summary:'将『摇曳露营△』标为想看。这是界面测试记录，尚未执行。'},{actionId:'fixture-playback',kind:'playback_open',state:'unknown',eventSeq:1,updatedAt:Date.now(),evidence:'timeout',errorCode:'TIMEOUT',userReportedSuccess:false,summary:'已记录页面打开意图，还没有实际播放回执。'}]})
  let other=book('另一位用户的手帐',bob);other=history.appendUser(bob,other.id,{requestId:randomUUID(),expectedRevision:other.revision,body:'BOB_PRIVATE_SENTINEL'}).session
  const welcome=book('新的一页')
  store.proposePreference(alice,{category:'tone',value:'推荐时先说氛围和集数，别剧透。'})
  let mode:'normal'|'slow'|'error'|'unavailable'|'stale'|'sources'='normal'
  const profile:ProviderProfile={source:'byok',model:'ui-scripted-fixture',fingerprint:'ui-fixture-only',capabilities:{protocol:'chat_completions',contextTokens:1_000_000,maxOutputTokens:8192,toolCalling:true,tokenCounting:'estimate',nativeCompaction:'none',nativeMinimumTokens:0,verified:true}}
  const usage=(operation:AgentUsage['operation']='model'):AgentUsage=>({operation,provider:'byok',model:profile.model,inputTokens:100,cachedInputTokens:0,outputTokens:30,durationMs:1,resultCount:1,estimatedCost:null,currency:null,priceVersion:null})
  const provider:ContextProvider={profile,async probe(signal){signal.throwIfAborted();return{value:profile.capabilities,usage:usage('compact')}},async count(input){return estimateContextTokens(input)},async json(operation,data,signal){
    await delay(150,undefined,{signal})
    if(operation==='verify')return{value:{passed:true,missingMessageIds:[],contradictions:[]},usage:usage('compact')}
    const value=data as {records?:{messageId:string}[];summaries?:SummaryState[]},anchor=value.records?.[0]?.messageId??value.summaries?.[0]?.task_goal.messageIds[0]
    const fact={value:'一起整理轻松、无剧透的番剧线索。',messageIds:[anchor!],sourceIds:[],certainty:'unknown' as const}
    const state:SummaryState={task_goal:fact,confirmed_preferences:[],entities:[],constraints:[],decisions:[],source_refs:[],tool_results:[],action_receipts:[],unresolved_questions:[],next_step:fact,injection_flags:[]}
    return{value:state,usage:usage('compact')}
  },async native(){throw new Error('NO_NATIVE_FIXTURE')}}
  const context=new AgentContextService(store,()=>provider),runStore=new AgentRunStore(db)
  // 注册表直接取生产的 READ_DATA_TOOLS，不再抄一份：抄的那份一旦漏掉新工具，
  // 功能说明里引用它的条目会被判成 pending_sync，表现为「发送没反应」而不是工具报错，很难查。
  const {READ_DATA_TOOLS}=await import('../server/agent/data-tools')
  const release=readLoadedRelease().release,registry=new AgentKnowledgeRegistry(release,AGENT_FEATURE_REGISTRATIONS,AGENT_FEATURES,READ_DATA_TOOLS)
  const knowledge=(uid:number)=>({...registry.snapshot(uid,{enabled:true,permissionVersion:mode,features:AGENT_FEATURES.map(f=>f.id),tools:['listMyTracks'],conditions:{answerModelReady:mode!=='unavailable',contextModelReady:true,chatUiReady:true}}),release:mode==='stale'?'older-client-test-server':release})
  const runs=new AgentRunService(runStore,uid=>({context,knowledge:()=>knowledge(uid),assertIdentity(){},provider:{source:'byok',model:profile.model,fingerprint:profile.fingerprint,async *stream(request,signal):AsyncGenerator<RunProviderEvent>{
    metrics.modelCalls++;yield{type:'usage',usage:usage()}
    if(!request.results.length){yield{type:'output',value:{kind:'tool_calls',calls:[{name:'listMyTracks',arguments:{filters:{limit:3}}}]}};return}
    const answer='线索已经夹进手帐啦。\n\n先从轻松的日常开始，慢慢看看角色之间的小细节。你想先聊哪一部？'
    let built=''
    for(const text of [answer.slice(0,10),answer.slice(10,28),answer.slice(28)]){await delay(mode==='slow'?3000:120,undefined,{signal});built+=text;yield{type:'delta',text};if(mode==='error')throw new Error('SCRIPTED_PROVIDER_ERROR')}
    yield{type:'output',value:{kind:'answer',text:built,sourceIds:['ui-tracks-source']}}
  }},tools:[{name:'listMyTracks',async execute(_args,actor){metrics.toolCalls++;if(actor.uid!==uid)throw new Error('OWNER_MISMATCH');return{ok:true,data:{items:[],revision:0},sources:[{sourceId:'ui-tracks-source',kind:'my_tracks',label:'测试手帐里的追番',retrievedAt:1}],resultCount:0,truncated:false}}}]}))
  const app=new Hono<{Variables:{agentUid:number}}>();app.use('*',securityHeaders());app.use('/api/*',sameOriginGuard())
  const {createGuestApi}=await import('../server/agent/guest-api')
  const {guestDataTools}=await import('../server/agent/run-runtime')
  const guestKnowledge=()=>registry.guestSnapshot({enabled:true,permissionVersion:mode,features:AGENT_FEATURES.map(f=>f.id),tools:['readCachedCalendar','listPublicReviews','aggregatePublicData'],conditions:{answerModelReady:true}})
  const guestStatus=()=>({enabled:true,configured:true,ready:true,source:'server' as const,model:'ui-guest-fixture'})
  app.route('/api/agent',createGuestApi({
    database:db,status:guestStatus,connect:async()=>{metrics.connections++;await delay(300);return guestStatus()},knowledge:guestKnowledge,tools:guestDataTools,
    binding:()=>({context:provider,execute:action=>action(),provider:{
      source:'server',model:'ui-guest-fixture',fingerprint:'ui-guest-fixture',
      async *stream(request,signal){
        metrics.modelCalls++
        if(mode==='sources'){
          if(!request.results.length){yield {type:'output' as const,value:{kind:'tool_calls',calls:['public_users','public_tracks','public_reviews','public_recommendations'].map(metric=>({name:'aggregatePublicData',arguments:{metric,filters:{}}}))}}}
          else{const sources=request.results.flatMap(r=>(r.result as {sources?:{sourceId:string}[]}).sources??[]);yield {type:'output' as const,value:{kind:'answer',text:'已查询大厅的四项公开统计，具体指标与口径可在下方展开查看。',sourceIds:sources.map(s=>s.sourceId)}}}
          return
        }
        const text='## 先从这里开始\n\n**番剧周历**看更新，*追番大厅*看公开点评。\n\n1. 挑一部想看的番\n2. 看看大家的评价\n\n> 不急，慢慢挑。\n\n| 页面 | 用途 |\n| --- | --- |\n| 周历 | 更新安排 |\n| 大厅 | 公开点评 |\n\n```ts\nconst greeting = "hello";\nconsole.log(greeting);\n```\n\n这是 `行内代码`，也可以点[番剧周历](/#/)。'
        for(const piece of [text.slice(0,30),text.slice(30,130),text.slice(130)]){await delay(mode==='slow'?3000:120,undefined,{signal});yield {type:'delta' as const,text:piece}}
        yield {type:'output' as const,value:{kind:'answer',text,sourceIds:[]}}
      },
    }}),
  }))
  app.use('/api/agent/*',async(c,next)=>{metrics.apiRequests++;const session=await getSession(c);if(!session)return c.json({code:'AUTH_REQUIRED'},401);c.set('agentUid',session.uid);await next()})
  app.get('/__agent-test/login/:owner',async c=>{const owner=c.req.param('owner')==='bob'?{uid:bob,username:'ui_bob'}:c.req.param('owner')==='empty'?{uid:empty,username:'ui_empty'}:{uid:alice,username:'ui_alice'};await issueSession(c,{...owner,tv:0});return c.redirect('/#/tracks')})
  app.post('/__agent-test/mode',async c=>{const value=await c.req.json() as {mode:typeof mode};if(!['normal','slow','error','unavailable','stale','sources'].includes(value.mode))return c.json({ok:false},400);mode=value.mode;return c.json({ok:true})})
  app.get('/__agent-test/status',c=>c.json({metrics,mode,welcomeId:welcome.id,storyId:story.id,actionId:actionBook.id}))
  app.get('/api/agent/provider',c=>{c.header('X-Agent-Owner',String(c.get('agentUid')));return c.json({enabled:true,ready:true,source:'server',model:'ui-model-fixture',profiles:[{endpoint:'https://api.deepseek.com',model:'deepseek-v4-flash-vision-exp',contextTokens:1000000}],usage:{tokens:100,cost:0.001,turns:1,warningCost:0.005}})})
  app.route('/api/agent',createAgentRunApi(runs,knowledge,new AgentActionStore(db,Date.now,uid=>knowledge(uid).version),new AgentPlaybackStore(db,Date.now,uid=>knowledge(uid).version),{heartbeatMs:1000,idleMs:60_000}));app.route('/api/agent',createAgentContextApi(context));app.route('/',production)
  const dist=join(directory,'dist');cpSync(fileURLToPath(new URL('../dist/',import.meta.url)),dist,{recursive:true});const html=readFileSync(join(dist,'index.html'),'utf8').replace(/<script\b[^>]*src=["']https?:\/\/[^>]*>[\s\S]*?<\/script>/gi,'')
  app.get('/',c=>c.html(html));app.use('/*',serveStatic({root:dist}))
  const port=Number(process.env.AGENT_UI_PORT??0);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('FIXTURE_PORT');
  const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port});await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('FIXTURE_ADDRESS')
  const origin=`http://127.0.0.1:${address.port}`,browserOrigin=`http://agent-phase4.localhost:${address.port}`;network.enableNetConnect(new URL(origin).host)
  const close=async()=>{await runs.close();await context.close();await productionContext.close();const done=new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));(server as Server).closeAllConnections();await done;db.close();await network.close();setGlobalDispatcher(oldDispatcher);globalThis.fetch=originalFetch;process.chdir(oldCwd);process.env=oldEnv;rmSync(directory,{recursive:true,force:true})}
  return{origin,browserOrigin,originalFetch,createUser,alice,bob,welcomeId:welcome.id,storyId:story.id,actionId:actionBook.id,history,store,context,runs,db,metrics,close}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  process.env.AGENT_UI_FIXTURE='1';process.env.NODE_ENV='test';const fixture=await createAgentUiFixture()
  console.log(JSON.stringify({origin:fixture.origin,browserUrl:fixture.browserOrigin+'/__agent-test/login/alice',mode:'isolated-ui-fixture',realAiCalls:0}))
  process.once('SIGINT',()=>void fixture.close().then(()=>process.exit(0)));process.once('SIGTERM',()=>void fixture.close().then(()=>process.exit(0)))
}
