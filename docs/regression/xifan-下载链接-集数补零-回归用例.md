# Xifan 下载链接（集数占位符 / 补零）— 回归用例

Xifan 的下载是「拿第 1 集真实 URL → 推断出一个模板 → 用集号套模板拼出每一集 URL」。这块逻辑（`src/main/xifan/api.ts` 的 `buildTemplate` + `src/main/xifan/download.ts` 的 `formatEpUrl`）历来是雷区：不同源对集数文件名的写法不一致，**写死一种补零规则就会让另一类源 404**。

和 BGM 简介解析（见 `bgm-简介解析-回归用例.md`）一个性质——「大部分情况没问题」，但总有源用了你没兼容的写法。本文件维护**所有已知踩过坑的样本**。每次改下载链接相关逻辑之前 **必须** 把下面每个样本都过一遍确认没回归。

> ⚠️ **占位符 token 的解析逻辑目前有两份拷贝，改一处必须同步另一处**：
> - `src/main/xifan/download.ts` 的 `formatEpUrl` —— 真正下载时拼 URL
> - `src/renderer/src/stores/siteApi.ts` 的 `resolveEpUrl`（xifan 分支）—— 下载队列「复制 mp4 直链」时拼 URL
>
> 两者都得能解析 `{:d}` / `{:0Nd}` / 旧 `{:02d}`。只改一处的典型症状：能正常下载，但复制出来的链接里残留 `{:d}` 没被替换。

新发现 bug → 修复 + 把踩坑的番加进「测试用例」+ 在「修改历史」追一笔 commit 引用。

---

## 改动前 checklist

```
□ 「测试用例」里每个样本，按它的「ep1 真实 URL → 期望的 epN URL」核对拼出来的链接
□ 拼出来的 URL 直接能下（或丢给浏览器/NDM 能 200，不是 404）
□ 下载队列「复制 mp4 直链」复制出来的 URL 与实际下载用的完全一致（不能残留 {:d}）
□ 历史 localStorage 里残留的旧 {:02d} 模板仍能正确解析（兼容性别回归）
□ download.ts 的 formatEpUrl 与 siteApi.ts 的 resolveEpUrl 两份拷贝保持同步
□ 文件名不是集号的特殊集（OVA 等）：模板拼出 404 后回源解析能下到真实文件；普通集不触发回源（零额外请求）
□ 假 mp4（链接拼错但服务器回 HTTP 200 + 几 KB JSON 错误体）：不能当成功写盘、不能显示「完成」；触发回源解析真实直链，回源不成则报错（不是 done）
□ 旧 localStorage 任务（没有 epPages）恢复后普通集照常下载，特殊集报错行为同从前（不崩、不回源）
□ 发现新踩坑写法 → 加进列表 + 修复 + 「修改历史」记一笔
```

---

## 核心原则（别再违反）

- **集数的补零宽度必须从「第 1 集的真实 URL」推断，绝不能写死。**
  - ep1 是 `.../1.mp4`（无前导零）→ 后续集**不补零**：ep4 = `4.mp4`、ep10 = `10.mp4`
  - ep1 是 `.../01.mp4`（前导零、两位）→ 后续集**补零到两位**：ep4 = `04.mp4`、ep10 = `10.mp4`
  - ep1 是 `.../001.mp4`（三位）→ 补零到三位
- **端口、query、host 一律原样保留**，不要「归一化」。`:8088`、`?_cf_bypass_cache=1` 这类是源本身的东西；NDM 抓到的链接看起来没端口/带 query 是 NDM 自己的处理，不代表我们该改。大多数源能正常下，恰恰说明这些原样的部分是对的——动它就会把正常的大多数搞坏。
- 占位符 token 自带位宽信息（`{:d}` = 不补零，`{:0Nd}` = 补零到 N 位），随模板一起持久化，跨重启/跨设备自解释。
- **模板只能拼出「文件名 = 集号」的集。** 文件名不是数字的特殊集（OVA / SP 等，如 `.../OVA.mp4`）任何补零规则都拼不出来，唯一可靠来源是该集播放页 `watch/{id}/{srcIdx}/{ep}.html` 里 `player_aaaa.url` 的真实地址。所以模板拼出的 URL 探测到 **404**（且仅限 404——限流/5xx 仍按红线原样上抛，不许在这里重试）时回源解析一次再下。`epPages`（各源播放页 URL 模板）与 `templates` 平行持久化；回源解析出的真实直链经 `ep_url` 事件记进任务的 `epUrls`，「复制 mp4 直链」优先用它。
- **「假 mp4」也是「我们拼错链接」的一种，和 404 同等对待。** 有些 CDN（如 moedot）对拼错的链接不回 404，而是 **HTTP 200 + 几 KB 的 JSON 错误体**——光看状态码会被当下载成功，用户拿到一个点开「无法打开文件或流」的假 mp4。`mp4-range-downloader` 的 `probe` 据 `Content-Type`（json/html/text）或「无 Range 支持的 200 且体积 < 100KB」识别出来，返回 `not_media` outcome；xifan/download.ts 把 `not_media` 和 404 一起走回源兜底，**但文件名不同**：404（OVA）跟真实链接的文件名走，`not_media`（普通集模板拼错）保持常规集号命名 `{title} - 11.mp4`。回源拿不到（无 epPages / 真实链接相同 / 真实链接也是假 mp4）则报错，**绝不显示完成**。

