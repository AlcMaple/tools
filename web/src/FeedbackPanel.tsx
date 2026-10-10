import { useEffect, useId, useRef, useState } from 'react'
import { FEEDBACK_CATEGORIES, FEEDBACK_STATUSES, type FeedbackCategory, type FeedbackContext, type FeedbackDetail, type FeedbackSummary } from '../shared/feedback'
import { feedbackApi, feedbackContext } from './feedback'
import { Ic } from './SketchIcon'
import './feedback.css'

type View = 'new' | 'mine' | 'admin'
const date = (at:number):string => new Date(at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
async function screenshot(file: File): Promise<string> {
 if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 10*1024*1024) throw new Error('请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片')
 const bitmap = await createImageBitmap(file)
 try {
  const scale = Math.min(1,1600/Math.max(bitmap.width,bitmap.height)); const canvas=document.createElement('canvas')
  canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale))
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('图片处理失败')
  ctx.drawImage(bitmap,0,0,canvas.width,canvas.height)
  const encoded=canvas.toDataURL('image/webp',0.82)
  if(encoded.length>1.35*1024*1024)throw new Error('图片内容较大，请裁剪后再添加')
  return encoded
 } finally {bitmap.close()}
}
export function FeedbackPanel({context,onClose,dialog=false}:{context?:FeedbackContext;onClose?:()=>void;dialog?:boolean}):JSX.Element {
 const prefix=useId();const busyRef=useRef(false)
 const [view,setView]=useState<View>('new');const [admin,setAdmin]=useState(false);const [ready,setReady]=useState(false);const [mailConfigured,setMailConfigured]=useState(true);const [more,setMore]=useState(false)
 const [category,setCategory]=useState<FeedbackCategory>('problem');const [body,setBody]=useState('');const [email,setEmail]=useState('')
 const [images,setImages]=useState<string[]>([]);const [includeContext,setIncludeContext]=useState(true)
 const [items,setItems]=useState<FeedbackSummary[]>([]);const [detail,setDetail]=useState<FeedbackDetail|null>(null)
 const [reply,setReply]=useState('');const [busy,setBusy]=useState(false);const [imageBusy,setImageBusy]=useState(false)
 const [error,setError]=useState('');const [notice,setNotice]=useState('');const [loading,setLoading]=useState(false)
 busyRef.current=busy
 const requestId=useRef(crypto.randomUUID());const replyId=useRef(crypto.randomUUID());const generation=useRef(0);const live=useRef(true)
 const panel=useRef<HTMLElement>(null)
 const fileInput=useRef<HTMLInputElement>(null);const meta=useRef(context??feedbackContext()).current
 async function connect():Promise<void>{setError('');try{const r=await feedbackApi<{admin:boolean;mailConfigured?:boolean}>('/context');if(live.current){setAdmin(r.admin);setMailConfigured(r.mailConfigured!==false);setReady(true)}}catch(e){if(live.current)setError(e instanceof Error?e.message:'反馈服务连接失败')}}
 useEffect(()=>{live.current=true;void connect();return()=>{live.current=false;generation.current++}},[])
 useEffect(()=>{requestId.current=crypto.randomUUID()},[body,email,category,images,includeContext])
 useEffect(()=>{replyId.current=crypto.randomUUID()},[reply])

 async function list(next:View,append=false):Promise<void>{
  const gen=++generation.current;setView(next);setDetail(null);setError('');setNotice('');setLoading(true)
  try{const data=await feedbackApi<{items:FeedbackSummary[];more:boolean}>(`/?view=${next}&offset=${append?items.length:0}`);if(live.current&&gen===generation.current){setItems(append?[...items,...data.items.filter(i=>!items.some(old=>old.id===i.id))]:data.items);setMore(data.more)}}
  catch(e){if(live.current&&gen===generation.current)setError(e instanceof Error?e.message:'读取失败')}
  finally{if(live.current&&gen===generation.current)setLoading(false)}
 }
 async function read(id:string,clearReply=true):Promise<void>{
  const gen=++generation.current;setError('');setLoading(true)
  try{const data=await feedbackApi<FeedbackDetail>(`/${id}`);if(!live.current||gen!==generation.current)return;setDetail(data);if(clearReply)setReply('');await feedbackApi(`/${id}/seen`,{});window.dispatchEvent(new Event('maple:feedback-read'))}
  catch(e){if(live.current&&gen===generation.current)setError(e instanceof Error?e.message:'读取失败')}
  finally{if(live.current&&gen===generation.current)setLoading(false)}
 }
 async function addImages(files:File[]):Promise<void>{
  if(imageBusy||busy)return
  if(files.length+images.length>3){setError('最多添加 3 张截图');return}
  setImageBusy(true);setError('')
  try{const added:string[]=[];for(const f of files)added.push(await screenshot(f));if(live.current)setImages(current=>[...current,...added].slice(0,3))}
  catch(e){if(live.current)setError(e instanceof Error?e.message:'图片处理失败')}
  finally{if(live.current)setImageBusy(false)}
 }
 async function submit(e:React.FormEvent):Promise<void>{
  e.preventDefault();if(busy||imageBusy||!ready)return;setBusy(true);setError('');setNotice('')
  try{const result=await feedbackApi<{id:string}>('/',{requestId:requestId.current,category,body,email,images,context:includeContext?meta:null});if(!live.current)return;setBody('');setImages([]);setView('mine');await read(result.id);setNotice('已收到，你可以在这里查看回复或继续补充。')}
  catch(e){if(live.current)setError(e instanceof Error?e.message:'提交失败，内容已保留')}
  finally{if(live.current)setBusy(false)}
 }
 async function sendReply(e:React.FormEvent):Promise<void>{
  e.preventDefault();if(!detail||busy)return;setBusy(true);setError('')
  try{await feedbackApi(`/${detail.id}/replies`,{requestId:replyId.current,body:reply,asAdmin:view==='admin'});await read(detail.id)}
  catch(e){if(live.current)setError(e instanceof Error?e.message:'回复失败')}
  finally{if(live.current)setBusy(false)}
 }
 async function changeStatus(status:string):Promise<void>{
  if(!detail||busy)return;setBusy(true);setError('')
  try{await feedbackApi(`/${detail.id}/status`,{status});await read(detail.id,false)}catch(e){if(live.current)setError(e instanceof Error?e.message:'状态更新失败')}finally{if(live.current)setBusy(false)}
 }
 useEffect(()=>{
  if(!dialog)return
  const previous=document.activeElement instanceof HTMLElement?document.activeElement:null
  panel.current?.querySelector<HTMLButtonElement>('button')?.focus()
  const trap=(event:KeyboardEvent):void=>{
   if(event.key==='Escape'){event.stopPropagation();if(!busyRef.current)onClose?.();return}
   if(event.key!=='Tab'||!panel.current)return
   const nodes=Array.from(panel.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([hidden]):not([disabled]),textarea:not([disabled]),a[href],summary')).filter(node=>node.getClientRects().length>0)
   const first=nodes[0],last=nodes.at(-1)
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
  }
  const escape=(event:KeyboardEvent):void=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();if(!busyRef.current)onClose?.()}}
  const keepFocus=(event:FocusEvent):void=>{if(panel.current&&event.target instanceof Node&&!panel.current.contains(event.target))panel.current.querySelector<HTMLButtonElement>('button')?.focus()}
  const node=panel.current;node?.addEventListener('keydown',trap);window.addEventListener('keydown',escape,true);document.addEventListener('focusin',keepFocus)
  return()=>{node?.removeEventListener('keydown',trap);window.removeEventListener('keydown',escape,true);document.removeEventListener('focusin',keepFocus);previous?.focus()}
 },[dialog])
 const content=<section ref={panel} className={`feedback-panel${dialog?' dlg':''}`} role={dialog?'dialog':undefined} aria-modal={dialog||undefined} aria-labelledby={`${prefix}-title`}>
  <div className="feedback-head"><h2 id={`${prefix}-title`} className="dlg-title">反馈与建议</h2>{onClose&&<button type="button" className="icon-btn" aria-label="关闭反馈" disabled={busy} onClick={onClose}><Ic name="x"/></button>}</div>
  <div className="feedback-tabs">{(['new','mine',...(admin?['admin']:[])] as View[]).map(tab=><button key={tab} type="button" className={`btn btn-sm${view===tab?' btn-primary':''}`} disabled={busy} onClick={()=>{if(tab==='new'){generation.current++;setView(tab);setDetail(null);setLoading(false);setError('');setNotice('')}else void list(tab)}}>{tab==='new'?'写反馈':tab==='mine'?'我的反馈':'反馈管理'}</button>)}</div>
  {view==='admin'&&!mailConfigured&&<p className="small" role="status">邮件通知尚未配置；反馈仍会正常保存。</p>}
  {view==='new'?<form onSubmit={e=>void submit(e)} onPaste={e=>{
   const files=Array.from(e.clipboardData.files).filter(file=>file.type.startsWith('image/'))
   // 混合粘贴的文字由输入框原生插入，图片单独加入截图区。
   if(files.length){void addImages(files);return}
   const html=e.clipboardData.getData('text/html')
   if(html&&new DOMParser().parseFromString(html,'text/html').querySelector('img')){
    setError('复制的内容含图片，但剪贴板没有提供图片文件。请逐张复制图片粘贴，或点击“添加截图”选择图片。')
   }
  }}>
   <div className="feedback-types" role="group" aria-label="反馈类型">{Object.entries(FEEDBACK_CATEGORIES).map(([value,label])=><button key={value} type="button" className={`btn btn-sm${category===value?' btn-primary':''}`} aria-pressed={category===value} disabled={busy} onClick={()=>setCategory(value as FeedbackCategory)}>{label}</button>)}</div>
   <label className="feedback-label" htmlFor={`${prefix}-body`}>想告诉我们什么？</label><textarea id={`${prefix}-body`} value={body} disabled={busy} onChange={e=>setBody(e.target.value)} placeholder="描述问题或建议……" maxLength={3000} required rows={5}/>
   <input hidden type="file" accept="image/png,image/jpeg,image/webp" multiple ref={fileInput} onChange={e=>{void addImages(Array.from(e.target.files??[]));e.target.value=''}}/>
   <button className="btn btn-sm" type="button" disabled={imageBusy||images.length>=3||busy} onClick={()=>fileInput.current?.click()}>{imageBusy?'正在处理图片…':'＋ 添加截图（可粘贴）'}</button>
   {!!images.length&&<div className="feedback-images">{images.map((image,index)=><div key={index}><img src={image} alt={`待提交截图 ${index+1}`}/><button type="button" aria-label={`移除截图 ${index+1}`} disabled={busy} onClick={()=>setImages(images.filter((_,i)=>i!==index))}>×</button></div>)}</div>}
   <label className="feedback-label" htmlFor={`${prefix}-email`}>邮箱 <span className="faint">（选填，用于接收回复）</span></label><input id={`${prefix}-email`} type="email" value={email} disabled={busy} onChange={e=>setEmail(e.target.value)} maxLength={254} autoComplete="email"/>
   <details className="feedback-context"><summary>附带的信息</summary><label><input type="checkbox" checked={includeContext} disabled={busy} onChange={e=>setIncludeContext(e.target.checked)}/> 附带页面和设备信息</label><pre>{JSON.stringify(meta,null,2)}</pre></details>
   <button type="submit" className="btn btn-primary" disabled={busy||imageBusy||!ready||!body.trim()}>{busy?'正在发送…':'发送反馈'}</button>
  </form>:loading?<p role="status">正在读取…</p>:detail?<>
   <button type="button" className="btn btn-sm" onClick={()=>void list(view)}>返回列表</button>
   <div className="feedback-detail-head"><span>{FEEDBACK_CATEGORIES[detail.category]}</span><span className="feedback-status">{FEEDBACK_STATUSES[detail.status]}</span><time>{date(detail.createdAt)}</time></div>
   {view==='admin'&&admin&&<div className="feedback-types" aria-label="处理状态">{Object.entries(FEEDBACK_STATUSES).map(([value,label])=><button key={value} type="button" className={`btn btn-sm${detail.status===value?' btn-primary':''}`} disabled={busy} onClick={()=>void changeStatus(value)}>{label}</button>)}</div>}
   {detail.messages.map(m=><article key={m.id} className={`feedback-message ${m.author==='admin'?'from-admin':''}`}><div><b>{m.author==='admin'?'开发者':'用户'}</b><time>{date(m.createdAt)}</time></div><p>{m.body}</p>{!!m.images.length&&<div className="feedback-attachments">{m.images.map(src=><a key={src} href={src} target="_blank" rel="noreferrer"><img src={src} alt="反馈截图"/></a>)}</div>}</article>)}
   {view==='admin'&&<><p className="small">联系邮箱：{detail.email||'未填写'}</p>{detail.context&&<details className="feedback-context"><summary>附带的信息</summary><pre>{JSON.stringify(detail.context,null,2)}</pre></details>}{detail.notifications?.filter(n=>n.state!=='sent').map(n=><div className="feedback-notification" key={n.id}>邮件通知：{n.state==='failed'?'发送失败':n.state==='sending'?'发送结果待核对':'待发送'}{n.state!=='sending'&&<button type="button" className="btn btn-sm" disabled={busy} onClick={()=>{setBusy(true);void feedbackApi(`/${detail.id}/notifications/${n.id}/retry`,{}).then(()=>read(detail.id,false)).catch(e=>setError(String(e.message))).finally(()=>setBusy(false))}}>重新发送</button>}</div>)}</>}
   <form onSubmit={e=>void sendReply(e)}><label className="feedback-label" htmlFor={`${prefix}-reply`}>{view==='admin'?'回复用户':'补充说明'}</label><textarea id={`${prefix}-reply`} value={reply} disabled={busy} onChange={e=>setReply(e.target.value)} maxLength={3000} required rows={3}/><button type="submit" className="btn btn-primary" disabled={busy||!reply.trim()}>{busy?'正在发送…':'发送'}</button></form>
  </>:<div className="feedback-list">{items.length?items.map(item=><button type="button" key={item.id} className="feedback-list-item" onClick={()=>void read(item.id)}><span><b>{FEEDBACK_CATEGORIES[item.category]}</b><span>{FEEDBACK_STATUSES[item.status]}</span>{item.unread&&<em>有新消息</em>}</span><p>{item.preview}</p><time>{date(item.updatedAt)}</time></button>):<p className="faint">还没有反馈记录</p>}{more&&<button className="btn btn-sm" type="button" disabled={loading} onClick={()=>void list(view,true)}>查看更多</button>}</div>}
  {!ready&&error&&<button type="button" className="btn btn-sm" onClick={()=>void connect()}>重新连接</button>}
  <div className="feedback-result" role="status" aria-live="polite">{error?<span className="text-error">{error}</span>:notice}</div>
 </section>
 return dialog?<div className="dlg-backdrop open feedback-backdrop">{content}</div>:content
}
