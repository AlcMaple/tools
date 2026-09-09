import type { CompactJob } from '../../shared/agent-context'
import type { HistoryMessage } from '../../shared/agent-history'
import type { RunEvent } from '../../shared/agent-run'

export interface AnimeContext { bgmId:number; title:string; titleCn?:string;year?:number|null;episodes?:number|null;tags?:string[];summary?:string;completed?:boolean|null; canReview?:boolean; canOpenSources?:boolean }
export interface AgentIssue { code:string; message:string }
export interface TrackFields { bgmId:number; title:string; status:string; episode:number; userTags:string[] }
export interface TrackActionPreview {
  action:{actionId:string;state:string;errorCode:string|null;expiresAt:number;actualRevision:number|null}
  preview:{actionId:string;kind:'track_change';bgmId:number;impact:string;expectedRevision:number;expiresAt:number;before:TrackFields|null;after:TrackFields}
  confirmationToken:string|null
}
// 播放打开没有写入凭证：真正的执行发生在用户自己的浏览器里，服务端只签发回执。
export interface PlaybackActionPreview {
  action:{actionId:string;state:string;errorCode:string|null;expiresAt:number}
  preview:{actionId:string;kind:'playback_open';bgmId:number;impact:string;expiresAt:number;title:string;source:'xifan'|'girigiri';episode:number;target:'web_player'|'source_search';addsToTracks:boolean;bindsSource:{id:string;name:string}|null;sourceCandidates:{name:string;note:string}[]|null}
  openable:boolean
}
export type ActionPreview=TrackActionPreview|PlaybackActionPreview
export const isPlaybackPreview=(p:ActionPreview|undefined):p is PlaybackActionPreview=>p?.preview.kind==='playback_open'
export const isTrackPreview=(p:ActionPreview|undefined):p is TrackActionPreview=>p?.preview.kind==='track_change'
/** 播放打开的确认入口：<a> 在用户手势内直接开新标签，异步请求不吃浏览器的弹窗手势。 */
export const playbackOpenHref=(actionId:string):string=>`/api/agent/actions/${encodeURIComponent(actionId)}/open`
export const STATUS_TEXT:Record<string,string>={watching:'在看',plan:'想看',considering:'观望',done:'看完'}
export const activeCompact=(job:CompactJob|null):boolean=>Boolean(job&&!['completed','failed','cancelled','skipped'].includes(job.stage))
export const idValid=(id:unknown):id is string=>typeof id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(id)
export function validAnime(value:unknown):value is AnimeContext {
  if(!value||typeof value!=='object')return false
  const anime=value as Record<string,unknown>
  return Number.isSafeInteger(anime.bgmId)&&anime.bgmId!==0&&typeof anime.title==='string'&&anime.title.trim().length>0&&anime.title.length<=200
}
export const JOB_LABELS:Record<CompactJob['stage'],string>={queued:'等待压缩',budgeting:'检查上下文容量',extracting:'提取摘要',checking:'核对原文',merging:'合并摘要',native:'压缩上下文',completed:'压缩完成',failed:'压缩失败',cancelled:'已取消压缩',skipped:'暂不需要压缩'}
export function shouldSend(key:string,shift:boolean,composing:boolean,keyCode?:number):boolean{return key==='Enter'&&!shift&&!composing&&keyCode!==229}
export function viewportPlacement(v:{width:number;height:number;left:number;top:number}){
  const short=v.height<480,margin=short?8:16,width=Math.max(1,Math.min(440,v.width-margin*2))
  const height=Math.max(1,Math.min(660,v.height-margin*2-(short?0:66)))
  return{short,width,height,left:v.left+Math.max(margin,v.width-width-margin),top:v.top+Math.max(margin,v.height-height-margin-(short?0:66)),launcherLeft:v.left+v.width-margin,launcherTop:v.top+v.height-margin}
}
export function phoneDevice(coarse:boolean,screenWidth:number,screenHeight:number):boolean{return coarse&&Math.min(screenWidth,screenHeight)<600}
export function fallbackChoices(question:string,anime:AnimeContext|null):('search'|'review'|'xifan'|'girigiri')[]{
  const result:('search'|'review'|'xifan'|'girigiri')[]=[]
  if(/找|搜|推荐|类似|看什么/.test(question))result.push('search')
  if(/点评|评价|评论|推荐文/.test(question)&&anime?.bgmId&&anime.bgmId>0&&anime.canReview)result.push('review')
  if(anime&&anime.canOpenSources&&anime.bgmId>0&&/稀饭|girigiri|播放|片源|在线/i.test(question)){if(!/girigiri/i.test(question)||/稀饭/.test(question))result.push('xifan');if(!/稀饭/.test(question)||/girigiri/i.test(question))result.push('girigiri')}
  return result
}
export function mergeMessages(current:HistoryMessage[],incoming:HistoryMessage[]):HistoryMessage[]{
  const map=new Map(current.map(message=>[message.id,message]))
  for(const message of incoming){const old=map.get(message.id);if(!old||message.updatedAt>=old.updatedAt)map.set(message.id,message)}
  return[...map.values()].sort((a,b)=>a.seq-b.seq)
}
export function applyDelta(messages:HistoryMessage[],buffers:Map<string,string>,event:RunEvent,sessionId:string):HistoryMessage[]{
  if(event.type!=='delta'||!event.data||typeof event.data!=='object'||Array.isArray(event.data))return messages
  const {messageId,text}=event.data
  if(!idValid(messageId)||typeof text!=='string'||!text.length)return messages
  const body=(buffers.get(messageId)??'')+text
  if(body.length>32_000)return messages
  buffers.set(messageId,body)
  const previous=messages.find(message=>message.id===messageId)
  if(previous&&(previous.status!=='streaming'||!body.startsWith(previous.body)))return messages
  const message:HistoryMessage=previous?{...previous,body}:{id:messageId,sessionId,seq:(messages.at(-1)?.seq??0)+1,role:'assistant',body,status:'streaming',sources:[],sourceIds:[],toolSummaries:[],actions:[],actionIds:[],createdAt:event.createdAt,updatedAt:0,pinned:false,usage:[]}
  return previous?messages.map(item=>item.id===messageId?message:item):[...messages,message]
}

export function pageContext(anime:AnimeContext|null){
  if(!anime||anime.bgmId<=0)return null
  return {bgmId:anime.bgmId,title:anime.title,titleCn:(anime.titleCn??'').slice(0,200),year:anime.year&&anime.year>=1900&&anime.year<=2200?anime.year:null,episodes:anime.episodes&&anime.episodes>0&&anime.episodes<=20000?anime.episodes:null,tags:[...new Set((anime.tags??[]).map(t=>t.slice(0,20)).filter(Boolean))].slice(0,12),completed:anime.completed??null,summary:(anime.summary??'').slice(0,12000),loadedAt:Date.now()}
}