---

## 测试用例

### 学园默示录（HIGHSCHOOL OF THE DEAD）— 不补零源 ⭐ 本文件的起因
- **现象**: 软件下不了，NDM 能下。
- **ep1 真实 URL**: `https://play.xfvod.pro:8088/X/X-学园默示录/1.mp4`（集号**不补零**）
- **软件曾经拼出（错误）**: `https://play.xfvod.pro:8088/X/X-学园默示录/04.mp4` → **404**
- **期望拼出**: `https://play.xfvod.pro:8088/X/X-学园默示录/4.mp4`
- **NDM 实际下的链接**（仅供对照，端口/query 差异是 NDM 自己的归一化，**不是**我们要改的点）:
  `https://play.xfvod.pro/X/X-学园默示录/4.mp4?_cf_bypass_cache=1`
- **历史踩坑**: `buildTemplate` 把 ep1 URL 里的集号无脑替换成字面量 `{:02d}`，`download.ts` 又用 `padStart(2,'0')` 填，**补零宽度写死两位**。多数源是 `01.mp4` 所以没暴露，本源用 `1.mp4` 就 404。修法：从 ep1 集号的原始写法（有无前导零、几位）推断 token。

### Re：从零开始的异世界生活 第四季 丧失篇 — 线路一「假 mp4」⭐ not_media 回源的起因
- **现象**: 线路一「秒下载完成」，下到的 mp4 只有 4KB、播放器报「无法打开文件或流」；显示成「下载完成 ✓」误导用户。线路二正常。
- **ep1 真实 URL（推断模板用）**: `https://apn.moedot.net/d/wo/2604/RE1z.mp4`（**ep1 文件名带个多余的 `z`**）
- **软件曾经拼出（错误）**: `buildTemplate` 按 ep1 推断 → 模板 `RE{:d}z.mp4` → ep11 拼成 `https://apn.moedot.net/d/wo/2604/RE11z.mp4`
- **ep11 真实 URL（F12 / 播放页 `player_aaaa.url`）**: `https://apn.moedot.net/d/wo/2604/RE11.mp4`（**这集没有 `z`**——同一部番不同集的文件名服务器自己就不一致）
- **拼错链接的服务器响应**: `RE11z.mp4` 不回 404，而是 **HTTP 200 + 约 4KB 的 JSON 错误体**（NDM 下出来就是个 .json 文件）。所以旧逻辑既不触发 404 回源、又被当成「下载成功」。
- **期望行为**: probe 识别出这不是视频（Content-Type 非 video / 无 Range 的小体积 200）→ `not_media` → 回源拉 `watch/3446/1/11.html` 解析出 `RE11.mp4` → 正常下载，文件名仍是常规集号 `{title} - 11.mp4`（**不**用 URL 里的 `RE11`）；「复制 mp4 直链」第 11 集复制出 `RE11.mp4`（epUrls 覆盖）。回源若也拿不到 → 该集报**错误**（不是完成），错误卡片上的「切换线路」按钮可一键换线重下。
- **不回归点**: 普通集模板一次就 206/200 且是真视频 → 不触发回源；限流/5xx 仍原样抛错、不回源（红线）；正片体积都 ≫ 100KB，`MIN_MEDIA_BYTES` 阈值不会误伤真视频。

### 「补零两位」常规源（回归对照，必须仍正常）
- **ep1 真实 URL 形如**: `.../01.mp4`
- **期望拼出**: ep4 = `.../04.mp4`、ep10 = `.../10.mp4`
- **说明**: 这是绝大多数 Xifan 源的写法，修「不补零」时**不能把这类弄坏**。`buildTemplate` 检测到前导零 → 生成 `{:02d}`，行为与从前完全一致。

