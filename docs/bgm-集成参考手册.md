# BGM 集成参考手册

> 改 BGM 相关代码前**先看一遍**。本文档汇总：
>
> - 已落地的决策 + 落地原因
> - 已被否决的方案 + 否决原因
> - BGM 出问题时的诊断顺序
>
> 目的：让未来的我 / Claude **不再重新走已经走过的路**。新发现的踩坑场景
> 直接追加到对应章节，并在「修改历史」记一笔。

相关文档：
- [`功能索引.md`](./功能索引.md) §2 —— 完整代码文件索引
- [`bgm-简介解析-回归用例.md`](./bgm-简介解析-回归用例.md) —— 简介中日混排解析的回归用例
- [`ideas/003-BGM限流防御与错误反馈.md`](./ideas/003-BGM限流防御与错误反馈.md) —— 限流防御一期归档记录
- [`ideas/004-BGM登录与认证.md`](./ideas/004-BGM登录与认证.md) —— **登录方案否决记录（重点看 §2.7）**

---

## 1. 网络出口：唯一统一入口

### 落地决策

**所有 `api.bgm.tv` 请求必须走 `src/main/bgm/api-client.ts` 的 `fetchBgmApiJson()`**。

| 调用方 | 端点 | 走 client ✓ |
|---|---|---|
| `detail.ts` | `/v0/subjects/{id}` + `/v0/subjects/{id}/persons` | ✓ |
| `calendar.ts` | `/calendar` | ✓ |
| `search.ts` | `/v0/subjects/{id}`（别名 fallback 分支） | ✓ |

`bgm.tv` HTML 抓取走 `src/main/bgm/search.ts` 的 `rawGet()`（用 `BrowserSession`）。

### 不要再走的路

- ❌ 不要在 detail/calendar/search 里各自 `https.get` 打 `api.bgm.tv` —— 会绕过共享限速器和规范 UA
- ❌ 不要给 `api.bgm.tv` 用 Chrome 浏览器伪装 UA —— **跟 HTML 期望相反**，API 端要老实自报家门，HTML 端才装浏览器
- ❌ 不要在 renderer / preload 里直接 fetch BGM —— 全部走 IPC（`window.bgmApi.*`）

### 触发重启条件

只有当新增 BGM API 端点时，直接调用 `fetchBgmApiJson(newUrl)` 即可；**不要**新建网络出口模块。

---

## 2. User-Agent 规范

### 落地决策

**`api.bgm.tv` 请求 UA 格式**：

```
MapleTools/${app.getVersion()} (https://github.com/AlcMaple/tools)
```

格式来自 BGM 官方要求：`{app-name}/{version} ({contact})`。版本号走 `app.getVersion()` 自动跟 `package.json` 同步，发版后 UA 自动更新。

**`bgm.tv` HTML 请求 UA**：Chrome 浏览器伪装 UA（`BrowserSession` 从池子里随机挑一个 + 对齐 `sec-ch-ua`）。

### 不要再走的路

- ❌ **占位符 UA**（如 `tools/1.0 (github.com/user/tools)`）—— BGM 一查就知道是默认模板，触发风控概率高。**踩过坑**：之前用这个跑了好几天，限流频率明显高于正常
- ❌ **版本号写死**（`MapleTools/1.0`）—— 发新版本 UA 不变，BGM 无法区分客户端版本，运营上自找麻烦
- ❌ **匿名 UA / 不带 UA** —— BGM 默认拒绝服务，相当于纯爬虫
- ❌ **用 `python-requests` / `axios/*` 这种默认 UA** —— BGM 风控直接拦
- ❌ **api.bgm.tv 也用浏览器伪装 UA** —— 跟 HTML 期望相反，反而提高风控分

### 触发重启条件

无 —— 这是 BGM 官方明文要求，不要再讨论"要不要规范 UA"。

---

## 3. 限流防御（003 阶段落地）

### 落地决策

**`api.bgm.tv`**：500ms 间隔 + 200ms 抖动的共享 `RateLimiter`，所有端点串行节流。HTTP 429 抛 `RateLimitError`，带 `Retry-After` 秒数。

