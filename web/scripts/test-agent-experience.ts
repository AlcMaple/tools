import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentMarkdown,agentMarkdownUrl } from '../src/agent/AgentMarkdown'
import { AgentActivity,agentActivity } from '../src/agent/AgentActivity'
import { AgentConnection } from '../src/agent/connection'
import { partialAnswer } from '../server/agent/provider-stream'
import { createAnswerProvider } from '../server/agent/external-provider'
import { MODEL_OUTPUT_SCHEMA } from '../shared/agent-contracts'
import type { ProviderProfile } from '../server/agent/context-provider'
let checks=0
const check=async(name:string,test:()=>unknown)=>{await test();console.log(`PASS X${++checks} ${name}`)}
const render=(text:string)=>renderToStaticMarkup(createElement(AgentMarkdown,{text}))
await check('粗体、斜体、标题、引用和列表渲染为结构元素',()=>{const html=render('# 标题\n\n**番剧周历**与*文字*\n\n> 引用\n\n1. 一\n2. 二\n\n- 项目');for(const tag of ['h1','strong','em','blockquote','ol','ul'])assert(html.includes('<'+tag));assert(!html.includes('**番剧周历**'))})
await check('GFM 表格、删除线、任务清单和分隔线',()=>{const html=render('| 名字 | 说明 |\n| --- | --- |\n| 番剧 | 公开 |\n\n~~旧文字~~\n\n- [x] 完成\n- [ ] 未完成\n\n---');for(const tag of ['table','th','td','del','input','hr'])assert(html.includes('<'+tag));assert(html.includes('agent-table-wrap'));assert(html.includes('disabled'))})
await check('代码块支持语言标识、复制按钮和原始转义，未闭合 fence 也可增量显示',()=>{for(const text of ['```ts\nconst a = "<script>";\n```','```ts\nconst a = 1']){const html=render(text);assert(html.includes('<pre'));assert(html.includes('language-ts'));assert(html.includes('复制代码'));assert(!html.includes('<script>'))}assert(render('`x < y`').includes('<code>'))})
await check('HTML/script/iframe 不执行，图片不自动联网，危险 URL 不变为链接',()=>{const html=render('<script>alert(1)</script>\n\n<iframe src="https://x.test"></iframe>\n\n![图片](https://x.test/track.png)\n\n[x](javascript:alert%281%29)');assert(!html.includes('<script>'));assert(!html.includes('<iframe'));assert(!html.includes('<img'));assert(!html.includes('href="javascript:'));assert(!html.includes('src="https://x.test'))})
await check('链接协议、用户信息、反斜线及协议相对 URL 受限',()=>{for(const url of ['javascript:alert(1)','data:text/html,x','file:///x','https://a:b@x.test','//x.test','/\\x.test','https://x.test/\n'])assert.equal(agentMarkdownUrl(url),'');assert.equal(agentMarkdownUrl('/#/community'),'/#/community');assert.equal(agentMarkdownUrl('https://example.com/a'),'https://example.com/a');assert(render('[站点](https://example.com)').includes('noopener noreferrer'))})
await check('状态文案对应真实阶段，离线工具不声称联网搜索',()=>{assert(agentActivity('thinking').includes('纱雾'));for(const tool of ['readCachedCalendar','searchOfflineAnime','listMyTracks']){const label=agentActivity('tool',tool);assert(!label.includes('联网'));assert(!label.includes('连接'))}assert(renderToStaticMarkup(createElement(AgentActivity,{})).includes('role="status"'))})
await check('后台准备和发送共享同一 Promise，不重复探测',async()=>{let count=0,release=()=>{};const gate=new Promise<void>(r=>{release=r}),c=new AgentConnection(async()=>{count++;await gate});const a=c.ensure(),b=c.ensure();assert.equal(a,b);assert.equal(c.retry(),a);assert.equal(count,1);release();await a;await c.ensure();assert.equal(count,1)})
await check('后台失败不自动重试，显式重试后恢复；到期按需检查',async()=>{let count=0,now=0;const c=new AgentConnection(async()=>{if(++count===1)throw new Error('probe failed')},()=>now);await assert.rejects(c.ensure());await assert.rejects(c.ensure());assert.equal(count,1);await c.retry();await c.ensure();assert.equal(count,2);now=26*60000;await c.ensure();assert.equal(count,3)})
await check('JSON 字段换序、空格及 text 在前仍能增量取正文',()=>{for(const [text,wanted] of [['{"kind":"answer","sourceIds":[],"text":"早到的片段','早到的片段'],['{ "text" : "文字','文字'],['{"sourceIds":["a"], "kind":"answer", "text":"继续','继续']])assert.equal(partialAnswer(text),wanted);assert.equal(partialAnswer('{"kind":"tool_calls","calls":['),null);assert.equal(partialAnswer('{"results":{"text":"不是正文"},"text":"正文'),'正文')})
await check('JSON 反斜线、引号、Unicode 和半个 surrogate 不破坏逐字前缀',()=>{const text='引用 "文本"，路径 C:\\users，换行\n🙂 结尾';const raw=JSON.stringify({text,kind:'answer',sourceIds:[]});let last='';for(let i=1;i<=raw.length;i++){const p=partialAnswer(raw.slice(0,i));if(p!==null){assert(p.startsWith(last));last=p}}assert.equal(last,text);assert.equal(partialAnswer('{"text":"\\u4f'),'');assert.equal(partialAnswer('{"text":"\\\\u12'),'\\u12')})
await check('供应商尚未结束时已收到 delta，不使用整段文本模拟打字',async()=>{
 const profile:ProviderProfile={source:'server',model:'test-model',fingerprint:'fixture',capabilities:{protocol:'chat_completions',contextTokens:128000,maxOutputTokens:8192,toolCalling:true,verified:true,tokenCounting:'estimate',nativeCompaction:'none',nativeMinimumTokens:0}}
 let release=()=>{},ended=false;const gate=new Promise<void>(r=>{release=r})
 const provider=createAnswerProvider(profile,async(_p,_b,_s,_h,onText)=>{onText?.('{"sourceIds":[],"text":"第一段');await gate;onText?.('{"sourceIds":[],"text":"第一段第二段","kind":"answer"}');ended=true;return {choices:[{finish_reason:'stop',message:{content:'{"sourceIds":[],"text":"第一段第二段","kind":"answer"}'}}],usage:{prompt_tokens:10,completion_tokens:20}}},{currency:'USD',version:'fixture',inputPerMillion:1,cachedInputPerMillion:1,outputPerMillion:1})
 const iterator=provider.stream({system:'test',knowledge:{version:'v',release:'v',status:'ready',features:[],tools:[],notice:'',conditions:{}},layers:[],nativeState:null,tools:{},results:[],outputSchema:MODEL_OUTPUT_SCHEMA},new AbortController().signal)[Symbol.asyncIterator]()
 const first=await iterator.next();assert.deepEqual(first.value,{type:'delta',text:'第一段'});assert.equal(ended,false);release();let final=false;for(;;){const next=await iterator.next();if(next.done)break;if(next.value.type==='output')final=true}assert(final)
})
console.log(JSON.stringify({checks,failed:0,realAiCalls:0}))
