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
  // 境内能直连的境外站（不需 VPN），用来判断网络国际出口本身行不行
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

  // 主用区域 — 设置后会在结论里单独高亮该区域状态、推荐节点优先选这里。null 表示无偏好。
  // 可选值（与节点名匹配，由 detailedRegion 决定）：
  //   '香港' / '台湾' / '日本' / '美国' / '新加坡' / '韩国' / '马来西亚' / '越南' / '泰国' / '英国' / '德国'
  preferredRegion: '台湾',

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

// Phase 2: 网络基础（不走代理）
async function phase2_baseNetwork() {
  log('INFO', 'Phase 2', '═══ 检查网络基础（不走代理）═══');
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
    log('WARN', '境外直连', '所有境外站直连都不通 → 国际出口可能全断了'); }
  else if (slow + fail > 0) { r.foreignDirectSlow = true;
    log('HINT', '境外直连', '部分境外站直连慢/超时（可能单点抽风也可能出口拥塞，结合代理穿透判断）'); }
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

// 细粒度地区识别 — 用于检测「某地区整组失效」（比如台湾 D10-D15 全挂）
function detailedRegion(name) {
  if (/香港|🇭🇰|\bhk\b|hong\s*kong/i.test(name)) return '香港';
  if (/台湾|台灣|🇹🇼|\btw\b|taiwan/i.test(name)) return '台湾';
  if (/日本|🇯🇵|\bjp\b|japan|东京|大阪/i.test(name)) return '日本';
  if (/美国|🇺🇸|\bus\b|usa|america|united\s*states|洛杉矶|硅谷|纽约/i.test(name)) return '美国';
  if (/新加坡|🇸🇬|\bsg\b|singapore/i.test(name)) return '新加坡';
  if (/韩国|🇰🇷|\bkr\b|korea/i.test(name)) return '韩国';
  if (/马来|🇲🇾|malaysia/i.test(name)) return '马来西亚';
  if (/越南|🇻🇳|vietnam/i.test(name)) return '越南';
  if (/泰国|🇹🇭|thailand/i.test(name)) return '泰国';
  if (/英国|🇬🇧|\buk\b|britain/i.test(name)) return '英国';
  if (/德国|🇩🇪|germany/i.test(name)) return '德国';
  return '其他';
}

