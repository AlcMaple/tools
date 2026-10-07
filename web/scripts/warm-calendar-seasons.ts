// 往期周历预热 —— 部署后跑一次，把 2013 年起还没翻过的季度一次翻完，用户就不用逢季度第一次点开都等十秒。
//   npm run warm:seasons                 # 默认节奏，约 20～30 分钟
//   npm run warm:seasons -- --limit 5    # 只翻最新的 5 个，试试水
//   npm run warm:seasons -- --dry-run    # 只列出会翻哪些季度，不发请求
//   npm run warm:seasons -- --page-gap 3000 --season-gap 15000   # 更慢更稳（毫秒）
//
// 宁可慢也不要被 BGM 限流：串行；页与页、季与季之间都停一会儿（带随机抖动）；
// 任何一次失败（429 / 403 / 5xx / 超时）立刻整体停下，不重试、不跳过继续打 ——
// 限流窗口里再发请求只会加重。已翻好的季度落盘即永久有效，稍后重跑会从没翻过的季度接着来。
// 数据目录跟服务一致（DATA_DIR），在服务器上跑就写进线上那份；服务在跑也没关系，落盘是原子的。
import { proxyReady } from '../server/http'
import { deriveSeason, listSeasons } from '../server/bgm/calendar-history'

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(name)
  const n = i >= 0 ? Number(process.argv[i + 1]) : NaN
  return Number.isFinite(n) && n >= 0 ? n : fallback
}
const PAGE_GAP_MS = arg('--page-gap', 2500)
const SEASON_GAP_MS = arg('--season-gap', 10_000)
const LIMIT = arg('--limit', Infinity)
const DRY_RUN = process.argv.includes('--dry-run')

// 基准值上下浮动 30%，别让请求踩着固定节拍
const jitter = (ms: number): number => Math.round(ms * (0.85 + Math.random() * 0.3))
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function main(): Promise<void> {
  const pending = listSeasons().filter((s) => s.count === null && !s.current).slice(0, LIMIT)
  if (!pending.length) {
    console.log('所有往期季度都已经翻好了，没有要做的。')
    return
  }
  // 每季约 3 页，每页自己也要几秒
  const estimateMin = Math.ceil((pending.length * (3 * (PAGE_GAP_MS + 3000) + SEASON_GAP_MS)) / 60_000)
  console.log(`还有 ${pending.length} 个季度没翻（${pending[0].key} → ${pending[pending.length - 1].key}），预计 ${estimateMin} 分钟。`)
  if (DRY_RUN) {
    console.log(pending.map((s) => s.key).join(' '))
    return
  }

  await proxyReady
  let done = 0
  for (const season of pending) {
    const startedAt = Date.now()
    try {
      const snapshot = await deriveSeason(season.key, { pageGapMs: jitter(PAGE_GAP_MS) })
      const count = snapshot.data.reduce((n, d) => n + d.items.length, 0)
      done++
      console.log(`[${done}/${pending.length}] ${season.key}：${count} 部（${Math.round((Date.now() - startedAt) / 1000)} 秒）`)
    } catch (error) {
      console.error(`\n翻 ${season.key} 失败：${error instanceof Error ? error.message : String(error)}`)
      console.error(`已翻好 ${done} 个。为避免加重限流，现在停下；过一阵（限流一般几分钟到几小时）再重跑，会从没翻过的季度接着来。`)
      process.exitCode = 1
      return
    }
    if (done < pending.length) await sleep(jitter(SEASON_GAP_MS))
  }
  console.log(`\n全部翻完，共 ${done} 个季度。`)
}

void main()
