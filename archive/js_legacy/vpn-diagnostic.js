#!/usr/bin/env node
/**
 * flclash / VPN 网络诊断工具 v2
 *
 * 用法:
 *   node vpn-diagnostic.js           # 默认：单次诊断（推荐，按需运行）
 *   node vpn-diagnostic.js --watch=5 # 可选：每 5 分钟跑一次
 *
 * 关于 flclash 外部控制器:
 *   在 flclash → 工具 → 基本配置 → 最底下的「外部控制器」开关打开即可
 *   默认端口 9090，对应 CONFIG.controllerPort。开启后 Phase 4 才能跑。
 */

const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ============ 配置区 ============
const CONFIG = {
  proxyHost: '127.0.0.1',
  httpProxyPort: 7890,                  // flclash mixed-port

  controllerHost: '127.0.0.1',
  controllerPort: 9090,                 // 没开外部控制器留空也行
  controllerSecret: '',

  domesticTargets: [
    { name: '百度',     url: 'https://www.baidu.com' },
    { name: '腾讯',     url: 'https://www.qq.com' },
  ],
  // 境内能直连的境外站（不需 VPN），用来判断公司国际出口本身行不行
  foreignDirectTargets: [
    { name: 'Apple',      url: 'https://www.apple.com' },
    { name: 'Cloudflare', url: 'https://www.cloudflare.com' },
  ],
  // 必须 VPN 才通的境外站
  foreignViaProxyTargets: [
    { name: 'Google',  url: 'https://www.google.com' },
    { name: 'GitHub',  url: 'https://github.com' },
    { name: 'gstatic', url: 'http://www.gstatic.com/generate_204' },
  ],
  // 当前节点稳定性测试：用同一个轻量目标重复请求
  stabilityTarget: 'http://www.gstatic.com/generate_204',
  stabilityRounds: 6,

  timeout: 10000,
  slowDelayThreshold: 1000,      // 节点延迟告警阈值（ms）
  unstableJitterRatio: 0.6,      // 抖动 / 平均 > 此值 视为不稳
  maxNodesToTest: 30,

  // 主流地区识别规则 — 只要节点名命中这些模式就算「主流核心地区」
  // 用于识别「订阅源失效」特征：主流地区全挂 + 冷门地区幸存
  popularRegionPatterns: [
    /香港|🇭🇰|\bhk\b|hong\s*kong/i,
    /台湾|台灣|🇹🇼|\btw\b|taiwan/i,
    /日本|🇯🇵|\bjp\b|japan|东京|大阪/i,
    /美国|🇺🇸|\bus\b|usa|america|united\s*states|洛杉矶|硅谷|纽约/i,
    /新加坡|🇸🇬|\bsg\b|singapore/i,
  ],

  logDir: './vpn-logs',
};

// ============ 工具 ============
const c = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m',
  magenta: '\x1b[35m', gray: '\x1b[90m', bold: '\x1b[1m',
};

let logStream = null;
function initLog() {
  try {
    if (!fs.existsSync(CONFIG.logDir)) fs.mkdirSync(CONFIG.logDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    logStream = fs.createWriteStream(path.join(CONFIG.logDir, `vpn-${day}.log`), { flags: 'a' });
  } catch (e) { console.error('日志文件无法创建:', e.message); }
}
function log(level, category, msg) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  const colorMap = { OK: c.green, WARN: c.yellow, ERR: c.red, INFO: c.cyan, HINT: c.magenta };
  console.log(`${c.gray}[${ts}]${c.reset} ${colorMap[level] || ''}[${level}]${c.reset} ${c.bold}[${category}]${c.reset} ${msg}`);
  if (logStream) logStream.write(`[${ts}] [${level}] [${category}] ${msg}\n`);
}

function checkPort(host, port, timeout = 2000) {
  return new Promise(resolve => {
    const sock = new net.Socket(); let done = false;
    const fin = ok => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(timeout);
    sock.once('connect', () => fin(true));
    sock.once('timeout', () => fin(false));
    sock.once('error', () => fin(false));
    sock.connect(port, host);
  });
}