**`bgm.tv` HTML 搜索**：三层防御
1. **Layer 1 Timing**：2200ms 间隔（BGM 阈值约 2000ms，留 200ms 网络抖动余量）
2. **Layer 2 Browser fingerprint**：随机 Chrome UA + 对齐 sec-ch-ua + cookie jar
3. **Layer 3 Body detection**：识别 BGM 返 HTTP 200 + 中文限流页面（"您在 N 秒内只能进行一次搜索"）

**错误透传**：限流走 `RateLimitError(retryAfterSec)`，UI 据此显示倒计时。

### 不要再走的路

- ❌ **失败后自动重试**（曾经的 `withRateLimitRetry` / 5xx retry）—— 限流 / 5xx 之后再发一次就是在惩罚窗口里加戳，最坏算下来 1 + 网络层 retry + 5xx retry + 限流 retry = 8 次请求。已经全部撤掉，函数体从 `shared/rate-limit.ts` **物理删除**，**不要再加回来**
- ❌ **失败后试探"现在恢复了没"** —— 触发限流后任何"再试一个请求看看现在限不限"都会加剧惩罚。检测限流**只能**用用户主动发出的请求收到的状态码 / body 来判断，不能主动探测
- ❌ **把 2200ms 间隔调低**为了"快一点" —— BGM 惩罚窗口最长可到几十分钟，省下来的几百毫秒不值
- ❌ **静默吞错** —— 早期 `fetchPage` 把所有错误 catch 成 `null`，结果用户看到"没结果"以为没搜到，实际是被限流。现在错误一律抛到 UI

### 核心原则

区分**两类调用语义**，不要混淆：

**A. 失败后的行为**（严格禁止）

- ❌ 限流 / 5xx 失败后**应用层自动重试**
- ❌ 失败后**周期性探测**「现在恢复了没」
- ❌ 失败的请求"假装成功"（吞错返回 null）

**B. 正常情况下的派生调用**（允许，但要"软"）

只要满足「**失败即作废，不重试不探测**」就允许：

| 场景 | 实现 | 失败时的行为 |
|---|---|---|
| **SWR 后台刷新** stale 缓存（`refreshBgmSearchInBackground`） | 用户命中 stale → 后台**单次**调 BGM 刷新 | catch swallow，缓存仍 stale，**等下次用户主动搜同关键词**再触发 SWR |
| **+追番 派生 detail**（`ensureBgmTagsFilled`） | 用户加追番时数据缺 tag → 异步**单次**调 detail 补全 | catch swallow，下次 +追番 / 打开详情时再触发，加 800-2000ms 随机延迟错峰 |
| **邮件触发周历**（`calendar-mailer.ts`） | 用户配的定时任务触发周历 cache hit | 用户预先授权过，是用户行为的延时执行 |

**关键判定**：调用本身是不是"试探性 / 突破性"？

- ✅ 用户主动行为派生的**一次性**补全 / 后台优化 → 允许
- ❌ "失败之后再发一个看看" → 禁止
- ❌ "现在没动作但试着请求一下" → 禁止

### 当前的"非自动"语义（详细审计）

| 检测点 | 触发条件 | 行为 | 是否自动重试 |
|---|---|---|---|
| `api-client.ts` HTTP 429 | 用户发起的请求收到 429 | 读 `Retry-After`，throw `RateLimitError` | ❌ 不重试 |
| `search.ts` HTTP 429 | 用户发起的搜索收到 429 | throw `RateLimitError(30)` 兜底 | ❌ 不重试 |
| `search.ts` `detectLimit` | 响应 body 是中文限流页 | 解析 wait-N，throw `RateLimitError(waitN)` | ❌ 不重试 |
| `calendar.ts` 失败 | refresh=true 时拉周历失败 | throw 让 UI 看到 | ❌ 不静默 fallback |
| **整个 BGM 代码路径** | —— | —— | **零自动重试 / 零自动探测** |

所有"重试"都来自 **UI 上用户主动点击** `CountdownRetryButton`。倒计时归零之前按钮**可见但视觉警示**（强制点的话用户自己承担风险）。

### 触发重启条件

