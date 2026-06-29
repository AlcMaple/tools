# aowu (FantasyKon) `/api/site/secure` 逆向与反爬硬化手册

> 这份文档**写给未来 Claude 会话**：当用户在新的对话里报告 aowu 出问题时，这里
> 是当前实现的全部上下文 — 协议形态、解决思路、风险图景、出问题的诊断路径、
> 以及"协议又变了"时该怎么重新逆向。
>
> 用户：alcmaple.claude — 单设备单用户使用，部署形态是 mac/win 桌面 Electron 应用。

---

## 背景与时间线

aowu (`https://www.aowu.tv`) 的前端架构变迁：

| 时间 | 架构 | 我们的客户端 |
|---|---|---|
| ≤ 2026-04 | MacCMS dsn2，HTML 直接出内容 | axios + cheerio |
| 2026-05 | 改版为 "FantasyKon" SPA，所有数据走加密 `POST /api/site/secure` | 隐藏 BrowserWindow 加载 SPA + DOM 抓取 |
| 2026-05 后 | 同上 | **本次：逆向 secure 协议，纯 Node HTTP** |

历史 git 提交（按时间倒序，aowu 相关）：

```
022fc9e hardening(aowu): 反爬伪装、节流、流式分页、瞬断重试
302000b perf(aowu): 逆向 /api/site/secure 协议，干掉 BrowserWindow
975386c fix(aowu): 修 watch token 取错 + 复制链接给 mp4 直链
e6e734f feat(aowu): 改用隐藏 BrowserWindow 适配 FantasyKon SPA 全套架构
f02f161 feat(aowu): 适配 FantasyKon 新搜索结构 + 修空结果污染缓存
5961334 fix(aowu): 区分站点访问失败 / 改版 / 真无结果，错误信息不再误导
58bf090 fix(aowu): 修复选集范围错误 — 将 parseEpisodes 限定到正确的 anthology-list-box
cdea3b8 feat(search): 三个源都支持分页，1s 延迟避免触发反爬
c5eb688 fix(aowu): 搜索结果支持分页（之前只拿第一页）
d0f78a7 fix(aowu): 搜索结果用 div.vod-detail.search-list 锁定卡片，修复封面丢失
e7fb8d4 feat(aowu): 主进程层（api / url-resolver / download / ipc）
```

aowu 改版频率：**约半年一次**。下次大改可能在 2026-11 前后。改版几乎必然伴随
`/api/site/secure` 协议或 key 派生算法变化。

---

## 协议总览（2026-05 版本）

### 信封

所有请求 / 响应统一外形：

```json
{
  "n": "<12-byte IV, base64 (16 chars, no padding)>",
  "d": "<ciphertext + 16-byte GCM tag, base64 (with padding)>"
}
```

- **算法**：AES-256-GCM
- **IV**：12 字节随机（每次请求重新生成）
- **认证标签**：16 字节，附在密文末尾
- **填充**：无（GCM 模式）

### 密钥派生（关键）

32 字节 AES-256 key 由 5 段藏在首页 HTML 里的字符串拼接而来：

```
parts =   gt(  document.querySelector('meta[name="fk-p"]').content       )
        + gt(  document.documentElement.dataset.fkS                       )
        + gt(  window.__FKM[0]                                            )
        + gt(  getComputedStyle(document.documentElement).getPropertyValue('--fk-c') )
        + gt(  window.__FKM[1]                                            )

keyBinaryStr = atob(parts)               // base64 解码 → 32 字符 latin-1 字符串
keyBytes     = TextEncoder.encode(keyBinaryStr)   // utf-8 编码 → 32 字节

gt(s) = s.trim().replace(/^["']|["']$/g, '')      // 去首尾引号 + 空白
```

**5 段在 HTML 里的位置**：

| 字段 | HTML 位置 | 提取正则 | 长度（典型） |
|---|---|---|---|
| `meta` | `<meta name="fk-p" content="...">` | `<meta[^>]+name=["']fk-p["'][^>]+content=["']([^"']+)["']` | 9 字符 |
| `fkS` | `<html data-fk-s="...">` | `<html[^>]+data-fk-s=["']([^"']+)["']` | 9 字符 |
| `fkm[0]`, `fkm[1]` | 内联 `<script>window.__FKM=["x","y"]</script>` | `__FKM\s*=\s*(\[[^\]]+\])` 然后 JSON.parse | 9 + 8 字符 |
| `fkc` | 内联 `<style>...:root{--fk-c:"..."}</style>` | `--fk-c\s*:\s*"([^"]+)"` | 9 字符 |

