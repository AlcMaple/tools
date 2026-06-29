# BGM 失效后的国内直连替代方案调研

> 背景：BGM（Bangumi）现需魔法才能访问，用户的 Windows 机器无魔法，导致所有 BGM 功能（条目详情/番剧周期表/搜索/封面）失效。本文调研国内**无需 VPN 直连**的替代数据源。
>
> **本轮已按用户决策收敛：只保留国内直连可用、且不含 Bilibili 的源。最终采用 3 个源 —— 弹弹play（主干）+ 萌娘百科 + 百度百科（补简介）。** 其余源已全部排除，清单见文末「已排除清单」，请勿再重复调研。

---

## 1. 采用的数据源（国内无 VPN 直连）

| 源 | 直连可达 | 角色 | 依据/备注 |
|---|---|---|---|
| **弹弹play API** (api.dandanplay.net) | ✅ 可直连 | **主干**（周期表/搜索/详情/封面） | 国产服务、面向大陆优化 CDN。注：开发者注册门户 dev.dandanplay.com 部分组件需魔法，仅影响一次性注册，不影响运行时 |
| **萌娘百科** (zh.moegirl.org.cn) | ✅ 可直连 | 补中文简介 / infobox | .org.cn 国内运营；需浏览器 UA（否则 403），项目 BrowserSession 已具备。复用现有 `moegirl/synopsis.ts` |
| **百度百科** (baike.baidu.com) | ✅ 可直连 | 简介最后人工兜底 | 本土站点；但无官方 API、质量参差，低频谨慎使用 |

> 仅这 3 个源同时满足「国内直连 + 项目网络红线」。下文方案完全围绕它们展开。

---

## 2. 推荐方案（以弹弹play 为主干）

| 能力 | 主源 | 兜底源 | 说明 |
|---|---|---|---|
| **当季新番周期表** | **弹弹play** `bangumi/shin` | — | 返回带 `airDay`，可按星期分组 |
| **搜索（关键词→条目）** | **弹弹play** `search/anime` | — | 国内直连，需签名 |
| **条目详情** | **弹弹play** `bangumi/{animeId}` | — | 简介/集数/分集/封面/评分/放送/别名(titles)/职员/标签 |
| **中文简介（弹弹play 为空时）** | **萌娘百科** MediaWiki API | 百度百科（人工兜底） | 复用现有 `moegirl/synopsis.ts` |
| **封面 CDN** | **弹弹play** `imageUrl` | — | 见第 6 节 |

**与原 BGM 方案的最大区别：** 失去 Bilibili 后，弹弹play 从「字段补全/兜底」升为**唯一结构化主干**。代价是弹弹play **需要 AppId/AppSecret 签名**，且 2026-06-25 起启用配额分级，个人应用额度可能收紧——这成为本方案的核心风险点（见第 5 节）。

---

## 3. 番剧周期表

**弹弹play 当季新番**
```
GET https://api.dandanplay.net/api/v2/bangumi/shin   (需签名头)
返回 bangumiList[]: animeId / animeTitle / imageUrl / airDay(0-7) / isOnAir / rating / startDate
```
- `airDay` 即可对应原 BGM calendar 的「周一到周日」分组，在主进程归一化成原 calendar 结构即可。
- 数据按「当前在播季」给出，季度切换由弹弹play 侧维护。

> ⚠️ 待实测：`airDay` 取值约定（0=周日还是周一）需对照实际返回核实，避免周期表排错位。

---

## 4. 条目详情（字段映射）

以 **弹弹play `GET /api/v2/bangumi/{animeId}`** 为骨架：

| BGM 字段 | 弹弹play 来源 | 缺失时回退 |
|---|---|---|
| 标题 | `animeTitle` | — |
| 简介 | `summary` | **萌娘百科 extracts** → 百度百科 |
| 集数 | `episodeCount` / `episodes[]` 长度 | — |
| 分集 | `episodes[]`（episodeId / episodeTitle） | — |
| 封面 | `imageUrl` | — |
| 评分 | `rating`（**弹弹play 评分，非 BGM 体系**） | — |
| 放送日期 | `startDate / airDay` | — |
| 类型/标签 | `typeDescription` / `tags[]` | 萌娘 infobox |
| 别名 | `titles[]`（多语言标题） | 萌娘 opensearch |
| 职员(staff/CV) | `staff / characters / credits` | 萌娘 infobox |
| 回链 BGM | `onlineDatabases[]` / `bangumiId` | — |