function directRequest(targetUrl, timeout = CONFIG.timeout) {
  return new Promise(resolve => {
    const start = Date.now();
    let u; try { u = new URL(targetUrl); } catch { return resolve({ ok: false, error: 'BAD_URL', elapsed: 0 }); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search || '/', method: 'HEAD', timeout,
    }, res => { res.resume(); resolve({ ok: true, status: res.statusCode, elapsed: Date.now() - start }); });
    req.on('error', err => resolve({ ok: false, error: err.code || err.message, elapsed: Date.now() - start }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT', elapsed: Date.now() - start }); });
    req.end();
  });
}

function proxyRequest(targetUrl, proxyHost, proxyPort, timeout = CONFIG.timeout) {
  return new Promise(resolve => {
    const start = Date.now();
    let u; try { u = new URL(targetUrl); } catch { return resolve({ ok: false, error: 'BAD_URL', elapsed: 0 }); }
    const targetPort = u.port || (u.protocol === 'https:' ? 443 : 80);
    if (u.protocol === 'https:') {
      const sock = net.connect(proxyPort, proxyHost);
      let buf = '';
      const timer = setTimeout(() => { sock.destroy(); resolve({ ok: false, error: 'TIMEOUT', elapsed: Date.now() - start }); }, timeout);
      sock.on('connect', () => sock.write(`CONNECT ${u.hostname}:${targetPort} HTTP/1.1\r\nHost: ${u.hostname}:${targetPort}\r\n\r\n`));
      sock.on('data', chunk => {
        buf += chunk.toString('utf8');
        if (buf.includes('\r\n\r\n')) {
          clearTimeout(timer);
          const elapsed = Date.now() - start;
          const m = buf.match(/^HTTP\/1\.\d\s+(\d+)/);
          sock.destroy();
          resolve(m && m[1] === '200' ? { ok: true, status: 200, elapsed } : { ok: false, error: `代理返回 ${m ? m[1] : '未知'}`, elapsed });
        }
      });
      sock.on('error', err => { clearTimeout(timer); resolve({ ok: false, error: err.code || err.message, elapsed: Date.now() - start }); });
    } else {
      const req = http.request({
        host: proxyHost, port: proxyPort, method: 'HEAD', path: targetUrl,
        headers: { Host: u.hostname }, timeout,
      }, res => { res.resume(); resolve({ ok: true, status: res.statusCode, elapsed: Date.now() - start }); });
      req.on('error', err => resolve({ ok: false, error: err.code || err.message, elapsed: Date.now() - start }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT', elapsed: Date.now() - start }); });
      req.end();
    }
  });
}

function clashApi(apiPath) {
  return new Promise(resolve => {
    const opts = {
      host: CONFIG.controllerHost, port: CONFIG.controllerPort,
      path: apiPath, method: 'GET', headers: {}, timeout: 8000,
    };
    if (CONFIG.controllerSecret) opts.headers.Authorization = `Bearer ${CONFIG.controllerSecret}`;
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ ok: true, status: res.statusCode, data: data ? JSON.parse(data) : null }); }
        catch { resolve({ ok: true, status: res.statusCode, data }); }
      });
    });
    req.on('error', err => resolve({ ok: false, error: err.code || err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT' }); });
    req.end();
  });
}

// ============ 阶段 ============

// Phase 1: flclash 本地服务
async function phase1_localService() {
  log('INFO', 'Phase 1', '═══ 检查 flclash 本地服务 ═══');
  const r = { healthy: true, controllerOk: false };
  if (await checkPort(CONFIG.proxyHost, CONFIG.httpProxyPort)) {
    log('OK', 'flclash', `HTTP 代理端口 ${CONFIG.httpProxyPort} 可连接`);
  } else {
    log('ERR', 'flclash', `HTTP 代理端口 ${CONFIG.httpProxyPort} 不通 → flclash 没运行 / 端口配错了`);
    r.healthy = false; return r;
  }
  if (await checkPort(CONFIG.controllerHost, CONFIG.controllerPort)) {
    const ver = await clashApi('/version');
    if (ver.ok) { log('OK', 'flclash', `控制器 API 正常: ${JSON.stringify(ver.data)}`); r.controllerOk = true; }
    else log('WARN', 'flclash', `控制器端口开但 API 无响应: ${ver.error}`);
  } else {
    log('HINT', 'flclash', `控制器端口 ${CONFIG.controllerPort} 不通 — 节点池详细诊断会跳过（脚本顶部注释说明了怎么开启）`);
  }
  return r;
}

