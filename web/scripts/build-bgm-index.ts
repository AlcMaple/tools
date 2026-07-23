// 生成/重建本地动漫索引 bgm_index.db（追番搜索加番的数据源，见 server/bgm/anime-index.ts）。
//
// 用法：
//   cd web && npm run sync:index                                 下最新档（bangumi/Archive，~400MB zip）重建
//   cd web && npx tsx scripts/build-bgm-index.ts --file a.jsonlines   用本地已解压的 jsonlines（测试用，不下载）
//
// 索引**不在 git 里、也不是 build 产物**，`git pull + npm run build` 不会更新它 —— 生产靠 cron 每周跑本脚本，
// 首次部署也必须手跑一次，否则 /api/search 一直 ready=false。整套线上流程见 docs/web/唐人云部署保姆教程.md。
// 本地跑带 HTTPS_PROXY 走 Clash。依赖系统 `unzip`（流式取压缩包里的 subject 文件，不整包落盘解压）。
//
// **原子替换**：先写 `bgm_index.db.tmp`，成了再 rename 覆盖 —— 搜索端要么读旧库、要么读新库，绝不读半成品。
import '../server/http' // 副作用：EnvHttpProxyAgent，让 fetch 认 HTTPS_PROXY
import Database from 'better-sqlite3'
import { createReadStream, createWriteStream, renameSync, rmSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInterface } from 'node:readline'
import { execFileSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { indexDbPath } from '../server/bgm/anime-index'

const LATEST_JSON = 'https://raw.githubusercontent.com/bangumi/Archive/master/aux/latest.json'

interface Row {
  bgm_id: number
  name: string
  name_cn: string
  aliases: string
  tags: string
  date: string
  score: number
}

// 档里的 infobox 是**原始 wiki 字符串**（跟在线 API 已解析成数组不同），得自己抠「别名」。
// 两种写法都兼容：`|别名= 单值` 或 `|别名={ [别名一] [别名二|注释] }`。抠不到就空（加番时 detail 会补）。
function parseAliasesFromWiki(infobox: unknown): string[] {
  if (typeof infobox !== 'string') return []
  const m = infobox.match(/\|\s*别名\s*=\s*(\{[\s\S]*?\}|[^\n|]*)/)
  if (!m) return []
  const raw = m[1].trim()
  if (raw.startsWith('{')) {
    const items = raw.match(/\[([^\]]+)\]/g) ?? []
    return items.map((s: string) => s.slice(1, -1).split('|')[0].trim()).filter(Boolean)
  }
  return raw ? [raw] : []
}

// tags 档里大概率是 [{name,count}]（跟在线 API 同构），兼容纯字符串数组。按 count 降序取前 10。
function topTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  const named = tags
    .map((t) => {
      if (typeof t === 'string') return { name: t, count: 1 }
      const o = t as { name?: unknown; count?: unknown }
      return { name: typeof o.name === 'string' ? o.name : '', count: Number(o.count) || 0 }
    })
    .filter((t) => t.name)
  named.sort((a, b) => b.count - a.count)
  return named.slice(0, 10).map((t) => t.name)
}