如果实测发现 500ms 间隔仍频繁触发限流，先排查 IP 惩罚窗口（见 §4），再考虑调高到 800ms / 1s。**不要**反向调低。

---

## 4. IP 滑动惩罚窗口

### 现状

BGM 不是简单的"窗口内 N 次"限流，它对触发过限流的 IP 维护一个**滑动惩罚计数器**：

- 触发过限流的 IP 在接下来一段时间内阈值会**变低**
- 频繁触发会让计数器累积，阈值越来越严
- 一般 **24-48 小时**不碰就清掉，恢复普通阈值
- 浏览器能上 bgm.tv 不代表 api.bgm.tv 没限你（两套独立限流策略）

### 应对路径（**全部是用户手动操作**，代码不做任何自动探测）

| 症状 | 用户诊断步骤 | 用户处置 |
|---|---|---|
| 频繁 timeout（10s 不响应） | 浏览器能开 bgm.tv 吗？能 → 多半 IP 惩罚 | 停手 1-2 小时 / 切网络（手机热点 / 不同 WiFi）验证 |
| HTTP 429 | 看错误面板里的倒计时 | 等倒计时归零再操作 |
| HTTP 5xx | 浏览器开 bgm.tv 能登录吗？不能 → 站点故障 | 等 BGM 自己恢复，跟我们无关 |
| HTTP 200 + 中文限流页 | `search.ts` 的 `detectLimit` 抓到限流页 → 转为倒计时 | 倒计时 + 自然等 |

**重申**：以上所有"诊断步骤"都是**人去做**（看错误面板 / 试着开浏览器 / 切网络），**代码不会**主动发任何"试探请求"去确认是否限流。详细审计表见 §3。

### 不要再走的路

- ❌ **以为限流是永久封禁** —— 不是，最坏几十分钟自动解除
- ❌ **靠重试解决限流** —— 见 §3，加重惩罚
- ❌ **写脚本压测验证限流阈值** —— 脚本本身就会显著加重 IP 标记，得不偿失。曾在 004 阶段考虑过，已否决
- ❌ **加自动健康检查 / 周期性试发请求** —— 同上，任何形式的主动探测都是反模式。**永远**只从用户主动发出的请求结果里被动判断状态

---

## 5. 鉴权（OAuth / PAT）——**已否决**

### 否决决策

完整决策记录见 [`ideas/004-BGM登录与认证.md`](./ideas/004-BGM登录与认证.md)。摘要：

**为什么不做**：

1. **BGM 没有 PAT 机制** —— bgm.tv/dev/app 只能"创建应用"然后跑 OAuth 2.0，没有"点一下生成 token"的快捷路径
2. **OAuth 实现复杂度高** —— 需要 App ID + App Secret（secret 进 bundle 即公开）+ BrowserWindow / loopback server 处理 redirect + 7 天 access_token 续期机制
3. **收益完全未经验证** —— BGM 官方文档**没有任何明确条款**说"鉴权后限速更宽松"。这是社区口口相传的传闻，没有可验证来源
4. **痛点已经被 003 解决** —— 03 之后正常使用基本不限流，004 优化的是"共享 NAT / 多人同 IP"的极端场景

### 不要再走的路

- ❌ **因为"听说登录后限流少"重启 004** —— 这句话出处不明，无法证伪也无法证实。需要**实测数据**才能重启
- ❌ **写脚本压测匿名 vs 带 token 对比** —— 脚本会加重 IP 标记，验证成本太高
- ❌ **尝试用 cookie session 模拟登录** —— BGM 有 anti-bot，不官方支持，脆弱性极高

### 触发重启条件

**同时满足**才考虑重启：

1. 有真实用户反馈他们经常被限流（不是猜测 / 不是传闻）
2. 并且有方法**实测验证**鉴权后限流阈值真的不一样（比如借朋友账号短期对比）
3. 复杂度评估时记得 OAuth + 7 天续期 + 401 降级 + Settings UI + 文档全套

---

## 6. 错误反馈链路

### 落地决策

**主进程**：`bgm/*.ts` 抛具体错误类型
- `RateLimitError(retryAfterSec, msg)` —— 限流
- 普通 `Error(msg)` —— 网络 / 超时 / 5xx / 4xx 等

