#!/usr/bin/env node
/**
 * diagnose-network.mjs —— 排查「应用连不上 / 冷启动超时，但浏览器正常」。
 *
 * 用法：
 *   node scripts/diagnose-network.mjs
 *
 * 它对 BGM / 萌娘的几个域名分别做：
 *   1. DNS 解析：列出 A（IPv4）和 AAAA（IPv6）记录 + 解析耗时
 *   2. 三种连法各试一次，记录成功/失败 + 耗时：
 *        - family=4  强制 IPv4
 *        - family=6  强制 IPv6
 *        - auto      autoSelectFamily（IPv4/IPv6 赛跑，Chromium 默认就是这个）
 *   3. 系统代理（macOS scutil --proxy + 环境变量）
 *
 * 读到响应头就立刻断开，不下载 body —— 对 api.bgm.tv 只是轻量探一下连通性，
 * 不刷数据、不重试、一次性，不会加重限流。
 *
 * 怎么看结果：
 *   - IPv6 那列超时/失败，但 IPv4 + auto 成功  → IPv6 路由坏，开 autoSelectFamily 即可
 *   - 三种都成功但耗时很久（>8s）            → 纯粹是慢，调长超时 / 加重试
 *   - 三种都失败但浏览器能开 + 系统有代理     → app 没走代理，得换 Electron net 走系统代理
 *   - DNS 都解析不出来                        → DNS 问题（换 DNS / 走代理）
 */
import https from 'node:https'
import dns from 'node:dns/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const HOSTS = [
  { host: 'api.bgm.tv', path: '/v0/subjects/1', note: 'BGM API（详情/周历/别名，最常超时的就是它）' },
  { host: 'bgm.tv', path: '/', note: 'BGM 主站（HTML 搜索）' },
  { host: 'lain.bgm.tv', path: '/', note: 'BGM 图片 CDN（封面）' },
  { host: 'mzh.moegirl.org.cn', path: '/', note: '萌娘百科（简介兜底）' },
]

const UA = 'MapleTools-Diagnostic/1.0 (https://github.com/AlcMaple/tools)'
const PER_ATTEMPT_TIMEOUT = 12000

function ms(start) {
  return `${Date.now() - start}ms`
}

/** 一次连接尝试。读到响应头就 destroy，不下 body。 */
function attempt(host, path, opts) {
  const start = Date.now()
  return new Promise((resolve) => {
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      resolve({ ...result, elapsed: ms(start) })
    }
    const req = https.get(
      {
        host,
        path,
        headers: { 'User-Agent': UA, Accept: '*/*' },
        timeout: PER_ATTEMPT_TIMEOUT,
        ...opts,
      },
      (res) => {
        const ip = res.socket.remoteAddress
        const fam = res.socket.remoteFamily
        res.destroy() // 不下载 body
        done({ ok: true, status: res.statusCode, ip, fam })
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error(`timeout(${PER_ATTEMPT_TIMEOUT}ms)`))
    })
    req.on('error', (e) => {
      done({ ok: false, code: e.code || '', msg: e.message })
    })
  })
}

function fmt(r) {
  if (r.ok) return `✅ ${r.status}  ${r.elapsed}  (${r.fam} ${r.ip})`
  return `❌ ${r.code || r.msg}  ${r.elapsed}`
}

async function resolveDns(host) {
  const out = { v4: [], v6: [], v4err: null, v6err: null, v4ms: '', v6ms: '' }
  let s = Date.now()
  try { out.v4 = await dns.resolve4(host) } catch (e) { out.v4err = e.code || e.message }
  out.v4ms = ms(s)
  s = Date.now()
  try { out.v6 = await dns.resolve6(host) } catch (e) { out.v6err = e.code || e.message }
  out.v6ms = ms(s)
  return out
}

async function systemProxy() {
  const env = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
    .map((k) => (process.env[k] ? `${k}=${process.env[k]}` : null))
    .filter(Boolean)
  let scutil = ''
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileP('scutil', ['--proxy'])
      const enabled = stdout
        .split('\n')
        .filter((l) => /Enabled\s*:\s*1|HTTPSProxy|HTTPProxy|ProxyAutoConfigURLString/.test(l))
        .map((l) => l.trim())
      scutil = enabled.length ? enabled.join('\n   ') : '(系统未开 HTTP/HTTPS 代理)'
    } catch { scutil = '(读不到 scutil)' }
  }
  return { env, scutil }
}

async function main() {
  console.log('═'.repeat(64))
  console.log(' 网络诊断 —— 应用连不上 / 冷启动超时')
  console.log(` Node ${process.version}  platform=${process.platform}`)
  console.log('═'.repeat(64))

  console.log('\n【系统代理】')
  const proxy = await systemProxy()
  console.log('  环境变量代理:', proxy.env.length ? proxy.env.join('  ') : '(无)')
  if (proxy.scutil) console.log('  macOS 系统代理:', proxy.scutil.includes('\n') ? '\n   ' + proxy.scutil : proxy.scutil)

  for (const { host, path, note } of HOSTS) {
    console.log('\n' + '─'.repeat(64))
    console.log(`■ ${host}   ${note}`)

    const d = await resolveDns(host)
    console.log(`  DNS A(IPv4):  ${d.v4err ? '❌ ' + d.v4err : d.v4.join(', ')}  (${d.v4ms})`)
    console.log(`  DNS AAAA(v6): ${d.v6err ? '— ' + d.v6err : (d.v6.length ? '⚠ ' + d.v6.join(', ') : '(无 IPv6 记录)')}  (${d.v6ms})`)

    const v4 = await attempt(host, path, { family: 4 })
    console.log(`  强制 IPv4:    ${fmt(v4)}`)

    if (d.v6.length) {
      const v6 = await attempt(host, path, { family: 6 })
      console.log(`  强制 IPv6:    ${fmt(v6)}`)
    } else {
      console.log('  强制 IPv6:    (跳过，无 AAAA 记录)')
    }

    const auto = await attempt(host, path, { autoSelectFamily: true })
    console.log(`  自动赛跑:     ${fmt(auto)}`)

    // 显式关掉 autoSelectFamily，模拟「旧 Electron 默认不赛跑」的行为 ——
    // 这一行最接近你 app 实际可能踩的坑（系统 node 新版默认已开，会掩盖问题）。
    const noAuto = await attempt(host, path, { autoSelectFamily: false })
    console.log(`  关掉赛跑:     ${fmt(noAuto)}  ← 最接近 app 实际行为`)
  }

  console.log('\n' + '═'.repeat(64))
  console.log(' 读法：')
  console.log('  · IPv6❌ 但 IPv4✅/自动✅ → IPv6 路由坏，开 autoSelectFamily 就好')
  console.log('  · Node默认❌ 但 自动✅     → 默认挑了坏的 IPv6，同样开 autoSelectFamily')
  console.log('  · 全❌ + 浏览器能开 + 有代理 → app 没走系统代理，需换 Electron net')
  console.log('  · 全✅ 但都很慢(>8s)        → 纯慢，调长超时 / 加传输层重试')
  console.log('═'.repeat(64))
}

main().catch((e) => { console.error('诊断脚本自身出错:', e); process.exit(1) })
