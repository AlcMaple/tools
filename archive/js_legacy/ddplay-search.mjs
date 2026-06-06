#!/usr/bin/env node
// 弹弹play 搜索接口探针 —— 评估「能不能平替 BGM 的搜索动漫列表」。
//
// 目的：跑 `光之美少女` 这类关键词，看返回的【番剧名称 + 播出日期】(以及评分/
// 类型/集数/封面/ID)和 BGM 的搜索结果差多少，判断弹弹play 当主源够不够。
//
// 为什么是弹弹play：国产、国内直连、每条番自带稳定 animeId(可当替代 BGM 的主键)，
// 搜索/周期表/详情/封面一站覆盖《替代BGM-需要的信息清单》大部分字段。嗷呜等是
// 播放/资源站(目录有限、无评分/题材/正经放送日期)，当不了元数据替身，故不选。
//
// ── 鉴权(必须)─────────────────────────────────────────────────────────────
// 新版弹弹play API 强制签名，裸调直接 403(X-Error-Message: Missing Authentication
// Headers)。需先在 https://dev.dandanplay.com 注册一个免费应用拿 AppId/AppSecret，
// 然后用环境变量传进来：
//
//   DANDANPLAY_APP_ID=xxx DANDANPLAY_APP_SECRET=yyy node archive/js_legacy/ddplay-search.mjs 光之美少女
//
// 签名算法(官方)：X-Signature = Base64( SHA256( AppId + Timestamp + Path + AppSecret ) )
//   - Timestamp：当前 Unix 秒
//   - Path：不含域名和查询串的 API 路径，如 /api/v2/search/anime
//
// 这是 archive 下的独立探针脚本，不属于 Electron app、不走 netRequest，直接用
// Node 原生 fetch。

import crypto from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// 从脚本同目录的 .env 读凭据(已被 .gitignore 忽略，不入库)，省得每次手敲。
// 命令行里显式传的环境变量优先级更高(已存在就不覆盖)。
const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

const APP_ID = process.env.DANDANPLAY_APP_ID
const APP_SECRET = process.env.DANDANPLAY_APP_SECRET
const keyword = process.argv[2] || '光之美少女'

if (!APP_ID || !APP_SECRET) {
  console.error(`
缺少弹弹play 凭据。请先到 https://dev.dandanplay.com 注册免费应用，拿到 AppId/AppSecret 后：

  DANDANPLAY_APP_ID=你的ID DANDANPLAY_APP_SECRET=你的密钥 node archive/js_legacy/ddplay-search.mjs "${keyword}"
`)
  process.exit(1)
}

const HOST = 'https://api.dandanplay.net'
const PATH = '/api/v2/search/anime'

// 按官方算法生成签名头
function authHeaders(path) {
  const ts = Math.floor(Date.now() / 1000)
  const sig = crypto
    .createHash('sha256')
    .update(APP_ID + ts + path + APP_SECRET)
    .digest('base64')
  return {
    'X-AppId': APP_ID,
    'X-Timestamp': String(ts),
    'X-Signature': sig,
    Accept: 'application/json',
    'User-Agent': 'MapleTools-Probe/0.1',
  }
}

// ISO datetime → YYYY-MM-DD(只取日期，对齐 BGM 列表的播出日期展示)
function fmtDate(s) {
  if (!s) return '—'
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : String(s)
}

async function main() {
  const url = `${HOST}${PATH}?keyword=${encodeURIComponent(keyword)}`
  const res = await fetch(url, { headers: authHeaders(PATH) })

  if (!res.ok) {
    console.error(`HTTP ${res.status} ${res.statusText}`)
    console.error('X-Error-Message:', res.headers.get('x-error-message') || '(无)')
    const body = await res.text().catch(() => '')
    if (body) console.error('body:', body.slice(0, 300))
    process.exit(1)
  }

  const data = await res.json()
  if (data.errorCode) {
    console.error(`接口报错 errorCode=${data.errorCode}: ${data.errorMessage}`)
    process.exit(1)
  }

  const animes = data.animes || []
  console.log(`\n关键词「${keyword}」→ ${animes.length} 条结果（hasMore=${data.hasMore}）\n`)

  // 列表：番名 + 播出日期(用户关注的核心两项) + 评分/类型/集数/ID
  for (const a of animes) {
    const title = a.animeTitle ?? '(无名)'
    const date = fmtDate(a.startDate)
    const rating = a.rating ? `★${a.rating}` : ''
    const type = a.typeDescription || a.type || ''
    const eps = a.episodeCount ? `${a.episodeCount}话` : ''
    console.log(`${date}  ${title}  ${[rating, type, eps].filter(Boolean).join(' · ')}  #${a.animeId}`)
  }

  // 把第一条的全部字段原样打出来 —— 看清搜索列表到底能给到清单里的哪些字段
  // (名称/日期/封面/评分/类型/集数有没有，别名/简介/题材/staff 是不是得另调详情)。
  if (animes[0]) {
    console.log('\n── 首条原始字段(看清单覆盖) ──')
    console.log(JSON.stringify(animes[0], null, 2))
  }
}

main().catch((e) => {
  console.error('运行失败:', e.message)
  process.exit(1)
})