// 中文/emoji 字符宽度修正版 padEnd（用于终端对齐）
// 国旗 emoji = 两个 Regional Indicator Symbol，视觉宽度 2（不是 4）
function padDisplay(s, width) {
  let w = 0, i = 0;
  while (i < s.length) {
    const cp = s.codePointAt(i);
    const charLen = cp > 0xFFFF ? 2 : 1;
    if (cp >= 0x1F1E6 && cp <= 0x1F1FF) {
      const next = s.codePointAt(i + charLen);
      if (next && next >= 0x1F1E6 && next <= 0x1F1FF) {
        w += 2;
        i += charLen + (next > 0xFFFF ? 2 : 1);
        continue;
      }
    }
    if (cp >= 0x1F300) w += 2;                                              // 其他 emoji
    else if ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3040 && cp <= 0x30FF)) w += 2;  // 中日韩
    else w += 1;
    i += charLen;
  }
  return s + ' '.repeat(Math.max(0, width - w));
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
    // 每个具体地区的死活统计 — 用于检测「某地区整组挂掉」、给主用区域单独高亮
    byDetailedRegion: {},   // { 地区: { total, dead, alive: [{ name, delay }] } }
    // 健康（≤slowDelayThreshold）节点列表，verdict 里排序后用作切节点推荐
    fastNodes: [],          // [{ name, delay }]
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
    const region = detailedRegion(name);
    if (!r.byDetailedRegion[region]) r.byDetailedRegion[region] = { total: 0, dead: 0, alive: [], nodes: [] };
    r.byDetailedRegion[region].total++;

    const encoded = encodeURIComponent(name);
    const x = await clashApi(`/proxies/${encoded}/delay?url=http%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=5000`);
    r.stats.total++;
    r.byRegion[cat].total++;
    const tag = cat === 'popular' ? '主流' : '冷门';

    let isDead = false, delayValue = null;
    if (x.ok && typeof x.data?.delay === 'number') {
      const d = x.data.delay;
      if (d === 0) {
        log('ERR', '节点', `[${tag}][${info.type}] ${name} → 不可用`);
        r.stats.fail++; r.byRegion[cat].fail++;
        if (cat === 'popular') r.byRegion.popular.deadNames.push(name);
        isDead = true;
      } else if (d > CONFIG.slowDelayThreshold) {
        log('WARN', '节点', `[${tag}][${info.type}] ${name} → ${d}ms (慢)`);
        r.stats.slow++; r.byRegion[cat].slow++;
        if (cat === 'obscure') r.byRegion.obscure.aliveNames.push(`${name}(${d}ms)`);
        delayValue = d;
      } else {
        log('OK', '节点', `[${tag}][${info.type}] ${name} → ${d}ms`);
        r.stats.ok++; r.byRegion[cat].ok++;
        if (cat === 'obscure') r.byRegion.obscure.aliveNames.push(`${name}(${d}ms)`);
        delayValue = d;
        r.fastNodes.push({ name, delay: d });
      }
    } else {
      log('ERR', '节点', `[${tag}][${info.type}] ${name} → 测试失败 (${x.data?.message || x.error})`);
      r.stats.fail++; r.byRegion[cat].fail++;
      if (cat === 'popular') r.byRegion.popular.deadNames.push(name);
      isDead = true;
    }

    if (isDead) r.byDetailedRegion[region].dead++;
    else if (delayValue != null) r.byDetailedRegion[region].alive.push({ name, delay: delayValue });

    // 同时按池里顺序保存到 nodes，给主用区域块逐节点展示用
    const nodeStatus = isDead ? 'fail' : (delayValue > CONFIG.slowDelayThreshold ? 'slow' : 'ok');
    r.byDetailedRegion[region].nodes.push({ name, status: nodeStatus, delay: isDead ? null : delayValue });
  }

  r.fastNodes.sort((a, b) => a.delay - b.delay);

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
  const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const line = s => { console.log(s); if (logStream) logStream.write(stripAnsi(s) + '\n'); };
  const sevIcon = lvl =>
    lvl === 'ok'   ? c.green  + ' ✓ ' + c.reset :
    lvl === 'fail' ? c.red    + ' ✗ ' + c.reset :
    lvl === 'warn' ? c.yellow + ' ⚠ ' + c.reset :
                     c.gray   + ' – ' + c.reset;

  // ---------- 1. 收集每一类的判定（含依据）----------
  let flclash;
  if (!p1.healthy) flclash = { lvl: 'fail', msg: `端口 ${CONFIG.httpProxyPort} 不通 → flclash 没运行或端口配错` };
  else if (!p1.controllerOk) flclash = { lvl: 'warn', msg: '代理端口正常，但外部控制器未开（节点详情会跳过）' };
  else flclash = { lvl: 'ok', msg: `正常（代理 ${CONFIG.httpProxyPort} + 控制器 API）` };

  // 真的国际出口拥塞 vs 单点抽风：
  //   p2.foreignDirectSlow 太敏感（一个境外站慢就触发，比如 Cloudflare 路由抽风但其实不影响 VPN）
  //   "真拥塞" 需要：经代理穿透多个目标都慢 + 当前节点本身不慢（排除节点慢的干扰）
  const proxyManySlow = p3a && p3a.results.length >= 2
    && p3a.results.filter(r => !r.ok || r.elapsed > 3000).length >= 2;
  const currentNodeFast = !p3b || !p3b.stats || p3b.stats.avg <= 800;

  let network;
  if (!p2.dnsOk)                network = { lvl: 'fail', msg: 'DNS 解析失败 → 网络配置出问题' };
  else if (!p2.domesticOk)      network = { lvl: 'fail', msg: '境内站连不上 → 整个网络断了' };
  else if (!p2.foreignDirectOk) network = { lvl: 'fail', msg: '国际出口断了，VPN 也走不出去（流量也走这条路）→ 个人无解，换手机热点或等线路恢复' };
  else if (p2.foreignDirectSlow && proxyManySlow && currentNodeFast) {
    network = { lvl: 'warn', msg: '国际出口确实拥塞（经代理多个目标都慢）→ VPN 救不了，临时换手机热点或等高峰过' };
  }
  else network = { lvl: 'ok', msg: '正常（境内 + 国际出口都通）' };

  let subscription;
  if (!p4 || p4.skipped) subscription = { lvl: 'skip', msg: '未检查（控制器 API 未开，节点池跳过了）' };
  else if (p4.stalePattern) {
    const obsAlive = p4.byRegion.obscure.ok + p4.byRegion.obscure.slow;
    subscription = { lvl: 'fail', msg: `失效 — 主流 ${p4.byRegion.popular.total} 全死、冷门活 ${obsAlive} 个 → 重新导入订阅` };
  } else {
    const popAlive = p4.byRegion.popular.ok + p4.byRegion.popular.slow;
    subscription = { lvl: 'ok', msg: `健康（主流活 ${popAlive}/${p4.byRegion.popular.total}）` };
  }

  let preferred = null;
  if (CONFIG.preferredRegion) {
    if (!p4 || p4.skipped) {
      preferred = { lvl: 'skip', msg: '未检查（控制器 API 未开）' };
    } else {
      const st = p4.byDetailedRegion[CONFIG.preferredRegion];
      if (!st || st.total === 0) {
        preferred = { lvl: 'skip', msg: `节点池里没有 ${CONFIG.preferredRegion} 节点` };
      } else if (st.alive.length === 0) {
        preferred = { lvl: 'fail', msg: `${st.total} 个节点全部失效（详见下方）` };
      } else if (st.dead > 0) {
        preferred = { lvl: 'warn', msg: `部分可用 ${st.alive.length}/${st.total}（详见下方）` };
      } else {
        preferred = { lvl: 'ok', msg: `全部可用 ${st.alive.length}/${st.total}` };
      }
    }
  }

  let current = null;
  if (p3b && p3b.stats) {
    const s = p3b.stats;
    if (s.succRate === 0)                                    current = { lvl: 'fail', msg: '0% 成功率 → 节点完全挂了' };
    else if (s.succRate < 0.7)                               current = { lvl: 'fail', msg: `成功率仅 ${(s.succRate * 100).toFixed(0)}%` };
    else if (s.jitterRatio > CONFIG.unstableJitterRatio)     current = { lvl: 'warn', msg: `抖动严重 σ=${s.stdev}ms（不稳定）` };
    else if (s.avg > 2000)                                   current = { lvl: 'fail', msg: `平均 ${s.avg}ms 过高（稳定但慢）` };
    else if (s.avg > 800)                                    current = { lvl: 'warn', msg: `平均 ${s.avg}ms 偏慢` };
    else                                                     current = { lvl: 'ok',   msg: `平均 ${s.avg}ms, 稳定（σ=${s.stdev}ms）` };
  }

  // ---------- 2. 问题定位（按优先级把"最该处理的事"挑出来）----------
  // 优先级：flclash > 网络 > 订阅源 > 主用区域全死 > 其他区域整组失效 > 当前节点 > 国际出口拥塞 > 主用区域部分劣化 > 一切正常
  let issue;
  if (flclash.lvl === 'fail') {
    issue = { color: c.red, title: 'flclash 软件异常', hint: '检查 flclash 是否运行、端口是否被改' };
  } else if (!p2.dnsOk || !p2.domesticOk) {
    issue = { color: c.red, title: '网络问题', hint: '联系 IT 或检查物理网络，VPN 救不了' };
  } else if (!p2.foreignDirectOk) {
    issue = { color: c.red, title: '国际出口断了', hint: 'VPN 流量也走这条路，换手机热点绕过或等线路恢复' };
  } else if (subscription.lvl === 'fail') {
    issue = { color: c.red, title: '订阅源失效', hint: '主流地区全死、冷门活 → 重新导入订阅链接' };
  } else if (preferred && preferred.lvl === 'fail') {
    issue = {
      color: c.red,
      title: `节点失效（${CONFIG.preferredRegion}机房挂了）`,
      hint: '等 1–2 小时机房恢复，期间切到下方推荐的低延迟节点暂时缓解',
    };
  } else if (p4 && !p4.skipped) {
    let downRegion = null;
    for (const [region, st] of Object.entries(p4.byDetailedRegion || {})) {
      if (region === '其他' || region === CONFIG.preferredRegion) continue;
      if (st.total >= 3 && st.dead / st.total >= 0.8) { downRegion = region; break; }
    }
    if (downRegion) {
      issue = { color: c.yellow, title: `${downRegion}区域整组失效`, hint: '该机房挂了，过几小时再测' };
    } else if (current && current.lvl === 'fail') {
      issue = { color: c.red, title: '当前节点性能差', hint: '切到其他节点（推荐见下方）' };
    } else if (network.lvl === 'warn') {
      issue = { color: c.yellow, title: '国际出口拥塞', hint: '换手机热点 / 等高峰过，VPN 救不了' };
    } else if (current && current.lvl === 'warn') {
      issue = { color: c.yellow, title: '当前节点偏慢', hint: '可考虑切到更快的节点' };
    } else if (preferred && preferred.lvl === 'warn') {
      issue = { color: c.yellow, title: '主用区域部分劣化', hint: '部分节点失效，但仍可工作' };
    } else {
      issue = { color: c.green, title: '一切正常 ✓', hint: null };
    }
  } else {
    issue = { color: c.green, title: '一切正常 ✓', hint: null };
  }

  // ---------- 3. 输出 ----------
  console.log('');
  line(c.bold + c.cyan + '══════════════════ 诊断结果 ══════════════════' + c.reset);
  line('');
  line('  ' + c.bold + '【问题定位】' + c.reset + ' ' + issue.color + c.bold + issue.title + c.reset);
  if (issue.hint) line('  ' + c.gray + '             ' + issue.hint + c.reset);
  line('');

  // 五行状态
  const rows = [
    { name: 'flclash 软件', ...flclash },
    { name: '网络',         ...network },
    { name: '订阅源',       ...subscription },
  ];
  if (preferred) rows.push({ name: `主用区域（${CONFIG.preferredRegion}）`, ...preferred });
  if (current)   rows.push({ name: '当前节点', ...current });
  for (const r of rows) {
    line(`  ${sevIcon(r.lvl)} ${c.bold}${padDisplay(r.name, 18)}${c.reset}  ${r.msg}`);
  }

  // ---------- 4. 主用区域专属区块（逐节点 + 推荐）----------
  if (CONFIG.preferredRegion && p4 && !p4.skipped) {
    const st = p4.byDetailedRegion[CONFIG.preferredRegion];
    if (st && st.total > 0) {
      line('');
      const aliveN = st.alive.length;
      line(c.bold + c.cyan + `─────── ${CONFIG.preferredRegion}节点逐个状态（${aliveN}/${st.total} 可用）───────` + c.reset);
      for (const n of st.nodes) {
        let icon, valueColored;
        if (n.status === 'fail')      { icon = c.red    + '✗' + c.reset; valueColored = c.red    + '失效' + c.reset; }
        else if (n.status === 'slow') { icon = c.yellow + '⚠' + c.reset; valueColored = c.yellow + `${n.delay}ms (慢)` + c.reset; }
        else                          { icon = c.green  + '✓' + c.reset; valueColored = c.green  + `${n.delay}ms` + c.reset; }
        line(`   ${icon}  ${padDisplay(n.name, 20)}  ${valueColored}`);
      }
      line('');
      if (aliveN === 0) {
        line('  ' + c.gray + '期间临时切到这些低延迟节点缓解:' + c.reset);
        if (p4.fastNodes && p4.fastNodes.length > 0) {
          for (const n of p4.fastNodes.slice(0, 3)) {
            line(`     • ${n.name}    ${c.green}${n.delay}ms${c.reset}`);
          }
        } else {
          line('     ' + c.gray + '（节点池里没有可用的快节点）' + c.reset);
        }
      } else {
        const fastest = st.alive.reduce((a, b) => a.delay < b.delay ? a : b);
        line('  ' + c.gray + '推荐使用: ' + c.reset + c.green + c.bold + `${fastest.name}  ${fastest.delay}ms` + c.reset + c.gray + '（最快）' + c.reset);
      }
    }
  }

  // 区域恢复/失效检测 — 与上次运行对比
  printRegionStateChange(p4, line);

  console.log('');
}


