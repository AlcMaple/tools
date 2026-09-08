import { AgentRunError } from '../../shared/agent-run'
const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}

function stringPrefix(json:string,start:number){
  if(json[start]!=='"')return null
  let value='',i=start+1
  for(;i<json.length;i++){
    const c=json[i]
    if(c==='"')return {value,end:i+1,complete:true}
    if(c==='\\'){
      const next=json[++i];if(next===undefined)break
      if(next==='u'){const hex=json.slice(i+1,i+5);if(hex.length<4)break;if(!/^[0-9a-f]{4}$/i.test(hex))return null;value+=String.fromCharCode(parseInt(hex,16));i+=4}
      else {const escaped:Record<string,string>={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};if(!Object.hasOwn(escaped,next))return null;value+=escaped[next]}
    }else{if(c.charCodeAt(0)<32)return null;value+=c}
  }
  if(/[\uD800-\uDBFF]$/.test(value))value=value.slice(0,-1)
  return {value,end:i,complete:false}
}
export function partialAnswer(json:string):string|null{
  let i=0,kind:string|undefined
  const space=()=>{while(/\s/.test(json[i]??'')&&i<json.length)i++}
  space();if(json[i++]!=='{')return null
  for(;;){
    space();const key=stringPrefix(json,i);if(!key?.complete)return null;i=key.end;space();if(json[i++]!==':')return null;space()
    if(key.value==='text'){const text=stringPrefix(json,i);return kind!==undefined&&kind!=='answer'?null:text?.value??null}
    if(key.value==='kind'){const value=stringPrefix(json,i);if(!value?.complete)return null;kind=value.value;if(kind!=='answer')return null;i=value.end}
    else {
      let depth=0
      for(;i<json.length;i++){
        const c=json[i]
        if(c==='"'){const value=stringPrefix(json,i);if(!value?.complete)return null;i=value.end-1}
        else if(c==='['||c==='{')depth++
        else if(c===']'||c==='}'){if(!depth)return null;depth--}
        else if(c===','&&!depth)break
      }
    }
    space();if(json[i++]!==',')return null
  }
}
export async function readCompletionStream(reader:ReadableStreamDefaultReader<Uint8Array>,onText:(text:string)=>void){
  let buffer='',content='',finish:unknown=null,usage:unknown=null,total=0,done=false
  const decoder=new TextDecoder()
  try{
    for(;;){
      const chunk=await reader.read();if(chunk.done)break;total+=chunk.value.byteLength;if(total>768*1024)throw new AgentRunError('INVALID_OUTPUT')
      buffer+=decoder.decode(chunk.value,{stream:true});buffer=buffer.replace(/\r\n/g,'\n')
      for(let i=buffer.indexOf('\n\n');i>=0;i=buffer.indexOf('\n\n')){
        const block=buffer.slice(0,i);buffer=buffer.slice(i+2)
        const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n')
        if(!data)continue
        if(data==='[DONE]'){done=true;continue}
        if(done)throw new AgentRunError('INVALID_OUTPUT')
        let raw:unknown;try{raw=JSON.parse(data)}catch{throw new AgentRunError('INVALID_OUTPUT')}
        const r=record(raw);if(r.error)throw new AgentRunError('PROVIDER_UNAVAILABLE',503)
        if(r.usage)usage=r.usage
        if(!Array.isArray(r.choices)||r.choices.length>1)throw new AgentRunError('INVALID_OUTPUT')
        const choice=record(r.choices[0]),delta=record(choice.delta)
        if(delta.tool_calls||delta.function_call)throw new AgentRunError('INVALID_OUTPUT')
        if(choice.finish_reason!==undefined&&choice.finish_reason!==null)finish=choice.finish_reason
        if(delta.content!==undefined&&delta.content!==null){if(typeof delta.content!=='string')throw new AgentRunError('INVALID_OUTPUT');content+=delta.content;if(content.length>128*1024)throw new AgentRunError('INVALID_OUTPUT');onText(content)}
      }
    }
    if(!done||finish!=='stop')throw new AgentRunError('INVALID_OUTPUT')
    return {choices:[{finish_reason:finish,message:{content}}],usage}
  }finally{void reader.cancel().catch(()=>{});reader.releaseLock()}
}
