import type { FeatureDescription } from './knowledge'
const feature=(id:string,title:string,purpose:string,entry:string,steps:string[],limitations:string[],tools:FeatureDescription['tools']=[],audience:'public'|'authenticated'='authenticated'):FeatureDescription=>({id,revision:1,title,purpose,entry,steps,limitations,tools,mode:tools.length?'tool':'explain',audience})
export const SITE_FEATURES:readonly FeatureDescription[]=[
  feature('web.calendar','番剧周历','按星期查看番剧更新与已加载资料。','/#/',['打开番剧周历，切换横向或纵向视图','点击卡片查看资料；刷新由用户点击'],['Agent 只读取已有缓存，过期不自动联网刷新'],['readCachedCalendar','readCurrentAnimeContext'],'public'),
  feature('web.search','找番与离线索引','在加番入口按番名查找候选。','/#/tracks',['打开加番搜索','默认本地检索；在线搜索须由用户主动选择'],['Agent 仅使用本地索引和补充表；缺索引不借远端站点搜索','离线完结状态未知，标签相似不是模型推荐结论'],['searchOfflineAnime']),
  feature('web.tracks','我的追番','管理自己的追番状态、进度、标签、收藏程度及好看集。','/#/tracks',['登录后添加番剧或手动条目','在卡片编辑进度、状态、标签或详情','可导入 Bangumi 收藏及使用既有同步入口'],['私人资料仅当前账号可读','Agent 本阶段只读，不代为添加、修改、删除、上传封面或导入'],['listMyTracks']),
  feature('web.community','追番大厅','浏览用户主动公开的番剧、点评与推荐。','/#/community',['打开追番大厅查看公开用户或公开点评','从条目进入番剧讨论或公开用户页'],['关闭公开开关或撤回发布后不再进入工具结果','聚合只统计公开动画追番，私密和非动画条目不纳入'],['listPublicReviews','aggregatePublicData'],'public'),
  feature('web.reviews','点评与推荐助手','为已在看或看完的番剧整理点评或推荐草稿。','/#/tracks',['进入符合状态的追番卡片，点击点评','填写问题、调整草稿，明确点击发布或撤回'],['须登录并拥有该番剧；想看和观望不满足写点评条件','Agent 不直接生成发布请求；模型连接状态以当前配置为准']),
  feature('web.auth','登录与注册','使用账号登录后管理私人数据。','/#/settings',['点击登录/注册，使用已开通的登录方式','在设置中按界面流程修改账号、密码与公开开关'],['访客可了解登录流程，但不执行账号操作；不向 Agent 提供密码或验证码'],[],'public'),
  feature('web.email','邮箱验证码','使用已启用的邮箱验证码入口登录或绑定邮箱。','/#/settings',['点击邮箱登录或设置中的邮箱入口','本人填写验证码完成操作'],['入口取决于服务器邮件配置；Agent 不发送邮件或读取验证码'],[],'public'),
  feature('web.google','Google 登录','通过已启用的 Google 登录入口验证账号。','/#/settings',['点击 Google 登录并完成提供方流程'],['只在服务器配置就绪时启用；Agent 不代为操作凭据'],[],'public'),
  feature('web.settings','偏好与公开设置','调整站点显示、账号资料、公开范围与 AI 配置。','/#/settings',['进入设置修改已有选项','公开追番由用户主动开启'],['账号配置与 Agent 四项偏好是不同设置','Agent 不修改设置或读取 API key']),
  feature('web.xifan','稀饭播放入口','从追番条目选择稀饭来源并播放。','/#/tracks',['在条目点击继续看，选择片源与集数'],['搜索、解析与播放由用户点击触发；Agent 无在线片源查询工具','本阶段不签发播放执行回执']),
  feature('web.girigiri','Girigiri 播放入口','从追番条目选择 Girigiri 来源并播放。','/#/tracks',['在条目点击继续看，选择片源与集数'],['来源搜索和播放不是 Agent 工具；Agent 不自动访问源站']),
  feature('web.slowPlayback','慢源观看与候补','慢源播放按名额、候补及观看会话规则分配。','/#/tracks',['在已有播放器内查看等待状态','有名额后按播放器流程继续'],['须登录；候补排队不等于已播放','Agent 不申请名额或发送观看心跳']),
  feature('web.rewards','放映福利','查看当前账号积分与已启用的权益兑换。','/#/rewards',['进入放映福利查看个人状态','本人确认后兑换权益'],['按服务器开关和账号名单开放；Agent 不兑换或抽取']),
  feature('web.invites','邀请权益','使用账号已开放的邀请功能。','/#/rewards',['在放映福利查看邀请入口'],['受邀请开关及账号资格约束；Agent 不读取或分发私人邀请码']),
  feature('web.lottery','幸运扭蛋','使用账号已开放的抽取功能。','/#/rewards',['在放映福利查看可用次数并本人点击抽取'],['受扭蛋开关及账号资格约束；Agent 不代为抽取']),
  feature('web.announcements','站内公告','查看当前公告及版本提醒。','/#/',['首页展示当前公告','可按界面选择本版本暂不再显示'],['账号与访客的公告偏好各自隔离；Agent 不修改公告状态'],[],'public'),
]
// 仅构建校验使用，不进入模型或公开快照。每个顶层 API 入口必须有功能归属。
export const SITE_API_FEATURES:Readonly<Record<string,string>>={
 '/api/health':'infrastructure.health','/api/cover/*':'infrastructure.cover','/api/auth':'web.auth','/api/auth/oauth':'web.google',
 '/api/rewards':'web.rewards','/api/slow-playback':'web.slowPlayback','/api/community':'web.community','/api/announcements':'web.announcements',
 '/api/tracks':'web.tracks','/api/reviews':'web.reviews','/api/agent':'agent.run','/api/xifan':'web.xifan','/api/girigiri':'web.girigiri','/api/search':'web.search','/api/calendar':'web.calendar',
}
export interface SiteFeatureAccess { email:boolean;google:boolean;rewards:boolean;invites:boolean;lottery:boolean }
export function enabledSiteFeatures(flags:SiteFeatureAccess,guest=false):string[]{
 const gates:Record<string,boolean>={'web.email':flags.email,'web.google':flags.google,'web.rewards':flags.rewards,'web.invites':flags.invites,'web.lottery':flags.lottery}
 return SITE_FEATURES.filter(f=>(!guest||f.audience==='public')&&gates[f.id]!==false).map(f=>f.id)
}