**拼凑流程：** ① 弹弹play 取骨架 → ② 简介为空/质量差时调萌娘 `extracts` → ③ 萌娘也没有时百度百科人工兜底。

> 注：弹弹play 番剧库聚合自 AniDB + Bangumi.tv，其 `bangumiId` 多数实现按 `== bgm subjectId` 使用做回链，但官方未逐字担保等价，**待实测核实**。

---

## 5. 关键短板（无法 1:1 替代 BGM 之处）

1. **覆盖面：弹弹play 库是「日本动画 + 日剧 + 电影」**，**无漫画 / 轻小说 / 书籍 / 游戏 / 人物条目**。BGM 原本收书籍/游戏/音乐/人物，这块**无替代**——项目 `SubjectType` 中的 `manga / novel` 类目将失去数据来源，只能靠萌娘/百度人工补，且无周期表。
2. **签名 + 配额风险（核心）**。弹弹play 需 AppId/AppSecret 签名，且 2026-06-25 起配额分级，个人应用额度可能收紧。一旦限额，主干即受影响，需有降级/提示路径。
3. **评分体系不一致**。弹弹play `rating` 与 BGM 评分**不可混用**，UI 需标注来源（如「弹弹play 评分」）或放弃显示。
4. **萌娘 infobox 字段不规范**，话数/放送/制作键名不统一，冷门番条目可能稀薄甚至缺失；百度百科无 API、需谨慎低频抓取。
5. **简介质量**：弹弹play 简介来自上游聚合，中文质量不稳定，很多条目需回退萌娘才有像样中文简介。

> 诚实标注：`bangumiId == bgm subjectId` 等价、`airDay` 取值约定、弹弹play 配额数字均**未实测**。

---

## 6. 与现有架构的契合（最小改动）

**核心策略：保留 IPC channel 形状，只换底层数据源**（preload/renderer/env.d.ts 几乎不动）。

- `bgm:calendar` → 底层改调弹弹play `bangumi/shin`，按 `airDay` 适配成原 calendar 结构。
- `bgm:search` → 底层改调弹弹play `search/anime`，归一化成原 search 形状。
- `bgm:detail` → 按第 4 节拼凑（弹弹play 骨架 + 萌娘简介兜底），输出原 detail 结构，缺失字段给空值/默认（契合现有 `normalize()` 零迁移策略）。
- 新增 `src/main/dandanplay/`（calendar/detail/search + 签名工具），与 `xifan/girigiri/aowu` 平级；复用 `shared/net-request.ts`（Electron net 跟随系统代理）、`shared/rate-limit.ts`、`BrowserSession`（萌娘需浏览器 UA）。
- **网络红线全部满足**：走 netRequest、限速、失败 throw 给 UI 不自动重试、不上 IP 池/Playwright。

**封面 CDN 换弹弹play `imageUrl` 后，cover-cache / archivist 流程仍完全适用：**
- `bgm:cache-cover` 是「下载远程封面 → 存 userData → 经 archivist:// 提供给 renderer」，与来源域名无关，只换下载 URL 即可，**缓存与协议不需改**。
- 仍遵守「不持久化机器绝对路径、存可移植 URL、显示时经 useCover.ts 本地化」。

**签名实现：** 弹弹play v2 需在请求头带 `X-AppId` / `X-Timestamp` / `X-Signature`，签名为 `base64(sha256(AppId + Timestamp + Path + AppSecret))`。AppSecret 不可入库渲染层，放主进程；申请门户部分组件需魔法，但属一次性操作。

---

## 7. 可选兜底：BGM 国内反代/镜像开关

值得做，作为**保底**而非主方案。尤其在弹弹play 配额受限、或需要漫画/轻小说/人物（弹弹play 覆盖不到）时，反代能把 BGM「金标准」找回来。

