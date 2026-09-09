import { partialAnswer } from './provider-stream'
import { AgentRunError, RUN_LIMITS } from '../../shared/agent-run'
import type { AgentUsage } from '../../shared/agent-contracts'
import { estimateContextTokens, type ProviderProfile, type ProviderTransport } from './context-provider'
import { estimateCost,type PriceCard } from './policy'
import type { RunProvider } from './run-service'
import { matchesContract } from './validation'
import type { ExternalQuota } from './external-quota'

export const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}
export function reportedUsage(raw:unknown){
  const u=record(record(raw).usage),input=u.prompt_tokens,output=u.completion_tokens,cached=u.prompt_cache_hit_tokens??record(u.prompt_tokens_details).cached_tokens??0
  if(![input,output,cached].every(n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0)||(cached as number)>(input as number))return null
  return {input:input as number,output:output as number,cached:cached as number}
}
// 费用预授权保留多少输出。**不是** max_tokens：实测回答只有 60～500 token，按满额 8192 冻结
// 相当于每次多占十几倍，单轮上限里塞不下两次调用，正常的多轮工具回合必然 COST_LIMIT
// （加油站按整箱油预授权的那种毛病）。真实花费由 settle() 按 provider 实报补差，一分不少收；
// 单次最多低估 (max_tokens - RESERVED_OUTPUT_TOKENS) 的输出费用，下一次调用前就会被上限拦住。
export const RESERVED_OUTPUT_TOKENS=1024
export function meteredTransport(transport:ProviderTransport,quota:ExternalQuota,price:PriceCard,contextTokens:number):ProviderTransport{
  return async(path,body,signal,headers,onText)=>{
    signal.throwIfAborted()
    const input=estimateContextTokens(body),output=Number(body.max_tokens)
    // 窗口检查仍按满额 output：模型真有可能写满，超窗是硬错误，不能按预期值放行。
    if(!Number.isSafeInteger(output)||output<1||input+output>contextTokens)throw new AgentRunError('CONTEXT_BUDGET')
    const settle=quota.reserve(input,Math.min(output,RESERVED_OUTPUT_TOKENS),price,{operation:onText?'model':body.tools||String(record(Array.isArray(body.messages)?body.messages[0]:null).content??'').startsWith('只返回 JSON 对象 {"nonce"')?'probe':'compact',model:String(body.model??'unknown').slice(0,100)})
    try{const result=await transport(path,body,signal,headers,onText);settle(reportedUsage(result));return result}catch(error){settle(null);throw error}
  }
}
// 统计值已经在 toolResults.data 中；来源展示口径留给界面，不重复占用模型上下文。
export function serializeModelMaterial(value:unknown):string{
  return JSON.stringify(value,function(key,entry){return key==='aggregate'&&this.kind==='public_aggregate'&&typeof this.sourceId==='string'?undefined:entry})
}
export function createAnswerProvider(profile:ProviderProfile,transport:ProviderTransport,price:PriceCard,maxOutput=8192,warningCost=Infinity):RunProvider{
  return {source:profile.source,model:profile.model,fingerprint:profile.fingerprint,async *stream(request,signal){
    if(request.nativeState!==null&&request.nativeState!==undefined)throw new AgentRunError('INVALID_NATIVE_STATE')
    const started=Date.now()
    const allowed=Object.keys(request.tools)
    const schema={anyOf:[request.outputSchema.anyOf![0],{type:'object',properties:{kind:{enum:['tool_calls']},calls:{type:'array',minItems:1,maxItems:4,items:{anyOf:request.outputSchema.anyOf![1].properties!.calls.items!.anyOf!.filter(s=>allowed.includes(String(s.properties!.name.enum![0])))}}},required:['kind','calls'],additionalProperties:false}]}
    const availableTools=Object.fromEntries(Object.entries(request.tools).map(([name,tool])=>[name,{description:tool.description,parameters:tool.parameters}]))
    const body={model:profile.model,messages:[{role:'system',content:request.system+'\n只返回一个符合以下合同的 JSON 对象：'+JSON.stringify(schema)+'\n回答字段按 kind、text、sourceIds 顺序输出；工具请求只输出 kind、calls。\n服务器本轮能力（未列出功能保持未知）：'+JSON.stringify(request.knowledge)},
      {role:'user',content:serializeModelMaterial({layers:request.layers,availableTools,toolResults:request.results})}],
      response_format:{type:'json_object'},temperature:0,max_tokens:Math.min(maxOutput,profile.capabilities.maxOutputTokens),
      ...(profile.model.startsWith('deepseek-')?{thinking:{type:'disabled'}}:{})}
    // 价格预警与预授权同一口径；按满额算的话每次调用都会触发，等于没有预警。
    const ceiling=estimateCost(estimateContextTokens(body),0,Math.min(body.max_tokens,RESERVED_OUTPUT_TOKENS),price)!
    if(ceiling>=warningCost)yield {type:'warning',estimatedCost:ceiling,currency:price.currency}
    let wake:()=>void=()=>{},finished=false,failure:unknown,result:unknown,sent=''
    const pending:string[]=[]
    const task=transport('chat/completions',body,signal,undefined,text=>{
      const partial=partialAnswer(text)
      if(partial!==null&&partial.startsWith(sent)&&partial.length>sent.length){pending.push(partial.slice(sent.length));sent=partial;wake()}
    }).then(raw=>{result=raw},error=>{failure=error}).finally(()=>{finished=true;wake()})
    while(!finished||pending.length){if(pending.length){yield {type:'delta',text:pending.shift()!};continue}await new Promise<void>(resolve=>{wake=resolve;if(finished||pending.length)resolve()})}
    await task;if(failure)throw failure
    const raw=record(result),choice=record(Array.isArray(raw.choices)?raw.choices[0]:null),message=record(choice.message)
    const u=reportedUsage(raw)
    const usage:AgentUsage={operation:'model',provider:profile.source,model:profile.model,inputTokens:u?.input??null,outputTokens:u?.output??null,cachedInputTokens:u?.cached??null,
      durationMs:Date.now()-started,resultCount:1,estimatedCost:u?estimateCost(u.input,u.cached,u.output,price):null,currency:price.currency,priceVersion:price.version}
    yield {type:'usage',usage}
    if(choice.finish_reason!=='stop'||message.tool_calls||typeof message.content!=='string'||Buffer.byteLength(message.content)>RUN_LIMITS.modelOutputBytes)throw new AgentRunError('INVALID_OUTPUT')
    let value:unknown;try{value=JSON.parse(message.content)}catch{throw new AgentRunError('INVALID_OUTPUT')}
    if(!matchesContract(request.outputSchema,value))throw new AgentRunError('INVALID_OUTPUT')
    if(sent){const text=record(value).text;if(typeof text!=='string'||!text.startsWith(sent))throw new AgentRunError('INVALID_OUTPUT');if(text.length>sent.length)yield {type:'delta',text:text.slice(sent.length)}}
    yield {type:'output',value}
  }}
}
