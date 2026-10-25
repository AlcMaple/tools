// 估价小时对照：同一份需求和 RadQuote 的结果比总小时、开发小时（口径见 docs/ideas/020）。
// 直连 .env.local 的服务器 AI，每单跑 RUNS 次看自身波动。用法：npx tsx scripts/bench-order-judge-estimate.ts [RUNS]
import { execFileSync } from 'node:child_process'
import '../server/http'
import { estimateHours } from '../server/order-judge-estimate'

process.loadEnvFile('.env.local')
const BASE = process.env.AI_BASE_URL?.trim() || 'https://api.deepseek.com'
const MODEL = process.env.AI_MODEL?.trim() || 'deepseek-flash'
const KEY = process.env.AI_API_KEY
if (!KEY) throw new Error('.env.local 没有 AI_API_KEY')
const RUNS = Number(process.argv.find(a => /^\d+$/.test(a)) ?? 3)

// RadQuote 结果：同一份需求跑过多次的都列出，取平均比较
const CASES: { name: string; brief: string; radquote: { total: number; dev: number }[] }[] = [
  { name: '语音会议', brief: '仿 elive.one 做网页版语音会议：创建/加入会议、固定会议号、会议记录、评论可开关、连麦语音、屏幕共享、无广告横幅，7 天内完工，能承载 300 人每天两小时', radquote: [{ total: 1350, dev: 650 }] },
  { name: '多链钱包', brief: '仿 TokenPocket 做一个多链数字货币钱包 App，支持 BTC、ETH、TRON、BSC、Solana 等链的资产管理与转账，苹果和安卓双端都要', radquote: [{ total: 1920, dev: 880 }, { total: 2007, dev: 782 }] },
  // 以下两单的输入是评估结论里的「需求」那一句（用户原样贴给 RadQuote 的），不是评估时的完整材料
  { name: 'Visio 泳道图互转', brief: '客户希望实现 Flowable 在线流程设计器（bpmn-js）与 Visio 泳道流程图的双向互通：Visio 做的泳道图能导入 Flowable，Flowable 做的能导出为 Visio 可打开的格式，并要一个工作量预估范围。', radquote: [{ total: 589, dev: 254 }] },
  { name: '智慧净水物联网', brief: '做智慧净水物联网平台及微信小程序：设备管理、Modbus RTU 与 MQTT/EMQX 接入、实时监控、告警、耗材与取水管理、历史数据、远程控制，配 Vue 管理后台、MySQL、REST/WebSocket 接口，Linux/Docker 部署并现场联调上线。', radquote: [{ total: 2097, dev: 1060 }] },
  { name: 'Maxwell 改写', brief: '把 MATLAB 电机优化算法改写为 Python，用 PyAEDT 驱动 Maxwell2D 对 13 个转子变量做 JBA 优化，要求运行不报错、转子结果正确、平均转矩尽量大且脉动尽量小，并导出收敛曲线与迭代 CSV', radquote: [{ total: 981, dev: 798 }] },
]

// 校准集：RadQuote 公开示例，输入现场下载（不进仓库）；提示词按它调，上面两单只做检验
const playground = async (file: string): Promise<string> => {
  const res = await fetch(`https://radquote.io/playground/${file}`)
  if (!res.ok) throw new Error(`${file} HTTP ${res.status}`)
  if (!file.endsWith('.pdf')) return res.text()
  return execFileSync('pdftotext', ['-', '-'], { input: Buffer.from(await res.arrayBuffer()) }).toString()
}
if (process.argv.includes('--calibrate')) {
  CASES.length = 0
  CASES.push(
    { name: '企业官网（校准）', brief: await playground('sitemap.xml'), radquote: [{ total: 416, dev: 0 }] },
    { name: '电商（校准）', brief: await playground('ecommerce-spec.pdf'), radquote: [{ total: 2617, dev: 0 }] },
  )
}

const call = async (body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
  const res = await fetch(`${BASE}/chat/completions`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

const pct = (a: number, b: number) => `${a >= b ? '+' : ''}${((a - b) / b * 100).toFixed(1)}%`
const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length

for (const c of CASES) {
  const ref = { total: avg(c.radquote.map(r => r.total)), dev: avg(c.radquote.map(r => r.dev)) }
  console.log(`\n== ${c.name}  RadQuote 总 ${ref.total} 开发 ${ref.dev}`)
  for (let i = 1; i <= RUNS; i++) {
    const started = Date.now()
    const e = await estimateHours(call, MODEL, c.brief, [], AbortSignal.timeout(120_000), () => {})
    const dev = e.groups.find(g => g.key === 'development')?.hours ?? 0
    console.log(`#${i} ${((Date.now() - started) / 1000).toFixed(1)}s  总 ${e.totalHours} (${pct(e.totalHours, ref.total)})  开发 ${dev}${ref.dev ? ` (${pct(dev, ref.dev)})` : ''}  ${e.taskCount} 任务  | ${e.groups.map(g => `${g.name} ${g.hours}`).join(' / ')}`)
  }
}