- 形态：Settings 加「BGM 数据源」开关 → 「直连 / 国内反代（用户自填 base URL）」。反代 URL 由用户自填（Cloudflare Workers 反代 / 自建 / 社区镜像），**项目不内置固定镜像**（存续性不可控）。
- 红线兼容：反代仍走 netRequest 跟随系统代理，失败 throw 给 UI。

---

## 8. 落地优先级

**P0（恢复核心功能）**
1. 新增 `src/main/dandanplay/`：签名工具 + calendar（`bangumi/shin`）+ detail（`bangumi/{id}`）+ search（`search/anime`），复用 netRequest + RateLimiter。
2. `bgm:calendar` / `bgm:detail` / `bgm:search` 底层切到弹弹play，保持 IPC 返回结构不变，缺失字段给空。
3. 封面下载 URL 切到弹弹play `imageUrl`，沿用现有 cache-cover/archivist。
4. 简介为空时回退萌娘百科（复用 synopsis.ts）。
5. **实测确认**：`airDay` 取值约定、`bangumiId == bgm subjectId` 是否等价、签名头格式、配额上限。

**P1（兜底 + 健壮性）**
1. 加「BGM 国内反代」Settings 开关（用户自填 base URL），尤其用于漫画/轻小说/人物等弹弹play 覆盖不到的类目。
2. 百度百科作为简介最后人工兜底（无 API，低频谨慎）。
3. 弹弹play 配额/签名失败时的降级与 UI 提示路径。

**P2（增强 / 长期）**
1. 评估 manga/novel 类目的专门来源（弹弹play 不收；当前只能反代 BGM 或萌娘/百度）。
2. 接口健康监控：弹弹play 配额收紧时的告警与降级。

---

## 9. 多源组合补齐 BGM 类目缺口（第二轮调研增补）

> 弹弹play 只覆盖「日本动画/日剧/电影」，BGM 原有的【漫画】【轻小说】【游戏/人物】无来源。本章用「多源组合、各取所需」补这些缺口。**只纳入国内核查为 yes/partial 且不踩红线的源**，被推翻/被墙的进文末「已排除清单」。

### 9.1 新增可用源（按类目）