5 段总长 **9+9+9+9+8 = 44 字符**，base64 解 = 32 字节。**注意 fkm[1] 末尾带 `=`
padding，是合法 base64 标记**。

> **为什么是 latin-1 → utf-8 转码？** 浏览器 SPA 的 `wt()` 函数用 `atob(parts)`
> 拿到一个二进制字符串（每字符 codepoint 0-255），然后 `TextEncoder.encode()`
> 转 utf-8。如果 atob 出来的 32 字节都是 ≤0x7F（当前情况），utf-8 转码是 identity
> → 32 字节。如果未来某个字节 > 0x7F，utf-8 会把它扩成 2 字节，结果 > 32 字节。
> 我们的代码用 `Buffer.from(latin1Str, 'utf8')` 严格复刻这个行为，对未来高位 key
> 仍然兼容。

### Verbs

请求 payload 形如 `{ action, params }`，响应解密后是 `{ code, msg, data }`。

#### `bundle` — 一次性拿整页所有数据

四种 `bundle_page` 子动作，**搜索 / 详情 / 播放页都用这一个 verb**：

```js
// 搜索（带分页）
{ action: "bundle",
  params: { bundle_page: "search", anime: <keyword>, page: <1..N> } }
→ data.data: { query, list[10], page, limit, total }

// 详情（包含所有 source/episode）
{ action: "bundle",
  params: { id: <video_id>, bundle_page: "video" } }
→ data.data: { video, sources[].episodes[], recommended, ads }

// 播放页 — 拿一次性签名 token，**不直接返回 mp4 URL**
{ action: "bundle",
  params: { id, source_id, episode, bundle_page: "play" } }
→ data.data: { detail, play_token: { token: <90-char signed> },
               play_token_source_id, play_token_episode }
```

#### `play` — 用上一步的 token 换 mp4 URL

```js
{ action: "play", params: { id, token: <play_token.token> } }
→ data: { video_id, episode_no, url: "https://v16.toutiao50.com/..." }
```

mp4 URL 是签名的字节系 CDN 链接，**支持 HTTP Range，有效期数小时**。

#### `route` — URL token → 内部数字 id（兼容旧链接用）

```js
{ action: "route", params: { token: "_2jACJ3_AIQE" } }
→ data: { page: "video"|"play"|..., video_id: <number> }
```

新版 `search()` 直接给数字 id（如 `2893`），不需要走 `route`。但旧队列里残留的字符串
token（如 `P0GqV7T0yre9`）走 `watch()` / `resolveAowuMp4()` 时会被自动 `route()` 一次。

#### `route-tokens` — 批量路径 → token 映射（不在我们的代码路径里使用）

```js
{ action: "route-tokens", params: { paths: ["/play/2893", "/type/1"] } }
```

SPA 内部用，用于把 `<a>` 链接的 path 翻译成内部 token。**我们不调用这个**。

### play_token 内部结构

观察用，**不需要客户端复刻**（服务器签发 + 校验，客户端透传即可）：

```
Mjg5MzozMDg2OjE6MTc3ODIyNjI3Mzo5TndUb1NOeE93dw  .  94kbuvdpguWBuzMg8QZPKrragdl-TknSDuSeDnHBIUU
└─── base64url(payload) ─────────────────────────┘    └──── base64url(HMAC-SHA256?) ─────────────┘

payload = "id:source_id:episode:timestamp:nonce"
        = "2893:3086:1:1778226273:9NwToSNxOww"
```

签名秘密在服务端，我们无从知晓，也不需要 — 服务器签了就认。

---

## 实施清单

### 主进程

| 文件 | 职责 |
|---|---|
| `src/main/aowu/secure.ts` | 协议核心：UA 池 / cookie jar / browser headers / gzip 解压 / AES-GCM / key 缓存 / 节流 / 重试 / 错误分类 |
| `src/main/aowu/api.ts` | `search()` 流式 + `watch()` |
| `src/main/aowu/url-resolver.ts` | `resolveAowuMp4()` 走 bundle(play) + play(token) 两步 |
| `src/main/aowu/download.ts` | 调用 `buildAowuWatchUrl` + `resolveAowuMp4`，交给 `mp4-range-downloader` |
| `src/main/ipc/aowu.ts` | IPC 注册 + 流式搜索的 event push |
| `src/main/index.ts` | 已删 `closeAowuHeadless` 关停钩子（不再用 BrowserWindow）|