// Phase 2: 公司基础网络
async function phase2_baseNetwork() {
  log('INFO', 'Phase 2', '═══ 检查公司基础网络（不走代理）═══');
  const r = { healthy: true, dnsOk: true, domesticOk: true, foreignDirectOk: true, foreignDirectSlow: false };
  try {
    const ips = await Promise.race([dns.resolve4('www.baidu.com'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('DNS 超时')), 3000))]);
    log('OK', 'DNS', `DNS 解析正常: www.baidu.com → ${ips.slice(0, 2).join(', ')}`);
  } catch (e) { log('ERR', 'DNS', `DNS 解析失败: ${e.message}`); r.dnsOk = false; r.healthy = false; }

  for (const t of CONFIG.domesticTargets) {
    const x = await directRequest(t.url, 5000);
    if (x.ok) log('OK', '境内直连', `${t.name} ${x.elapsed}ms`);
    else { log('ERR', '境内直连', `${t.name} 失败: ${x.error}`); r.domesticOk = false; r.healthy = false; }
  }

  let fail = 0, slow = 0;
  for (const t of CONFIG.foreignDirectTargets) {
    const x = await directRequest(t.url, 8000);
    if (x.ok) {
      const isSlow = x.elapsed > 3000;
      log(isSlow ? 'WARN' : 'OK', '境外直连', `${t.name} ${x.elapsed}ms${isSlow ? ' (慢)' : ''}`);
      if (isSlow) slow++;
    } else { log('WARN', '境外直连', `${t.name} 失败: ${x.error}`); fail++; }
  }
  if (fail === CONFIG.foreignDirectTargets.length) { r.foreignDirectOk = false;
    log('WARN', '境外直连', '所有境外站直连都不通 → 公司国际出口可能全断了'); }
  else if (slow + fail > 0) { r.foreignDirectSlow = true;
    log('HINT', '境外直连', '境外直连出现慢/超时 → 公司国际出口本身就在拥塞'); }
  return r;
}

// Phase 3a: 经代理的多目标穿透（看「能不能用」）
async function phase3a_proxyConnectivity() {
  log('INFO', 'Phase 3a', '═══ 经代理穿透到不同境外目标 ═══');
  const r = { healthy: true, results: [] };
  let ok = 0, slow = 0, fail = 0;
  for (const t of CONFIG.foreignViaProxyTargets) {
    const x = await proxyRequest(t.url, CONFIG.proxyHost, CONFIG.httpProxyPort, CONFIG.timeout);
    r.results.push({ target: t.name, ...x });
    if (x.ok) {
      if (x.elapsed > 3000) { log('WARN', '代理穿透', `${t.name} ${x.elapsed}ms (慢)`); slow++; }
      else { log('OK', '代理穿透', `${t.name} ${x.elapsed}ms`); ok++; }
    } else { log('ERR', '代理穿透', `${t.name} 失败: ${x.error} (${x.elapsed}ms)`); fail++; }
  }
  log('INFO', '代理穿透', `汇总: 正常 ${ok} | 慢 ${slow} | 失败 ${fail}`);
  if (fail === CONFIG.foreignViaProxyTargets.length) r.healthy = false;
  else if (slow + fail > ok) r.healthy = false;
  return r;
}

// Phase 3b: 当前节点稳定性（重复测同一个轻量目标）
async function phase3b_currentNodeStability() {
  log('INFO', 'Phase 3b', `═══ 当前节点稳定性测试（重复 ${CONFIG.stabilityRounds} 次）═══`);
  const r = { healthy: true, samples: [], stats: null };
  for (let i = 1; i <= CONFIG.stabilityRounds; i++) {
    const x = await proxyRequest(CONFIG.stabilityTarget, CONFIG.proxyHost, CONFIG.httpProxyPort, CONFIG.timeout);
    r.samples.push(x);
    if (x.ok) log('OK', '稳定性', `第 ${i} 次 ${x.elapsed}ms`);
    else log('ERR', '稳定性', `第 ${i} 次 失败: ${x.error}`);
    await new Promise(res => setTimeout(res, 300));
  }
  const oks = r.samples.filter(s => s.ok);
  const succRate = oks.length / r.samples.length;
  if (oks.length === 0) {
    r.healthy = false; r.stats = { succRate: 0 };
    log('ERR', '稳定性', '当前节点 0% 成功率 → 选中的节点已挂');
    return r;
  }
  const delays = oks.map(s => s.elapsed);
  const avg = delays.reduce((a, b) => a + b, 0) / delays.length;
  const min = Math.min(...delays), max = Math.max(...delays);
  const stdev = Math.sqrt(delays.reduce((s, x) => s + (x - avg) ** 2, 0) / delays.length);
  const jitterRatio = stdev / avg;
  r.stats = { succRate, avg: Math.round(avg), min, max, stdev: Math.round(stdev), jitterRatio };
  log('INFO', '稳定性', `成功率 ${(succRate * 100).toFixed(0)}% | 平均 ${Math.round(avg)}ms | 范围 ${min}~${max}ms | 抖动 σ=${Math.round(stdev)}ms`);
  if (succRate < 0.7) { r.healthy = false; log('WARN', '稳定性', '成功率 < 70% → 当前节点不可靠'); }
  if (jitterRatio > CONFIG.unstableJitterRatio && oks.length > 1) {
    r.healthy = false; log('WARN', '稳定性', `抖动比 ${jitterRatio.toFixed(2)} > ${CONFIG.unstableJitterRatio} → 当前节点延迟很不稳定`);
  }
  if (avg > 2000) { r.healthy = false; log('WARN', '稳定性', `平均延迟 ${Math.round(avg)}ms 过高`); }
  return r;
}