| 类目 | 源 | 域名 | 方式 | 能拿字段 | 定位 | 可达性 |
|---|---|---|---|---|---|---|
| 漫画 | **动漫之家 dmzj** | v3api.dmzj.com / v2.api.dmzj.com | api(JSON) | 标题/简介/作者/类型/状态/封面/**卷话章节数组**/热度 | **主源（唯一独苗）** | 中 |
| 轻小说 | **SF轻小说 sfacg** | api.sfacg.com | api(JSON) | 标题/作者/简介/封面/状态/标签/字数/**`/dirs` 卷-章两级目录** | **主源（国内最稳）** | 高 |
| 轻小说 | 轻小说文库 wenku8 | wenku8.net | scrape(GBK) | 日轻覆盖最好/别名/卷-章目录 | 覆盖补充 | 中(Cloudflare 国内不稳) |
| 人物/声优 | **萌娘百科** | mzh.moegirl.org.cn | scrape(已集成) | 姓名/别名/代表角色/公司/infobox | 主源 | 中(低频兜底) |
| 人物/声优 | 百度百科 | baike.baidu.com | scrape | 人物简介/职业/代表作 | 兜底(严禁批量) | 高 |
| 跨源ID映射 | **bangumi-data** | registry.npmmirror.com | static-json | bgm/bili/acfun/iqiyi/netflix 站点 ID + 放送档期 | **主源** | 高(淘宝镜像) |
| 跨源ID映射 | anime-offline-database | GitHub(gh-proxy) | static-json | MAL/AniList/Kitsu/AniDB ID + synonyms | 可选兜底(代理须可配) | 中 |

### 9.2 按类目拼图结论

- **漫画**：dmzj 一根独苗，能补到「搜索 + 详情 + 卷话进度」，章节数组天然适配追番进度。短板：别名/评分弱、无同级兜底，dmzj 域名迁移时只能靠 v2/v3 双子域互备，**属单点可用、需监控**。
  - endpoint：详情 `https://v3api.dmzj.com/comic/comic_${id}.json`（或旧 `http://v2.api.dmzj.com/comic/${id}.json`）；搜索 `http://v2.api.dmzj.com/search/show/0/${kw}/${page}.json`。免登录。
- **轻小说**：这次**补得最干净**的类目——sfacg 和 wenku8 都原生提供卷/章两级，正好对上现有「小说追番卷/章两级进度」store 模型（commit `0d3bbf4`）。策略：**sfacg 当可达性主源**（`/novels/{id}` + `/novels/{id}/dirs`，境内阿里云最稳），日轻覆盖不足时回落 wenku8（接受国内不稳、失败 throw）。
  - ⚠️ 与上一版相反：核查把 sfacg 判 yes、wenku8 判 partial，故主源换成 sfacg，wenku8 降为补充。
- **人物/声优**：萌娘（复用现有 `moegirl/synopsis.ts`，扩展加 infobox/人物 section 解析）为主，百度百科单条按需兜底。知名条目可补，冷门长尾两家都缺，**承认补不全**。
- **跨源 ID 映射**：用 bangumi-data（npmmirror 一线稳通道）替代原本设想的 Wikidata；需 MAL/AniList ID 再上 anime-offline-database。

### 9.3 静态数据集拉取渠道
- **bangumi-data → registry.npmmirror.com（淘宝镜像，阿里云 CDN，最稳）**：`GET registry.npmmirror.com/bangumi-data/latest` 取 `dist.tarball` → 下 `.tgz` → 解出 `dist/data.json` → 本地缓存。一次性拉快照，不做周期探活。
- **anime-offline-database → gh-proxy 公益代理**（如 ghfast.top，地址须 Settings 可配）：没上 npm、jsDelivr 只有旧快照、raw.* 有 DNS 污染。能用 bangumi-data 满足就别引它。

### 9.4 与现有架构契合（漫画/轻小说建议单开 IPC）
- 漫画「卷话数组」、轻小说「卷/章两级」与 BGM 的 episode 模型不同，**硬套 `bgm:detail` 会让返回类型臃肿**。建议新增 channel：`manga:search`/`manga:detail`（dmzj）、`novel:search`/`novel:detail`（sfacg+wenku8，detail 返回卷/章树）、`person:detail`（萌娘+百度）、`metaMap:resolve`（bangumi-data）。渲染层经 `siteApi.ts` 同款「源无关接口」抽象。
- 新增模块（与 bgm/xifan 同构）：`src/main/dmzj/`、`src/main/sfacg/`、`src/main/wenku8/`、`src/main/bangumiData/`、（可选）`src/main/animeOfflineDb/`；人物扩展直接改 `src/main/moegirl/synopsis.ts`。
- **强制复用**：netRequest（Electron net）、RateLimiter（dmzj/sfacg 各一实例）、BrowserSession（wenku8/萌娘/百度抓 HTML 用伪装 UA；dmzj/sfacg 的 JSON API 用诚实 `MapleTools/<ver>` UA——别混用）。轻小说 detail 卷/章结构直接对齐 `animeTrackStore` 进度模型。

### 9.5 取舍与诚实标注
- **游戏类目：完全无国内可直连、不踩红线的源，仍是空缺，无方案。**
- **萌娘百科口径更正**：实为 Cloudflare 后端、WAF 对非浏览器 UA 返 403，应表述为「⚠️ 国内时好时坏、仅低频兜底」（与 AniList 同构），不是「稳定直连」。
- 高风险需监控：dmzj（漫画唯一源，挂了无替补，双子域兜底）、wenku8（移动/电信高失败率、2024 曾传关站）、百度（反爬强，单条按需、严禁批量）、anime-offline-database（代理地址会变）。
- **全部未做大陆出口节点端到端实测**（核查本机 DNS 落在 198.18.x Clash fake-ip 黑洞段，不能作可达性证据）。落地前务必在真实大陆住宅网络对 `api.sfacg.com`、`v3api.dmzj.com`、`registry.npmmirror.com` 各做一次 200 实测。

### 9.6 更新后落地优先级（并入第 8 节）
- **P0**：① bangumi-data(npmmirror) ② sfacg 轻小说 API ③ dmzj 漫画 API ④ 萌娘人物/声优扩展（外加第 8 节弹弹play 三件套）。
- **P1**：⑤ wenku8 日轻补充 ⑥ 百度百科人物兜底（外加第 8 节 BGM 反代开关）。
- **P2**：⑦ anime-offline-database(gh-proxy，仅当需 MAL/AniList ID)。

---

## 待实测清单（落地前务必验证）
- [ ] 弹弹play `airDay` 取值约定（0=周日还是周一）
- [ ] 弹弹play `bangumiId == bgm subjectId` 是否真等价
- [ ] 弹弹play 签名头格式（`X-AppId/X-Timestamp/X-Signature`）与 2026-06-25 后个人应用配额数字
- [ ] 萌娘 api.php（extracts/parse）在主进程 netRequest + 浏览器 UA 下能否稳定 200
- [ ] 大陆住宅网络对 `api.sfacg.com` / `v3api.dmzj.com` / `registry.npmmirror.com` 各做一次 200 实测
- [ ] dmzj v3api/v2.api 双子域当前哪个可用、字段差异

---

## 已排除清单（结论已定，请勿再重复调研）

以下源经本轮调研 + 用户决策**明确排除**，后续不要再花时间探索：

| 排除源 | 排除原因 |
|---|---|
| **Bilibili 番剧 API** | 用户明确不要（即使技术上国内可直连） |
| **豆瓣** (douban.com) | 反爬极严，通用绕过手段全部踩中项目网络红线 |
| **bangumi/Archive**（GitHub Releases） | GitHub 国内需魔法，且是离线全量非实时 |
| **AniList** (anilist.co) | 躲在 Cloudflare 后，国内时好时坏，不能作生产稳定依赖 |
| **MyAnimeList / Jikan** (api.jikan.moe) | 国内被墙 |
| **TMDB API** (api.themoviedb.org) | 国内被墙（官方确认） |
| **AniDB** | 反爬极严，客户端直连即封 |
| **中文维基百科 / 镜像** | 国内被墙 |
| **acgsecrets.hk / yuc.wiki** | 未实测，且方案未依赖，不再追查 |
| **Wikidata** (wikidata.org / query.wikidata.org) | **第二轮核查推翻**：与 Wikipedia 共用 Wikimedia 自托管服务器，GFW 自 2019 起 IP 层整体封锁，**稳定不可达**（不是时好时坏）。跨源 ID 映射改用 bangumi-data 替代 |
| **漫画柜 manhuagui** (manhuagui.com) | 核查推翻：GFW 干扰 + 站点激进封 IP（下几话就封一天），非稳定直连；国内入口 mhgui.com 内容删减 |
| **哔哩哔哩漫画** (manga.bilibili.com) | 属 B站系，随 Bilibili 一并排除 |
| **腾讯动漫** (ac.qq.com) | 签名+JS 加密+混淆，取全字段需逆向/无头浏览器，踩红线 |
| **快看漫画** | JS 动态注入 + 国漫条漫为主，与 BGM 日漫单行本重合度低 |
| **哔哩轻小说 linovelib** | Cloudflare 强防护 + icomoon 字体加密，逼近红线 |
| **起点 / 轻之国度** | 字体反爬/登录墙/非结构化 + 与日轻交集小 |
| **番剧资源站**（AGE/樱花/OmoFun/风车/myself-bbs/Anime1 等） | 分省被墙 + 域名 2-3 月轮换 + 盗版聚合，稳定可达需 DNS/代理规避，踩红线；整类不作元数据源 |
| **Kitsu / Annict / ANN / Shikimori** | 无中文、需鉴权或 Cloudflare 强墙，国内可达性 unknown/no，收益低于成本 |
| **游戏类目（全部）** | 无任何国内可直连、不踩红线的游戏元数据源候选，**类目空缺，无方案** |
