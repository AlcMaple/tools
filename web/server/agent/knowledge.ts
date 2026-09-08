import { SITE_FEATURES } from './site-features'
import { createHash } from 'node:crypto'
import { AGENT_TOOLS, type AgentToolName } from '../../shared/agent-contracts'
import { AgentRunError } from '../../shared/agent-run'

export const knowledgeHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export interface FeatureDescription {
  audience?:'public'|'authenticated'; id: string; revision: number; title: string; purpose: string; entry: string; steps: string[]; limitations: string[]
  mode: 'explain' | 'open_page' | 'tool'; tools: AgentToolName[]
}
export interface FeatureRegistration { id: string; revision: number; descriptionHash: string }
export interface KnowledgeAccess { enabled: boolean; permissionVersion: string; features: readonly string[]; tools: readonly AgentToolName[]; conditions?: Readonly<Record<string,boolean>> }
export interface KnowledgeSnapshot {
  version: string; release: string; status: 'ready' | 'pending_sync'; features: FeatureDescription[]; tools: AgentToolName[]
  notice: string; conditions: Record<string,boolean>
}

// 功能描述与站点入口、工具实现同发布；快照再次按身份和开关筛选。
export const AGENT_FEATURES: readonly FeatureDescription[] = [
  { id: 'agent.history', revision: 3, title: '个人会话历史', purpose: '登录后保存、查看、导出自己的完整对话。', entry: '/api/agent/sessions',
    steps: ['首次发送后进入历史并自动提取一次标题，手动改名优先', '历史条目可归档或恢复'], limitations: ['PC 和平板可使用右下角手帐，手机首期隐藏', '压缩不会删除完整聊天'], mode: 'explain', tools: [] },
  { id: 'agent.context', revision: 5, title: '上下文与偏好', purpose: '整理下一轮上下文，保留原文，四项偏好由用户一次保存。', entry: '/api/agent/sessions',
    steps: ['使用压缩、摘要版本和偏好接口'], limitations: ['付费压缩与回答共用当前已连接模型和额度', '每类偏好一个值，留空默认，点击保存即生效'], mode: 'explain', tools: [] },
  { id: 'agent.run', revision: 6, title: '只读运行循环', purpose: '按轮装配上下文、校验结果，保存进度并支持取消和恢复。', entry: '/api/agent/sessions',
    steps: ['创建回合', '通过事件接口查看进度', '暂停后由用户明确继续'], limitations: ['真实服务器 AI 或 BYOK 需通过连接探测和费用预检', '只开放六个本地只读工具；不执行写入和播放'], mode: 'explain', tools: [] },
  { id:'agent.chat',revision:7,title:'纱雾助手',purpose:'PC 和平板右下角的头像入口，查看对话、来源、偏好与上下文。',entry:'/#/',
    steps:['点击右下角头像，通过顶栏对话入口返回','可从番剧卡片或详情带入当前番剧','收起后稍后继续查看','统计来源可展开查看指标、口径与查询时间，并点击查看大厅'],limitations:['手机首期隐藏入口','服务器有 key 时页面后台准备；回复实时流式输出并支持 Markdown；BYOK 在 AI 页配置','动作卡只展示已有状态，确认执行留在后续功能'],mode:'explain',tools:[] },
  {id:'agent.provider',revision:3,title:'AI 连接与用量',purpose:'连接项目模型或用户自配 API，查看本账号的用量。',entry:'/api/agent/provider',steps:['页面加载后后台准备服务器 AI，直接发送即可','BYOK 在 AI 页配置；上下文档位在上下文页设置'],limitations:['BYOK 仅开放核准端点和型号；凭据临时保留，过期需重连','能力不足、额度超限或连接失败不切换模型；探测也计费'],mode:'explain',tools:[]},
  {id:'agent.guest',revision:4,audience:'public',title:'访客临时对话',purpose:'未登录可询问网站用法、已有周历缓存和公开大厅资料。',entry:'/api/agent/guest/status',steps:['页面后台准备项目 AI，打开头像直接提问，发送即显示回复状态','收起后可继续；刷新开始新对话','统计来源合并为一组，展开查看明细，点击查看大厅'],limitations:['仅三个公开只读工具；不读取个人记录，不写入或播放','没有历史、偏好、摘要或 BYOK；临时状态不跨刷新保留','共享 IP 额度不因刷新重置；有 key 默认开放并后台准备，管理员可显式关闭，探测成功才回答'],mode:'explain',tools:[...['readCachedCalendar','listPublicReviews','aggregatePublicData'] as const]},
  ...SITE_FEATURES,
]
export const AGENT_FEATURE_REGISTRATIONS: readonly FeatureRegistration[] = [
  {id:'agent.history',revision:3}, {id:'agent.context',revision:5}, {id:'agent.run',revision:6}, {id:'agent.chat',revision:7}, {id:'agent.provider',revision:3}, {id:'agent.guest',revision:4}, ...SITE_FEATURES.map(({id,revision})=>({id,revision})),
].map(registration=>({ ...registration,descriptionHash:knowledgeHash(AGENT_FEATURES.find(f=>f.id===registration.id)??null) }))

