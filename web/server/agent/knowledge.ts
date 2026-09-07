import { createHash } from 'node:crypto'
import { AGENT_TOOLS, type AgentToolName } from '../../shared/agent-contracts'
import { AgentRunError } from '../../shared/agent-run'

export const knowledgeHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export interface FeatureDescription {
  id: string; revision: number; title: string; purpose: string; entry: string; steps: string[]; limitations: string[]
  mode: 'explain' | 'open_page' | 'tool'; tools: AgentToolName[]
}
export interface FeatureRegistration { id: string; revision: number; descriptionHash: string }
export interface KnowledgeAccess { enabled: boolean; permissionVersion: string; features: readonly string[]; tools: readonly AgentToolName[]; conditions?: Readonly<Record<string,boolean>> }
export interface KnowledgeSnapshot {
  version: string; release: string; status: 'ready' | 'pending_sync'; features: FeatureDescription[]; tools: AgentToolName[]
  notice: string; conditions: Record<string,boolean>
}

// 清单只描述本进程注册的阶段 1～3 入口；整个站点的初始清单与页面映射在阶段 5 补齐。
export const AGENT_FEATURES: readonly FeatureDescription[] = [
  { id: 'agent.history', revision: 1, title: '个人会话历史', purpose: '登录后保存、查看、导出自己的完整对话。', entry: '/api/agent/sessions',
    steps: ['使用会话接口保存与读取记录'], limitations: ['聊天浮层尚未开放', '压缩不会删除完整聊天'], mode: 'explain', tools: [] },
  { id: 'agent.context', revision: 2, title: '上下文与偏好', purpose: '整理下一轮上下文，保留原文，长期偏好由用户确认。', entry: '/api/agent/sessions',
    steps: ['使用压缩、摘要版本和偏好接口'], limitations: ['付费压缩需要维护者开启', '偏好按钮和聊天浮层尚未开放'], mode: 'explain', tools: [] },
  { id: 'agent.run', revision: 3, title: '只读运行循环', purpose: '按轮装配上下文、校验结果，保存进度并支持取消和恢复。', entry: '/api/agent/sessions',
    steps: ['创建回合', '通过事件接口查看进度', '暂停后由用户明确继续'], limitations: ['真实回答模型在外部 AI 阶段接入', '当前没有线上数据工具和聊天入口'], mode: 'explain', tools: [] },
]
export const AGENT_FEATURE_REGISTRATIONS: readonly FeatureRegistration[] = [
  {id:'agent.history',revision:1}, {id:'agent.context',revision:2}, {id:'agent.run',revision:3},
].map(registration=>({ ...registration,descriptionHash:knowledgeHash(AGENT_FEATURES.find(f=>f.id===registration.id)??null) }))

export class AgentKnowledgeRegistry {
  private readonly features: FeatureDescription[]
  private readonly registrations: FeatureRegistration[]
  private readonly registeredTools: readonly AgentToolName[]
  private readonly cache = new Map<number, { key: string; snapshot: KnowledgeSnapshot }>()
  constructor(readonly release: string, registrations: readonly FeatureRegistration[], descriptions: readonly FeatureDescription[],
    registeredTools: readonly AgentToolName[], private readonly codeMatches = true) {
    this.features = structuredClone([...descriptions]); this.registrations = structuredClone([...registrations]); this.registeredTools = [...registeredTools]
  }
  snapshot(uid: number, access: KnowledgeAccess): KnowledgeSnapshot {
    if (!Number.isSafeInteger(uid) || uid <= 0 || !access.enabled) throw new AgentRunError('AUTH_REQUIRED', 401)
    const key = knowledgeHash({ release: this.release, access, codeMatches: this.codeMatches })
    const cached = this.cache.get(uid)
    if (cached?.key === key) return structuredClone(cached.snapshot)
    const features: FeatureDescription[] = []; let pending = !this.codeMatches
    if (this.codeMatches) for (const registration of this.registrations) {
      if (!access.features.includes(registration.id)) continue
      const entry = this.features.find(f => f.id === registration.id)
      if (!entry || entry.revision !== registration.revision || knowledgeHash(entry) !== registration.descriptionHash
        || entry.tools.some(t => !this.registeredTools.includes(t))) { pending = true; continue }
      features.push(entry)
    }
    const tools = pending ? [] : this.registeredTools.filter(t => access.tools.includes(t) && AGENT_TOOLS[t].mode === 'read')
    const snapshot: KnowledgeSnapshot = { version: knowledgeHash({ key, features, tools }), release: this.release,
      status: pending ? 'pending_sync' : 'ready', features, tools, conditions: {...access.conditions},
      notice: '本轮服务器功能状态优先于旧消息、摘要和偏好；未列出的功能保持未知。页面是否已刷新由客户端版本单独判断。' }
    if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(uid, { key, snapshot }); return structuredClone(snapshot)
  }
}
export function requireSameKnowledge(expected: KnowledgeSnapshot, current: KnowledgeSnapshot): void {
  if (expected.version !== current.version || current.status !== 'ready') throw new AgentRunError('CAPABILITY_CHANGED')
}