> ⚠️ **`src/main/aowu/headless.ts` 已删除**。如果未来需要回滚到 BrowserWindow 方案，
> 看 git 历史 `e6e734f` 之前的版本。

### 渲染端

| 文件 | 改动 |
|---|---|
| `src/preload/index.ts` | `aowuApi.search()` 改返回 `{requestId, results, total, more}`；新增 `onSearchPage()` 订阅 |
| `src/renderer/src/env.d.ts` | 同步类型 |
| `src/renderer/src/pages/SearchDownload.tsx` | useEffect 订阅 onSearchPage，用 ref 过滤 stale 流 |
| `src/renderer/src/pages/AnimeInfo.tsx` | doSearch 同步等待 `done=true` 才走 handleResults（保留"唯一结果自动跳详情"语义）|

### 性能基线

冷启动到拿 mp4 URL（首页 GET + 4 次 secure POST，含节流）：

```
GET /                 ~200ms
secure × 4 (节流)     ~150ms × 4 + 1.25s × 3 ≈ 4.4s
─────────────────────
合计                  ~4.6s
```

预热后（key 缓存中）拿一个新 ep 的 mp4 URL：

```
secure × 2 (节流)     ~150ms × 2 + 1.25s ≈ 1.5s
```

搜索 6 页（59 条结果）实测：**~6-9s**，落在用户期望的"翻页节奏"区间。

---

## 反爬硬化（当前措施）

实现都在 `src/main/aowu/secure.ts`：

| 措施 | 用途 | 实现位置 |
|---|---|---|
| 浏览器头齐全 | 模拟 Chrome 120 的 `Accept-*` / `Sec-Fetch-*` / `Sec-Ch-Ua-*` | `browserHeaders()` |
| Cookie jar | 跟随主页响应持久化（虽然 aowu 用 JS 设 cookie，机制就位）| `_cookies` Map + `ingestSetCookie()` |
| gzip / br / deflate 解压 | 配合 `Accept-Encoding: gzip, deflate, br` | `decodeBody()` |
| 全局节流 500-2000ms | 任意两次 POST 间随机间隔，杀掉 burst 模式 | `throttle()` 用 `_throttleChain` 链式 await |
| 随机 UA 池 | 5 个 Chrome 版本（119-123），启动时随机一个，整会话保持 | `chromeVariants()` + `SESSION_VARIANT` |
| 平台一致 | UA / sec-ch-ua-platform 都跟 `process.platform` 对齐 | `chromeVariants(platform)` |
| 网络瞬断单次重试 | ECONNRESET / ETIMEDOUT / EAI_AGAIN 等白名单 errno | `withRetry()` + `TRANSIENT_ERRNOS` |
| 429 / 503 不重试 | 限流时不"重戳"服务，明确告诉用户 | callSecure 的 status 检查 |

### 未做的（明确选择不做）

| 措施 | 为什么不做 |
|---|---|
| TLS JA3 指纹模仿 | 需要换 HTTP 客户端到 `undici` + custom Agent 或 `curl-impersonate-node`，工程代价大；单用户量级触发 TLS 单独 flag 概率极低 |
| HTTP/2 | Node `https` 是 h1，但 aowu 没有 ALPN 严格门禁。换 h2 改造面较大 |
| 模拟 mxana 分析事件 | 实测无 mxa cookies / events 也能正常调用 secure 接口 |
| Key 周期刷新 | 已有 401/403/decrypt-fail 单次重试机制兜底，主动定时刷新性价比低 |

如果未来真触发激进反爬（频繁 429），按"性价比"顺序加：
1. 网络层切 `undici` Agent，hello 包模仿 Chrome
2. 引入 `curl-impersonate-node` 完整复刻 Chrome TLS handshake
3. 必要时回退到 BrowserWindow（最保险但最慢）

---

## 错误分类与诊断

### 三种错误码（在 toast / 日志里出现）

