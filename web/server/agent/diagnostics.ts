// Agent 诊断日志。线上默认静音,dev(或显式 AGENT_DEBUG=1)才打印。
//
// 存在的理由:Agent 的失败几乎全部被「友好文案」吞掉了 —— HTTP 层统一成 429/503 的中文提示,
// 回合层 catch 后只把 code 落库。出问题时终端一片安静,只能靠猜。这里在**吞掉之前**打一行原因。
const on = process.env.AGENT_DEBUG === '1' || (process.env.AGENT_DEBUG !== '0' && process.env.NODE_ENV !== 'production')

export function logAgentIssue(scope: string, detail: Record<string, unknown>, error?: unknown): void {
  if (!on) return
  const cause = error instanceof Error ? `${(error as { code?: string }).code ?? error.name}: ${error.message}` : error === undefined ? '' : String(error)
  const fields = Object.entries(detail).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')
  console.warn(`[agent:${scope}] ${fields}${cause ? ` <- ${cause}` : ''}`)
  // 非 AgentRunError(即真正的意外异常)带上栈,否则一行足够。
  if (error instanceof Error && !(error as { code?: string }).code) console.warn(error.stack)
}

// 每条 Agent 请求一行:用来回答「我什么都没做,它在自己发什么?」
// 只在 dev / AGENT_DEBUG=1 下打印,SSE 与轮询也会出现,这正是要看的东西。
export function logAgentRequest(scope: string, method: string, path: string, uid: number | string): void {
  if (!on) return
  console.log(`[agent:${scope}] -> ${method} ${path} uid=${uid}`)
}