// 判断节点是否属于「主流核心地区」（HK/TW/JP/US/SG/KR）
function isPopularRegion(nodeName) {
  return CONFIG.popularRegionPatterns.some(re => re.test(nodeName));
}

// Phase 4: 节点池详细诊断（仅当 API 可用）
async function phase4_nodePool(controllerOk) {
  log('INFO', 'Phase 4', '═══ 节点池详细诊断 ═══');
  const r = {
    skipped: false, healthy: true, stalePattern: false,
    stats: { ok: 0, slow: 0, fail: 0, total: 0 },
    byRegion: {
      popular: { ok: 0, slow: 0, fail: 0, total: 0, deadNames: [] },
      obscure: { ok: 0, slow: 0, fail: 0, total: 0, aliveNames: [] },
    },
  };
  if (!controllerOk) {
    log('HINT', '节点池', '控制器 API 不可用，跳过');
    r.skipped = true; return r;
  }
  const list = await clashApi('/proxies');
  if (!list.ok || !list.data?.proxies) {
    log('ERR', '节点池', `获取节点列表失败: ${list.error || '响应格式异常'}`);
    r.skipped = true; return r;
  }
  const types = ['Shadowsocks', 'ShadowsocksR', 'Vmess', 'Vless', 'Trojan', 'Hysteria', 'Hysteria2', 'Tuic', 'WireGuard'];
  const nodes = Object.entries(list.data.proxies).filter(([, info]) => types.includes(info.type));
  log('INFO', '节点池', `共 ${nodes.length} 个节点，采样测试前 ${Math.min(nodes.length, CONFIG.maxNodesToTest)} 个...`);
  const sample = nodes.slice(0, CONFIG.maxNodesToTest);

  for (const [name, info] of sample) {
    const cat = isPopularRegion(name) ? 'popular' : 'obscure';
    const encoded = encodeURIComponent(name);
    const x = await clashApi(`/proxies/${encoded}/delay?url=http%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=5000`);
    r.stats.total++;
    r.byRegion[cat].total++;
    const tag = cat === 'popular' ? '主流' : '冷门';

    if (x.ok && typeof x.data?.delay === 'number') {
      const d = x.data.delay;
      if (d === 0) {
        log('ERR', '节点', `[${tag}][${info.type}] ${name} → 不可用`);
        r.stats.fail++; r.byRegion[cat].fail++;
        if (cat === 'popular') r.byRegion.popular.deadNames.push(name);
      } else if (d > CONFIG.slowDelayThreshold) {
        log('WARN', '节点', `[${tag}][${info.type}] ${name} → ${d}ms (慢)`);
        r.stats.slow++; r.byRegion[cat].slow++;
        if (cat === 'obscure') r.byRegion.obscure.aliveNames.push(`${name}(${d}ms)`);
      } else {
        log('OK', '节点', `[${tag}][${info.type}] ${name} → ${d}ms`);
        r.stats.ok++; r.byRegion[cat].ok++;
        if (cat === 'obscure') r.byRegion.obscure.aliveNames.push(`${name}(${d}ms)`);
      }
    } else {
      log('ERR', '节点', `[${tag}][${info.type}] ${name} → 测试失败 (${x.data?.message || x.error})`);
      r.stats.fail++; r.byRegion[cat].fail++;
      if (cat === 'popular') r.byRegion.popular.deadNames.push(name);
    }
  }

  const { ok, slow, fail, total } = r.stats;
  const pop = r.byRegion.popular, obs = r.byRegion.obscure;
  const popAlive = pop.ok + pop.slow, obsAlive = obs.ok + obs.slow;

  log('INFO', '节点池', `总体: 健康 ${ok} | 慢 ${slow} | 失败 ${fail} (共 ${total})`);
  log('INFO', '节点池', `主流地区(HK/TW/JP/US/SG/KR): 活 ${popAlive}/${pop.total}  |  冷门地区: 活 ${obsAlive}/${obs.total}`);

  // ★ 精确的「订阅源失效」特征 — 你描述的那个罕见但典型的现象
  // 信号要求：
  //   ① 测了至少 3 个主流地区节点（避免样本太小误报）
  //   ② 主流地区全军覆没（活 = 0）
  //   ③ 冷门地区有 1 个以上还活着
  // 满足这三条 → 几乎可以确定就是订阅源里的主流节点过期了，重新导入即可
  if (pop.total >= 3 && popAlive === 0 && obsAlive >= 1) {
    r.stalePattern = true;
    r.healthy = false;
    log('HINT', '节点池', `★★ 检测到「订阅源失效」典型特征：`);
    log('HINT', '节点池', `   主流地区 ${pop.total} 个节点全部死亡（${pop.deadNames.slice(0, 3).join(' / ')}${pop.deadNames.length > 3 ? ' ...' : ''}）`);
    log('HINT', '节点池', `   但冷门地区还有 ${obsAlive} 个能用（${obs.aliveNames.slice(0, 3).join(' / ')}${obs.aliveNames.length > 3 ? ' ...' : ''}）`);
    log('HINT', '节点池', `   ⇒ 这不是网络问题，是订阅源主路被打、冷路侥幸幸存。重新导入订阅链接即可全复活。`);
  }
  // 较弱的信号：主流地区大批死亡（≥80%）但没全挂
  else if (pop.total >= 3 && pop.fail / pop.total >= 0.8 && popAlive >= 1) {
    log('HINT', '节点池', `主流地区死亡率 ${(pop.fail/pop.total*100).toFixed(0)}% — 接近订阅源失效特征但还有少量主流活着，先观察或尝试切节点`);
    r.healthy = false;
  }
  // 整体劣化但不是失效特征
  else if (total > 0 && fail + slow > ok) {
    r.healthy = false;
  }
  return r;
}

