import { navigate } from '../router'

export const AGENT_CONTEXT_EVENT='maple-agent-context'
export const AGENT_NAVIGATION_EVENT='maple-agent-navigation'
// actionId 只在「播放打开」预览确认后带上：选完片源真正开播时，播放页链接会捎上它，
// 让权威回执能跟着这次打开一路走到 playing（见 server/agent/playback-store.ts）。
export type AgentNavigation={kind:'search'}|{kind:'review';bgmId:number}|{kind:'source';bgmId:number;source:'xifan'|'girigiri';actionId?:string}
let pending:{owner:number;action:AgentNavigation}|null=null
export function goFromAgent(action:AgentNavigation,owner:number):void{
  pending={owner,action};navigate('tracks');window.dispatchEvent(new Event(AGENT_NAVIGATION_EVENT))
}
export function takeAgentNavigation(owner:number):AgentNavigation|null{const value=pending;pending=null;return value?.owner===owner?value.action:null}