### 学园默示录 — 最后一集是 OVA，文件名不是集号 ⭐ 回源解析的起因
- **现象**: 全 13 集，前 12 集模板正常，第 13 集按规律拼出 `.../13.mp4` → **404**。
- **ep13 真实 URL**: `https://play.xfvod.pro/X/X-学园默示录/OVA.mp4`（文件名是 `OVA`，任何补零规则都拼不出）
- **期望行为**: 模板拼出的 `13.mp4` 探测到 404 → 回源拉 `watch/{id}/{srcIdx}/13.html` 解析出 `OVA.mp4` → 下载成功，**文件名跟着真实链接走**，存为 `{title} - OVA.mp4`（拿什么名字就用什么名字，不硬套集号）；「复制 mp4 直链」该集复制出 `OVA.mp4` 那条（epUrls 覆盖），其他集仍走模板。
- **下载弹窗**: 集数网格第 13 格显示「OVA」而不是「13」——集名来自播放页选集列表（`parseEpLabels`，同一页面现成数据，零额外请求）；普通集（站点标注「第01集」/「01」这类）仍显示集号，From/To 输入框维持 1..N 序号语义。
- **不回归点**: 普通集（模板一次就 200）不触发回源，零额外请求；限流/5xx 不触发回源，照旧抛错给 UI。

---

## 修改历史

> 每次动 `buildTemplate` / `formatEpUrl` / 任何 xifan 拼 URL 的逻辑都在这里追一笔。

- **2026-06-29（下载器丢端口）** —— 接上一条 not_media 修复后，回源拿到的真实直链仍下不动（0% 报错），但同一条 URL 丢给 NDM / 浏览器能下。根因:moedot 的真实视频 `RE11.mp4` 会 **302 跳到非标端口** `https://bjdownload.pan.wo.cn:30443/openapi/download?fid=…`(联通网盘签名直链),而 `mp4-range-downloader` 里所有 `http(s).get` 的参数只给了 `hostname`+`path`、**漏了 `port`**,Node 默认连 443 → 连不上 → 0% 失败。修法:新增 `reqOptions(u, extraHeaders)` 统一构造请求参数并带上 `port: u.port || undefined`,4 处调用(resolveRedirects / probe / downloadChunk / streamToFile)全部改用它。顺带验证:该签名 `fid` 直链**可复用**(同一 URL 多个 Range 请求都 206),所以「解析一次重定向 → 8 线程共用 finalUrl」的架构无需改;`Content-Range` 给出总长 263200448 字节。
  - 触发样本:Re：从零 第四季 丧失篇 线路一(`RE11.mp4` → 302 → `bjdownload.pan.wo.cn:30443`)
  - 不回归验证:无端口的普通直链(`u.port===''` → `undefined` → Node 用协议默认端口)行为不变;带非标端口的源(如 xfvod `:8088`)现在也会**保留端口**请求(从前靠 CDN 恰好 443 也开着才没暴露)
