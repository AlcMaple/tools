import { useState } from 'react'
import type { HistoryMessage } from '../../shared/agent-history'
import type { ActionState } from '../../shared/agent-contracts'
import type { ActionPreview } from './model'
import { STATUS_TEXT, isPlaybackPreview, isTrackPreview, playbackOpenHref } from './model'
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

const SOURCE_LABEL:Record<string,string>={xifan:'稀饭',girigiri:'Girigiri'}

// 一次确认按顺序做的几件事，逐条列在卡片上 —— 与服务端 impact 同源同序（见 playback-store.prepare）。
// 只有一步时不编号，免得「第一步：打开播放页」读着像还有下文。
function playbackSteps(p:{source:string;episode:number;target:string;addsToTracks:boolean;bindsSource:{name:string}|null}):string[]{
  const label=SOURCE_LABEL[p.source]??p.source
  const steps:string[]=[]
  if(p.addsToTracks)steps.push(`追番记到「在看 · 第 ${p.episode} 集」`)
  if(p.bindsSource)steps.push(`认源到${label}的「${p.bindsSource.name}」`)
  steps.push(p.target==='web_player'?`打开${label}第 ${p.episode} 集播放页`:`去${label}找片源`)
  return steps
}


/**
 * 就地认源面板：搜片源 →（要验证码就看图输数字）→ 在候选里挑一个。
 * 验证码图片来自我们服务端转发的位图，用户输入的数字也原路发回去，两样都不进对话历史、
 * 不进模型上下文 —— 验证码要证明的正是「此刻有个人在」，让模型经手就没意义了。
 */
function SourcePicker({actionId,preview,busy,image,setImage,onCaptcha,onSubmitCaptcha,onPick}:{
  actionId:string;preview:{sourceCandidates:{name:string;note:string}[]|null;bindsSource:{name:string}|null}
  busy?:boolean;image:string|null;setImage:(src:string|null)=>void
  onCaptcha:(id:string)=>Promise<string|null>
  onSubmitCaptcha:(id:string,code:string)=>Promise<boolean>
  onPick:(id:string,index:number)=>Promise<void>
}):JSX.Element{
  const [code,setCode]=useState('')
  const [note,setNote]=useState('')
  const candidates=preview.sourceCandidates
  const refresh=async()=>{setNote('');setImage(await onCaptcha(actionId))}
  const submit=async()=>{
    if(!code.trim())return
    const ok=await onSubmitCaptcha(actionId,code.trim())
    setCode('')
    if(ok){setImage(null);setNote('')}
    else{setNote('这组数字没通过，换一张再试试。');await refresh()}
  }
  return <div className="agent-source-picker">
    {image&&<div className="agent-captcha">
      <img src={image} alt="稀饭站内搜索的验证码" width={120} height={40}/>
      <input value={code} onChange={e=>setCode(e.target.value)} maxLength={32} inputMode="numeric"
        placeholder="图上的数字" aria-label="验证码" disabled={busy}
        onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void submit()}}}/>
      <button type="button" className="btn btn-sm" disabled={busy||!code.trim()} onClick={()=>void submit()}>提交</button>
      <button type="button" className="agent-icon" title="换一张" aria-label="换一张" disabled={busy} onClick={()=>void refresh()}><Ic name="refresh" cls="ic ic-sm"/></button>
    </div>}
    {note&&<small>{note}</small>}
    {candidates!==null&&(candidates.length===0
      ?<small>站内没搜到同名的片源，点「去选片源」到追番页自己找找看。</small>
      /* 挑哪个由用户定：名字对不对只有看过番的人认得出，认错了全站的绑定都跟着错。 */
      :<ul className="agent-source-list">{candidates.map((hit,index)=>
        <li key={index}><button type="button" className="btn btn-sm" disabled={busy} onClick={()=>void onPick(actionId,index)}>
          {hit.name}{hit.note&&<small> · {hit.note}</small>}</button></li>)}
      </ul>)}
  </div>
}