// 持久化区域状态、并报告与上次运行的差异（恢复/新失效）
function printRegionStateChange(p4, line) {
  if (!p4 || p4.skipped) return;
  const stateFile = path.join(CONFIG.logDir, 'last-region-state.json');

  // 先读上次状态
  let last = null;
  try {
    if (fs.existsSync(stateFile)) {
      last = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
  } catch { /* 损坏就当没有 */ }

  // 构造当前状态
  const current = {};
  for (const [r, st] of Object.entries(p4.byDetailedRegion || {})) {
    if (r === '其他') continue;
    current[r] = { total: st.total, alive: st.alive.length };
  }

  // 写入当前状态（即便之后比对失败，也要把这次的写下来供下次用）
  try {
    fs.writeFileSync(stateFile, JSON.stringify({ ts: Date.now(), regions: current }, null, 2));
  } catch { /* 写不了不致命 */ }

  if (!last || !last.regions) return;

  // 对比
  const recovered = [], degraded = [];
  for (const [r, cur] of Object.entries(current)) {
    const prev = last.regions[r];
    if (!prev) continue;
    if (prev.alive === 0 && cur.alive > 0) {
      recovered.push({ region: r, alive: cur.alive, total: cur.total });
    } else if (prev.alive > 0 && cur.alive === 0 && cur.total >= 3) {
      degraded.push({ region: r, total: cur.total });
    }
  }

  if (recovered.length === 0 && degraded.length === 0) return;

  const ago = Math.max(1, Math.round((Date.now() - last.ts) / 60000));
  line('');
  line(c.gray + `自上次运行（${ago} 分钟前）以来:` + c.reset);
  for (const r of recovered) {
    line('  ' + c.green + `🎉 ${r.region} 已恢复（活 ${r.alive}/${r.total}）` + c.reset);
  }
  for (const r of degraded) {
    line('  ' + c.red + `💀 ${r.region} 刚刚整组失效（0/${r.total}）` + c.reset);
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