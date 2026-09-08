import { navigate } from '../router'

export const AGENT_CONTEXT_EVENT='maple-agent-context'
export const AGENT_NAVIGATION_EVENT='maple-agent-navigation'
export type AgentNavigation={kind:'search'}|{kind:'review';bgmId:number}|{kind:'source';bgmId:number;source:'xifan'|'girigiri'}
let pending:{owner:number;action:AgentNavigation}|null=null
export function goFromAgent(action:AgentNavigation,owner:number):void{
  pending={owner,action};navigate('tracks');window.dispatchEvent(new Event(AGENT_NAVIGATION_EVENT))
}
export function takeAgentNavigation(owner:number):AgentNavigation|null{const value=pending;pending=null;return value?.owner===owner?value.action:null}
