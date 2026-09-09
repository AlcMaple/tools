import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { RunView } from '../shared/agent-run'
import type { HistoryMessage,HistorySession } from '../shared/agent-history'
import { AgentController } from '../src/agent/controller'
import { emptyPreferenceValues } from '../shared/agent-context'
import { firstMessageTitle } from '../server/agent/history-store'
import { MessageCard } from '../src/agent/AgentCards'
import { applyDelta,fallbackChoices,mergeMessages,phoneDevice,shouldSend,validAnime,viewportPlacement } from '../src/agent/model'
import { createAgentUiFixture } from './agent-ui-fixture'

process.env.NODE_ENV='test';process.env.AGENT_UI_FIXTURE='1'
const fixture=await createAgentUiFixture(),controllers:AgentController[]=[],fetches:{path:string;method:string;body:unknown}[]=[]
const {Hono}=await import('hono'),{issueSession}=await import('../server/auth'),{readLoadedRelease}=await import('../server/agent/release')
let checks=0,serial=0
const waitFor=async(test:()=>boolean)=>{for(let i=0;i<200;i++){if(test())return;await delay(20)}throw new Error('UI_FIXTURE_WAIT_TIMEOUT')}
const check=async(name:string,run:()=>unknown|Promise<unknown>)=>{await run();checks++;console.log(`PASS U${String(checks).padStart(2,'0')} ${name}`)}
async function owner(uid?:number){const name=`ui_case_${++serial}`,id=uid??fixture.createUser(name);const app=new Hono().get('/',async c=>{await issueSession(c,{uid:id,username:name,tv:0});return c.text('ok')});const cookie=(await app.request(fixture.origin)).headers.get('set-cookie')!.split(';')[0]
  const fetchImpl:typeof fetch=async(input,init)=>{const path=String(input);fetches.push({path,method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):null});const headers=new Headers(init?.headers);headers.set('Cookie',cookie);headers.set('Origin',fixture.origin);return fixture.originalFetch(path.startsWith('/')?fixture.origin+path:path,{...init,headers})}
  return{uid:id,fetchImpl}
}
async function controller(uid?:number,override?:(base:typeof fetch)=>typeof fetch){const actor=await owner(uid);const c=new AgentController(actor.uid,readLoadedRelease().release,{fetchImpl:override?override(actor.fetchImpl):actor.fetchImpl,pollMs:200});controllers.push(c);await c.initialize();assert.equal(c.getSnapshot().error,null);return c}
async function seedSession(c:AgentController){const session=fixture.history.createSession(c.uid,{requestId:randomUUID(),currentBgmId:c.getSnapshot().anime?.bgmId??null});await c.select(session.id)}
const blank=(id='message-1'):HistoryMessage=>({id,sessionId:'session-1',seq:1,role:'assistant',body:'',status:'streaming',sources:[],sourceIds:[],actions:[],actionIds:[],toolSummaries:[],usage:[],pinned:false,createdAt:1,updatedAt:1})
const mode=async(value:string)=>{const response=await fixture.originalFetch(fixture.origin+'/__agent-test/mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:value})});assert(response.ok)}
try{
  const hostSource=readFileSync(new URL('../src/agent/AgentHost.tsx',import.meta.url),'utf8'),cssSource=readFileSync(new URL('../src/agent/agent.css',import.meta.url),'utf8')
  await check('头像复用同一图集裁切，不把整张贴图作为 img 展示',()=>{assert(!hostSource.includes('<img src="/assets/sagiri-face.webp"'));assert.equal((hostSource.match(/<AgentAvatar\/>/g)??[]).length,2);assert(cssSource.includes('289.473684% 263.157895%'));assert(cssSource.includes('.agent-empty-art>span:not(.agent-avatar)'));assert(Math.abs(550/(289.473684/100)-190)<0.001);assert(Math.abs(500/(263.157895/100)-190)<0.001)})
  await check('入口固定 52px 正圆，发送箭头使用 18px SVG 而非字体箭头',()=>{const launcher=cssSource.split('.agent-launcher {')[1].split('}')[0];assert(launcher.includes('width:52px;height:52px'));assert(!launcher.includes('min-width'));assert(hostSource.includes('<svg width="18" height="18"'));assert(!hostSource.includes('<span>↑</span>'))})
  await check('偏好分类分别保存输入，一次保存四项，无确认卡片',()=>{assert(hostSource.includes('PREFERENCE_EXAMPLES[category]'));assert(hostSource.includes('value={values[category]}'));assert(hostSource.includes('onClick={()=>setCategory(key as'));assert(hostSource.includes('c.savePreferences(values,settings.version)'));assert(!hostSource.includes('待你确认'));assert(!hostSource.includes('确认使用'));assert(!hostSource.includes('放入待确认'))})
  await check('对话导航在短视口仍保留，设置移除重复入口和常驻刷新说明',()=>{const manage=hostSource.split('function ManagePane')[1];assert(!manage.includes('agent-quick-nav'));assert(!manage.includes('刷新页面'));assert(hostSource.includes("onClick={()=>changeSection('chat')}>对话"));assert(!cssSource.includes('.agent-layer[data-short=true] .agent-nav,'));for(const text of ['一点线索，慢慢收好','把好奇的事写下来','A LITTLE NOTE FOR TODAY','对话准备中，想聊的内容'])assert(!hostSource.includes(text))})
  await check('PC、平板横竖屏、窄窗和键盘高度均在可视区域内计算固定浮层',()=>{for(const [width,height] of [[1440,900],[1024,768],[768,1024],[500,700],[720,450],[768,320],[320,240]]){const p=viewportPlacement({width,height,left:0,top:0});assert(p.left>=0&&p.top>=0&&p.width<=width&&p.height<=height);assert(p.left+p.width<=width&&p.top+p.height<=height);assert.equal(p.short,height<480)}const p=viewportPlacement({width:600,height:380,left:30,top:100});assert(p.left>=30&&p.top>=100&&p.top+p.height<=480)})
  await check('手机横竖屏隐藏，平板弹出键盘与桌面窄窗不误判手机',()=>{assert(phoneDevice(true,390,844));assert(phoneDevice(true,844,390));assert(!phoneDevice(true,768,1024));assert(!phoneDevice(false,390,844))})
  await check('中文输入法、229 与 Shift+Enter 不触发发送',()=>{assert(shouldSend('Enter',false,false));assert(!shouldSend('Enter',false,true));assert(!shouldSend('Enter',false,false,229));assert(!shouldSend('Enter',true,false));assert(!shouldSend('a',false,false))})
  await check('番剧上下文只接受有界 ID/标题，失败入口按相关意图和已有资格展示',()=>{assert(validAnime({bgmId:101,title:'番剧'}));assert(!validAnime({bgmId:0,title:'番剧'}));assert(!validAnime({bgmId:101,title:'x'.repeat(201)}));assert.deepEqual(fallbackChoices('找一部轻松的番',null),['search']);assert.deepEqual(fallbackChoices('写点评',{bgmId:101,title:'x'}),[]);assert.deepEqual(fallbackChoices('写点评',{bgmId:101,title:'x',canReview:true}),['review']);assert.deepEqual(fallbackChoices('打开稀饭',{bgmId:101,title:'x',canOpenSources:true}),['xifan']);assert.deepEqual(fallbackChoices('播放',{bgmId:101,title:'x'}),[])})
  await check('SSE 重放以独立缓冲对齐原文，完整记录不重复追加',()=>{const buffers=new Map<string,string>(),message={...blank(),body:'你好'};const event=(text:string,seq:number)=>({runId:'run-1',seq,type:'delta' as const,data:{messageId:message.id,text},createdAt:2});let messages=applyDelta([message],buffers,event('你',1),message.sessionId);assert.equal(messages[0].body,'你好');messages=applyDelta(messages,buffers,event('好',2),message.sessionId);assert.equal(messages[0].body,'你好');messages=applyDelta(messages,buffers,event('呀',3),message.sessionId);assert.equal(messages[0].body,'你好呀');const complete={...messages[0],status:'completed' as const};assert.equal(applyDelta([complete],buffers,event('迟到',4),message.sessionId)[0].body,'你好呀')})
  await check('原文分页按 ID 去重、按 seq 排序且旧响应不覆盖新记录',()=>{const a={...blank('m1'),seq:1,body:'新',updatedAt:3},b={...blank('m2'),seq:2};assert.deepEqual(mergeMessages([b,a],[{...a,body:'旧',updatedAt:2}]).map(m=>[m.id,m.body]),[['m1','新'],['m2','']])})
  await check('正文与来源按文本转义，无预览时不出现可执行确认按钮',()=>{const message={...blank(),body:'<img src=x onerror="alert(1)"><script>bad()</script>',sources:[{sourceId:'source',kind:'offline_index' as const,label:'<svg onload=bad()>',retrievedAt:1}],actions:[{actionId:'action',kind:'track_change' as const,state:'prepared' as const,eventSeq:1,updatedAt:1,evidence:'preview' as const,errorCode:null,userReportedSuccess:false,summary:'待确认预览'}]};const html=renderToStaticMarkup(createElement(MessageCard,{message,disabled:false}));assert(html.includes('&lt;img'));assert(!html.includes('<script>'));assert(!html.includes('<svg onload'));assert(!html.includes('确认执行'));assert(html.includes('正在读取预览'))})
  await check('取到预览与凭证后动作卡显示新旧值与确认/取消，凭证缺失只提示过期',()=>{
    const action={actionId:'act-1',kind:'track_change' as const,state:'prepared' as const,eventSeq:1,updatedAt:1,evidence:'preview' as const,errorCode:null,userReportedSuccess:false,summary:'把某番改为看完'}
    const bundle={action:{actionId:'act-1',state:'prepared',errorCode:null,expiresAt:9,actualRevision:null},preview:{actionId:'act-1',kind:'track_change' as const,bgmId:101,impact:'把某番改为看完',expectedRevision:3,expiresAt:9,before:{bgmId:101,title:'某番',status:'watching',episode:2,userTags:[]},after:{bgmId:101,title:'某番',status:'done',episode:2,userTags:['补']}},confirmationToken:'x'.repeat(64)}
    let confirmed='',cancelled=''
    const ready=renderToStaticMarkup(createElement(MessageCard,{message:{...blank(),status:'completed' as const,actions:[action]},disabled:false,actionPreviews:{'act-1':bundle},onConfirmAction:(id:string)=>{confirmed=id},onCancelAction:(id:string)=>{cancelled=id}}))
    assert(ready.includes('确认执行')&&ready.includes('在看')&&ready.includes('看完')&&ready.includes('补'))
    const stale=renderToStaticMarkup(createElement(MessageCard,{message:{...blank(),status:'completed' as const,actions:[action]},disabled:false,actionPreviews:{'act-1':{...bundle,confirmationToken:null}},onConfirmAction:()=>{},onCancelAction:()=>{}}))
    assert(!stale.includes('确认执行')&&stale.includes('预览已过期'))
    // 标签由页面打开「我的追番」时回填，空标签不显示「无标签」，免得用户以为拿不到再追问
    const noTag={...bundle,preview:{...bundle.preview,before:null,after:{...bundle.preview.after,userTags:[]}}}
    const added=renderToStaticMarkup(createElement(MessageCard,{message:{...blank(),status:'completed' as const,actions:[action]},disabled:false,actionPreviews:{'act-1':noTag},onConfirmAction:()=>{},onCancelAction:()=>{}}))
    assert(!added.includes('无标签')&&added.includes('未追此番'))
    void confirmed;void cancelled
  })
  await check('初始化只读，不自动创建会话或调用模型',async()=>{const before=fetches.length,models=fixture.metrics.modelCalls,c=await controller();assert.equal(c.getSnapshot().session,null);assert(fetches.slice(before).every(r=>r.method==='GET'));assert.equal(fixture.metrics.modelCalls,models)})
  await check('已有会话与当前番剧落到正确账号，点击上下文不访问数据工具',async()=>{const c=await controller();await c.setAnime({bgmId:101,title:'当前的番'});await seedSession(c);const session=c.getSnapshot().session!;assert.equal(session.currentBgmId,101);assert.equal(fixture.history.exportSession(c.uid,session.id).session.id,session.id);const before=fixture.metrics.toolCalls;await c.setAnime({bgmId:102,title:'换到另一部'});assert.equal(c.getSnapshot().anime?.title,'换到另一部');assert.equal(fixture.metrics.toolCalls,before);await c.setAnime(null);assert.equal(c.getSnapshot().session?.currentBgmId,null)})
  await check('收起/再打开保留草稿和会话，不发取消或保存请求',async()=>{const c=await controller();await seedSession(c);c.setDraft('尚未发送的草稿');const before=fetches.length,id=c.getSnapshot().session!.id;c.setOpen(false);c.setOpen(true);assert.equal(c.getSnapshot().draft,'尚未发送的草稿');assert.equal(c.getSnapshot().session!.id,id);assert.equal(fetches.length,before)})
  await check('会话之间切换保留各自草稿，不串到另一本',async()=>{const c=await controller();await seedSession(c);const first=c.getSnapshot().session!.id;c.setDraft('第一本草稿');await seedSession(c);const second=c.getSnapshot().session!.id;c.setDraft('第二本草稿');await c.select(first);assert.equal(c.getSnapshot().draft,'第一本草稿');await c.select(second);assert.equal(c.getSnapshot().draft,'第二本草稿')})
  await check('切会话时慢到的旧 GET 被丢弃',async()=>{let block='',release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});const c=await controller(undefined,base=>async(input,init)=>{const response=await base(input,init);if(block&&String(input).includes(`/sessions/${block}?`))await gate;return response});await seedSession(c);const first=c.getSnapshot().session!.id;await seedSession(c);const second=c.getSnapshot().session!.id;block=first;const pending=c.select(first);await delay(20);await c.select(second);release();await pending;assert.equal(c.getSnapshot().session?.id,second)})
  await check('真实本机 HTTP + SSE 驱动 UI 状态，回答不重复并显示来源',async()=>{await mode('normal');const c=await controller();c.setOpen(true);c.setDraft('UI 测试消息');await c.send();const run=c.getSnapshot().run!;await fixture.runs.wait(run.id);await waitFor(()=>c.getSnapshot().connection==='idle');const messages=c.getSnapshot().messages;assert.equal(messages.length,2);assert.equal(messages.at(-1)!.body,'线索已经夹进手帐啦。\n\n先从轻松的日常开始，慢慢看看角色之间的小细节。你想先聊哪一部？');assert.equal(messages.at(-1)!.sources[0].sourceId,'ui-tracks-source');assert.equal(c.getSnapshot().draft,'');assert.equal(c.getSnapshot().run?.state,'completed')})
  await check('隐藏后多个正文片段只计一条未读，打开后清除当前未读',async()=>{const c=await controller();c.setOpen(false);c.setDraft('未读计数');await c.send();await fixture.runs.wait(c.getSnapshot().run!.id);await waitFor(()=>c.getSnapshot().connection==='idle');assert.equal(c.getSnapshot().unread,1);c.setOpen(true);assert.equal(c.getSnapshot().unread,0)})
  await check('模型未接入时保留输入，不用 fake 或普通消息接口代发',async()=>{await mode('unavailable');const c=await controller(),before=fetches.length,models=fixture.metrics.modelCalls;c.setDraft('准备之后再发');await c.send();assert.equal(c.getSnapshot().draft,'准备之后再发');assert.equal(c.getSnapshot().error?.code,'AGENT_RUNTIME_NOT_READY');assert.equal(c.getSnapshot().session,null);assert.equal(fetches.length,before);assert.equal(fixture.metrics.modelCalls,models);await mode('normal')})
  await check('429 一律显示平和的「等几秒再试」，不显示通用「请求已停止」',async()=>{
    let on=false;const c=await controller(undefined,base=>async(input,init)=>on&&String(input).includes('/knowledge')?new Response(JSON.stringify({code:'RATE_LIMITED',error:'这次请求已停止，请检查后手动重试。'}),{status:429,headers:{'X-Agent-Owner':String(c.uid)}}):base(input,init))
    await seedSession(c);on=true
    await c.refresh()
    assert.equal(c.getSnapshot().error?.code,'RATE_LIMITED')
    assert(c.getSnapshot().error!.message.includes('等几秒')&&!c.getSnapshot().error!.message.includes('已停止'))
  })
  await check('发送响应中断后手动重试沿用请求号，不重复模型调用',async()=>{let drop=true;const c=await controller(undefined,base=>async(input,init)=>{const result=await base(input,init);if(drop&&init?.method==='POST'&&String(input).endsWith('/runs')){drop=false;throw new TypeError('fixture network loss')}return result});c.setDraft('相同请求');await c.send();assert.equal(c.getSnapshot().draft,'相同请求');const session=c.getSnapshot().session!,first=fixture.runs.store.list(c.uid,session.id).runs[0];await fixture.runs.wait(first.id);const before=fixture.metrics.modelCalls;await c.send();await waitFor(()=>c.getSnapshot().connection==='idle');assert.equal(c.getSnapshot().run?.id,first.id);assert.equal(fixture.metrics.modelCalls,before);assert.equal(fixture.history.exportSession(c.uid,session.id).messages.length,2)})
  await check('切标签页回来的后台对账失败静默处理，不弹横幅；点「重新读取」才提示',async()=>{
    let block=false;const c=await controller(undefined,base=>async(input,init)=>{if(block&&String(input).includes('/knowledge'))return new Response(JSON.stringify({code:'PROVIDER_UNAVAILABLE',error:'这次请求已停止，请检查后手动重试。'}),{status:503,headers:{'X-Agent-Owner':String(c.uid)}});return base(input,init)})
    await seedSession(c);block=true
    await c.refresh(true);assert.equal(c.getSnapshot().error,null)
    await c.refresh();assert.equal(c.getSnapshot().error?.code,'PROVIDER_UNAVAILABLE')
    block=false;await c.refresh();assert.equal(c.getSnapshot().error,null)
  })
  await check('SSE 掉线不弹惊吓横幅：回读权威状态，回合完成后正文照常落地',async()=>{await mode('normal');let drop=2;const c=await controller(undefined,base=>async(input,init)=>{if(drop>0&&String(input).includes('/events')){drop--;throw new TypeError('fixture SSE loss')}return base(input,init)});c.setOpen(true);c.setDraft('掉线测试');await c.send();await fixture.runs.wait(c.getSnapshot().run!.id);await waitFor(()=>c.getSnapshot().connection==='idle');assert.equal(c.getSnapshot().error,null);assert.equal(c.getSnapshot().run?.state,'completed');assert.equal(c.getSnapshot().messages.length,2);assert(c.getSnapshot().messages.at(-1)!.body.length>0)})
  await check('模型失败留住片段，重新编辑只恢复问题而不自动收费重试',async()=>{await mode('error');const c=await controller();c.setDraft('保留这条问题');await c.send();await fixture.runs.wait(c.getSnapshot().run!.id);await waitFor(()=>c.getSnapshot().connection==='idle');assert.equal(c.getSnapshot().run?.state,'failed');assert(c.getSnapshot().messages.at(-1)!.body.length>0);const before=fixture.metrics.modelCalls;const last=c.getSnapshot().messages.filter(m=>m.role==='user').at(-1)!;c.startEdit(last);assert.equal(c.getSnapshot().draft,'保留这条问题');assert.equal(c.getSnapshot().editingSeq,last.seq);assert.equal(fixture.metrics.modelCalls,before);c.cancelEdit();await mode('normal')})
  await check('明确取消停止活动回合，终态与原文从服务器回读',async()=>{await mode('slow');const c=await controller();c.setDraft('慢一点');await c.send();await c.cancel();await waitFor(()=>c.getSnapshot().connection==='idle');assert.equal(c.getSnapshot().run?.state,'cancelled');assert.equal(c.getSnapshot().messages[0].body,'慢一点');await mode('normal')})
  await check('偏好先待确认、确认后生效，编辑/删除带 revision',async()=>{const c=await controller();await c.preference('create',{category:'tone',value:'温柔的短句'});let card=c.getSnapshot().preferences[0];assert.equal(card.status,'proposed');await c.preference('confirm',{id:card.id,revision:card.revision});card=c.getSnapshot().preferences[0];assert.equal(card.status,'confirmed');await c.preference('edit',{id:card.id,revision:card.revision,value:'简短一些'});card=c.getSnapshot().preferences[0];assert.equal(card.value,'简短一些');await c.preference('delete',{id:card.id,revision:card.revision});assert.equal(c.getSnapshot().preferences.length,0)})
  await check('编辑首条并重发：截断其后对话，只重新回答编辑的那句；上下文档位走后端 revision',async()=>{
    await mode('normal');const c=await controller();c.setOpen(true)
    for(const q of ['第一句','第二句']){c.setDraft(q);await c.send();await fixture.runs.wait(c.getSnapshot().run!.id);await waitFor(()=>c.getSnapshot().connection==='idle')}
    assert.equal(c.getSnapshot().messages.length,4)
    const first=c.getSnapshot().messages.filter(m=>m.role==='user')[0]
    c.startEdit(first);assert.equal(c.getSnapshot().editingSeq,first.seq)
    c.setDraft('第一句改过了');await c.send();await fixture.runs.wait(c.getSnapshot().run!.id);await waitFor(()=>c.getSnapshot().connection==='idle')
    const msgs=c.getSnapshot().messages
    assert.equal(msgs.length,2);assert.equal(msgs[0].body,'第一句改过了');assert.equal(msgs[0].role,'user');assert.equal(msgs[1].role,'assistant')
    assert.equal(c.getSnapshot().editingSeq,null)
    assert.equal(fixture.history.exportSession(c.uid,c.getSnapshot().session!.id).messages.length,2)
    await c.tier('64k',false);assert.equal(c.getSnapshot().session?.contextTier,'64k');assert.equal(c.getSnapshot().context?.adaptive,false)
  })
  await check('旧 revision 失败不自动覆盖另一端，重新读取后显示新名称',async()=>{const c=await controller();await seedSession(c);const session=c.getSnapshot().session!;fixture.history.patchSession(c.uid,session.id,{expectedRevision:session.revision,title:'另一端的新名称'});await c.manage('rename','过期修改');assert.equal(c.getSnapshot().error?.code,'REVISION_CONFLICT');await c.refresh();assert.equal(c.getSnapshot().session?.title,'另一端的新名称')})
  await check('归档/恢复、清空与删除 UI 操作维持历史语义',async()=>{const c=await controller();await seedSession(c);const start=c.getSnapshot().session!;fixture.history.appendUser(c.uid,start.id,{requestId:randomUUID(),expectedRevision:start.revision,body:'首条消息'});await c.refresh();await c.manage('archive');assert(c.getSnapshot().session?.archivedAt);await c.manage('archive');assert.equal(c.getSnapshot().session?.archivedAt,null);c.setDraft('清空测试');await c.send();await fixture.runs.wait(c.getSnapshot().run!.id);await waitFor(()=>c.getSnapshot().connection==='idle');await c.manage('clear');assert.equal(c.getSnapshot().messages.length,0);assert(c.getSnapshot().session);await c.manage('delete');assert.equal(c.getSnapshot().session,null)})
  await check('另一端清空后重新读取不会把已清除的消息拼回来',async()=>{const c=await controller();c.setDraft('跨端清空');await c.send();await fixture.runs.wait(c.getSnapshot().run!.id);await waitFor(()=>c.getSnapshot().connection==='idle');const session=fixture.store.session(c.uid,c.getSnapshot().session!.id);fixture.history.clearSession(c.uid,session.id,{expectedRevision:session.revision});await c.refresh();assert.equal(c.getSnapshot().messages.length,0)})
  await check('导出由明确操作触发，包含原文而不暴露内部检查点',async()=>{const c=await controller();c.setDraft('导出内容');await c.send();await fixture.runs.wait(c.getSnapshot().run!.id);await waitFor(()=>c.getSnapshot().connection==='idle');const data=await c.export() as {messages:HistoryMessage[]};assert.equal(data.messages[0].body,'导出内容');assert(!JSON.stringify(data).includes('checkpoint_json'))})
  await check('摘要整理进度保留到终态，手动 /compact 不变成普通聊天消息',async()=>{const c=await controller();await seedSession(c);let session=c.getSnapshot().session!;for(let i=0;i<12;i++){session=fixture.history.appendUser(c.uid,session.id,{requestId:randomUUID(),expectedRevision:session.revision,body:'旧线索'}).session;session=fixture.history.appendAssistant(c.uid,session.id,{requestId:randomUUID(),expectedRevision:session.revision,body:'已经记录',status:'completed',sources:[],toolSummaries:[],actions:[],usage:[]}).session}await c.refresh();c.setDraft('/compact');await c.send();await waitFor(()=>c.getSnapshot().job?.stage==='completed');await waitFor(()=>c.getSnapshot().context?.active!==null);assert.equal(c.getSnapshot().draft,'');assert.equal(c.getSnapshot().messages.length,24);assert(c.getSnapshot().context?.active)})
  await check('账号失效会清空界面并停止请求，迟到响应不恢复旧内容',async()=>{let expired=0;const actor=await owner(),c=new AgentController(actor.uid,'client',{fetchImpl:async()=>new Response(JSON.stringify({code:'AUTH_REQUIRED'}),{status:401}),onAuthExpired(){expired++}});controllers.push(c);c.setDraft('PRIVATE_DRAFT');await c.initialize();assert.equal(expired,1);assert.equal(c.getSnapshot().draft,'');assert.equal(c.getSnapshot().authExpired,true);assert.equal(c.getSnapshot().messages.length,0)})
  await check('销毁后迟到的旧账号请求不污染另一个账号的控制器',async()=>{const a=await owner();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});const c=new AgentController(a.uid,'client',{fetchImpl:async(input,init)=>{const result=await a.fetchImpl(input,init);await gate;return result}});controllers.push(c);c.setDraft('OLD_OWNER_PRIVATE');const pending=c.initialize();await delay(20);c.dispose();const other=await controller(fixture.bob);release();await pending;assert.equal(c.getSnapshot().draft,'');assert(!JSON.stringify(other.getSnapshot()).includes('OLD_OWNER_PRIVATE'));assert(JSON.stringify(other.getSnapshot()).includes('BOB_PRIVATE_SENTINEL'))})
  await check('服务器发布版本变化标记旧客户端，但不自动刷新或清除草稿',async()=>{await mode('stale');const c=await controller();c.setDraft('刷新前的草稿');await c.refresh();assert.notEqual(c.getSnapshot().knowledge?.release,c.clientVersion);assert.equal(c.getSnapshot().draft,'刷新前的草稿');await mode('normal')})
  await check('快速切换归档筛选与刷新时，晚到的旧结果不覆盖当前视图',async()=>{
    let blockList=true,releaseList!:()=>void;const listGate=new Promise<void>(resolve=>{releaseList=resolve})
    const c=await controller(undefined,base=>async(input,init)=>{const result=await base(input,init);if(blockList&&String(input).includes('archived=archived'))await listGate;return result})
    const old=c.list(true);await delay(10);await c.list(false);blockList=false;releaseList();await old;assert.equal(c.getSnapshot().archived,false)
    let block='',release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve})
    const current=await controller(undefined,base=>async(input,init)=>{const result=await base(input,init);if(block&&String(input).includes(`/sessions/${block}?`))await gate;return result})
    await seedSession(current);const session=current.getSnapshot().session!;block=session.id;const first=current.refresh();await delay(15);block='';fixture.history.patchSession(current.uid,session.id,{expectedRevision:session.revision,title:'较新的名称'});await current.refresh();release();await first;assert.equal(current.getSnapshot().session?.title,'较新的名称')
  })
  await check('暂停后先完成权威回读，再为新 attempt 开启独立 SSE 通道',async()=>{
    let run:RunView|null=null,events=0,held=false,release!:()=>void,emitter:ReadableStreamDefaultController<Uint8Array>|undefined
    const gate=new Promise<void>(resolve=>{release=resolve}),encoder=new TextEncoder(),runId=randomUUID()
    const reply=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json','X-Agent-Owner':String(c.uid)}})
    const frame=(seq:number,type:string,attempt:number)=>encoder.encode(`id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({runId,seq,type,data:{attempt},createdAt:1})}\n\n`)
    const c=await controller(undefined,base=>async(input,init)=>{
      const path=String(input)
      if(init?.method==='POST'&&path.endsWith('/resume')){run={...run!,state:'running',attempt:2,canResume:false};return reply({run})}
      if(init?.method==='POST'&&path.endsWith('/runs')){const sessionId=path.split('/')[4];run={id:runId,sessionId,state:'running',messageId:null,userMessageId:'user-fixture',attempt:1,rounds:0,activeMs:0,createdAt:1,updatedAt:1,lastEventSeq:0,code:null,knowledgeVersion:'fixture',canResume:false};return reply({run})}
      if(path.includes(`/runs/${runId}/events`)){
        events++
        if(events===1){run={...run!,state:'paused',canResume:true};return new Response(frame(1,'paused',1),{headers:{'Content-Type':'text/event-stream','X-Agent-Run-Attempt':'1','X-Agent-Owner':String(c.uid)}})}
        return new Response(new ReadableStream<Uint8Array>({start(controller){emitter=controller;controller.enqueue(frame(2,'resumed',2))}}),{headers:{'Content-Type':'text/event-stream','X-Agent-Run-Attempt':'2','X-Agent-Owner':String(c.uid)}})
      }
      if(path===`/api/agent/runs/${runId}`){if(!held){held=true;const previous=structuredClone(run);await gate;return reply({run:previous})}return reply({run})}
      if(run&&/\/sessions\/[^/]+\/runs(?:\?|$)/.test(path))return reply({runs:[run]})
      // 打开/对账已经改成合并读取(?include=context,runs),夹具里的假回合要从同一个响应里给回去。
      if(run&&/\/sessions\/[^/?]+\?/.test(path)&&path.includes('include=')&&path.includes('runs')){
        const merged=await (await base(input,init)).json() as Record<string,unknown>
        return reply({...merged,runs:[run]})
      }
      return base(input,init)
    })
    await seedSession(c);c.setDraft('通道切换夹具');await c.send();await waitFor(()=>held);assert.equal(c.getSnapshot().run?.state,'paused');assert.equal(c.getSnapshot().syncing,true);await c.resume();assert.equal(events,1);release();await waitFor(()=>c.getSnapshot().connection==='idle');await c.resume();await waitFor(()=>events===2);await delay(20)
    assert.equal(c.getSnapshot().watchingRun?.attempt,2);assert.equal(c.getSnapshot().connection,'connected')
    run={...run!,state:'completed'};emitter!.enqueue(frame(3,'completed',2));emitter!.close();await waitFor(()=>c.getSnapshot().connection==='idle');assert.equal(c.getSnapshot().watchingRun?.attempt,2)
  })
  await check('响应归属与界面账号不一致时，在读取正文前清空旧状态',async()=>{
    const actor=await owner();let expired=0
    const c=new AgentController(actor.uid,'fixture',{fetchImpl:async()=>{return new Response('INVALID_JSON_FROM_OTHER_OWNER',{headers:{'X-Agent-Owner':String(actor.uid+1000)}})},onAuthExpired(){expired++}});controllers.push(c);c.setDraft('OLD_DRAFT');await c.initialize();assert.equal(expired,1);assert.equal(c.getSnapshot().draft,'');assert.equal(c.getSnapshot().messages.length,0)
  })
  await check('反复新对话不创建空记录，首条发送进入历史并且只取题一次',async()=>{
    const c=await controller(),before=fetches.length
    for(let i=0;i<12;i++)await c.newSession()
    assert.equal(fetches.length,before);assert.equal(c.getSnapshot().session,null);assert.equal(fixture.history.listSessions(c.uid).sessions.length,0)
    c.setDraft('请帮我推荐几部轻松的日常番，不要剧透。谢谢！');await c.send();await fixture.runs.wait(c.getSnapshot().run!.id);await waitFor(()=>c.getSnapshot().connection==='idle')
    const session=c.getSnapshot().session!;assert(session.startedAt);assert.equal(session.title,'推荐几部轻松的日常番，不要剧透');assert.equal(fixture.history.listSessions(c.uid).sessions.length,1)
    await c.manage('rename','我的周末片单');c.setDraft('再看看科幻作品');await c.send();await fixture.runs.wait(c.getSnapshot().run!.id);await waitFor(()=>c.getSnapshot().connection==='idle');assert.equal(c.getSnapshot().session?.title,'我的周末片单')
    await c.manage('clear');c.setDraft('清空后继续');await c.send();await fixture.runs.wait(c.getSnapshot().run!.id);await waitFor(()=>c.getSnapshot().connection==='idle');assert.equal(c.getSnapshot().session?.title,'我的周末片单')
  })
  await check('旧空会话隐藏且拒绝归档，首条取题尊重手动标题与长度',async()=>{
    const actor=await owner(),s=fixture.history.createSession(actor.uid,{requestId:randomUUID()});assert.equal(fixture.history.listSessions(actor.uid).sessions.length,0)
    assert.throws(()=>fixture.history.patchSession(actor.uid,s.id,{expectedRevision:s.revision,archived:true}),/发送首条消息/)
    const renamed=fixture.history.patchSession(actor.uid,s.id,{expectedRevision:s.revision,title:'手动标题'})
    const sent=fixture.history.appendUser(actor.uid,s.id,{requestId:randomUUID(),expectedRevision:renamed.revision,body:'自动标题不应覆盖我'}).session;assert.equal(sent.title,'手动标题');assert(sent.startedAt)
    assert.equal(firstMessageTitle('你好，请帮我推荐治愈番。不要剧透'),'推荐治愈番');assert.equal(Array.from(firstMessageTitle('长'.repeat(100))).length,25)
  })
  await check('历史条目独立归档恢复，不切换当前对话',async()=>{
    const c=await controller();await seedSession(c);const first=c.getSnapshot().session!;fixture.history.appendUser(c.uid,first.id,{requestId:randomUUID(),expectedRevision:first.revision,body:'第一段'});await c.refresh();const target=c.getSnapshot().session!
    await seedSession(c);const current=c.getSnapshot().session!.id;await c.archiveSession(target);assert.equal(c.getSnapshot().session!.id,current);await c.list(true);assert.equal(c.getSnapshot().sessions[0].id,target.id);await c.archiveSession(c.getSnapshot().sessions[0]);assert.equal(c.getSnapshot().session!.id,current);assert.equal(fixture.history.listSessions(c.uid).sessions[0].id,target.id)
  })
  await check('四项偏好原子保存、空白默认、重试幂等、版本冲突和账号隔离',async()=>{
    const c=await controller(),other=await controller();await c.preferences();await other.preferences();const version=c.getSnapshot().preferenceSettings!.version
    const values={tone:'简洁',liked_tags:'日常',avoided_tags:'恐怖',recommendation_focus:'短篇'}
    assert(await c.savePreferences(values,version));assert.equal(fixture.store.preferences(c.uid,true).length,4);assert.deepEqual(c.getSnapshot().preferenceSettings!.values,values)
    const firstVersion=c.getSnapshot().preferenceSettings!.version;assert(await c.savePreferences(values,version));assert.equal(c.getSnapshot().preferenceSettings!.version,firstVersion)
    assert.deepEqual(other.getSnapshot().preferenceSettings!.values,emptyPreferenceValues())
    assert(!(await c.savePreferences({...values,tone:'过期写入'},version)));assert.equal(c.getSnapshot().error?.code,'REVISION_CONFLICT');assert.equal(fixture.store.preferenceSettings(c.uid).values.tone,'简洁')
    assert(await c.savePreferences({...emptyPreferenceValues(),tone:'   '},firstVersion));assert.deepEqual(fixture.store.preferences(c.uid),[])
  })
  await check('旧同类多条取最后确认值，保存后每类唯一',async()=>{
    const c=await controller(),now=Date.now();fixture.db.prepare("INSERT INTO agent_preferences VALUES (?, ?, 'tone', ?, 'confirmed', 1, NULL, ?, ?, ?)").run(randomUUID(),c.uid,'旧值',now-1,now-1,now-1);fixture.db.prepare("INSERT INTO agent_preferences VALUES (?, ?, 'tone', ?, 'confirmed', 1, NULL, ?, ?, ?)").run(randomUUID(),c.uid,'最近确认值',now,now,now)
    await c.preferences();assert.equal(c.getSnapshot().preferenceSettings!.values.tone,'最近确认值');assert.equal(fixture.store.preferences(c.uid,true).length,1)
    assert(await c.savePreferences(c.getSnapshot().preferenceSettings!.values,c.getSnapshot().preferenceSettings!.version));assert.equal(fixture.store.preferences(c.uid).length,1)
  })
  await check('新对话草稿切换后恢复，发送后不残留到下一段新对话',async()=>{
    const c=await controller();await seedSession(c);const old=c.getSnapshot().session!.id;await c.newSession();c.setDraft('未发送的新草稿');await c.select(old);await c.newSession();assert.equal(c.getSnapshot().draft,'未发送的新草稿');await c.send();await fixture.runs.wait(c.getSnapshot().run!.id);await waitFor(()=>c.getSnapshot().connection==='idle');await c.newSession();assert.equal(c.getSnapshot().draft,'');assert.equal(c.getSnapshot().session,null)
  })
  await check('四项保存中任一写入失败整组回滚，参数缺失或越界不落库',async()=>{
    const actor=await owner(),values={tone:'原值',liked_tags:'日常',avoided_tags:'',recommendation_focus:''};const original=fixture.store.savePreferenceSettings(actor.uid,fixture.store.preferenceSettings(actor.uid).version,values)
    fixture.db.exec("CREATE TEMP TRIGGER fail_pref BEFORE INSERT ON agent_preferences WHEN NEW.value = 'FAIL_ATOMIC' BEGIN SELECT RAISE(ABORT, 'fixture save failure'); END")
    try{assert.throws(()=>fixture.store.savePreferenceSettings(actor.uid,original.version,{...values,tone:'新值',liked_tags:'FAIL_ATOMIC'}));assert.deepEqual(fixture.store.preferenceSettings(actor.uid),original)}finally{fixture.db.exec('DROP TRIGGER fail_pref')}
    for(const bad of [{tone:'漏字段'},{...values,tone:'长'.repeat(501)},{...values,userId:actor.uid}]){const response=await actor.fetchImpl('/api/agent/preferences/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:original.version,values:bad})});assert.equal(response.status,400);assert.deepEqual(fixture.store.preferenceSettings(actor.uid),original)}
    assert.throws(()=>fixture.store.proposePreference(actor.uid,{category:'tone',value:'第二个说话方式'}),/此分类已有偏好/)
  })
  await check('有 key 时页面后台预连接，发送复用探测且不显示连接提示',async()=>{
    const uid=fixture.createUser('auto-connect'),models=fixture.metrics.modelCalls;let connected=false,probes=0
    const c=await controller(uid,base=>async(input,init)=>{
      if(String(input)==='/api/agent/provider/prepare'){if(!connected)probes++;connected=true;return Response.json({ready:true},{headers:{'X-Agent-Owner':String(uid)}})}
      const response=await base(input,init)
      // /bootstrap 把功能说明和会话列表合并返回了,两处的 knowledge 都要按同一套条件改写。
      if(String(input)==='/api/agent/knowledge'){const knowledge=await response.json();knowledge.conditions.answerModelAutoConnect=true;knowledge.conditions.answerModelReady=connected;return Response.json(knowledge,{headers:response.headers})}
      if(String(input)==='/api/agent/bootstrap'){const boot=await response.json();boot.knowledge.conditions.answerModelAutoConnect=true;boot.knowledge.conditions.answerModelReady=connected;return Response.json(boot,{headers:response.headers})}
      return response
    })
    assert.equal(probes,1);assert.equal(fixture.metrics.modelCalls,models);assert(!c.getSnapshot().status.includes('连接'))
    c.setDraft('首次自动检查后回答');await c.send();assert.equal(c.getSnapshot().error,null);assert.equal(probes,1);await fixture.runs.wait(c.getSnapshot().run!.id);await waitFor(()=>c.getSnapshot().connection==='idle')
    c.setDraft('继续对话');await c.send();await fixture.runs.wait(c.getSnapshot().run!.id);await waitFor(()=>c.getSnapshot().connection==='idle');assert.equal(probes,1)
  })
  await check('自动探测失败保留草稿，不建会话、不发送回答、不自动重试',async()=>{
    const uid=fixture.createUser('auto-fail'),models=fixture.metrics.modelCalls;let probes=0
    const c=await controller(uid,base=>async(input,init)=>{
      if(String(input)==='/api/agent/provider/prepare'){probes++;return Response.json({code:'PROVIDER_HTTP_401',error:'API key 检查失败'},{status:503,headers:{'X-Agent-Owner':String(uid)}})}
      const response=await base(input,init)
      if(String(input)==='/api/agent/knowledge'){const knowledge=await response.json();knowledge.conditions.answerModelAutoConnect=true;knowledge.conditions.answerModelReady=false;return Response.json(knowledge,{headers:response.headers})}
      if(String(input)==='/api/agent/bootstrap'){const boot=await response.json();boot.knowledge.conditions.answerModelAutoConnect=true;boot.knowledge.conditions.answerModelReady=false;return Response.json(boot,{headers:response.headers})}
      return response
    })
    c.setDraft('失败后保留的问题');await c.send();assert.equal(c.getSnapshot().draft,'失败后保留的问题');assert.equal(c.getSnapshot().session,null);assert.equal(c.getSnapshot().error?.code,'PROVIDER_HTTP_401');assert.equal(probes,1);assert.equal(fixture.metrics.modelCalls,models)
  })
  await check('后台准备未结束时发送立即显示问题与思考占位，复用同一连接请求',async()=>{
    const uid=fixture.createUser('pending-placeholder');let release=()=>{},probes=0,ready=false
    const gate=new Promise<void>(r=>{release=r})
    const c=await controller(uid,base=>async(input,init)=>{
      if(String(input)==='/api/agent/provider/prepare'){probes++;await gate;ready=true;return Response.json({ready:true},{headers:{'X-Agent-Owner':String(uid)}})}
      const response=await base(input,init)
      if(String(input)==='/api/agent/knowledge'){const knowledge=await response.json();knowledge.conditions.answerModelAutoConnect=true;knowledge.conditions.answerModelReady=ready;return Response.json(knowledge,{headers:response.headers})}
      if(String(input)==='/api/agent/bootstrap'){const boot=await response.json();boot.knowledge.conditions.answerModelAutoConnect=true;boot.knowledge.conditions.answerModelReady=ready;return Response.json(boot,{headers:response.headers})}
      return response
    })
    assert.equal(probes,1);assert.equal(c.getSnapshot().error,null);assert.equal(c.getSnapshot().status,'')
    c.setDraft('立即出现的消息');const pending=c.send();assert.equal(c.getSnapshot().pendingBody,'立即出现的消息');assert.equal(c.getSnapshot().draft,'');assert(c.getSnapshot().status.includes('纱雾'));assert(!c.getSnapshot().status.includes('连接'));assert.equal(probes,1)
    release();await pending;await fixture.runs.wait(c.getSnapshot().run!.id);await waitFor(()=>c.getSnapshot().connection==='idle');assert.equal(c.getSnapshot().pendingBody,null)
  })
  await check('浏览器侧控制器没有新增工具执行权限，所有验证仅访问本机',()=>{assert.equal(fixture.metrics.externalRequests,0);assert(fetches.every(item=>item.path.startsWith('/api/agent/')));assert(!fetches.some(item=>/applyTrack|playback|\/api\/xifan|\/api\/girigiri/.test(item.path)))})
  console.log(JSON.stringify({checks,failed:0,httpRequests:fetches.length,externalRequests:fixture.metrics.externalRequests,realAiCalls:0,modelQuality:'not_run',controller:'real-loopback-http-sse-and-error-fixtures',rendering:'React-text-escaping',database:'temporary-sqlite',browserLayout:'separate-cua-record'}))
}finally{for(const c of controllers)c.dispose();await fixture.close()}
