// 估价小时：两步，都以 RadQuote 公开示例的完整 WBS 为参考样例（order-judge-estimate-reference.json，
// scripts/sync-estimate-reference.ts 拉取）。用户自己的对照单不进提示词，留作检验。
// 1. 定范围：一次调用列出全部任务并分组。范围必须由一个调用一次定完——各组各自想范围会互相重复或漏项。
// 2. 估小时：按组并行，每组拿到完整任务清单（知道别的组已经包了什么）只估本组；每个任务按参与角色分别估，
//    任务工时 = 各角色之和。这是 RadQuote 的口径（任务树里每个任务挂多条 estimates，示例平均 2.7~3.6 条），
//    多端项目的单个任务因此天然比单端大。墙钟时间≈定范围 + 最慢一组，任务粒度不为速度让步（见 docs/ideas/020）。
import { AgentRunError } from '../shared/agent-run'
import {
  ESTIMATE_GROUPS, type EstimateEvent, type EstimateGroup, type EstimateGroupKey, type HoursEstimate,
} from '../shared/order-judge-estimate'
import reference from './order-judge-estimate-reference.json'

export type ModelCall = (body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>

interface ScopeTask { group: EstimateGroupKey; title: string; scope: string }

const GROUP_LIST = ESTIMATE_GROUPS.map(g => `- ${g.key}: ${g.en}（${g.name}）`).join('\n')

const outline = (lines: string[]): string => lines.map(l => l.replace(/ = [\d+]+$/, '')).join('\n')
const REFERENCE_OUTLINE = `【样例一：企业官网改版，${reference.business.length} 个任务】\n${outline(reference.business)}\n\n【样例二：电商网站重建，${reference.ecommerce.length} 个任务】\n${outline(reference.ecommerce)}`
const REFERENCE_HOURS = `【样例一：企业官网改版，合计 416 小时】\n${reference.business.join('\n')}\n\n【样例二：电商网站重建，合计 2617 小时】\n${reference.ecommerce.join('\n')}`

const SCOPE_SYSTEM = `你是数字外包公司的资深售前估算师，把客户需求拆成交付级工作分解结构（WBS）。
顶层任务组固定为：
${GROUP_LIST}

规则：
- 按「专业团队完整交付一个可上线的生产级产品」来理解需求：需求里点到的端（iOS / Android / Web / 管理后台 / 服务端）都要做；需求暗示的必需部分（账号体系、后台管理、权限、日志监控、安全、性能与并发）也要列出。
- 例外：需求描述的是一项技术功能而不是一个独立运营的产品时（格式转换、导入导出、双向互通、算法移植、接口对接、脚本、单个模块），只拆这项功能本身：不加用户系统、管理后台、权限、监控，也没有部署上线、上线后支持、项目管理这样的组，需求没要求的端和页面不要补。任何独立运营的网站、App、平台、小程序、会议、钱包都不适用这条，照上一条完整拆。
- 需求里的工期、预算、「几天完工」只说明客户着急，不缩减范围。
- 粒度和拆法照下面两份标准估价样例（「组/小节 | 任务」）：每个页面、功能模块、端、第三方服务各自成任务，不合并成「前端开发」这种大包；任务数随规模变化。
- 需求只有一句话时，按同类成熟产品的常规功能补全范围再拆。
- scope 用一句话写清这个任务具体包含什么。任务标题用中文。

${REFERENCE_OUTLINE}

只输出 JSON：{"tasks":[{"group":"development","title":"…","scope":"…"}]}`

const ESTIMATE_SYSTEM = `你是数字外包公司的资深估算师，给 WBS 里指定任务组的每个任务估工时（小时）。
口径照下面两份标准估价样例：「= 」后面是这个任务各参与角色的工时，任务工时是它们之和。
- 角色只用这张费率卡：客户经理、项目经理、业务 / 数据分析、设计、前端、后端、运维、内容、测试、全栈、SEO、文案（移动端 App 由前端承担）。
- 每个任务列出所有会花时间的角色，各估一个数：开发类任务通常同时有项目经理、分析、设计、前端、后端、运维、测试的份；需求有几个端，前端的份按端数加量。
- 单个角色的工时取 1、2、4、6、8、12、16、24、32、40 之一，与样例同一量级：同等复杂度的任务给出和样例相近的数。
- 只估用户指定那一组的任务，别的组只作上下文。

${REFERENCE_HOURS}

只输出 JSON：{"tasks":[{"i":任务编号,"roles":[{"r":"后端","h":数}]}]}`

function contentOf(raw: unknown): string | null {
  const choices = (raw && typeof raw === 'object' ? (raw as { choices?: unknown }).choices : null)
  const first = Array.isArray(choices) ? choices[0] as { message?: { content?: unknown } } | undefined : undefined
  const content = first?.message?.content
  return typeof content === 'string' && content.trim() ? content : null
}

// JSON 模式偶尔返回空内容，最多试 3 次；HTTP 错误不重试（与评估一致）
async function askJson(call: ModelCall, model: string, system: string, user: string, images: string[], maxTokens: number, signal: AbortSignal, tag: string): Promise<unknown> {
  const body = {
    model,
    temperature: 0.2,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    ...(model.startsWith('deepseek-') ? { thinking: { type: 'disabled' } } : {}),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: images.length ? [{ type: 'text', text: user }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))] : user },
    ],
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const content = contentOf(await call(body, signal))
    if (!content) {
      console.info(`[order-judge:estimate] ${tag} 第 ${attempt} 次返回空内容`)
      continue
    }
    try {
      return JSON.parse(content)
    } catch (e) {
      console.error(`[order-judge:estimate] ${tag} 不是 JSON: ${content.slice(0, 200)}`, e)
      throw new AgentRunError('BAD_RESPONSE', 503)
    }
  }
  throw new AgentRunError('EMPTY_RESPONSE', 503)
}