export function MessageCard({message,disabled,activity,onNavigate,onEdit,editing,actionPreviews,onConfirmAction,onCancelAction,onOpenPlayback,onFollowPlayback,onSearchSource,onCaptcha,onSubmitCaptcha,onPickSource,actionBusy}:{message:HistoryMessage;disabled:boolean;activity?:string;onNavigate?:()=>void;onEdit?:()=>void;editing?:boolean;actionPreviews?:Record<string,ActionPreview>;onConfirmAction?:(id:string)=>void;onCancelAction?:(id:string)=>void;onOpenPlayback?:(id:string)=>void;onFollowPlayback?:(id:string)=>void
  onSearchSource?:(id:string)=>Promise<{needsCaptcha:boolean}>;onCaptcha?:(id:string)=>Promise<string|null>
  onSubmitCaptcha?:(id:string,code:string)=>Promise<boolean>;onPickSource?:(id:string,index:number)=>Promise<void>
  actionBusy?:boolean}):JSX.Element{
  const own=message.role==='user'
  // 认源过程中的验证码图。它不属于任何持久状态：刷新就该重新取一张，源站那边旧图也已作废。
  const [captcha,setCaptcha]=useState<{actionId:string;image:string|null}|null>(null)
  // 右下角那颗「去选片源」：先打周表定位，要验证码才把图取回来显示。
  const findSource=async(id:string)=>{
    if(!onSearchSource||!onCaptcha)return
    const {needsCaptcha}=await onSearchSource(id)
    setCaptcha(needsCaptcha?{actionId:id,image:await onCaptcha(id)}:null)
  }
  return <article className={`agent-message ${own?'agent-message-own':''}${editing?' is-editing':''}`} data-message-id={message.id}>
    <div className="agent-message-by"><span>{own?'我':'纱雾'}</span><span>{editing?'编辑中…':message.status==='streaming'?'正在写…':message.status==='cancelled'?'已停止':message.status==='failed'?'保留的片段':''}</span>{own&&onEdit&&<button type="button" className="agent-icon" title="编辑并重新提问" aria-label="编辑并重新提问" onClick={onEdit} disabled={disabled}><Ic name="pencil" cls="ic ic-sm" /></button>}</div>
    {message.body?(own?<p className="agent-message-text">{message.body}</p>:<AgentMarkdown text={message.body}/>):message.status==='streaming'?<AgentActivity label={activity}/>:<p className="agent-message-empty">这一页的查询记录已收好。</p>}
    {!own&&message.body&&message.status==='streaming'&&<AgentActivity label={activity}/>}
    {/* 动作卡紧跟正文，排在来源 / 翻阅记录 / 用量之前：待确认的预览一旦被挤到这些区块下面，
        就会掉出浮层可视区，用户以为回复结束了，其实还有一张卡在等他。 */}
    {message.actions.map(action=>{
      const bundle=actionPreviews?.[action.actionId]
      const track=isTrackPreview(bundle)?bundle:undefined
      const playback=isPlaybackPreview(bundle)?bundle:undefined
      const canConfirm=Boolean(track)&&action.state==='prepared'&&Boolean(track?.confirmationToken)&&Boolean(onConfirmAction)
      return <div key={action.actionId} className="agent-action-card" data-action-state={action.state}>
        <div><Ic name={action.kind==='track_change'?'tracks':'play'} cls="ic ic-sm" /><b>{action.kind==='track_change'?'追番变更':'播放打开'}</b><span>{ACTION_LABEL[action.state]}</span></div>
        <p>{action.summary}</p>
        {track&&<dl className="agent-action-diff"><div><dt>改前</dt><dd>{track.preview.before?trackLine(track.preview.before):'未追此番'}</dd></div><div><dt>改后</dt><dd>{trackLine(track.preview.after)}</dd></div></dl>}
        {playback&&<dl className="agent-action-diff">{playbackSteps(playback.preview).map((step,index,all)=>
          <div key={index}><dt>{all.length>1?`第 ${'一二三'[index]}步`:'片源'}</dt><dd>{step}</dd></div>)}
        </dl>}
        {playback?.openable&&playback.preview.target==='source_search'&&onCaptcha&&onSubmitCaptcha&&onPickSource
          &&(playback.preview.sourceCandidates!==null||captcha?.actionId===action.actionId)&&
          <SourcePicker actionId={action.actionId} preview={playback.preview} busy={actionBusy}
            image={captcha?.actionId===action.actionId?captcha.image:null}
            setImage={src=>setCaptcha(src?{actionId:action.actionId,image:src}:null)}
            onCaptcha={onCaptcha} onSubmitCaptcha={onSubmitCaptcha} onPick={onPickSource}/>}
        {action.state==='prepared'&&(canConfirm
          ?<div className="agent-action-buttons"><button type="button" className="btn btn-sm" disabled={actionBusy} onClick={()=>onCancelAction?.(action.actionId)}>取消</button><button type="button" className="btn btn-sm btn-primary" disabled={actionBusy} onClick={()=>onConfirmAction?.(action.actionId)}>确认执行</button></div>
          :playback?.openable
            /* 已认过片源：原生 <a> 在用户手势内开新标签，服务端先推进回执再 302 到播放页；
               换成 fetch 再 window.open 会被浏览器当成非用户手势拦掉。 */
            /* 只有「纯打开、已认片源」这一种才用原生 <a>：它不写任何数据，GET 最稳。
               组合动作要先写追番，必须走 POST（同源守卫只覆盖写方法），标签页由 controller
               在点击手势里先开好再导航；没认片源的那种没有新标签，也走 POST。 */
            ?<div className="agent-action-buttons"><button type="button" className="btn btn-sm" disabled={actionBusy} onClick={()=>onCancelAction?.(action.actionId)}>取消</button>{playback.preview.target==='web_player'&&!playback.preview.addsToTracks&&!playback.preview.bindsSource
              ?<a className="btn btn-sm btn-primary" href={playbackOpenHref(action.actionId)} target="_blank" rel="noopener" onClick={()=>onFollowPlayback?.(action.actionId)}>打开播放页</a>
              /* 还没认片源：这一颗就地认源（周表 → 必要时验证码 → 候选），认下来之后
                 target 变成 web_player，同一颗按钮自然变成「确认并打开」。
                 站内也搜不到时才退回追番页那套既有的选源弹窗。 */
              :playback.preview.target==='source_search'&&onSearchSource
                ?<button type="button" className="btn btn-sm btn-primary" disabled={actionBusy}
                  onClick={()=>void (playback.preview.sourceCandidates?.length===0?onOpenPlayback?.(action.actionId):findSource(action.actionId))}>去选片源</button>
                :<button type="button" className="btn btn-sm btn-primary" disabled={actionBusy} onClick={()=>onOpenPlayback?.(action.actionId)}>确认并打开</button>}</div>
            :<small>{bundle?'预览已过期，请让纱雾重新生成。':'正在读取预览…'}</small>)}
        {action.state==='completed'&&<small>{action.kind==='playback_open'?'播放页已经放起来了。':'已按回读的权威记录更新。'}</small>}
        {action.kind==='playback_open'&&['dispatch_started','navigation_committed','player_ready','source_selected','media_canplay','playing'].includes(action.state)&&<small>回执跟着播放页的真实事件走，这里不替它宣布结果。</small>}
        {action.state==='cancelled'&&action.errorCode==='ACTION_EXPIRED'&&<small>预览已超时，没有执行。</small>}
        {action.state==='failed'&&action.kind==='playback_open'&&<small>播放页报了错，换条线路或换个源再试试。</small>}
        {action.state==='unknown'&&<small>{action.kind==='playback_open'?'已经退到源站自己的播放器，那边的播放状态我们读不到。':'目前还没有实际完成的回执。'}</small>}
      </div>
    })}
    <AgentSources sources={message.sources} onNavigate={onNavigate}/>
    {message.toolSummaries.length>0&&<details className="agent-tool-records"><summary>翻阅记录 · {message.toolSummaries.length}</summary><ul>{message.toolSummaries.map((tool,index)=><li key={index}>{tool.summary}</li>)}</ul></details>}
    {message.usage.some(u=>u.operation==='model')&&<div className="agent-tool-records"><small>{message.usage.filter(u=>u.operation==='model').reduce((n,u)=>n+(u.inputTokens??0)+(u.outputTokens??0),0)} token · {message.usage.filter(u=>u.operation==='model').some(u=>u.estimatedCost===null)?'费用待核算':`估算 US$${message.usage.reduce((n,u)=>n+(u.estimatedCost??0),0).toFixed(4)}`}</small></div>}
  </article>
}