async function buildIndex(lines: AsyncIterable<string>): Promise<void> {
  const tmp = indexDbPath + '.tmp'
  rmSync(tmp, { force: true })
  const db = new Database(tmp)
  db.pragma('journal_mode = OFF') // 一次性批量建，不需要 WAL / 崩溃恢复，关了更快
  db.pragma('synchronous = OFF')
  db.exec(`
    CREATE TABLE anime (
      bgm_id  INTEGER PRIMARY KEY,
      name    TEXT NOT NULL DEFAULT '',
      name_cn TEXT NOT NULL DEFAULT '',
      aliases TEXT NOT NULL DEFAULT '',
      tags    TEXT NOT NULL DEFAULT '[]',
      date    TEXT NOT NULL DEFAULT '',
      score   REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
  `)
  const ins = db.prepare(
    `INSERT OR REPLACE INTO anime (bgm_id,name,name_cn,aliases,tags,date,score) VALUES (?,?,?,?,?,?,?)`
  )
  const flush = db.transaction((batch: Row[]) => {
    for (const r of batch) ins.run(r.bgm_id, r.name, r.name_cn, r.aliases, r.tags, r.date, r.score)
  })

  let n = 0
  let seen = 0
  let batch: Row[] = []
  for await (const line of lines) {
    if (!line) continue
    seen++
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (Number(o.type) !== 2) continue // 只要动画（1漫画 2动画 3音乐 4游戏 6三次元）
    const id = Number(o.id)
    if (!id) continue
    batch.push({
      bgm_id: id,
      name: String(o.name ?? ''),
      name_cn: String(o.name_cn ?? ''),
      aliases: JSON.stringify(parseAliasesFromWiki(o.infobox)),
      tags: JSON.stringify(topTags(o.tags)),
      date: String(o.date ?? ''),
      score: Number(o.score) || 0,
    })
    if (batch.length >= 2000) {
      flush(batch)
      n += batch.length
      batch = []
    }
  }
  if (batch.length) {
    flush(batch)
    n += batch.length
  }
  db.prepare(`INSERT OR REPLACE INTO meta (k,v) VALUES ('built_at', ?)`).run(String(Date.now()))
  db.prepare(`INSERT OR REPLACE INTO meta (k,v) VALUES ('count', ?)`).run(String(n))
  db.close()
  renameSync(tmp, indexDbPath)
  console.log(`扫描 ${seen} 条 → 收录动画 ${n} 条 → ${indexDbPath}`)
}

// ── 下载 + 解压（无 --file 时走这条）────────────────────────────────────────────
async function downloadDump(): Promise<string> {
  const meta = (await (await fetch(LATEST_JSON)).json()) as { browser_download_url?: string; name?: string; size?: number }
  const url = meta.browser_download_url
  if (!url) throw new Error('latest.json 里没有 browser_download_url')
  const zipPath = join(tmpdir(), 'bgm-archive-dump.zip')
  console.log(`下载 ${meta.name}（${((meta.size ?? 0) / 1e6).toFixed(0)}MB）…`)
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error('下载失败：HTTP ' + res.status)
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(zipPath))
  console.log(`已下载 → ${zipPath}（${(statSync(zipPath).size / 1e6).toFixed(0)}MB）`)
  return zipPath
}

function subjectFileInZip(zipPath: string): string {
  const list = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\n')
  const f = list.find((x) => /subject.*\.jsonlines$/i.test(x.trim()))
  if (!f) throw new Error('压缩包里找不到 subject*.jsonlines，实际文件：' + list.filter(Boolean).join(', '))
  return f.trim()
}

function unzipLines(zipPath: string, inner: string): AsyncIterable<string> {
  // unzip -p：把压缩包里指定文件的内容直接吐到 stdout（流式，不落盘），逐行喂给解析
  const child = spawn('unzip', ['-p', zipPath, inner])
  child.stderr.on('data', () => { /* 忽略 unzip 的提示噪音 */ })
  child.on('error', (e) => { throw e })
  return createInterface({ input: child.stdout, crlfDelay: Infinity })
}

async function main(): Promise<void> {
  const i = process.argv.indexOf('--file')
  if (i >= 0 && process.argv[i + 1]) {
    const path = process.argv[i + 1]
    console.log(`用本地文件 ${path}（跳过下载）`)
    await buildIndex(createInterface({ input: createReadStream(path), crlfDelay: Infinity }))
    return
  }
  const zip = await downloadDump()
  const inner = subjectFileInZip(zip)
  console.log(`解压取 ${inner}`)
  await buildIndex(unzipLines(zip, inner))
  rmSync(zip, { force: true })
}

main().catch((e) => {
  console.error('构建索引失败：', e)
  process.exit(1)
})
