import { useEffect,useRef,useState } from 'react'
import type { HistorySource } from '../../shared/agent-history'
import type { AgentUsage } from '../../shared/agent-contracts'
import { AgentConnection } from './connection'
import { AgentSources } from './AgentSources'
import { AgentMarkdown } from './AgentMarkdown'
import { AgentActivity,agentActivity } from './AgentActivity'
import { shouldSend } from './model'

type Message={status?:'streaming'|'completed'|'failed';role:'user'|'assistant';body:string;sources?:HistorySource[];usage?:AgentUsage[]}
export function GuestAgent({open,close,login,header}:{open:boolean;close:()=>void;login:()=>void;header:JSX.Element}){
  const [messages,setMessages]=useState<Message[]>([]),[draft,setDraft]=useState(''),[available,setAvailable]=useState(false),[enabled,setEnabled]=useState(false),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[notice,setNotice]=useState(''),[error,setError]=useState('')
  const connection=useRef<AgentConnection|null>(null),bottom=useRef(true),warmup=useRef<AbortController|null>(null)
  const active=useRef<AbortController|null>(null),alive=useRef(true),input=useRef<HTMLTextAreaElement>(null),scroll=useRef<HTMLDivElement>(null),composing=useRef(false)
  useEffect(()=>{alive.current=true;const controller=new AbortController();warmup.current=controller
    connection.current=new AgentConnection(async()=>{
      const attempt=new AbortController();warmup.current=attempt
      const response=await fetch('/api/agent/guest/connect',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}',signal:attempt.signal})
      const data=await response.json();if(attempt.signal.aborted||!alive.current)throw new DOMException('Stopped','AbortError')
      if(!response.ok||!data.ready)throw new Error(data.error??'AI 暂时没有准备好，请稍后重试。')
    })
    void fetch('/api/agent/guest/status',{signal:controller.signal,credentials:'same-origin'}).then(async response=>{const data=await response.json();if(!controller.signal.aborted&&alive.current){if(!response.ok)throw new Error(data.error??'连接检查失败');setAvailable((data.provider.ready||data.provider.canPrepare)&&data.knowledge.status==='ready');setEnabled(data.provider.enabled);if(data.provider.canPrepare||data.provider.ready)void connection.current?.ensure().catch(()=>{})}}).catch(e=>{if(!controller.signal.aborted&&alive.current)setError(e instanceof Error?e.message:'连接检查失败')})
    const hide=()=>{active.current?.abort();warmup.current?.abort();controller.abort()};window.addEventListener('pagehide',hide)
    return()=>{alive.current=false;active.current?.abort();warmup.current?.abort();controller.abort();window.removeEventListener('pagehide',hide)}
  },[])
  useEffect(()=>{if(open)input.current?.focus({preventScroll:true})},[open])
  useEffect(()=>{if(bottom.current)scroll.current?.scrollTo({top:scroll.current.scrollHeight})},[messages,status,open])
  const send=async()=>{
    if(busy||!available||!draft.trim())return
    const history=messages.map(({role,body})=>({role,body}))
    if(history.length>12||history.reduce((n,m)=>n+m.body.length,0)>12000){setError('本次临时对话已达到长度上限，请刷新后重新开始。');return}
    const controller=new AbortController();active.current=controller;const body=draft.trim(),retryConnection=Boolean(error);bottom.current=true;setMessages(previous=>[...previous,{role:'user',body},{role:'assistant',body:'',status:'streaming'}]);setDraft('');setBusy(true);setError('');setNotice('');setStatus(agentActivity('thinking'))
    const timer=setTimeout(()=>controller.abort(),125000)
    try{
      await (retryConnection?connection.current?.retry():connection.current?.ensure())
      if(controller.signal.aborted||!alive.current)return
      const response=await fetch('/api/agent/guest/turns',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),body,history}),signal:controller.signal})
      if(controller.signal.aborted||!alive.current)return
      if(!response.ok){const data=await response.json();if(data.code==='AGENT_AI_DISABLED')setAvailable(false);throw new Error(data.error??'请求没有完成')}
      if(response.headers.get('X-Agent-Owner')!=='guest'||!response.body)throw new Error('身份已变化，请重新打开助手。')
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',completed=false
      try{for(;;){const chunk=await reader.read();if(controller.signal.aborted||!alive.current)return;if(chunk.done)break;buffer=(buffer+decoder.decode(chunk.value,{stream:true})).replace(/\r\n/g,'\n');if(buffer.length>256*1024)throw new Error('回复超过大小限制')
        for(let i=buffer.indexOf('\n\n');i>=0;i=buffer.indexOf('\n\n')){const block=buffer.slice(0,i);buffer=buffer.slice(i+2);const event=block.split('\n').find(l=>l.startsWith('event:'))?.slice(6).trim(),raw=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!raw)continue;const data=JSON.parse(raw)
          if(event==='delta'){setMessages(previous=>[...previous.slice(0,-1),{...previous[previous.length-1],body:previous[previous.length-1].body+data.text}]);setStatus(agentActivity('writing'))}
          else if(event==='answer'){const answer:Message={role:'assistant',body:data.body,sources:data.sources,usage:data.usage,status:'completed'};setMessages(previous=>[...previous.slice(0,-1),answer])}
          else if(event==='price_warning')setNotice(`本次调用最高估算 US$${Number(data.estimatedCost).toFixed(4)}`)
          else if(event==='tool_started')setStatus(agentActivity('tool',data.name))
          else if(event==='tool_finished')setStatus(agentActivity('thinking'))
          else if(event==='model_started')setStatus(agentActivity('thinking'))
          else if(event==='failed'){if(data.code==='AGENT_AI_DISABLED')setAvailable(false);throw new Error(data.error)}
          else if(event==='completed'){completed=true;setStatus('')}
        }
      }}finally{void reader.cancel().catch(()=>{})}
      if(!completed)throw new Error('连接已中断，请手动重新提问。')
    }catch(e){if(alive.current){setError(controller.signal.aborted?'本轮已停止。':e instanceof Error?e.message:'连接已中断。');setDraft(current=>current||body);setMessages(previous=>[...previous.slice(0,-1),{...previous[previous.length-1],status:'failed'}])}}finally{clearTimeout(timer);if(alive.current){if(controller.signal.aborted){setError('本轮已停止。');setDraft(current=>current||body)}setMessages(previous=>previous.at(-1)?.status==='streaming'?[...previous.slice(0,-1),{...previous[previous.length-1],status:'failed'}]:previous);setBusy(false);setStatus('')}}
  }
  return open?<section id="agent-window" className="agent-window" role="dialog" aria-modal="false" aria-labelledby="agent-title" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();close()}}}>
    {header}<div className="agent-nav"><span>临时对话</span><button type="button" onClick={login}>登录</button></div>
    <div className={`agent-feedback ${error?'is-error':''}`} hidden={!error&&!notice} role="status"><span>{error||notice}</span></div>
    <div className="agent-chat-wrap"><div className="agent-chat agent-scroll" ref={scroll} role="log" aria-label="对话记录" onScroll={()=>{const node=scroll.current;if(node)bottom.current=node.scrollHeight-node.scrollTop-node.clientHeight<48}}><div className="agent-suggestions">{!messages.length&&['这个网站怎么用？','本周有哪些番更新？','追番大厅有哪些公开信息？'].map(question=><button type="button" key={question} onClick={()=>setDraft(question)}>{question}</button>)}</div>
      {messages.map((message,index)=><article key={index} className={`agent-message ${message.role==='user'?'agent-message-own':''}`}><div className="agent-message-by">{message.role==='user'?'我':'纱雾'}</div>{message.role==='user'?<p className="agent-message-text">{message.body}</p>:<>{message.body&&<AgentMarkdown text={message.body}/>} {message.status==='streaming'&&<AgentActivity label={status||agentActivity('thinking')}/>} {message.status==='failed'&&!message.body&&<p className="agent-message-empty">这次回复停住了，问题还在输入框里。</p>}</>}<AgentSources sources={message.sources??[]} onNavigate={close}/></article>)}
    </div></div>
    {!available&&<div className="agent-update"><span>{enabled?'模型尚未配置或功能说明待同步':'服务器 AI 暂不可用'}</span></div>}
    <form className="agent-composer" onSubmit={event=>{event.preventDefault();void send()}}><textarea ref={input} className="agent-scroll" rows={2} value={draft} maxLength={2000} aria-label="给纱雾的消息" placeholder="输入消息…" onChange={e=>setDraft(e.target.value)} onCompositionStart={()=>{composing.current=true}} onCompositionEnd={()=>{composing.current=false}} onKeyDown={e=>{if(shouldSend(e.key,e.shiftKey,e.nativeEvent.isComposing||composing.current,e.keyCode)){e.preventDefault();void send()}}}/><div className="agent-composer-foot agent-guest-composer-foot">{busy?<button type="button" className="agent-text-button" onClick={()=>{active.current?.abort();warmup.current?.abort()}}>停止</button>:<button type="submit" className="agent-send" aria-label="发送消息" disabled={!available||!draft.trim()}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 18V6M6 12l6-6 6 6"/></svg></button>}</div></form>
  </section>:null
}