| 错误前缀 | 含义 | 应对 |
|---|---|---|
| `AOWU_RATE_LIMITED` | HTTP 429 — 触发限流 | 等 5-10 分钟自然恢复；连续多次出现考虑切网络（手机热点）|
| `AOWU_UNREACHABLE` | 网络层失败（DNS / 连接 / 超时）或 5xx | 检查网络；服务端临时故障，过几分钟试 |
| `AOWU_STRUCTURE_CHANGED` | **协议变了** — key 提取失败 / 解密失败 / response code≠200 / 响应 shape 不对 | **找 Claude 重新逆向** — 这不是反爬，是站点改版 |

### 出问题时的诊断流程

1. **看错误前缀**：上表三选一，决定方向
2. **如果是 STRUCTURE_CHANGED**：
   - 先用浏览器开 https://www.aowu.tv 看能不能访问
   - 看页面源码里 `meta[name="fk-p"]` / `data-fk-s` / `__FKM` / `--fk-c` 是不是还存在
   - 任何一个没了 → 协议变了，进入"重新逆向" playbook
3. **如果是 RATE_LIMITED**：
   - 频率：偶发 → 等等就好；高频 → 反爬升级了，加 TLS 模仿
   - 看请求间隔是不是真的 ≥ 1s（throttle 没失效）
4. **如果是 UNREACHABLE**：
   - curl 测试 `https://www.aowu.tv/` 看是不是真的网络问题
   - 一般是临时的，重试就行

### 日志位置

主进程通过 `console.error` 输出，在 macOS dev 模式下写到 stderr。打包后日志在
`~/Library/Logs/MapleTools/`（如果接了 electron-log）。

---

## 风险评估（参考 2026-05-08 的判断）

按概率 × 影响排序：

### 🟢 低风险（基本不用担心）

- **单 IP 限流**：单用户 50-100 req/天，触发 429 概率低
- **协议响应新增字段**：用 type guard 读，新增字段被忽略
- **mp4 CDN URL 偶发 403**：链接过期，重新 resolve 即可（已自动处理）

### 🟡 中风险（可能某天遇到）

- **TLS 指纹被识别**：单用户量级不会被指纹单独 flag，但配合其他信号可能凑够阈值
- **JS 挑战（Cloudflare "Just a moment"）**：HTTP 客户端无法过 — 概率低，aowu 体量没到这个等级
- **mxana SDK 缺失被检测**：实测当前不影响

### 🔴 高概率事件

- **协议升级**：每 ~6 月一次。**不是反爬**，是网站迭代。处理方式见下面 playbook。

### ❌ 不会发生

- **永久封单 IP**：aowu 是公开内容站，没有动机
- **客户端被精准识别封禁**：实现层面没差到这一步

---

## 重新逆向 Playbook（协议变化时）

> **触发条件**：用户报告频繁看到 `AOWU_STRUCTURE_CHANGED`，或者搜索/详情/播放任一
> 功能 100% 失败。

### Step 0：确认是协议变了，不是别的

```bash
# 测试主页是否可访问
curl -sI https://www.aowu.tv/ | head -1
# 应该返回 HTTP/2 200 或 HTTP/1.1 200
```

如果主页返回非 200 / 超时，是网络问题不是协议问题。

### Step 1：抓 SPA 真实流量

需要 Chrome MCP（`mcp__Claude_in_Chrome__*`）。如果不可用，用户得手动开浏览器开
DevTools 抓包给你。

