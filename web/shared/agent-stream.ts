import type { RunEvent } from './agent-run'

export class AgentStreamError extends Error {
  constructor(readonly code:string){super(code);this.name='AgentStreamError'}
}
const terminal=new Set(['completed','failed','cancelled','paused'])
const eventKinds=new Set(['started','resumed','knowledge','context','model_started','delta','tool_started','tool_finished','soft_limit','long_task',...terminal])
export async function* subscribeAgentEvents(options:{runId:string;afterSeq?:number;signal:AbortSignal;fetchImpl?:typeof fetch;base?:string;idleMs?:number}):AsyncGenerator<RunEvent>{
  const {signal}=options,fetcher=options.fetchImpl??fetch,idleMs=options.idleMs??60_000
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(options.runId)||!Number.isSafeInteger(options.afterSeq??0)||(options.afterSeq??0)<0
    ||!Number.isSafeInteger(idleMs)||idleMs<1||idleMs>60_000)throw new AgentStreamError('INVALID_ARGUMENT')
  let cursor=options.afterSeq??0
  for(let attempt=0;attempt<=2;attempt++){
    signal.throwIfAborted()
    const connection=new AbortController(),abort=()=>connection.abort(signal.reason)
    signal.addEventListener('abort',abort,{once:true})
    let timer:ReturnType<typeof setTimeout>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined
    const resetTimer=()=>{if(timer)clearTimeout(timer);timer=setTimeout(()=>connection.abort(new Error('STREAM_IDLE')),idleMs)}
    const wait=<T>(promise:Promise<T>)=>new Promise<T>((resolve,reject)=>{
      const fail=()=>{connection.signal.removeEventListener('abort',fail);reject(connection.signal.reason)}
      if(connection.signal.aborted){reject(connection.signal.reason);return}
      connection.signal.addEventListener('abort',fail,{once:true})
      promise.then(value=>{connection.signal.removeEventListener('abort',fail);resolve(value)},error=>{connection.signal.removeEventListener('abort',fail);reject(error)})
    })
    try{
      resetTimer()
      const response=await wait(fetcher(`${options.base??'/api/agent'}/runs/${encodeURIComponent(options.runId)}/events?afterSeq=${cursor}&reconnectAttempt=${attempt}`,
        {method:'GET',headers:{Accept:'text/event-stream','Last-Event-ID':String(cursor)},credentials:'same-origin',signal:connection.signal}))
      if(response.status===204)return
      if(!response.ok)throw new AgentStreamError(`HTTP_${response.status}`)
      const currentAttempt=Number(response.headers.get('X-Agent-Run-Attempt')??'1')
      if(!Number.isSafeInteger(currentAttempt)||currentAttempt<1)throw new AgentStreamError('INVALID_STREAM')
      if(!/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type')??'')||!response.body)throw new AgentStreamError('INVALID_STREAM')
      reader=response.body.getReader();const decoder=new TextDecoder();let buffer=''
      for(;;){
        const chunk=await wait(reader.read());signal.throwIfAborted()
        if(chunk.done)break
        resetTimer();buffer=(buffer+decoder.decode(chunk.value,{stream:true})).replace(/\r\n/g,'\n')
        if(buffer.length>256*1024)throw new AgentStreamError('STREAM_TOO_LARGE')
        for(let boundary=buffer.indexOf('\n\n');boundary!==-1;boundary=buffer.indexOf('\n\n')){
          const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2)
          let id='',event='',data=''
          for(const line of block.split('\n')){
            if(line.startsWith('id:'))id=line.slice(3).trim()
            else if(line.startsWith('event:'))event=line.slice(6).trim()
            else if(line.startsWith('data:'))data+=(data?'\n':'')+line.slice(5).replace(/^ /,'')
          }
          if(!data&&!id&&!event)continue
          if(!/^[1-9]\d*$/.test(id)||!Number.isSafeInteger(Number(id))||!eventKinds.has(event))throw new AgentStreamError('INVALID_STREAM')
          let value:RunEvent
          try{value=JSON.parse(data) as RunEvent}catch{throw new AgentStreamError('INVALID_STREAM')}
          if(!value||value.runId!==options.runId||value.seq!==Number(id)||value.type!==event||!Number.isSafeInteger(value.createdAt)||value.createdAt<0||!Object.hasOwn(value,'data'))throw new AgentStreamError('INVALID_STREAM')
          if(value.seq<=cursor)continue
          if(value.seq!==cursor+1)throw new AgentStreamError('EVENT_GAP')
          cursor=value.seq;yield value
          if(terminal.has(event)&&Number((value.data&&typeof value.data==='object'&&!Array.isArray(value.data)?value.data.attempt:undefined)??1)>=currentAttempt)return
        }
      }
      throw new Error('STREAM_DISCONNECTED')
    }catch(error){
      signal.throwIfAborted()
      if(error instanceof AgentStreamError)throw error
      if(attempt===2)throw new AgentStreamError('RECONNECT_EXHAUSTED')
    }finally{
      if(timer)clearTimeout(timer);signal.removeEventListener('abort',abort);connection.abort()
      if(reader)void reader.cancel().catch(()=>{})
    }
  }
}
