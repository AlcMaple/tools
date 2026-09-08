import { memo,useRef,useState } from 'react'
import type { ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function agentMarkdownUrl(value:string):string{
  if(/[\u0000-\u0020\u007f\\]/.test(value)||value.startsWith('//'))return ''
  if(value.startsWith('#')||value.startsWith('/')&&!value.startsWith('//'))return value
  try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:''}catch{return ''}
}
function CodeBlock({children}:{children:ReactNode}){
  const ref=useRef<HTMLPreElement>(null),[copied,setCopied]=useState(false),[failed,setFailed]=useState(false)
  const copy=async()=>{try{await navigator.clipboard.writeText(ref.current?.textContent??'');setCopied(true);setFailed(false)}catch{setFailed(true)}}
  return <div className="agent-code-block"><div className="agent-code-bar"><span>代码</span><button type="button" onClick={()=>void copy()}>{failed?'复制失败':copied?'已复制':'复制代码'}</button></div><pre className="agent-scroll" ref={ref}>{children}</pre></div>
}
export const AgentMarkdown=memo(function AgentMarkdown({text}:{text:string}){
  return <div className="agent-markdown"><Markdown remarkPlugins={[remarkGfm]} urlTransform={agentMarkdownUrl} components={{
    pre:({children})=><CodeBlock>{children}</CodeBlock>,
    a:({href,children})=>href?<a href={href} target={href.startsWith('http')?'_blank':undefined} rel="noopener noreferrer">{children}</a>:<span>{children}</span>,
    // 模型生成的图片 URL 不自动联网取图，避免正文触发跟踪或绕过资料访问边界。
    img:({alt})=><span className="agent-image-alt">{alt||'图片'}</span>,
    table:({children})=><div className="agent-table-wrap agent-scroll"><table>{children}</table></div>,
  }}>{text}</Markdown></div>
})
