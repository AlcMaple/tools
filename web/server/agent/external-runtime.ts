import { waitBounded } from './run-service'
import { readCompletionStream } from './provider-stream'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { lookup as lookupAddress } from 'node:dns'
import { createHmac } from 'node:crypto'
import { Agent, fetch as apiFetch } from 'undici'
import { db } from '../db'
import { normalizeAiConfig } from '../auth'
import { AI_API_KEY,AI_BASE_URL,AI_MODEL,AUTH_SECRET } from '../secrets'
import { AgentRunError } from '../../shared/agent-run'
import { createProtocolProvider,providerFingerprint,type ProviderProfile,type ProviderTransport } from './context-provider'
import { DEFAULT_AGENT_MODEL,selectServerModel,estimateCost,type ModelUpgradeApproval,type PriceCard } from './policy'
import { CONSERVATIVE_LIMITS,ExternalQuota,type ExternalLimits } from './external-quota'
import { createAnswerProvider,meteredTransport } from './external-provider'

// 官方 2026-09-08 价格，USD / 百万 token；使用峰时上界，不预测缓存命中或优惠。
const baselinePrice:PriceCard={currency:'USD',version:'deepseek-2026-09-08-peak',inputPerMillion:0.44,cachedInputPerMillion:0.014,outputPerMillion:1.32}
export interface EndpointProfile {endpoint:string;model:string;contextTokens:number;maxOutputTokens:number;price:PriceCard}
const baseline:EndpointProfile={endpoint:'https://api.deepseek.com',model:DEFAULT_AGENT_MODEL,contextTokens:1_000_000,maxOutputTokens:8192,price:baselinePrice}
function parseConfig<T>(key:string,fallback:T):T{try{return process.env[key]?JSON.parse(process.env[key]!):fallback}catch{throw new AgentRunError('PROVIDER_CONFIGURATION',503)}}
export const externalQuota=new ExternalQuota(db,{...CONSERVATIVE_LIMITS,...parseConfig<Partial<ExternalLimits>>('AGENT_LIMITS_JSON',{})})
export function agentEnabled(hasKey:boolean,override:string|undefined){
  const flag=override?.trim();return !flag?hasKey:flag==='1'
}
export const externalEnabled=(source:'server'|'byok'='server')=>agentEnabled(source==='byok'||Boolean(AI_API_KEY),process.env.AGENT_AI_ENABLED)
export function allowedProviderAddress(host:string,address:string,development=process.env.NODE_ENV!=='production'&&!process.env.VERCEL){
  return publicAddress(address)||(development&&host==='api.deepseek.com'&&/^198\.(18|19)\./.test(address)&&isIP(address)===4)
}
export const guestOwner=(ip:string)=>'guest:'+createHmac('sha256',AUTH_SECRET).update(ip).digest('hex')
export function endpointUrl(input:string){
  let url:URL;try{url=new URL(input)}catch{throw new AgentRunError('ENDPOINT_NOT_ALLOWED',400)}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port&&url.port!=='443'||isIP(url.hostname)||url.hostname.includes(':')||url.hostname.endsWith('.')||!url.hostname.includes('.')||/\.(local|localhost|internal|test|invalid)$/i.test(url.hostname))throw new AgentRunError('ENDPOINT_NOT_ALLOWED',400)
  return url.toString().replace(/\/+$/,'')
}
export function publicAddress(address:string):boolean{
  if(isIP(address)===4){const [a,b]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51)||a===203&&b===0)}
  // 保守只接受全球单播 IPv6；映射 IPv4、ULA、link-local、组播均不在其中。
  return isIP(address)===6&&/^[23][0-9a-f]{3}:/i.test(address)&&!/^(?:2001:(?:db8|0{0,4}|10|20|2):|2002:)/i.test(address)
}
export function approvedProfiles():EndpointProfile[]{
  const profiles=[baseline,...parseConfig<EndpointProfile[]>('AGENT_BYOK_PROFILES',[])]
  for(const p of profiles){endpointUrl(p.endpoint);if(!p.model||p.model.length>100||!Number.isSafeInteger(p.contextTokens)||p.contextTokens<4096||p.contextTokens>1_000_000||!Number.isSafeInteger(p.maxOutputTokens)||p.maxOutputTokens<256||p.maxOutputTokens>8192||p.price?.currency!=='USD'||!p.price.version||[p.price.inputPerMillion,p.price.outputPerMillion,p.price.cachedInputPerMillion].some(n=>!Number.isFinite(n)||n<0))throw new AgentRunError('PROVIDER_CONFIGURATION',503)}
  return profiles
}
export function matchEndpoint(endpoint:string,model:string):EndpointProfile{
  const normalized=endpointUrl(endpoint),profile=approvedProfiles().find(p=>endpointUrl(p.endpoint)===normalized&&p.model===model)
  if(!profile)throw new AgentRunError('ENDPOINT_NOT_ALLOWED',400)
  return profile
}
export function protectedTransport(endpoint:string,key:string):ProviderTransport{
  const base=endpointUrl(endpoint),host=new URL(base).hostname
  return async(path,body,signal,_headers,onText)=>{
    if(path!=='chat/completions')throw new AgentRunError('ENDPOINT_NOT_ALLOWED',400)
    const addresses=await waitBounded(lookup(host,{all:true,verbatim:true}),signal);signal.throwIfAborted()
    if(!addresses.length||addresses.some(a=>!allowedProviderAddress(host,a.address)))throw new AgentRunError('ENDPOINT_NOT_ALLOWED',400)
    const address=addresses[0]
    // DNS 校验后固定本次连接的地址，TLS 仍核验原主机；重定向和代理环境均不参与 BYOK 寻址。
    const dispatcher=new Agent({connect:{lookup:(_hostname,options,callback)=>lookupAddress(address.address,options,callback)}})
    try{
      const response=await apiFetch(base+'/'+path,{method:'POST',redirect:'error',dispatcher,signal,headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify(onText?{...body,stream:true,stream_options:{include_usage:true}}:body)})
      if(!response.ok){await response.body?.cancel();throw new AgentRunError('PROVIDER_HTTP_'+response.status,503)}
      const reader=response.body?.getReader();if(!reader)throw new AgentRunError('INVALID_OUTPUT')
      if(onText){if(!/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type')??'')){await reader.cancel();throw new AgentRunError('INVALID_OUTPUT')}return await readCompletionStream(reader as unknown as ReadableStreamDefaultReader<Uint8Array>,onText)}
      let size=0;const chunks:Uint8Array[]=[]
      try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>768*1024){await reader.cancel();throw new AgentRunError('INVALID_OUTPUT')}chunks.push(part.value)}}finally{reader.releaseLock()}
      try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown}catch{throw new AgentRunError('INVALID_OUTPUT')}
    }catch(error){if(error instanceof AgentRunError)throw error;if(signal.aborted)throw signal.reason;throw new AgentRunError('PROVIDER_UNAVAILABLE',503)}finally{await dispatcher.close()}
  }
}
interface Connection {profile:ProviderProfile;transport:ProviderTransport;price:PriceCard;until:number;tv:number;config:string}
const connections=new Map<string,Connection>(),connecting=new Map<string,AbortController>()
const account=(uid:number)=>{const row=db.prepare('SELECT token_version,ai_config FROM users WHERE id=?').get(uid) as {token_version:number;ai_config:string}|undefined;if(!row)throw new AgentRunError('AUTH_REQUIRED',401);return row}
function selection(uid:number){const row=account(uid);return {...row,choice:normalizeAiConfig(row.ai_config)}}
function selectedConnection(uid:number|null):Connection|undefined{
  const row=uid===null?null:selection(uid),id=row?.choice.provider==='byok'?`user:${uid}`:'server',entry=connections.get(id)
  if(entry&&(entry.until<=Date.now()||row&&id!=='server'&&(row.token_version!==entry.tv||row.ai_config!==entry.config))){connections.delete(id);return undefined}
  return entry
}
const cleanup=setInterval(()=>{for(const [id,c] of connections)if(c.until<=Date.now())connections.delete(id)},60_000);cleanup.unref()
export function externalCanPrepare(uid:number|null){return externalEnabled()&&Boolean(AI_API_KEY)&&(uid===null||selection(uid).choice.provider==='server')}
export function externalReady(uid:number|null){const entry=selectedConnection(uid);return Boolean(entry&&externalEnabled(entry.profile.source))}
export function externalStatus(uid:number|null){
  const row=uid===null?null:selection(uid),entry=selectedConnection(uid)
  return {enabled:externalEnabled(row?.choice.provider??'server'),disabled:!agentEnabled(true,process.env.AGENT_AI_ENABLED),canPrepare:externalCanPrepare(uid),configured:Boolean(AI_API_KEY),ready:externalReady(uid),source:row?.choice.provider??'server',model:entry?.profile.model??(row?.choice.provider==='byok'?row.choice.model:AI_MODEL),
    ...(uid!==null?{endpoint:row?.choice.endpoint??'',profiles:approvedProfiles().map(({endpoint,model,contextTokens})=>({endpoint,model,contextTokens})),usage:externalQuota.status(`user:${uid}`)}:{})}
}
export function forgetConnection(uid:number){
  const id=`user:${uid}`
  connections.delete(id)
  // 撤销探测本身；保留锁直到旧请求退出，晚到结果还须通过同一操作身份检查。
  connecting.get(id)?.abort(new AgentRunError('PROVIDER_CHANGED'))
}
export async function connectExternal(uid:number|null,owner:string,input:{source:'server'|'byok';endpoint?:string;model?:string;key?:string},signal:AbortSignal,preserveSelection=false){
  signal.throwIfAborted()
  if(!externalEnabled(input.source))throw new AgentRunError('AGENT_AI_DISABLED',503)
  const row=uid===null?null:account(uid)
  if(uid===null&&input.source!=='server')throw new AgentRunError('AUTH_REQUIRED',401)
  const id=input.source==='server'?'server':`user:${uid}`
  const locks=[...new Set([id,...(uid===null?[]:[`user:${uid}`])])]
  // 必须先锁住账号选择和目标连接，再改配置；拒绝的并发请求没有写入副作用。
  if(locks.some(lock=>connecting.has(lock)))throw new AgentRunError('CONNECTION_BUSY',429)
  const operation=new AbortController()
  for(const lock of locks)connecting.set(lock,operation)
  const probeSignal=AbortSignal.any([signal,operation.signal,AbortSignal.timeout(30000)])
  try{
    if(uid!==null&&!preserveSelection){
      connections.delete(`user:${uid}`)
      db.prepare('UPDATE users SET ai_config=? WHERE id=?').run(JSON.stringify({provider:input.source,endpoint:input.endpoint??'',model:input.model??''}),uid)
    }
    let cfg:EndpointProfile,key:string
    if(input.source==='server'){
      const model=selectServerModel(AI_MODEL,parseConfig<ModelUpgradeApproval|null>('AGENT_MODEL_APPROVAL',null))
      cfg=matchEndpoint(AI_BASE_URL,model);key=AI_API_KEY
    }else{cfg=matchEndpoint(input.endpoint??'',input.model??'');key=input.key??''}
    if(!key||key.length>4096||/[\s\x00-\x1f\x7f]/.test(key))throw new AgentRunError('PROVIDER_NOT_CONFIGURED',503)
    // 来源先切换；新连接失败也不暗中使用旧模型。
    if(uid!==null&&!preserveSelection)db.prepare('UPDATE users SET ai_config=? WHERE id=?').run(JSON.stringify({provider:input.source,endpoint:cfg.endpoint,model:cfg.model}),uid)
    const config=uid===null?'':account(uid).ai_config
    if(input.source==='server'&&selectedConnection(null))return externalStatus(uid)
    if(connections.size>=500)throw new AgentRunError('GLOBAL_BUSY',429)
    connections.delete(id)
    return await externalQuota.turn(owner,uid===null,input.source==='server',async()=>{
      probeSignal.throwIfAborted()
      const transport=protectedTransport(cfg.endpoint,key),profile:ProviderProfile={source:input.source,model:cfg.model,fingerprint:providerFingerprint(input.source,cfg.model,cfg.endpoint,key),capabilities:{protocol:'chat_completions',contextTokens:cfg.contextTokens,maxOutputTokens:cfg.maxOutputTokens,toolCalling:false,tokenCounting:'estimate',nativeCompaction:'none',nativeMinimumTokens:0,verified:false}}
      const metered=meteredTransport(transport,externalQuota,cfg.price,cfg.contextTokens)
      const probe=await waitBounded(createProtocolProvider(profile,metered).probe(probeSignal),probeSignal)
      probeSignal.throwIfAborted()
      if(locks.some(lock=>connecting.get(lock)!==operation))throw new AgentRunError('PROVIDER_CHANGED')
      if(!externalEnabled(input.source))throw new AgentRunError('AGENT_AI_DISABLED',503)
      if(row){
        const current=account(uid!)
        if(current.token_version!==row.token_version)throw new AgentRunError('AUTH_REQUIRED',401)
        if(current.ai_config!==config)throw new AgentRunError('PROVIDER_CHANGED')
      }
      profile.capabilities=probe.value
      connections.set(id,{profile,transport,price:cfg.price,until:Date.now()+30*60_000,tv:row?.token_version??0,config})
      return externalStatus(uid)
    },false)
  }finally{
    for(const lock of locks)if(connecting.get(lock)===operation)connecting.delete(lock)
  }
}
let serverPreparation:Promise<void>|null=null
let serverPreparationFailure:{error:unknown;until:number}|null=null
function sharedPreparationError(error:unknown){
  // 仅供应商级失败可共享；额度、身份、并发和取消不是服务器连接故障。
  return error instanceof Error&&'code' in error&&typeof error.code==='string'&&/^(PROVIDER_HTTP_[0-9]{3}|PROVIDER_UNAVAILABLE|PROVIDER_CAPABILITY|INVALID_OUTPUT)$/.test(error.code)
}
export async function prepareExternal(uid:number|null,owner:string,signal:AbortSignal){
  signal.throwIfAborted()
  if(externalReady(uid))return externalStatus(uid)
  const source=uid===null?'server':selection(uid).choice.provider
  if(!externalEnabled(source))throw new AgentRunError('AGENT_AI_DISABLED',503)
  if(source==='byok')throw new AgentRunError('PROVIDER_CONNECTION_REQUIRED',503)
  const joined=serverPreparation!==null
  if(!serverPreparation){
    if(serverPreparationFailure&&serverPreparationFailure.until>Date.now())throw serverPreparationFailure.error
    serverPreparation=connectExternal(uid,owner,{source:'server'},signal,true).then(()=>{serverPreparationFailure=null},error=>{
      serverPreparationFailure=sharedPreparationError(error)?{error,until:Date.now()+30000}:null
      throw error
    })
    const current=serverPreparation
    void current.finally(()=>{if(serverPreparation===current)serverPreparation=null}).catch(()=>{})
  }
  try{await waitBounded(serverPreparation,signal)}catch(error){
    signal.throwIfAborted()
    // 已加入的调用者不继承发起者的额度/身份错误，也不自动补一次付费探测。
    if(joined&&!sharedPreparationError(error))throw new AgentRunError('PROVIDER_CONNECTION_REQUIRED',503)
    throw error
  }
  const status=externalStatus(uid)
  if(!status.ready||status.source!=='server')throw new AgentRunError('PROVIDER_CHANGED')
  return status
}
export function externalBinding(uid:number|null,owner:string){
  if(!externalEnabled(uid===null?'server':selection(uid).choice.provider))throw new AgentRunError('AGENT_AI_DISABLED',503)
  const c=selectedConnection(uid);if(!c)throw new AgentRunError('PROVIDER_CONNECTION_REQUIRED',503)
  const profile=structuredClone(c.profile),project=profile.source==='server'
  const transport:ProviderTransport=async(path,body,signal,headers,onText)=>externalQuota.turn(owner,uid===null,project,async()=>{
    if(selectedConnection(uid)!==c||!externalEnabled(profile.source))throw new AgentRunError('PROVIDER_CHANGED')
    try{return await meteredTransport(c.transport,externalQuota,c.price,c.profile.capabilities.contextTokens)(path,body,signal,headers,onText)}catch(error){
      if(error instanceof AgentRunError&&/^(PROVIDER_HTTP_|PROVIDER_UNAVAILABLE|INVALID_OUTPUT)/.test(error.code)){connections.delete(project?'server':`user:${uid}`)}throw error
    }
  })
  const context=createProtocolProvider(profile,transport)
  const json=context.json.bind(context)
  context.json=async(...args)=>{const result=await json(...args),u=result.usage;return {...result,usage:{...u,estimatedCost:u.inputTokens!==null&&u.outputTokens!==null?estimateCost(u.inputTokens,u.cachedInputTokens??0,u.outputTokens,c.price):null,currency:c.price.currency,priceVersion:c.price.version}}}
  // connect 已完成真实 JSON + 工具探测；prepare 复用结果，不再付费重复探测。
  context.probe=async()=>({value:profile.capabilities,usage:{operation:'compact',provider:profile.source,model:profile.model,inputTokens:0,cachedInputTokens:0,outputTokens:0,durationMs:0,resultCount:0,estimatedCost:0,currency:c.price.currency,priceVersion:c.price.version}})
  const output=Number(process.env.AGENT_ANSWER_OUTPUT_TOKENS??8192)
  if(!Number.isSafeInteger(output)||output<256||output>8192)throw new AgentRunError('PROVIDER_CONFIGURATION',503)
  return {provider:createAnswerProvider(profile,transport,c.price,uid===null?Math.min(2048,output):output,externalQuota.limits.warningCost),context,
    execute:<T>(action:()=>Promise<T>)=>externalQuota.turn(owner,uid===null,project,action)}
}