**渲染进程**：`utils/errorMessage.ts` 的 `friendlyError()` 把原始错误分类成 `{ title, hint, raw, retryAfterSec? }`。

**UI**：`components/ErrorPanel.tsx`
- `retryAfterSec` 存在 → 显示 `CountdownRetryButton`（倒计时 + 用户可强制点，强制后视觉降级警示）
- 否则 → 普通 Try again 按钮

### 已识别的错误分类（覆盖到的）

- BGM 限流（429 / 中文限流页 / "已触发限流"字样）
- BGM 5xx（特别是 502，文案明确说"BGM 那边的问题"避免用户误以为自己网络挂了）
- 网络层（ECONNRESET / ENOTFOUND / TLS / fetch failed / 各种 timeout）
- 解析失败（parse / JSON / unexpected token）
- 验证码（captcha）

### 不要再走的路

- ❌ **统一兜底文案** —— 早期所有错误都是"网络请求失败"，用户被限流时以为是自己网络挂了一直重试，**加重限流**。现在每个分类有自己的针对性文案 + 行动指引
- ❌ **错误黑盒**（catch 后 return null）—— 早期 `fetchPage` 这么做，用户看到"没结果"以为没搜到。现在错误一律抛
- ❌ **timeout 走兜底分类** —— 早期 `lower.includes('request timeout')` 漏匹配裸 `'timeout'` 字符串，归到"出错了，暂时没法判断来源"。现已修复（commit `2f76820`）

### 触发重启条件

新错误模式出现 → 在 `errorMessage.ts` 加分类 + 文案；不要重新设计这套机制。

---

## 7. 简介解析

### 落地决策

`src/main/bgm/detail.ts` 的 `extractChineseSummary()` 处理三种 BGM 简介形态：

1. **中日并排（带 marker）** —— `[简介原文]` / `【简介原文】` 等 marker，前半中文段
2. **中日并排（无 marker 直接拼）** —— 滑动窗口探测假名密度 + 在窗口内找第一个假名字符当真实切点
3. **纯中文 / 纯日文** —— 整段假名密度判定（>5% 或 >10 个假名 = 日文）

详细回归用例 + 改动前 checklist 见 [`bgm-简介解析-回归用例.md`](./bgm-简介解析-回归用例.md)。

### 不要再走的路

- ❌ **按 `\n` 逐段判假名密度过滤** —— 短句日文段（如`物語の舞台は魔族特区"恩莱島"`假名只 2 个）会被误判成中文留下，长句被丢，整篇简介撕成 3 段碎句。已踩过的坑，详见回归用例文档「噬血狂袭 IV」
- ❌ **拿滑动窗口起点当切点** —— 窗口起点往往还在中文段内（窗口要往后看 30 字才凑够假名）。已踩过的坑，详见回归用例文档「Yes! 光之美少女 5 GoGo!」
- ❌ **改 `extractChineseSummary` 不跑回归用例** —— **必须**把回归用例文档里每个用例都在应用里打开过一次

### 触发重启条件

发现新的 BGM 简介格式踩坑 → 加进回归用例 + 修复 + 在「修改历史」记一笔。

---

## 8. 缓存策略

### 落地决策

| 数据 | TTL | 过期行为 |
|---|---|---|
| Xifan / Girigiri 搜索卡片 | 30 天 | 当 miss，走完整流程 |
| **BGM 搜索** | **14 天** | **SWR**：先显示旧结果，后台**单次**静默刷缓存。**失败直接作废**（catch swallow），等下次用户主动搜同关键词再触发 SWR，不重试不探测 |
| **BGM 详情** | **永久** | 命中就用（官方元数据几乎不变） |
| **BGM 周历** | **14 天** | `update=true` 强制刷新（用户点刷新按钮触发），失败抛错让 UI 看到（不静默 fallback） |
| Xifan watch（集数列表） | **不缓存** | 每次实时拉，连载新集数必须可见 |

### 不要再走的路

