import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { AGENT_TOOLS,type AgentToolName,type JsonValue,type AgentErrorCode } from '../../shared/agent-contracts'
import { matchesContract,validateToolResult } from './validation'
import type { ReadTool } from './run-service'
import type { CalendarWeekday } from '../bgm/calendar'

export const READ_DATA_TOOLS = ['searchOfflineAnime','readCurrentAnimeContext','readCachedCalendar','listMyTracks','listPublicReviews','aggregatePublicData'] as const
export const GUEST_DATA_TOOLS = ['readCachedCalendar','listPublicReviews','aggregatePublicData'] as const
export type DataPrincipal = {kind:'user';uid:number;sessionId:string;tokenVersion:number}|{kind:'guest'}
export interface DataDependencies {
  db:Database.Database
  index:()=>Database.Database|null
  calendar:()=>{data:CalendarWeekday[];updatedAt:number}|null
  now?:()=>number
}
import type { PageAnimeContext } from '../../shared/agent-history'
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,32)
const text=(value:unknown,max:number)=>typeof value==='string'?value.slice(0,max):''
const list=(value:unknown):string[]=>{try{const a=typeof value==='string'?JSON.parse(value):value;return Array.isArray(a)?[...new Set(a.filter((v):v is string=>typeof v==='string').map(v=>v.slice(0,20)).filter(Boolean))].slice(0,12):[]}catch{return[]}}
const year=(value:unknown):number|null=>{const n=Number(text(value,10).slice(0,4));return Number.isInteger(n)&&n>=1900&&n<=2200?n:null}
const eps=(value:unknown):number|null=>typeof value==='number'&&Number.isInteger(value)&&value>0&&value<=20000?value:null
const fail=(code:AgentErrorCode,message:string)=>({ok:false as const,code,message,retryable:false})
const animeType="COALESCE(json_extract(CASE WHEN json_valid(t.extra) THEN t.extra ELSE '{}' END,'$.subjectType'),'anime') = 'anime'"
type Row=Record<string,unknown>
const anime=(r:Row)=>({bgmId:Number(r.bgm_id),title:text(r.name||r.name_cn,200),titleCn:text(r.name_cn,200),year:year(r.date),episodes:eps(r.eps),tags:list(r.tags),completed:null})
const tagged=(wanted:unknown,actual:string[])=>!Array.isArray(wanted)||wanted.every(tag=>actual.some(t=>t.toLowerCase()===String(tag).toLowerCase()))

