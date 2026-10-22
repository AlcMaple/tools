// 拉 RadQuote 首页公开示例的完整 WBS，生成估价提示词用的参考样例 server/order-judge-estimate-reference.json。
// 示例走它 playground 的模版接口（秒开，不触发 AI 生成），再用前端同款公开接口取任务树。
// 用法：npx tsx scripts/sync-estimate-reference.ts
import { writeFileSync } from 'node:fs'
import '../server/http'

const API = 'https://api.radquote.io'
interface Node { title: string; estimates?: { estimate: number }[]; subTasks?: Node[]; tasks?: Node[]; subGroups?: Node[] }

async function tree(template: string): Promise<string[]> {
  const res = await fetch(`${API}/v1/playground/estimate`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://radquote.io' }, body: JSON.stringify({ template_id: template }) })
  if (!res.ok) throw new Error(`${template} 模版 HTTP ${res.status}`)
  const { quote_id: quoteId } = await res.json() as { quote_id: string }
  const t = await fetch(`${API}/v1/task/tree?filter.quoteId.eq=${encodeURIComponent(quoteId)}`)
  if (!t.ok) throw new Error(`${template} 任务树 HTTP ${t.status}`)
  const lines: string[] = []
  const task = (n: Node, path: string): void => {
    if (n.subTasks?.length) return n.subTasks.forEach(s => task(s, path))
    lines.push(`${path} | ${n.title} = ${(n.estimates ?? []).map(e => e.estimate).join('+')}`)
  }
  const group = (g: Node, path: string): void => {
    const here = path ? `${path}/${g.title}` : g.title
    g.tasks?.forEach(x => task(x, here))
    g.subGroups?.forEach(s => group(s, here))
  }
  ;((await t.json()) as { groups: Node[] }).groups.forEach(g => group(g, ''))
  return lines
}

const out = { fetchedAt: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }), business: await tree('business'), ecommerce: await tree('ecommerce') }
writeFileSync(new URL('../server/order-judge-estimate-reference.json', import.meta.url), JSON.stringify(out, null, 1) + '\n')
console.log(`business ${out.business.length} 条，ecommerce ${out.ecommerce.length} 条`)
