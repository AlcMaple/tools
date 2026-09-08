import { db } from '../db'
import { AgentContextStore } from './context-store'
import { AgentContextService } from './context-service'
import { externalBinding } from './external-runtime'

export const agentContextStore=new AgentContextStore(db)
export const agentContextService=new AgentContextService(agentContextStore,uid=>externalBinding(uid,`user:${uid}`).context,
  (uid,action)=>externalBinding(uid,`user:${uid}`).execute(action))
