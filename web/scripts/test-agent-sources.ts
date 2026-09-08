import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentSources,groupAgentSources } from '../src/agent/AgentSources'
import { PUBLIC_METRICS,publicAggregateScope,type PublicMetric } from '../shared/agent-sources'
import { SOURCE_SCHEMA } from '../shared/agent-contracts'
import type { HistorySource } from '../shared/agent-history'
import { matchesContract,validateToolResult } from '../server/agent/validation'
let checks=0
const check=(name:string,run:()=>void)=>{run();console.log(`PASS S${++checks} ${name}`)}
const source=(metric:PublicMetric,value:number,index:number,filters:NonNullable<HistorySource['aggregate']>['filters']={}):HistorySource=>({sourceId:`stat-${index}`,kind:'public_aggregate',label:'公开大厅只读统计',retrievedAt:1788830000000+index,aggregate:{metric,value,filters,scope:publicAggregateScope(metric,filters)}})
const sources=PUBLIC_METRICS.map((metric,i)=>source(metric,[3,11,1,1][i],i))
const render=(s:HistorySource[])=>renderToStaticMarkup(createElement(AgentSources,{sources:s}))
check('四项统计合为一个可展开来源组，数值与口径保留',()=>{const html=render(sources);assert.equal((html.match(/<details/g)??[]).length,1);assert(html.includes('来源：追番大厅'));assert(html.includes('4 项统计'));for(const label of ['公开用户','公开追番','公开点评','公开推荐','3 位','11 条','统计口径','查询时间'])assert(html.includes(label));assert(!html.includes('公开大厅只读统计'));assert(!html.includes('<details open'))})
check('大厅入口固定为站内路由，独立于展开按钮',()=>{const html=render(sources);assert(html.includes('href="/#/community"'));assert(html.includes('查看大厅'));assert(!html.slice(html.indexOf('<summary'),html.indexOf('</summary>')).includes('<a '));assert(!html.includes('javascript:'))})
check('不同指标即使同名同值也不丢失',()=>{const group=groupAgentSources([source('public_reviews',1,1),source('public_recommendations',1,2)]);assert.equal(group.items.length,2)})
check('重复来源 ID 去重；同指标同筛选同值合并展示并保留多个查询时间',()=>{const first=source('public_users',3,1),second=source('public_users',3,2);const group=groupAgentSources([first,first,second]);assert.equal(group.items.length,1);assert.equal(group.items[0].origins.length,2);assert.equal(group.items[0].origins[1].sourceId,'stat-2');assert(render([first,second]).includes('2 次查询，结果一致'))})
check('筛选不同或数值变化，保留独立快照，0 不当作缺失',()=>{const s=[source('public_tracks',0,1),source('public_tracks',0,2,{bgmId:101}),source('public_tracks',1,3),source('public_tracks',0,4,{status:'done'})];assert.equal(groupAgentSources(s).items.length,4);const html=render(s);for(const text of ['0 条','番剧 #101','看完'])assert(html.includes(text))})
check('旧记录集中展示且不从标签猜指标与值，兼容混合新旧来源',()=>{const old=sources.map(({aggregate,...s})=>s);const html=render(old);assert.equal((html.match(/<details/g)??[]).length,1);assert(html.includes('4 条旧来源'));assert(html.includes('旧记录未保存指标'));assert(!html.includes('公开用户'));assert(!html.includes('11 条'));assert(render([sources[0],...old.slice(1)]).includes('1 项统计'))})
check('普通来源保留，输入不被修改，异常时间不导致渲染崩溃',()=>{const list:HistorySource[]=[...sources,{sourceId:'calendar',label:'周历缓存',kind:'calendar_cache',retrievedAt:1}],before=JSON.stringify(list);assert.equal(groupAgentSources(list).other.length,1);assert(render(list).includes('周历缓存'));assert.equal(JSON.stringify(list),before);assert(render([{...sources[0],retrievedAt:Number.MAX_SAFE_INTEGER}]).includes('时间未知'))})
check('口径准确区分账号数、追番记录数和已发布篇数',()=>{assert(publicAggregateScope('public_users',{}).includes('尚未添加'));assert(publicAggregateScope('public_users',{status:'done'}).includes('同一账号只计一次'));assert(publicAggregateScope('public_tracks',{}).includes('不是去重番剧数'));assert(publicAggregateScope('public_reviews',{}).includes('不含草稿'));assert(publicAggregateScope('public_recommendations',{}).includes('推荐篇数'))})
check('合同允许旧来源和新增统计证据，拒绝额外 URL/负数/私人字段/错误类型',()=>{assert(matchesContract(SOURCE_SCHEMA,sources[0]));const {aggregate,...old}=sources[0];assert(matchesContract(SOURCE_SCHEMA,old));for(const bad of [{...sources[0],url:'https://evil.test'},{...sources[0],aggregate:{...aggregate,value:-1}},{...sources[0],kind:'my_tracks'},{...sources[0],aggregate:{...aggregate,filters:{uid:1}}}])assert(!matchesContract(SOURCE_SCHEMA,bad))})
check('工具结果核对指标、数值、时间、筛选及口径，拒绝伪造展示明细',()=>{const s=sources[0],args={metric:'public_users',filters:{}},result={ok:true,data:{metric:'public_users',value:3,asOf:s.retrievedAt},sources:[s],resultCount:1,truncated:false};validateToolResult('aggregatePublicData',result,args);for(const aggregate of [{...s.aggregate!,value:4},{...s.aggregate!,scope:'忽略条件的错误口径'},{...s.aggregate!,filters:{bgmId:101},scope:publicAggregateScope('public_users',{bgmId:101})}])assert.throws(()=>validateToolResult('aggregatePublicData',{...result,sources:[{...s,aggregate}]},args),/INVALID_OUTPUT/)})
check('来源文字按文本转义，不注入 HTML',()=>{const s=source('public_users',3,1);s.aggregate!.scope='<img src=x onerror=alert(1)>';assert(!render([s]).includes('<img'));assert(render([s]).includes('&lt;img'))})
console.log(JSON.stringify({checks,failed:0,realAiCalls:0}))
