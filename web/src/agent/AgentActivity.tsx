export function agentActivity(stage:string,tool?:string):string{
  if(stage==='tool')return ({searchOfflineAnime:'纱雾在翻找番剧资料…',readCurrentAnimeContext:'让我看看这部番的资料…',readCachedCalendar:'纱雾在翻本周的更新表…',listMyTracks:'在你的追番里找找线索…',listPublicReviews:'纱雾在看看大家的点评…',aggregatePublicData:'把大厅里的公开数据理一理…'} as Record<string,string>)[tool??'']??'纱雾在核对资料…'
  if(stage==='writing')return '纱雾正在写回复…'
  if(stage==='compact')return '把前面的线索整理一下…'
  return '唔，让纱雾想一想…'
}
export function AgentActivity({label=agentActivity('thinking')}:{label?:string}){
  return <div className="agent-thinking" role="status"><span className="agent-thinking-spark" aria-hidden="true">✦</span><span>{label}</span><span className="agent-writing" aria-hidden="true"><span>·</span><span>·</span><span>·</span></span></div>
}
