import type { HistoryMessage } from '../../shared/agent-history'
import type { ActionState } from '../../shared/agent-contracts'
import { Ic } from '../SketchIcon'

const ACTION_LABEL:Record<ActionState,string>={prepared:'待确认',user_confirmed:'已确认',dispatch_started:'已发起',navigation_committed:'页面已打开',player_ready:'播放器已就绪',source_selected:'已选择片源',media_canplay:'可以开始播放',playing:'正在播放',completed:'已完成',failed:'未完成',cancelled:'已取消',unknown:'结果待确认'}
const SOURCE_LABEL:Record<HistoryMessage['sources'][number]['kind'],string>={offline_index:'离线资料',current_page:'当前页面',calendar_cache:'周历记录',my_tracks:'我的追番',public_reviews:'公开点评',public_aggregate:'公开统计'}
export function MessageCard({message,onPin,disabled}:{message:HistoryMessage;onPin:()=>void;disabled:boolean}):JSX.Element{
  const own=message.role==='user'
  return <article className={`agent-message ${own?'agent-message-own':''}`} data-message-id={message.id}>
    <div className="agent-message-by"><span>{own?'我':'纱雾'}</span><span>{message.pinned?'已固定':message.status==='streaming'?'正在写…':message.status==='cancelled'?'已停止':message.status==='failed'?'保留的片段':''}</span><button type="button" className={`agent-icon ${message.pinned?'is-on':''}`} title={message.pinned?'取消固定原文':'固定原文'} aria-label={message.pinned?'取消固定原文':'固定原文'} onClick={onPin} disabled={disabled||message.status==='streaming'}><Ic name="clip" cls="ic ic-sm" /></button></div>
    {message.body?<p className="agent-message-text">{message.body}</p>:message.status==='streaming'?<p className="agent-writing" aria-label="正在整理"><span>·</span><span>·</span><span>·</span></p>:<p className="agent-message-empty">这一页的查询记录已收好。</p>}
    {message.sources.length>0&&<div className="agent-sources" aria-label="来源">{message.sources.map(source=><div className="agent-source" key={source.sourceId}><Ic name="tracks" cls="ic ic-sm" /><span><b>{source.label}</b><small>{SOURCE_LABEL[source.kind]}{source.bgmId!==undefined?` · #${source.bgmId}`:''}</small></span></div>)}</div>}
    {message.toolSummaries.length>0&&<details className="agent-tool-records"><summary>翻阅记录 · {message.toolSummaries.length}</summary><ul>{message.toolSummaries.map((tool,index)=><li key={index}>{tool.summary}</li>)}</ul></details>}
    {message.actions.map(action=><div key={action.actionId} className="agent-action-card" data-action-state={action.state}><div><Ic name={action.kind==='track_change'?'tracks':'play'} cls="ic ic-sm" /><b>{action.kind==='track_change'?'追番变更':'播放打开'}</b><span>{ACTION_LABEL[action.state]}</span></div><p>{action.summary}</p>{action.state==='prepared'&&<button type="button" className="btn btn-sm" disabled title="动作确认将在后续功能中开放">确认入口准备中</button>}{action.state==='unknown'&&<small>目前还没有实际完成的回执。</small>}</div>)}
  </article>
}
