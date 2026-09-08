import type { HistoryMessage } from '../../shared/agent-history'
import type { ActionState } from '../../shared/agent-contracts'
import type { ActionPreview } from './model'
import { STATUS_TEXT } from './model'
import { AgentSources } from './AgentSources'
import { AgentMarkdown } from './AgentMarkdown'
import { AgentActivity } from './AgentActivity'
import { Ic } from '../SketchIcon'

const ACTION_LABEL:Record<ActionState,string>={prepared:'待确认',user_confirmed:'已确认',dispatch_started:'已发起',navigation_committed:'页面已打开',player_ready:'播放器已就绪',source_selected:'已选择片源',media_canplay:'可以开始播放',playing:'正在播放',completed:'已完成',failed:'未完成',cancelled:'已取消',unknown:'结果待确认'}

function trackLine(f:{status:string;episode:number;userTags:string[]}):string{
  const parts=[STATUS_TEXT[f.status]??f.status,`进度 ${f.episode}`]
  // 标签在打开「我的追番」时由页面自动回填，这里没值不代表拿不到，就别显示「无标签」误导用户再追问。
  if(f.userTags.length)parts.push(`标签 ${f.userTags.join('、')}`)
  return parts.join(' · ')
}

export function MessageCard({message,disabled,activity,onNavigate,onEdit,editing,actionPreviews,onConfirmAction,onCancelAction,actionBusy}:{message:HistoryMessage;disabled:boolean;activity?:string;onNavigate?:()=>void;onEdit?:()=>void;editing?:boolean;actionPreviews?:Record<string,ActionPreview>;onConfirmAction?:(id:string)=>void;onCancelAction?:(id:string)=>void;actionBusy?:boolean}):JSX.Element{
  const own=message.role==='user'
  return <article className={`agent-message ${own?'agent-message-own':''}${editing?' is-editing':''}`} data-message-id={message.id}>
    <div className="agent-message-by"><span>{own?'我':'纱雾'}</span><span>{editing?'编辑中…':message.status==='streaming'?'正在写…':message.status==='cancelled'?'已停止':message.status==='failed'?'保留的片段':''}</span>{own&&onEdit&&<button type="button" className="agent-icon" title="编辑并重新提问" aria-label="编辑并重新提问" onClick={onEdit} disabled={disabled}><Ic name="pencil" cls="ic ic-sm" /></button>}</div>
    {message.body?(own?<p className="agent-message-text">{message.body}</p>:<AgentMarkdown text={message.body}/>):message.status==='streaming'?<AgentActivity label={activity}/>:<p className="agent-message-empty">这一页的查询记录已收好。</p>}
    {!own&&message.body&&message.status==='streaming'&&<AgentActivity label={activity}/>}
    <AgentSources sources={message.sources} onNavigate={onNavigate}/>
    {message.toolSummaries.length>0&&<details className="agent-tool-records"><summary>翻阅记录 · {message.toolSummaries.length}</summary><ul>{message.toolSummaries.map((tool,index)=><li key={index}>{tool.summary}</li>)}</ul></details>}
    {message.usage.some(u=>u.operation==='model')&&<div className="agent-tool-records"><small>{message.usage.filter(u=>u.operation==='model').reduce((n,u)=>n+(u.inputTokens??0)+(u.outputTokens??0),0)} token · {message.usage.filter(u=>u.operation==='model').some(u=>u.estimatedCost===null)?'费用待核算':`估算 US$${message.usage.reduce((n,u)=>n+(u.estimatedCost??0),0).toFixed(4)}`}</small></div>}
    {message.actions.map(action=>{
      const bundle=actionPreviews?.[action.actionId]
      const canConfirm=action.kind==='track_change'&&action.state==='prepared'&&Boolean(bundle?.confirmationToken)&&Boolean(onConfirmAction)
      return <div key={action.actionId} className="agent-action-card" data-action-state={action.state}>
        <div><Ic name={action.kind==='track_change'?'tracks':'play'} cls="ic ic-sm" /><b>{action.kind==='track_change'?'追番变更':'播放打开'}</b><span>{ACTION_LABEL[action.state]}</span></div>
        <p>{action.summary}</p>
        {bundle&&action.kind==='track_change'&&<dl className="agent-action-diff"><div><dt>改前</dt><dd>{bundle.preview.before?trackLine(bundle.preview.before):'未追此番'}</dd></div><div><dt>改后</dt><dd>{trackLine(bundle.preview.after)}</dd></div></dl>}
        {action.state==='prepared'&&(canConfirm
          ?<div className="agent-action-buttons"><button type="button" className="btn btn-sm" disabled={actionBusy} onClick={()=>onCancelAction?.(action.actionId)}>取消</button><button type="button" className="btn btn-sm btn-primary" disabled={actionBusy} onClick={()=>onConfirmAction?.(action.actionId)}>确认执行</button></div>
          :<small>{bundle?'预览已过期，请让纱雾重新生成。':'正在读取预览…'}</small>)}
        {action.state==='completed'&&<small>已按回读的权威记录更新。</small>}
        {action.state==='cancelled'&&action.errorCode==='ACTION_EXPIRED'&&<small>预览已超时，没有执行。</small>}
        {action.state==='unknown'&&<small>目前还没有实际完成的回执。</small>}
      </div>
    })}
  </article>
}