```typescript
// 在 Chrome MCP 里：
mcp__Claude_in_Chrome__tabs_context_mcp({ createIfEmpty: true })
mcp__Claude_in_Chrome__navigate({ url: 'https://www.aowu.tv/', tabId })
// 等 SPA 加载

// 装 fetch hook 截获 secure 请求：
mcp__Claude_in_Chrome__javascript_tool({
  action: 'javascript_exec', tabId,
  text: `(()=>{
    if (window.__hook) return 'already';
    window.__hook = []; window.__hookCount = 0;
    const o = window.fetch;
    window.fetch = async function(input, init) {
      const url = typeof input === 'string' ? input : (input?.url || '');
      const isSecure = url.includes('/api/site/secure');
      const reqBody = isSecure ? init?.body : null;
      const r = await o.apply(this, arguments);
      if (isSecure) {
        const text = await r.clone().text();
        window.__hook.push({ url, reqBody, status: r.status, resBody: text });
        window.__hookCount++;
      }
      return r;
    };
    return 'installed';
  })()`,
})

// 触发一次操作（点搜索结果、切剧集）让 SPA 发请求
mcp__Claude_in_Chrome__computer({ action: 'left_click', coordinate: [...] })

// 读截获的请求/响应（注意 harness 可能拦截 cookie/token 数据，需要 redact）
mcp__Claude_in_Chrome__javascript_tool({
  action: 'javascript_exec', tabId,
  text: `JSON.stringify(window.__hook.map(it => ({
    url: it.url,
    reqBodyLen: (it.reqBody || '').length,
    reqShape: (() => { try { const p = JSON.parse(it.reqBody);
      return Object.fromEntries(Object.entries(p).map(([k, v]) =>
        [k, typeof v === 'string' ? \`string(\${v.length})\` : typeof v]));
    } catch { return 'unparseable'; } })(),
    resStatus: it.status,
    resBodyLen: (it.resBody || '').length,
  })), null, 2)`,
})
```

判断信封是否还是 `{n, d}` 形态。如果是 → 算法可能变了；如果不是 → 整个协议
重做。

### Step 2：解密验证（确认 AES-GCM + 密钥派生还可用）

如果信封形态不变，先用现有 key 派生公式试解密：

```javascript
// 在浏览器里执行：
const gt = s => (s||'').trim().replace(/^["']|["']$/g,'');
const meta = document.querySelector('meta[name="fk-p"]')?.content || '';
const fkS = document.documentElement.dataset.fkS || '';
const fkm = window.__FKM || [];
const fkc = getComputedStyle(document.documentElement).getPropertyValue('--fk-c');
const keyBytes = new TextEncoder().encode(atob([meta, fkS, fkm[0]||'', fkc, fkm[1]||''].map(gt).join('')));
const key = await crypto.subtle.importKey('raw', keyBytes, {name:'AES-GCM'}, false, ['decrypt']);
const b64dec = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

const env = JSON.parse(window.__hook[0].resBody);
const pt = await crypto.subtle.decrypt(
  {name:'AES-GCM', iv:b64dec(env.n)}, key, b64dec(env.d)
);
console.log(new TextDecoder().decode(pt));
```

- **解密成功 + 明文是 JSON `{code, msg, data}`** → key 派生还可用，只是 verb / 字段
  名变了。改 `api.ts` / `url-resolver.ts` 的字段读取。
- **解密失败 (OperationError)** → key 派生算法变了。继续 Step 3。

### Step 3：重新逆向 key 派生

下载主 bundle（路径在主页 HTML `<script src="/assets/index-XXX.js">` 里）：

```bash
curl -s -A "Mozilla/5.0..." 'https://www.aowu.tv/' | grep -oE 'assets/index-[^"]+\.js'
# 拿到 hash 后下载：
curl -s 'https://www.aowu.tv/assets/index-XXX.js' -o /tmp/bundle.js
# 检查是否 gzip：
file /tmp/bundle.js
gunzip -c /tmp/bundle.js > /tmp/bundle.unzipped.js  # 如果是 gzip
```

bundle 是 javascript-obfuscator 风格（`_0xXXXX` 标识符 + 字符串数组）。

**典型解码流程**（参考本次的 `/tmp/decode.js`）：

```bash
# 1. 用 grep 定位 'subtle' / 'encrypt' / 'AES-GCM' 字面量
grep -c "subtle\|importKey\|encrypt" /tmp/bundle.unzipped.js
# 通常出现 1-2 次，定位到加解密那一段函数

# 2. 用 Python 提取字符串数组函数 (_0xNNNN) 和解码器 (_0xMMMM)
# 见 /tmp/aowu-node/decode.js 模板：
#   - extract_fn(text, '_0xNNNN')  提取字符串数组
#   - extract_fn(text, '_0xMMMM')  提取解码函数
#   - 找 IIFE 旋转字符串数组
# 把三段拼成可独立运行的 JS：
node /tmp/decode.js  # 输入索引列表，输出字符串值

# 3. 把加密函数（约在 `kt`/`Ie`/`wt` 那一带）的所有索引解码出来，
#    还原成可读 JS。重点找：
#    - 字符串数组里的 'AES-GCM' / 'AES-CBC' 字面量
#    - importKey 调用的 key 来源（哪个变量）
#    - 那个变量怎么计算（拼了哪些字段）
```

把还原出的 `wt()`（或新名字）函数翻译成 Node 等价代码，更新 `secure.ts` 的
`extractFragments()` + `deriveKey()`。

### Step 4：验证

```bash
# 用 /tmp/aowu-node/full-flow.mjs 模板（每次重写一份）独立验证：
node /tmp/aowu-node/full-flow.mjs
# 应该输出：搜索 → 详情 → bundle(play) → play → mp4 URL
# 总耗时 < 2s（不带节流的独立测试）
```

通过后改 `secure.ts`，跑：

```bash
npm run build
npx tsc --noEmit -p tsconfig.web.json
```

`npm run dev` 实测一遍 search / detail / 单集下载。

### Step 5：commit + push

提交信息参考之前的：

```
perf(aowu): 重新逆向 /api/site/secure 协议（FantasyKon vX.Y.Z）

<简述变化：key 派生改了 / verb 改了 / 等等>

<列出主要修改文件>
```

### 重新逆向的预估工时

| 复杂度 | 场景 | 工时 |
|---|---|---|
| 小 | 仅字段名变了，算法不变 | 1-2 小时 |
| 中 | key 派生算法换了片段位置 | 3-5 小时 |
| 大 | 整个加密算法换（如 GCM → CBC + HMAC）| 0.5-1 天 |
| 极大 | 加了 JS 挑战 / TLS 指纹 / Cloudflare Bot Mgmt | 1-3 天，可能要回退 BrowserWindow |

---

## 工具与资源

### 浏览器调试

- `mcp__Claude_in_Chrome__*` — 这次逆向的主力，能 hook fetch / 截 cookie / 跑任意 JS
- 如果用户没装 Chrome 扩展：让用户开 DevTools Network 抓 `/api/site/secure` 请求
  / 响应 body，复制粘贴给你

### bundle 解码

- 见本次 session 的 `/tmp/decode.js`（基于 javascript-obfuscator 标准格式）
- 也可以用在线工具如 https://obf-io.deobfuscate.io/，但生成的代码可读性一般

### 协议测试参考实现

`/tmp/aowu-node/full-flow.mjs`（**每次会话重写**，不持久化）— Node 端独立的端到端
测试，验证整套协议在浏览器外跑得通。模板：

```javascript
import https from 'node:https'
import crypto from 'node:crypto'
// ... GET /, 提取 5 个片段, 派生 key, encrypt/decrypt envelope, 测试 verbs
```

如果重写麻烦，参考 `src/main/aowu/secure.ts` 的 `extractFragments` /
`deriveKey` / `encryptEnvelope` / `decryptEnvelope` 函数 — 直接复用算法。

### 真实站点观察

- 主页：https://www.aowu.tv/
- 搜索：`/search?anime=<keyword>` （会 302 到 `/s/<token>?anime=...`）
- 详情：`/v/<token>`
- 播放：`/w/<token>#s=<source_id>&ep=<episode>`
- API：`POST /api/site/secure`

CDN host：`v16.toutiao50.com` 或类似 `lf*-imcloud-file-sign.bytetos.com` —
字节系，签名 URL，几小时有效，支持 Range。

---

## FAQ（用户可能问的）

### Q：用着用着报错了，是不是被反爬抓到了？

看错误前缀：

- `AOWU_RATE_LIMITED` → 是反爬（限流），等等
- `AOWU_UNREACHABLE` → 不是反爬，网络/5xx 临时问题
- `AOWU_STRUCTURE_CHANGED` → **不是反爬**，是站点改版了，找 Claude 重逆向

### Q：我换个 IP 能解决吗？

仅当 `AOWU_RATE_LIMITED` 频繁触发时换 IP 有用。其他错误换 IP 无效。

### Q：能不能跟旧版客户端共存？

可以。新版 client 的 `animeId` 是数字字符串（"2893"），旧版是 token 字符串
（"P0GqV7T0yre9"）。`watch()` 和 `resolveAowuMp4()` 都自动 `route(token)` 兼容。
旧队列任务能继续工作。

### Q：协议变了我自己能修吗？

如果只是字段名变了 — 改 `api.ts` 几行 type 和读取路径就行。

如果加密算法变了 — 需要逆向 obfuscated bundle，建议交给 Claude code 处理（按
本文档的 playbook）。

### Q：BrowserWindow 方案能再用吗？

可以，git 历史里 `e6e734f` 之前的版本是完整的 BrowserWindow 实现。如果未来
HTTP 路径完全跑不通（如加了 JS 挑战），可以 cherry-pick 回退。但记住 BrowserWindow
方案的代价：每次操作 5-15s + 启动 ~3s prewarm + 维护脆弱的 DOM 选择器。
