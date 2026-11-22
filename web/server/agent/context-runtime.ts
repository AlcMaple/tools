import { db } from '../db'
import { AgentContextStore } from './context-store'
import { AgentContextService } from './context-service'
import { externalBinding,externalBindingForAction } from './external-runtime'

export const agentContextStore=new AgentContextStore(db)
export const agentContextService=new AgentContextService(agentContextStore,uid=>externalBinding(uid,`user:${uid}`).context,
  async(uid,action,signal,ai)=>(await externalBindingForAction(uid,`user:${uid}`,signal,false,ai)).execute(action))