const GROUP_KEYS = new Set<string>(ESTIMATE_GROUPS.map(g => g.key))

function parseScope(raw: unknown): ScopeTask[] {
  const list = (raw as { tasks?: unknown })?.tasks
  if (!Array.isArray(list)) throw new AgentRunError('BAD_RESPONSE', 503)
  const tasks = list.flatMap((t): ScopeTask[] => {
    const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>
    if (typeof o.group !== 'string' || !GROUP_KEYS.has(o.group) || typeof o.title !== 'string' || !o.title.trim()) return []
    return [{ group: o.group as EstimateGroupKey, title: o.title.trim().slice(0, 120), scope: typeof o.scope === 'string' ? o.scope.slice(0, 300) : '' }]
  })
  if (tasks.length < 10) {
    console.error(`[order-judge:estimate] 范围只拆出 ${tasks.length} 条有效任务`, JSON.stringify(raw).slice(0, 500))
    throw new AgentRunError('BAD_RESPONSE', 503)
  }
  return tasks
}

function roleHours(h: unknown): number | null {
  const n = Number(h)
  return Number.isFinite(n) && n >= 0 && n <= 400 ? n : null
}

export async function estimateHours(
  call: ModelCall, model: string, brief: string, images: string[], signal: AbortSignal, emit: (e: EstimateEvent) => Promise<unknown> | void,
): Promise<HoursEstimate> {
  await emit({ type: 'stage', stage: 'scope' })
  const scope = parseScope(await askJson(call, model, SCOPE_SYSTEM, `客户需求：\n${brief}`, images, 6000, signal, 'scope'))
  await emit({ type: 'scope', tasks: scope.length })

  const catalog = scope.map((t, i) => `${i} [${t.group}] ${t.title}：${t.scope}`).join('\n')
  const groups = await Promise.all(ESTIMATE_GROUPS.map(async (g): Promise<EstimateGroup> => {
    const own = scope.map((t, i) => ({ t, i })).filter(x => x.t.group === g.key)
    if (!own.length) return { key: g.key, name: g.name, hours: 0, tasks: [] }
    const user = `客户需求：\n${brief}\n\n完整 WBS（编号 [组] 标题：范围）：\n${catalog}\n\n请估 ${g.key}（${g.name}）组的任务：${own.map(x => x.i).join(', ')}`
    const raw = await askJson(call, model, ESTIMATE_SYSTEM, user, [], 4000, signal, g.key)
    const byIndex = new Map<number, number>()
    for (const x of ((raw as { tasks?: unknown })?.tasks as unknown[] | undefined) ?? []) {
      const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
      const roles = Array.isArray(o.roles) ? o.roles as Record<string, unknown>[] : []
      const hours = roles.map(r => roleHours(r?.h))
      if (roles.length && hours.every(h => h !== null)) byIndex.set(Number(o.i), (hours as number[]).reduce((a, b) => a + b, 0))
    }
    const missing = own.filter(x => !byIndex.has(x.i))
    if (missing.length) {
      console.error(`[order-judge:estimate] ${g.key} 缺 ${missing.length}/${own.length} 个任务的工时`, JSON.stringify(raw).slice(0, 500))
      throw new AgentRunError('BAD_RESPONSE', 503)
    }
    const tasks = own.map(x => ({ title: x.t.title, hours: Math.round(byIndex.get(x.i)!) }))
    const group = { key: g.key, name: g.name, hours: tasks.reduce((s, t) => s + t.hours, 0), tasks }
    await emit({ type: 'group', group })
    return group
  }))

  const ordered = groups.filter(g => g.tasks.length).sort((a, b) => b.hours - a.hours)
  return { totalHours: ordered.reduce((s, g) => s + g.hours, 0), taskCount: scope.length, groups: ordered }
}