export function createAgentDataTools(deps:DataDependencies,principal:DataPrincipal):readonly ReadTool[]{
  const now=deps.now??Date.now
  const names:readonly AgentToolName[]=principal.kind==='guest'?GUEST_DATA_TOOLS:READ_DATA_TOOLS
  return names.map(name=>({name,async execute(args,actor){
    const start=now(),deadline=start+AGENT_TOOLS[name].timeoutMs
    const guard=(identity=false)=>{
      if(actor.signal.aborted)throw fail('CANCELLED','查询已取消。')
      if(now()>deadline)throw fail('TIMEOUT','本地查询超时。')
      if(identity&&principal.kind==='user'){
        const row=deps.db.prepare('SELECT token_version FROM users WHERE id=?').get(principal.uid) as {token_version:number}|undefined
        if(actor.uid!==principal.uid||!row||row.token_version!==principal.tokenVersion)throw fail('AUTH_REQUIRED','账号状态已变化。')
        if(!deps.db.prepare('SELECT 1 FROM agent_sessions WHERE user_id=? AND id=?').get(principal.uid,principal.sessionId))throw fail('AUTH_REQUIRED','会话不属于当前账号。')
      }
    }
    const success=(data:Record<string,unknown>,kind:string,label:string,truncated=false)=>({ok:true,data,sources:[{sourceId:`data-${digest({name,data,principal:principal.kind==='user'?principal.uid:'guest',at:start})}`,kind,label,retrievedAt:start,...kind==='calendar_cache'?{cachedAt:data.cachedAt}:{} }],resultCount:Array.isArray(data.items)?data.items.length:1,truncated})
    try{
      guard(true)
      if(!matchesContract(AGENT_TOOLS[name].parameters,args))return fail('INVALID_ARGUMENT','查询参数不符合工具合同。')
      const f=(args.filters??{}) as Record<string,JsonValue>,limit=Number(f.limit??30)
      let result:unknown
      if(name==='searchOfflineAnime'){
        if(typeof f.yearFrom==='number'&&typeof f.yearTo==='number'&&f.yearFrom>f.yearTo)return fail('INVALID_ARGUMENT','年份范围不正确。')
        if(f.completed!==undefined)return fail('CONTEXT_MISSING','离线资料未收录可靠的完结状态，请移除此筛选条件。')
        const index=deps.index();if(!index)return fail('CACHE_MISS','离线索引尚未就绪，未调用在线搜索。')
        const columns=index.prepare('PRAGMA table_info(anime)').all() as {name:string}[]
        const query=`SELECT bgm_id,name,name_cn,aliases,date,score,${columns.some(c=>c.name==='tags')?'tags':"'[]' AS tags"},${columns.some(c=>c.name==='eps')?'eps':'0 AS eps'} FROM anime`
        let similar:string[]=[]
        if(f.similarToBgmId!==undefined){const base=index.prepare(query+' WHERE bgm_id=?').get(Number(f.similarToBgmId)) as Row|undefined;similar=list(base?.tags);if(!similar.length)return fail('CONTEXT_MISSING','目标番剧没有可用的离线标签。')}
        const seen=new Set<number>(),hits:{item:ReturnType<typeof anime>;score:number;rank:number}[]=[]
        let scanned=0
        const collect=(rows:Iterable<unknown>)=>{for(const raw of rows){guard();if(++scanned>100000)throw fail('QUOTA_EXCEEDED','离线候选过多，请缩小范围。');const r=raw as Row,id=Number(r.bgm_id);if(!Number.isSafeInteger(id)||id<=0||seen.has(id))continue;seen.add(id);const item=anime(r);if(!item.title)continue
          const q=text(f.query,120).trim().toLowerCase(),hay=[item.title,item.titleCn,text(r.aliases,8192)].join(' ').toLowerCase()
          if(q&&!hay.includes(q)||!tagged(f.tags,item.tags)||f.similarToBgmId===id||similar.length&&!similar.some(t=>item.tags.includes(t)))continue
          if(typeof f.yearFrom==='number'&&(item.year===null||item.year<f.yearFrom)||typeof f.yearTo==='number'&&(item.year===null||item.year>f.yearTo)||typeof f.episodesMax==='number'&&(item.episodes===null||item.episodes>f.episodesMax))continue
          hits.push({item,score:Number(r.score)||0,rank:similar.filter(t=>item.tags.includes(t)).length+(q&&(item.title.toLowerCase()===q||item.titleCn.toLowerCase()===q)?100:0)})}}
        collect(index.prepare(query).iterate())
        collect(deps.db.prepare("SELECT bgm_id,name,name_cn,aliases,date,score,'[]' AS tags,0 AS eps FROM bgm_search_additions").iterate())
        hits.sort((a,b)=>b.rank-a.rank||b.score-a.score||a.item.bgmId-b.item.bgmId)
        result=success({items:hits.slice(0,limit).map(h=>h.item)},'offline_index','BGM 离线索引与本地补充',hits.length>limit)
      }else if(name==='readCurrentAnimeContext'){
        if(principal.kind!=='user')return fail('AUTH_REQUIRED','访客尚未开放页面上下文工具。')
        const row=deps.db.prepare('SELECT current_bgm_id,page_context_json FROM agent_sessions WHERE user_id=? AND id=?').get(principal.uid,principal.sessionId) as {current_bgm_id:number|null;page_context_json:string}|undefined
        const page=row?.page_context_json?JSON.parse(row.page_context_json) as PageAnimeContext:null
        if(!page||page.bgmId!==row?.current_bgm_id||page.bgmId<=0)return fail('CONTEXT_MISSING','请先从番剧卡片带入当前资料。')
        const {summary,loadedAt,...item}=page
        result=success({anime:item,summary,loadedAt},'current_page','用户带入的当前页面资料')
      }else if(name==='readCachedCalendar'){
        const cache=deps.calendar();if(!cache)return fail('CACHE_MISS','周历缓存缺失，未自动刷新。')
        const range=args.range as Record<string,JsonValue>,items:unknown[]=[]
        for(const day of cache.data){guard();if(day.id<1||day.id>7||Array.isArray(range.weekdays)&&!range.weekdays.includes(day.id))continue
          for(const item of day.items){if(!Number.isSafeInteger(item.id)||item.id<=0)continue;items.push({weekday:day.id,anime:anime({bgm_id:item.id,name:item.name,name_cn:item.name_cn,date:item.airDate,eps:item.episodes})})}}
        result=success({items:items.slice(0,Number(range.limit)),cachedAt:cache.updatedAt,stale:now()-cache.updatedAt>=14*86400000},'calendar_cache','已有周历缓存',items.length>Number(range.limit))
      }else if(name==='listMyTracks'){
        if(principal.kind!=='user')return fail('AUTH_REQUIRED','需要登录。')
        const rows=deps.db.prepare(`SELECT t.bgm_id,t.title,t.title_cn,t.status,t.episode,t.user_tags FROM tracks t WHERE user_id=? AND ${animeType} ORDER BY t.updated_at DESC,t.bgm_id`).all(principal.uid) as Row[]
        const items=rows.filter(r=>(f.status===undefined||r.status===f.status)&&(!Array.isArray(f.bgmIds)||f.bgmIds.includes(Number(r.bgm_id)))&&tagged(f.tags,list(r.user_tags)))
        const offset=Number(f.offset??0),revision=(deps.db.prepare('SELECT tracks_rev FROM users WHERE id=?').get(principal.uid) as {tracks_rev:number}).tracks_rev
        result=success({items:items.slice(offset,offset+limit).map(r=>({bgmId:r.bgm_id,title:text(r.title_cn||r.title,200),status:r.status,episode:r.episode,userTags:list(r.user_tags)})),revision},'my_tracks','当前账号的追番',items.length>offset+limit)
      }else if(name==='listPublicReviews'){
        const allowed=f.spoiler==='none'?['none']:f.spoiler==='aired'?['none','aired']:['none','aired','all']
        const rows=deps.db.prepare(`SELECT r.bgm_id,r.mode,r.body,r.spoiler,r.published_at,u.username FROM review_contents r JOIN users u ON u.id=r.user_id JOIN tracks t ON t.user_id=r.user_id AND t.bgm_id=r.bgm_id WHERE u.tracks_public=1 AND r.published=1 AND r.bgm_id=? AND ${animeType} AND r.spoiler IN (${allowed.map(()=>'?').join(',')}) AND (? IS NULL OR r.mode=?) ORDER BY r.published_at DESC,u.username,r.mode LIMIT ?`).all(Number(args.bgmId),...allowed,f.mode??null,f.mode??null,limit+1) as Row[]
        result=success({items:rows.slice(0,limit).map(r=>({reviewId:`review-${digest([r.username,r.bgm_id,r.mode])}`,bgmId:r.bgm_id,mode:r.mode,body:text(r.body,4000),spoiler:r.spoiler,author:text(r.username,100),publishedAt:Number(r.published_at)||0}))},'public_reviews','已公开且发布的点评与推荐',rows.length>limit)
      }else{
        const filter=`${animeType} AND (? IS NULL OR t.bgm_id=?) AND (? IS NULL OR t.status=?)`,params=[f.bgmId??null,f.bgmId??null,f.status??null,f.status??null]
        let sql:string
        if(args.metric==='public_users')sql=f.bgmId===undefined&&f.status===undefined?'SELECT COUNT(*) AS value FROM users WHERE tracks_public=1':`SELECT COUNT(DISTINCT u.id) AS value FROM users u JOIN tracks t ON t.user_id=u.id WHERE u.tracks_public=1 AND ${filter}`
        else if(args.metric==='public_tracks')sql=`SELECT COUNT(*) AS value FROM tracks t JOIN users u ON u.id=t.user_id WHERE u.tracks_public=1 AND ${filter}`
        else sql=`SELECT COUNT(*) AS value FROM review_contents r JOIN users u ON u.id=r.user_id JOIN tracks t ON t.user_id=r.user_id AND t.bgm_id=r.bgm_id WHERE u.tracks_public=1 AND r.published=1 AND r.mode='${args.metric==='public_reviews'?'review':'recommend'}' AND ${filter}`
        const row=deps.db.prepare(sql).get(...(args.metric==='public_users'&&f.bgmId===undefined&&f.status===undefined?[]:params)) as {value:number}
        result=success({metric:args.metric,value:row.value,asOf:start},'public_aggregate','公开大厅只读统计')
      }
      guard(true);validateToolResult(name,result);return result
    }catch(error){if(error&&typeof error==='object'&&'ok' in error&&error.ok===false)return error;return fail('INTERNAL_ERROR','本地资料暂时不可读取。')}
  }}))
}