export class AgentKnowledgeRegistry {
  private readonly features: FeatureDescription[]
  private readonly registrations: FeatureRegistration[]
  private readonly registeredTools: readonly AgentToolName[]
  private readonly cache = new Map<string, { key: string; snapshot: KnowledgeSnapshot }>()
  constructor(readonly release: string, registrations: readonly FeatureRegistration[], descriptions: readonly FeatureDescription[],
    registeredTools: readonly AgentToolName[], private readonly codeMatches = true) {
    this.features = structuredClone([...descriptions]); this.registrations = structuredClone([...registrations]); this.registeredTools = [...registeredTools]
  }
  snapshot(uid: number, access: KnowledgeAccess): KnowledgeSnapshot {
    if (!Number.isSafeInteger(uid) || uid <= 0 || !access.enabled) throw new AgentRunError('AUTH_REQUIRED', 401)
    return this.build(String(uid),access)
  }
  guestSnapshot(access:KnowledgeAccess):KnowledgeSnapshot {
    if(!access.enabled)throw new AgentRunError('AUTH_REQUIRED',401)
    return this.build('guest',{...access,features:access.features.filter(id=>this.features.some(f=>f.id===id&&f.audience==='public')),tools:access.tools.filter(t=>['readCachedCalendar','listPublicReviews','aggregatePublicData'].includes(t))})
  }
  private build(owner:string,access:KnowledgeAccess):KnowledgeSnapshot{
    const key = knowledgeHash({ release: this.release, access, codeMatches: this.codeMatches })
    const cached = this.cache.get(owner)
    if (cached?.key === key) return structuredClone(cached.snapshot)
    const features: FeatureDescription[] = []; let pending = !this.codeMatches
    if (this.codeMatches) for (const registration of this.registrations) {
      if (!access.features.includes(registration.id)) continue
      const entry = this.features.find(f => f.id === registration.id)
      if (!entry || entry.revision !== registration.revision || knowledgeHash(entry) !== registration.descriptionHash
        || entry.tools.some(t => !this.registeredTools.includes(t))) { pending = true; continue }
      const tools=entry.tools.filter(t=>access.tools.includes(t))
      features.push({...entry,tools,mode:tools.length?'tool':'explain'})
    }
    const tools = pending ? [] : this.registeredTools.filter(t => access.tools.includes(t) && AGENT_TOOLS[t].mode === 'read')
    const snapshot: KnowledgeSnapshot = { version: knowledgeHash({ key, features, tools }), release: this.release,
      status: pending ? 'pending_sync' : 'ready', features, tools, conditions: {...access.conditions},
      notice: '本轮服务器功能状态优先于旧消息、摘要和偏好；未列出的功能保持未知。页面是否已刷新由客户端版本单独判断。' }
    if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(owner, { key, snapshot }); return structuredClone(snapshot)
  }
}
export function requireSameKnowledge(expected: KnowledgeSnapshot, current: KnowledgeSnapshot): void {
  if (expected.version !== current.version || current.status !== 'ready') throw new AgentRunError('CAPABILITY_CHANGED')
}
