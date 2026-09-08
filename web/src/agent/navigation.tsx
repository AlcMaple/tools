import { Ic } from '../SketchIcon'
import { navigate } from '../router'
import { validAnime,type AnimeContext } from './model'

export const AGENT_CONTEXT_EVENT='maple-agent-context'
export const AGENT_NAVIGATION_EVENT='maple-agent-navigation'
export type AgentNavigation={kind:'search'}|{kind:'review';bgmId:number}|{kind:'source';bgmId:number;source:'xifan'|'girigiri'}
let pending:{owner:number;action:AgentNavigation}|null=null
export function goFromAgent(action:AgentNavigation,owner:number):void{
  pending={owner,action};navigate('tracks');window.dispatchEvent(new Event(AGENT_NAVIGATION_EVENT))
}
export function takeAgentNavigation(owner:number):AgentNavigation|null{const value=pending;pending=null;return value?.owner===owner?value.action:null}
export function AgentContextButton({anime,inline=false,compact=false}:{anime:AnimeContext;inline?:boolean;compact?:boolean}):JSX.Element|null{
  if(!validAnime(anime))return null
  return <button type="button" className={`agent-context-button${inline?' agent-context-inline':compact?' agent-context-compact':''}`} aria-label={`和纱雾聊『${anime.title}』`} title="带进纱雾的手帐" onClick={event=>{event.stopPropagation();window.dispatchEvent(new CustomEvent(AGENT_CONTEXT_EVENT,{detail:anime}))}}><Ic name="pencil" cls="ic ic-sm" />{inline&&'聊聊这部'}</button>
}
