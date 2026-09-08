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
  { id: 'agent.context', revision: 4, title: '上下文与偏好', purpose: '整理下一轮上下文，保留原文，四项偏好由用户一次保存。', entry: '/api/agent/sessions',
    steps: ['使用压缩、摘要版本和偏好接口'], limitations: ['付费压缩需要维护者开启', '每类偏好一个值，留空默认，点击保存即生效'], mode: 'explain', tools: [] },
  { id: 'agent.run', revision: 5, title: '只读运行循环', purpose: '按轮装配上下文、校验结果，保存进度并支持取消和恢复。', entry: '/api/agent/sessions',
    steps: ['创建回合', '通过事件接口查看进度', '暂停后由用户明确继续'], limitations: ['真实回答模型在外部 AI 阶段接入', '已注册本地只读数据工具；真实回答模型尚未接入'], mode: 'explain', tools: [] },
  { id:'agent.chat',revision:3,title:'纱雾助手',purpose:'PC 和平板右下角的头像入口，查看对话、来源、偏好与上下文。',entry:'/#/',
    steps:['点击右下角头像，通过顶栏对话入口返回','可从番剧卡片或详情带入当前番剧','收起后稍后继续查看'],limitations:['手机首期隐藏入口','真实回答模型尚未接入','动作卡只展示已有状态，确认执行留在后续功能'],mode:'explain',tools:[] },
  ...SITE_FEATURES,
]
export const AGENT_FEATURE_REGISTRATIONS: readonly FeatureRegistration[] = [
  {id:'agent.history',revision:3}, {id:'agent.context',revision:4}, {id:'agent.run',revision:5}, {id:'agent.chat',revision:3}, ...SITE_FEATURES.map(({id,revision})=>({id,revision})),
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
