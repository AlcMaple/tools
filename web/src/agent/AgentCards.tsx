import type { HistoryMessage } from '../../shared/agent-history'
import type { ActionState } from '../../shared/agent-contracts'
import { AgentSources } from './AgentSources'
import { AgentMarkdown } from './AgentMarkdown'
import { AgentActivity } from './AgentActivity'
import { Ic } from '../SketchIcon'

const ACTION_LABEL:Record<ActionState,string>={prepared:'待确认',user_confirmed:'已确认',dispatch_started:'已发起',navigation_committed:'页面已打开',player_ready:'播放器已就绪',source_selected:'已选择片源',media_canplay:'可以开始播放',playing:'正在播放',completed:'已完成',failed:'未完成',cancelled:'已取消',unknown:'结果待确认'}

export function MessageCard({message,onPin,disabled,activity,onNavigate}:{message:HistoryMessage;onPin:()=>void;disabled:boolean;activity?:string;onNavigate?:()=>void}):JSX.Element{
  const own=message.role==='user'
  return <article className={`agent-message ${own?'agent-message-own':''}`} data-message-id={message.id}>
    <div className="agent-message-by"><span>{own?'我':'纱雾'}</span><span>{message.pinned?'已固定':message.status==='streaming'?'正在写…':message.status==='cancelled'?'已停止':message.status==='failed'?'保留的片段':''}</span><button type="button" className={`agent-icon ${message.pinned?'is-on':''}`} title={message.pinned?'取消固定原文':'固定原文'} aria-label={message.pinned?'取消固定原文':'固定原文'} onClick={onPin} disabled={disabled||message.status==='streaming'}><Ic name="clip" cls="ic ic-sm" /></button></div>
    {message.body?(own?<p className="agent-message-text">{message.body}</p>:<AgentMarkdown text={message.body}/>):message.status==='streaming'?<AgentActivity label={activity}/>:<p className="agent-message-empty">这一页的查询记录已收好。</p>}
    {!own&&message.body&&message.status==='streaming'&&<AgentActivity label={activity}/>}
    <AgentSources sources={message.sources} onNavigate={onNavigate}/>
    {message.toolSummaries.length>0&&<details className="agent-tool-records"><summary>翻阅记录 · {message.toolSummaries.length}</summary><ul>{message.toolSummaries.map((tool,index)=><li key={index}>{tool.summary}</li>)}</ul></details>}
    {message.usage.some(u=>u.operation==='model')&&<div className="agent-tool-records"><small>{message.usage.filter(u=>u.operation==='model').reduce((n,u)=>n+(u.inputTokens??0)+(u.outputTokens??0),0)} token · {message.usage.filter(u=>u.operation==='model').some(u=>u.estimatedCost===null)?'费用待核算':`估算 US$${message.usage.reduce((n,u)=>n+(u.estimatedCost??0),0).toFixed(4)}`}</small></div>}
    {message.actions.map(action=><div key={action.actionId} className="agent-action-card" data-action-state={action.state}><div><Ic name={action.kind==='track_change'?'tracks':'play'} cls="ic ic-sm" /><b>{action.kind==='track_change'?'追番变更':'播放打开'}</b><span>{ACTION_LABEL[action.state]}</span></div><p>{action.summary}</p>{action.state==='prepared'&&<button type="button" className="btn btn-sm" disabled title="动作确认将在后续功能中开放">确认入口准备中</button>}{action.state==='unknown'&&<small>目前还没有实际完成的回执。</small>}</div>)}
  </article>
}