- **2026-06-29** —— 修复线路一「假 mp4」：模板按 ep1（`RE1z.mp4`）推断，对 ep11（真实 `RE11.mp4`）拼出带多余 `z` 的错链接，服务器回 HTTP 200 + 4KB JSON 错误体，旧逻辑既不触发 404 回源、又被当「下载完成」。`mp4-range-downloader` 的 `probe` 现在带回 `Content-Type`，新增 `looksLikeErrorBody`（Content-Type 为 json/html/text，或无 Range 的 200 且体积 < `MIN_MEDIA_BYTES`=100KB → 判为假 mp4），`downloadByUrl` 返回新 outcome `not_media`（顺手把「已完成跳过」的二次 probe 合并掉，少一次请求，且让磁盘上残留的旧假 mp4 也能重新回源）；`xifan/download.ts` 把 `not_media` 和 404 一起走回源兜底，但 `not_media` 保持常规集号命名（`{title} - 11.mp4`，不套 URL 里的 `RE11`），404（OVA）仍跟真实文件名走；`aowu/download.ts` 同步加 `not_media` 错误文案（共用 `downloadByUrl`）。
  - 触发样本：Re：从零 第四季 丧失篇 线路一（ep1 `RE1z.mp4` → 模板 `RE{:d}z.mp4` → ep11 拼成 `RE11z.mp4`，真实是 `RE11.mp4`）
  - 不回归验证：真视频（206 或 video/* 的大体积 200）不触发 `not_media`；限流/5xx 仍原样抛错不回源（红线）；旧 localStorage 任务（无 epPages）回源拿不到时报错、不崩；下错的任务现在显示为「错误」而非「完成」，错误卡片「切换线路」按钮可一键换线重下
- **2026-06-11（二）** —— OVA 修复的三个收尾：① 回源下载的**文件名跟着真实链接走**（`download.ts` 新增 `nameFromUrl`，`.../OVA.mp4` 存为 `{title} - OVA.mp4`，不再硬套集号）；② 下载弹窗集数网格显示站点集名（`api.ts` 新增 `parseEpLabels` 从播放页选集列表解析，`XifanSource.epLabels` 带给渲染层，特殊集显示「OVA」、普通集仍显示集号）。选择器**必须**是 `[class*="anthology-list"]`（实测结构 `ul.anthology-list-play`），不能放宽成 `anthology`：`anthology-header` 里的「下集」按钮同样指向 `watch/{id}/{src}/{ep}.html` 且在列表之前，放宽会把对应集的集名污染成「下集」（已用学园默示录真实页面 HTML 跑过解析验证：新选择器解析出 `第01集…第12集|OVA`，宽选择器 ep2 = 「下集」）；③ 修「复制 mp4 直链」写死 `templates[0]` 的既有 bug——换源后复制出的还是原源链接，改为 `templates[sourceIdx]`。
  - 不回归验证：选集列表解析不到（模板改版等）→ `epLabels` 为空数组，网格回退显示纯集号，下载逻辑不受影响；From/To 与排除逻辑仍按序号（1..N），集名只是展示
- **2026-06-11** —— 修复 OVA 等「文件名不是集号」的特殊集 404。模板拼出的 URL 探测到 404（仅限 404）时，回源拉该集播放页解析 `player_aaaa.url` 的真实地址再下一次：`api.ts` 新增 `XifanSource.epPage`（播放页 URL 模板）+ `resolveEpRealUrl()`；`download.ts` 接 `epPages` 做回源兜底，解析出的真实直链经新事件 `ep_url` 通知渲染层；`downloadStore` 持久化 `epPages`（与 templates 平行）+ `epUrls`（回源解析结果），旧任务 normalize 为空、行为同从前；`siteApi.ts` 的 `resolveEpUrl` 优先用 `epUrls` 覆盖，模板替换逻辑未动；`mp4-range-downloader` 的 probe_failed 带上 HTTP 状态码供区分 404 与限流/5xx。
  - 触发样本：学园默示录（13 集，末集真实文件是 `OVA.mp4`，模板拼出 `13.mp4` → 404）
  - 不回归验证：普通集一次 200 不触发回源；限流/5xx 不回源、照旧抛错（红线）；旧 localStorage 任务（无 epPages）恢复后普通集照常、特殊集报错同从前；复制直链普通集仍走模板替换

- **2026-06-09** —— 修复「不补零源」被强制补零导致 404。`buildTemplate` 改为从 ep1 集号的原始写法推断：有前导零 → `{:0Nd}` 保留位宽，否则 → `{:d}` 不补零；`download.ts` 新增 `formatEpUrl` 按 token 携带的位宽格式化（兼容历史残留的旧 `{:02d}` 模板，语义不变）。
  - 触发样本：学园默示录（ep1 `1.mp4` → ep4 必须是 `4.mp4`，不是 `04.mp4`）
  - 不回归验证：补零两位的常规源（ep1 `01.mp4` → ep4 仍是 `04.mp4`）；旧 localStorage 里的 `{:02d}` 模板（`formatEpUrl` 解析为补零两位，与从前一致）
- **2026-06-09** —— 补修「复制 mp4 直链」：`siteApi.ts` 的 `resolveEpUrl` 当时还写死 `replace('{:02d}', ...)`，遇到新的 `{:d}` 模板替换不上，复制出来的链接残留字面量 `{:d}.mp4`（能正常下载，但复制功能拼错）。改成与 `formatEpUrl` 同款的 token 解析。教训：占位符解析有主进程 / 渲染进程两份拷贝，改一处必须同步另一处。
  - 触发样本：学园默示录（在下载队列里「复制 mp4 直链」，ep4 必须复制出 `.../4.mp4`，不能是 `.../{:d}.mp4`）