// ============ 综合判断 ============
function verdict(p1, p2, p3a, p3b, p4) {
  console.log('\n' + '═'.repeat(64));
  log('INFO', '诊断结论', '');
  console.log('═'.repeat(64));
  const conclusions = [];

  if (!p1.healthy) {
    conclusions.push({ sev: '严重', cat: 'flclash', msg: 'flclash 本地服务异常 → 重启 flclash 或检查端口' });
  }
  if (!p2.dnsOk) conclusions.push({ sev: '严重', cat: '公司网络', msg: 'DNS 解析挂了' });
  if (!p2.domesticOk) conclusions.push({ sev: '严重', cat: '公司网络', msg: '连境内站都连不上 → 公司网整个出问题' });
  if (p2.domesticOk && !p2.foreignDirectOk) {
    conclusions.push({ sev: '严重', cat: '公司国际出口', msg: '境内通但境外直连全失败 → 公司国际线路断了，VPN 走不出去' });
  } else if (p2.foreignDirectSlow) {
    conclusions.push({ sev: '中等', cat: '公司国际出口', msg: '境外直连慢/超时 → 公司国际带宽拥塞（下午高峰常见，VPN 也会一起慢）' });
  }

  // ★订阅源失效特征（最高优先级提示）
  if (p4 && p4.stalePattern) {
    conclusions.push({ sev: '中等', cat: '订阅源', msg: '主流地区(HK/TW/JP/US)节点全部失效但冷门地区还活着 → 重新导入订阅（最快的解决方案）' });
  }

  if (p3a && !p3a.healthy) {
    const allFail = p3a.results.every(x => !x.ok);
    if (allFail) conclusions.push({ sev: '严重', cat: '代理穿透', msg: '所有目标经代理都失败 → 当前节点已挂或代理链路不通' });
    else conclusions.push({ sev: '中等', cat: '代理穿透', msg: '部分境外目标经代理失败/慢 → 当前节点拥堵或线路不稳' });
  }
  if (p3b && !p3b.healthy && p3b.stats) {
    const s = p3b.stats;
    if (s.succRate < 0.5) conclusions.push({ sev: '严重', cat: '当前节点', msg: `成功率仅 ${(s.succRate*100).toFixed(0)}% → 切节点` });
    else if (s.jitterRatio > CONFIG.unstableJitterRatio) conclusions.push({ sev: '中等', cat: '当前节点', msg: `延迟很不稳定（抖动 σ=${s.stdev}ms，范围 ${s.min}~${s.max}ms）→ 切到稳定节点` });
    else if (s.avg && s.avg > 2000) conclusions.push({ sev: '中等', cat: '当前节点', msg: `平均延迟 ${s.avg}ms 过高` });
  }
  if (p4 && !p4.skipped && !p4.healthy && !p4.stalePattern) {
    conclusions.push({ sev: '中等', cat: '节点池', msg: `节点池整体劣化（健康 ${p4.stats.ok}/${p4.stats.total}）→ 试试切冷门节点` });
  }

  if (conclusions.length === 0) log('OK', '诊断结论', '✓ 全部检查通过，VPN 与网络状态健康');
  else conclusions.forEach((x, i) => {
    const icon = x.sev === '严重' ? '🔴' : '🟡';
    log('WARN', '诊断结论', `${i + 1}. ${icon} [${x.sev}][${x.cat}] ${x.msg}`);
  });

  console.log('\n' + c.cyan + '判断逻辑速查：' + c.reset);
  console.log('  Phase 1 失败              → flclash 本身问题');
  console.log('  Phase 2 境内全失败        → 公司网络断了');
  console.log('  Phase 2 境外直连全失败    → 公司国际出口出问题（VPN 救不了）');
  console.log('  Phase 2 境外直连慢        → 国际带宽拥塞（下午高峰）');
  console.log('  Phase 3a 全失败           → 当前节点挂了');
  console.log('  Phase 3b 抖动大           → 当前节点不稳，切节点');
  console.log('  Phase 4 主流全死+冷门活   → ★ 订阅源失效，重新导入');
  console.log('');

  // 时段提示
  const h = new Date().getHours();
  if (h >= 13 && h <= 19) {
    console.log(c.yellow + `💡 当前 ${h} 点正处下午高峰。如果 Phase 2 境外直连也慢，那就是公司国际出口被运营商限速 — VPN 也救不了；如果 Phase 2 OK 但 Phase 3/4 慢，那就是节点拥堵或订阅源失效，按上面结论处理。` + c.reset + '\n');
  }
}

