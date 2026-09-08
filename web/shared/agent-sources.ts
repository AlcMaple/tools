import type { TRACK_STATUSES } from './agent-contracts'

export const PUBLIC_METRICS=['public_users','public_tracks','public_reviews','public_recommendations'] as const
export type PublicMetric=typeof PUBLIC_METRICS[number]
export interface AggregateEvidence {
  metric:PublicMetric
  value:number
  filters:{bgmId?:number;status?:typeof TRACK_STATUSES[number]}
  scope:string
}
export const PUBLIC_METRIC_LABELS:Record<PublicMetric,{label:string;unit:string}>={
  public_users:{label:'公开用户',unit:'位'},public_tracks:{label:'公开追番',unit:'条'},
  public_reviews:{label:'公开点评',unit:'篇'},public_recommendations:{label:'公开推荐',unit:'篇'},
}
export const SOURCE_STATUS_LABELS:Record<typeof TRACK_STATUSES[number],string>={watching:'在追',plan:'想看',considering:'观望',done:'看完'}
export function publicAggregateScope(metric:PublicMetric,filters:AggregateEvidence['filters']):string{
  if(metric==='public_users')return filters.bgmId===undefined&&filters.status===undefined
    ?'开启公开追番的账号总数，包含尚未添加动画追番的账号；不是当前页显示的卡片数。'
    :'开启公开追番、且有符合筛选条件的动画追番的账号数；同一账号只计一次。'
  if(metric==='public_tracks')return '开启公开追番账号的动画追番记录数；不同账号追同一部番分别计数，不是去重番剧数。'
  return `开启公开追番账号中，已发布且仍对应动画追番记录的${metric==='public_reviews'?'点评':'推荐'}篇数；不含草稿、已撤回内容或非动画条目。`
}
