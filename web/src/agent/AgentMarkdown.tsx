import { memo,useRef,useState } from 'react'
import type { ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import { LongText } from '../lib/LongText'
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
const components: Components = {
    pre:({children})=><CodeBlock>{children}</CodeBlock>,
    a:({href,children})=>href?<a href={href} target={href.startsWith('http')?'_blank':undefined} rel="noopener noreferrer">{children}</a>:<span>{children}</span>,
    // 模型生成的图片 URL 不自动联网取图，避免正文触发跟踪或绕过资料访问边界。
    img:({alt})=><span className="agent-image-alt">{alt||'图片'}</span>,
    table:({children})=><div className="agent-table-wrap agent-scroll"><table>{children}</table></div>,
}
const completedComponents: Components = { ...components, p: ({children}) => {
  // 含链接、强调、行内代码的段落保留富文本布局，纯文本才有单一字体的测量合同。
  const text = typeof children === 'string' ? children : Array.isArray(children) && children.every(child => typeof child === 'string') ? children.join('') : null
  return text === null ? <p>{children}</p> : <LongText text={text}/>
}}
export const AgentMarkdown=memo(function AgentMarkdown({text,streaming=false}:{text:string;streaming?:boolean}){
  return <div className="agent-markdown"><Markdown remarkPlugins={[remarkGfm]} urlTransform={agentMarkdownUrl} components={streaming?components:completedComponents}>{text}</Markdown></div>
})
