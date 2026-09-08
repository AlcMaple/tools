import type { MouseEvent } from 'react'
import type { HistorySource } from '../../shared/agent-history'
import { PUBLIC_METRIC_LABELS,SOURCE_STATUS_LABELS } from '../../shared/agent-sources'
import { navigate } from '../router'

const SOURCE_LABEL:Record<HistorySource['kind'],string>={offline_index:'离线资料',current_page:'当前页面',calendar_cache:'周历缓存',my_tracks:'我的追番',public_reviews:'公开点评',public_aggregate:'公开统计'}
export function groupAgentSources(sources:readonly HistorySource[]){
  const seen=new Set<string>(),other:HistorySource[]=[],legacy:HistorySource[]=[],items:{source:HistorySource;origins:HistorySource[]}[]=[]
  for(const source of sources){
    if(seen.has(source.sourceId))continue;seen.add(source.sourceId)
    if(source.kind!=='public_aggregate'){other.push(source);continue}
    if(!source.aggregate){legacy.push(source);continue}
    const d=source.aggregate
    const existing=items.find(({source:s})=>{const a=s.aggregate!;return a.metric===d.metric&&a.value===d.value&&a.filters.bgmId===d.filters.bgmId&&a.filters.status===d.filters.status&&a.scope===d.scope})
    if(existing)existing.origins.push(source);else items.push({source,origins:[source]})
  }
  return {items,legacy,other}
}
function SourceTime({at}:{at:number}){
  const date=new Date(at)
  return Number.isFinite(date.getTime())?<time dateTime={date.toISOString()} title={date.toISOString()}>{date.toLocaleString('zh-CN',{hour12:false})}</time>:<span>时间未知</span>
}
function openCommunity(event:MouseEvent<HTMLAnchorElement>,onNavigate?:()=>void){
  if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return
  event.preventDefault();navigate('community');onNavigate?.()
}
export function AgentSources({sources,onNavigate}:{sources:readonly HistorySource[];onNavigate?:()=>void}){
  const {items,legacy,other}=groupAgentSources(sources)
  if(!sources.length)return null
  return <div className="agent-sources" aria-label="来源">
    {(items.length>0||legacy.length>0)&&<details className="agent-stat-sources">
      <summary><span>来源：追番大厅</span><small>{items.length>0?`${items.length} 项统计`:''}{items.length>0&&legacy.length>0?' · ':''}{legacy.length>0?`${legacy.length} 条旧来源`:''}</small></summary>
      <div className="agent-stat-content">
        {items.map(({source,origins})=>{const d=source.aggregate!,label=PUBLIC_METRIC_LABELS[d.metric],times=[...new Set(origins.map(s=>s.retrievedAt))].sort((a,b)=>a-b)
          return <section className="agent-stat-item" key={source.sourceId} aria-label={label.label}>
            <div className="agent-stat-title"><b>{label.label}</b><span>{d.value} {label.unit}</span></div>
            <p>统计口径：{d.scope}</p>
            <p>筛选：{d.filters.bgmId===undefined&&d.filters.status===undefined?'全部公开范围':<>{d.filters.bgmId!==undefined&&`番剧 #${d.filters.bgmId}`}{d.filters.bgmId!==undefined&&d.filters.status!==undefined?' · ':''}{d.filters.status!==undefined&&SOURCE_STATUS_LABELS[d.filters.status]}</>}</p>
            <p className="agent-stat-time">查询时间：<SourceTime at={times[0]}/>{times.length>1&&<> 至 <SourceTime at={times[times.length-1]}/></>}{origins.length>1&&` · ${origins.length} 次查询，结果一致`}</p>
          </section>
        })}
        {legacy.length>0&&<div className="agent-stat-item"><p>旧记录未保存指标与统计口径，明细暂缺；未从回答正文推测补齐。</p><ul>{legacy.map(source=><li key={source.sourceId}>查询时间：<SourceTime at={source.retrievedAt}/></li>)}</ul></div>}
        <p className="agent-stat-note">记录的是当时的查询结果，当前大厅可能已更新。</p>
        <a className="agent-source-link" href="/#/community" onClick={event=>openCommunity(event,onNavigate)}>查看大厅 <span aria-hidden="true">↗</span></a>
      </div>
    </details>}
    {other.map(source=><div className="agent-source" key={source.sourceId}><span><b>{source.label}</b><small>{SOURCE_LABEL[source.kind]}{source.bgmId!==undefined?` · #${source.bgmId}`:''}</small></span></div>)}
  </div>
}