- ❌ **BGM 详情不缓存** —— 元数据几乎不变，每次拉浪费 + 容易触发限流。已经踩过，永久缓存最合适
- ❌ **周历 refresh=true 失败静默 fallback 到旧缓存** —— 用户点刷新后以为成功了实际没刷新，时间戳没变但用户没看到 → 困惑。003 阶段改成失败抛错，UI 明确反馈
- ❌ **SWR 失败后周期性重试** —— SWR 单次失败必须作废，等下一次用户行为触发新一轮，**不要**加 setTimeout / setInterval 周期性试探

### 触发重启条件

如果 BGM 改了某条数据语义（比如简介策略调整 / staff 字段重命名），可以**手动**删 `userData/search_cache.json` 局部清缓存，不需要改 TTL 策略。

---

## 9. 问题诊断顺序（实战 playbook）

碰到 BGM 报错时，按以下顺序排查，不要跳步：

```
1. 浏览器能开 bgm.tv 吗？
   能 → 你的网络没问题 → 走第 2 步
   不能 → 网络 / VPN / 代理问题，先解决基础连通性

2. 报错是 429 / "限流" / "已触发限流" / 中文限流页？
   是 → 看 retry-after 秒数等到归零，期间别点
   否 → 走第 3 步

3. 报错是 timeout / 大量请求 10s 不响应？
   多半是 IP 滑动惩罚窗口 → 停 1-2 小时 / 切网络验证
   切到手机热点后没问题 → 确认是 IP 问题，等 24-48h 衰减

4. 报错是 HTTP 5xx（特别是 502）？
   多半是 BGM 那边偶发故障 → 跟我们无关，等
   持续超过 1 小时仍 5xx → 上 https://bgm.tv 看看是不是全站维护

5. 报错是 4xx（非 429）？
   404 → 这个 subject id 在 BGM 上被删了 / id 写错
   403 → 罕见，可能 UA 不规范触发风控（确认 §2 的 UA 规则）
   400 → 请求参数错，代码 bug

6. 都不是 → 看 ErrorPanel 「Show details」里的原始错误
   - parse / JSON → BGM 改字段格式，需要更新解析代码
   - ECONNRESET / TLS → 偶发网络抖动，重试即可
   - 其他 → 加到 errorMessage.ts 分类，更新本文档
```

---

## 修改历史

> 每次动 BGM 相关代码 / 决策时在这里追一笔。

- **2026-05-18** 初版 —— 汇总 003 / 004 阶段沉淀 + UA 规范 + 诊断 playbook
- **2026-05-18** `2f76820` —— `errorMessage.ts` 修 timeout 分类漏匹配，归到「请求超时」并引导停手
- **2026-05-18** —— `api-client.ts` UA 从占位符 `tools/1.0 (github.com/user/tools)` 改成规范的 `MapleTools/${app.getVersion()} (https://github.com/AlcMaple/tools)`
- **2026-05-18** —— **物理删除** `shared/rate-limit.ts` 的 `withRateLimitRetry` 函数 + `RateLimitRetryOptions` 接口（003 阶段虽然已停用但函数体还在，留着是隐患 —— 未来人可能误认为"这是限流防御套件应该用上"然后接进新功能）。同步在 §3 加了完整审计表，明确"整个 BGM 代码路径零自动重试 / 零自动探测"
- **2026-05-18** —— **反悔**：上一条把 SWR 一起删是过度处理。用户澄清的原则是"**失败后**不重试不探测"，正常情况下的派生调用（SWR / ensureBgmTagsFilled / 邮件触发 calendar）是**需要**的。回滚那次删除：
  - 恢复 `refreshBgmSearchInBackground` + `dedupRefresh`，注释明确"失败 swallow，等下次用户搜索再触发"
  - 给 `ensureBgmTagsFilled` 加 800-2000ms 动态延迟 + 延迟期间二次检查（track 可能已删 / tag 已被别的路径补上 → short-circuit）。错峰防止用户连点 +追番 时多次 detail 调用挤一起触发限流
  - §3 「核心原则」彻底重写，区分「A. 失败后的行为（严格禁止）」vs「B. 正常情况下的派生调用（允许，但失败即作废）」两类语义，明确判定准则