// ============ 主流程 ============
async function runOnce() {
  console.log(c.bold + c.blue + '\n╔══════════════════════════════════════════════╗');
  console.log('║   flclash / VPN 网络诊断工具 v2              ║');
  console.log('╚══════════════════════════════════════════════╝' + c.reset);
  log('INFO', '开始', `时间: ${new Date().toLocaleString('zh-CN')}`);
  try {
    const p1 = await phase1_localService();
    const p2 = await phase2_baseNetwork();
    let p3a = null, p3b = null, p4 = null;
    if (p1.healthy) {
      p3a = await phase3a_proxyConnectivity();
      p3b = await phase3b_currentNodeStability();
      p4  = await phase4_nodePool(p1.controllerOk);
    } else {
      log('WARN', '跳过', 'flclash 不健康，跳过 Phase 3/4');
    }
    verdict(p1, p2, p3a, p3b, p4);
  } catch (err) {
    log('ERR', '致命错误', `诊断流程异常: ${err.stack}`);
  }
}

async function main() {
  initLog();
  const watchArg = process.argv.find(a => a.startsWith('--watch'));
  if (watchArg) {
    const m = watchArg.match(/--watch=(\d+)/);
    const min = m ? parseInt(m[1], 10) : 5;
    log('INFO', '监控模式', `每 ${min} 分钟一次（Ctrl+C 退出）`);
    await runOnce();
    setInterval(runOnce, min * 60 * 1000);
  } else {
    await runOnce();
    if (logStream) logStream.end();
  }
}
main();
