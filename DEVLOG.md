# 开发日志（DEVLOG）

## 2026-07-01 docs: 新增 AI_GUIDELINES.md + DEVLOG.md

**效果**：
1. 项目根目录新增两份持续维护的文档——`AI_GUIDELINES.md`（AI 生成规范）和本文件 `DEVLOG.md`（开发日志）
2. 每次提交前都需要在 DEVELOG.md 对改动进行白盒记录,提交从下往上是最新的提交,并且要对同一个功能进行分类,无需分类的提交单独作为二级标题

## 安装包

### 2026-08-12 fix(build): 更新时自动结束旧进程，避免"无法关闭"卡死安装

**效果**：

1. MapleTools 有"关闭到托盘"设计，用户点 × 只是隐藏窗口、进程仍在后台/托盘运行；更新时旧安装包的 NSIS 检测到同名进程占用，会弹窗"MapleTools 无法关闭，请手动关闭它后重试"，取消则报 `Failed to uninstall old application files`，安装卡死。
2. 新增 `build/installer.nsh`，用 electron-builder 提供的 `preInit` 钩子（安装器最早期执行，早于自带的进程占用检测）静默 `taskkill /F /IM MapleTools.exe /T`，把旧进程连子进程一起结束掉，检测阶段就不会再发现运行中的实例，不再需要用户手动关闭。
3. `package.json` 的 `build.nsis` 加了 `"include": "build/installer.nsh"` 接入该钩子。此改动只影响**安装包本身**，仅对本次发布起（0.14.1）及之后新打出的安装包生效，用户手上已下载的旧安装包不受影响。

## 网页版

### 2026-08-15 fix(web): 多端切回页面时自动刷新追番状态

**效果**：

1. 同一账号在另一台设备修改后，旧页面重新获得焦点、从后台恢复可见或由浏览器恢复时会立即全量读取服务器；页面持续停留前台时每 15 秒只检查一次轻量 revision，变化后才拉完整追番列表。
2. `localStorage` 继续负责首屏秒开，但不参与新旧裁决；服务器快照始终是最终状态，并同时校正页面与缓存。
3. 同一账号的连续写入按用户操作顺序串行执行，避免先点的旧操作反而最后落库；队列最后一个请求无论成功或失败都会再拉一次权威快照，写入期间返回的旧 GET 与单条响应都不能长期覆盖服务器结果。

**关键数据流**：

![网页版多端追番状态校正](docs/devlog-assets/web-multidevice-tracks-sync.svg)

**边界 / 风险**：

1. 本次按「设备依次使用」设计：切回页面立即刷新，持续前台页面最迟约 15 秒发现其他设备的修改；没有为小规模站点常驻 WebSocket / SSE 连接。若以后要求两台设备同时操作并亚秒显示，再单独增加服务端推送。
2. revision 只用于判断用户追番状态是否变化；恢复前台仍执行全量读取，因此不递增 revision 的系统元数据回填也能在下一次切回时显示。

### 2026-08-15 fix(web): 防止追番同步覆盖并发修改

**效果**：

1. 桌面端整包上传的 `baseRev` 比对、追番集合替换与 `tracks_rev` 递增改在同一个 SQLite 立即事务中完成；事务开始前若网页已经写入新状态，旧整包固定返回 `409`，不会再误报成功并覆盖它。
2. 网页新增、编辑、删除追番与版本号递增一并提交；删除不存在的记录不再制造虚假版本变化，接口返回的状态与 revision 对应同一份已提交数据。
3. 追番状态读写不再等待最长 4～10 秒的 BGM 详情或周历网络请求；附属元数据改为后台补空值，并在落库前重新读取，避免覆盖等待期间由同步写入的较新字段。

**关键数据流**：

```text
旧：读 baseRev → 等外部周历 → 网页 PUT + rev → 旧整包覆盖 → 仍返回 200

新：整理上传数据 → BEGIN IMMEDIATE
                    ├─ 当前 rev != baseRev → ROLLBACK + 409
                    └─ 当前 rev == baseRev → 替换集合 + bump rev + COMMIT

网页 PUT / DELETE → BEGIN IMMEDIATE → 修改记录 + bump rev → COMMIT → 返回同一版本状态
```

**边界 / 风险**：

1. `tracks_rev` 只表示用户追番状态的变更；后台补标签、别名、首播日与封面不递增它，避免纯系统元数据让桌面端上传产生无意义冲突。

### 2026-08-15 feat(web): 邮箱验证码页支持快捷打开常用邮箱

**效果**：

1. 邮箱地址步骤新增 Gmail、Outlook、QQ 邮箱与 163 邮箱后缀按钮：已有本地部分时追加或替换域名，未填写本地部分时把光标放在 `@` 前继续输入。
2. 验证码步骤按邮箱域名显示对应官方收件箱入口，并兼容 `googlemail.com`、`hotmail.com`、`live.com`、`126.com` 与 `yeah.net`；非匹配邮箱不显示错误入口。
3. 发送、重发与校验结果共用固定高度的状态位，提示变化时不再挤动提交按钮。

**边界 / 风险**：

1. 后缀按钮只补全邮箱地址，收件箱按钮也只是打开固定官网；两者都不是 OAuth 或第三方免验证登录，MapleTools 仍以收到的 6 位验证码确认身份。
2. 收件箱链接不携带邮箱地址、挑战编号或验证码，并使用新标签页隔离、禁止 opener 访问和来源页传递。

### 2026-08-15 feat(web): 邮箱快捷注册与登录改为仅验证码

**效果**：

1. 邮箱入口统一为「邮箱地址 → 6 位验证码」：已有邮箱验证后直接登录，新邮箱验证后自动生成用户名、创建账号并登录，不再要求设置或确认密码。
2. 新邮箱账号明确标记为无密码账号；传统用户名 / 密码账号及已有邮箱账号继续兼容，密码登录、设置和找回接口不会把无密码账号误当成可验证密码的账号。
3. 登录成功后的 30 天安全会话保持不变；同一浏览器会话有效时无需重复验证，退出、换设备或 Cookie 失效后仍必须重新验证邮箱。

**关键数据流**：

![网页版邮箱仅验证码注册登录](docs/devlog-assets/web-email-otp-flow.svg)

**边界 / 风险**：

1. 新邮箱账号的新设备登录依赖 SMTP 正常投递；本次不批量关闭旧账号密码，避免邮件服务异常时影响已有用户。
2. 浏览器自动填充和设备信息不作为身份凭据；Google、Microsoft、QQ 等第三方授权登录需要平台应用凭据与服务端令牌校验，不在本次邮箱验证码流程里伪装实现。

### 2026-08-15 feat(web): 在线播放页支持切换稀饭与 Girigiri 源

**效果**：

1. 稀饭和 Girigiri 播放页新增独立「播放源」层；两站都已关联时可在播放器内直接切换，并保持当前集数，站内「线路」继续独立切换。
2. 播放链接携带稳定 `bgmId`，服务端分别读取 `xifan_binding` 与 `girigiri_binding`，不拿一个站点的编号猜另一个；换集后仍保留跨源上下文。
3. 切源、换集和离开页面都会先清理当前 video、HLS、iframe 与缓冲状态，再进入另一张既有播放页；媒体仍由浏览器直连源 CDN，不经过 MapleTools 服务器。

**关键流程**：

![网页版在线播放源切换](docs/devlog-assets/web-player-source-switch.svg)

**边界 / 风险**：

1. 未关联的源会明确显示「未关联」，仍需回「我的追番」完成一次候选确认；本次不在裸播放器里重复实现全站搜索和验证码弹窗。
2. 切源保持用户当前选择的集数，不猜测两站集数是否齐全；目标源没有该集时显示该播放器原有的真实错误。

### 2026-08-15 fix(web): 只显示与当前追番匹配的 Girigiri 候选

**效果**：

1. 点击某部追番的 Girigiri 入口时，周表候选只保留与当前标题或别名有明确关联的条目，不再因为都带「第二季」等通用后缀而混入其他番剧。
2. 低于有效相似度的结果会进入原有「Girigiri 全站搜索」兜底，仍由用户确认后才建立 `bgmId ↔ Girigiri` 绑定。

### 2026-08-15 feat(web): 设置页接入稀饭账号登录

**效果**：

1. 设置页新增「稀饭账号」模块，支持站点验证码登录、远端状态检查和退出。
2. 受限播放页可直达 `#/settings/xifan`；登录成功后，等待中的播放页会自动重新加载。
3. 登录页与全站搜索共用站点验证码，任一标签刷新验证码时，其他标签会立即作废旧图片和输入。

**关键流程**：

```text
#/settings/xifan → 检查状态 → 未登录：取验证码 → 提交登录
        │                                      │
        └──── storage 事件 ← 登录成功 / 验证码刷新 ─┘
                       ├─ 等待中的播放页重新加载
                       └─ 其他标签作废旧验证码
```

**边界 / 风险**：

1. 浏览器直接登录稀饭不会把 Cookie 复制给网页服务，必须在该设置模块中单独登录一次。

### 2026-08-15 feat(web): 稀饭播放复用账号登录态

**效果**：

1. 网页服务新增稀饭登录状态、登录与退出接口，并对账号和来源 IP 分别限制失败尝试次数。
2. 登录、验证码、全站搜索、播放列表和切换线路共用当前 MapleTools 用户的稀饭会话。
3. 匿名受限页返回「需要登录」，已登录仍受限则返回「账号权限不足」；登录结果缓存按用户和会话代次隔离。

**关键流程**：

```text
MapleTools uid ─┬─ auth / captcha / search ─→ 同一稀饭 Cookie 会话
                └─ playlist / resolve ──────→ 匿名共享缓存
                                           └→ 登录用户 + 会话代次缓存
```

**边界 / 风险**：

1. 稀饭会员权限仍由源站判定，登录成功不代表账号拥有所有资源权限。
2. VPS 无法复用 Electron 的隐藏 Chromium；遇到 UAM / Cloudflare 浏览器检查时只提示稍后再试，不模拟或绕过挑战。

### 2026-08-15 feat(web): 持久化稀饭账号会话

**效果**：

1. 每个 MapleTools 网页账号拥有独立的稀饭 Cookie 会话，服务重启后仍可恢复有效登录态。
2. Cookie 由 `AUTH_SECRET` 派生的密钥以 AES-256-GCM 加密写入 SQLite；账号、密码和验证码不落库。
3. 生产环境继续强制至少 32 字符的 `AUTH_SECRET`，轮换密钥会使 MapleTools JWT 与稀饭 Cookie 一起失效。

**关键流程**：

```text
MapleTools uid → 稀饭 Set-Cookie → AES-256-GCM 密文 → xifan_session
       ↑                                                    │
       └────────────── 服务重启后按 uid 解密恢复 ────────────┘
```

### 2026-08-08 perf(web): 优化稀饭线路一跳转后卡顿

**效果**：

1. 稀饭线路一从内嵌官方播放器改为网页原生 `<video>` 直连：播放页统一使用 `no-referrer`，可正常播放 `apn.moedot.net → pan.wo.cn` 的附件型 MP4；若个别浏览器直连失败，仍自动回退官方 iframe。
2. MP4 跳转或播放耗尽缓冲时，不再反复「播几秒、停几秒」：播放器先保留原进度与播放状态，以静音 1/16 倍速保持浏览器持续拉流；前向缓冲达到 10 秒后回到原进度、恢复原倍速与静音状态再播放。
3. 视频数据仍由浏览器直接向源 CDN 获取，不经过 MapleTools 服务器；HLS 线路继续沿用原有 hls.js 深缓冲，不受本次改动影响。

**关键流程**：

![网页版稀饭 MP4 缓冲闸门](docs/devlog-assets/web-xifan-mp4-buffer-gate.svg)

### 2026-08-08 fix(web): 防止用户名占用接口路径

**效果**：

1. 网页接口、页面和用户身份形成固定的三层命名空间：接口只走 `/api/*`，页面继续走 `#/...`，用户名只作为数据，不会参与服务端路由匹配。
2. 普通注册与邮箱注册共用用户名规则，新账号不能使用 `/` 等路径字符或 `api`、`assets` 等系统保留段；邮箱自动生成用户名也走同一校验，避免旁路。
3. 未定义的 `/api` 请求固定返回 JSON 404，不再被 VPS 的 SPA 兜底误返回成 `200 + index.html`；已有账号不迁移、不改名，登录不受影响。

**关键流程**：

```text
请求路径
├─ /api/*     → 已定义 Hono 接口 → 未命中则 JSON 404
├─ /assets/*  → 前端静态资源
└─ 其他 GET   → SPA index.html → 前端 #/ 路由

新用户名 → 字符白名单 + 路径保留段校验 → SQLite 身份数据（不拼接 URL）
```

### 2026-08-08 fix(web): 修复多端追番状态不一致

**效果**：

1. 同一账号在电脑、手机刷新后，追番总数与「在追 / 想看 / 看完」分类统一以服务器数据为准，不再被各设备的旧缓存长期分叉。
2. 仍保留追番页秒开：`localStorage` 先用于首屏展示，`GET /api/tracks` 返回后自动校正页面并覆盖缓存；上线后无需用户手动清缓存。
3. 若用户恰好在后台校验期间修改追番，当前标签页的内存计数会丢弃更早发出的读取结果，避免该旧响应立即盖回刚点击的状态。

> **2026-08-15 复核更正**：这里的「写操作版本号」不是服务器 `tracks_rev`，也不跨标签页或设备；当时只丢弃旧 GET，没有等待写入结束后补拉，更没有让持续打开的另一台设备自动刷新。因此它解决的是「刷新后旧 `localStorage` 反压服务器」，不能解释成实时多端同步。后续由「多端切回页面时自动刷新追番状态」补齐请求触发与写后权威校正。

**根因与关键流程**：

旧逻辑把浏览器缓存和服务器数据按每条记录的 `updatedAt` 做“谁新用谁”合并，但缓存时间戳可能来自旧部署、设备时钟或未完成的乐观更新。只要本机缓存时间大于服务器，该设备即使刷新并成功请求接口，也会继续保留旧分类。

```text
旧：本机缓存 ─┐
              ├─ 比 updatedAt ─→ 本机旧状态可能覆盖服务器 ─→ PC / 手机分叉
服务器数据 ───┘

新：本机缓存 ─→ 仅首屏秒开
    服务器数据 ─→ 整份校正页面 + 覆盖缓存
                     └─ 若本页已有写操作：丢弃更早发出的 GET 快照（当时没有补拉）
```

### 2026-08-08 feat(web): 新增邮箱快捷注册与登录

**效果**：

1. 注册登录增加「邮箱快捷登录 / 注册」：输入邮箱获取一次性验证码；已有邮箱账号验证后直接登录，新邮箱验证后设置密码，后续可用「邮箱 + 密码」登录。邮箱不会自动绑定旧用户名账号，避免无提示合并账号。
2. 验证码只存 HMAC，不存明文；10 分钟过期、单次使用、最多 5 次错误，按 IP / 邮箱限流，重发会使旧验证码失效；设置密码等原有凭证入口也继续按 IP / 账号限流。邮箱未配置 SMTP 时只停用新入口，不影响原有账号。
3. 浏览器自动填充邮箱只用于减少输入，不当作真实性证明；邮箱验证后写入 `users.email_verified_at`，在个人信息页显示邮箱凭据状态，并在登录态提示条中视为可恢复凭据。
4. 邮件通过 Nodemailer SMTP 发送：开发环境默认输出控制台验证码，生产通过部署目录外环境变量配置 SMTP。Google 登录的服务端验证边界与后续接入要求记录在 `docs/ideas/013-邮箱快捷注册与登录.md`。

**关键代码**：

```text
邮箱 → POST /email/start → email_challenge(HMAC(code), 10 min)
                         ↓
             POST /email/verify
                ├─ 已有邮箱 → 直接签发 httpOnly 会话
                └─ 新邮箱   → POST /email/register → 设密码 + email_verified_at
```

### 2026-08-07 fix(web): 加强 XSS 防护与会话安全

**效果**：

1. 存储型数据继续保留原文，但所有网页输出都走 React 文本节点；Bangumi 链接改由数字 ID 生成，封面和播放地址只接受安全协议，封面代理拒绝 HTML / SVG 等非栅格内容，避免恶意数据变成可执行资源。
2. 反射型与 DOM 型入口收紧：播放器的 `animeId` / `ep` 先在服务端校验，播放页内联脚本改用每次响应随机 nonce；统一 CSP、`nosniff`、禁止被嵌套、来源策略和权限策略，页面代码不使用 `innerHTML` / `eval` 等危险 sink。
3. 会话防护加固：生产缺少至少 32 字符的 `AUTH_SECRET` 时拒绝启动；会话改为 `__Host-mt_session; Secure; HttpOnly; SameSite=Strict`，账号 / 追番接口不缓存，写请求增加同源来源校验。密码修改 / 找回原有的 token version 失效机制继续生效。
4. 修复 Hono / Node adapter / Undici 以及开发构建链的已知依赖漏洞；生产依赖和完整依赖审计均为 0 vulnerabilities，Vite 开发页的 HMR 不被生产 CSP 误伤。Node adapter 升级后网页版运行时要求 Node.js 20+。

**关键代码**：

```text
用户输入 / 外部站点数据
        │
        ├─ JSON / SQLite ──→ React 文本节点（自动 HTML 编码）
        ├─ href / img / video ──→ https 协议与固定站点路径校验
        └─ 播放器 query ──→ 服务端参数校验 + URLSearchParams + textContent
                                      │
                                      ↓
                    CSP（self + 本次 nonce）/ nosniff / frame-ancestors
                                      │
                                      ↓
             HttpOnly + Secure + SameSite + __Host- Cookie（脚本不可读）
```

### 2026-08-07 feat(web): 新增 Girigiri 在线观看源

**效果**：

1. 追番卡片从只有稀饭一个在线入口变成稀饭 / Girigiri 两个并列入口；两个站点分别维护绑定，已绑定的资源直接打开，未绑定的资源先按官网周表匹配并让用户确认。
2. Girigiri 周表覆盖不到往季、剧场版时，可以进入 Girigiri 全站搜索；搜索沿用官网验证码流程，验证码 cookie 按 MapleTools 账号隔离，选中结果后保存 `bgmId ↔ GV…` 绑定。
3. 新增 Girigiri 播放页：读取官方 `/playGV{id}-{source}-{ep}/` 的 `player_aaaa`，支持 `encrypt=2` 的地址解码、繁中 / 简中线路切换和整季选集；HLS / MP4 地址由浏览器直接播放，直连失败时回退官方播放器 iframe，视频字节不经过 MapleTools 服务器。

**关键代码**：

官网入口会从 `bgm.girigirilove.com` 跳转到 `ani.girigirilove.com`。周表请求使用官网的 `POST /index.php/ds_api/weekday`，播放页使用 MacCMS 路由；`player_aaaa.url` 在 `encrypt=2` 时按「Base64 → percent decode」还原为 CDN `m3u8` / `mp4` 地址

```text
追番卡片
  ├─ 稀饭入口   → 稀饭周表 / 搜索 → 用户确认 → bgmId ↔ animeId → 稀饭播放页
  └─ Girigiri 入口 → Girigiri 周表 / 搜索+验证码 → 用户确认 → bgmId ↔ GV… → 播放页
                                                                    ↓
                                      player_aaaa → CDN m3u8 / mp4 → 浏览器 video
                                                                    └→ 直连失败 → 官方播放页 iframe
```

### 2026-08-07 fix(web): 修复继续看集数偏移

**效果**：

1. 追番卡片计数为 N 时，「继续看」显示并播放 EP N，不再错误跳到 EP N+1
2. 尚未开始的 0 集仍从 EP 1 播放；达到总集数时停留在最后一集，不再生成不存在的下一集链接

### 2026-08-07 feat(web): 稀饭支持搜索非周历资源播放

**效果**：

1. 往季旧番、剧场版等不在稀饭本季周表里的追番，点「继续看」后可改用稀饭全站搜索；完成验证码、选择正确资源后会记住绑定并直接进入现有播放页
2. 验证码 cookie 按登录用户隔离，不同用户同时搜索不会串验证码；错误验证码按接口 JSON 的精确 `code` 判断，不再把 `code=1002` 误判成成功
3. 本地开发缺少 `bgm_index.db` 时，「加番」搜索自动借线上公开搜索 API 返回结果；账号、追番数据和稀饭会话仍使用本地服务，生产环境继续读取自己的离线索引

**关键流程**：

```text
继续看 → 本季周表有候选 ──→ 选择资源 ──────────────────────┐
       └→ 无候选 → 全站搜索 → 验证码 → 搜索结果 → 选择资源 ─┤
                                                            ↓
                                              保存 bgmId ↔ xifanId → 播放
```

服务端为每个登录用户维护一个 15 分钟的短时稀饭 cookie 会话；搜索只负责定位 `xifanId`，视频仍走原有 `/playlist` + `/resolve` 浏览器直连链路，不经过 MapleTools 服务器传输。

### 2026-08-01 fix(web): 修复追番列表被更新时间打乱顺序

**效果**：

1. 改进度、改状态、加标签这类编辑不会再把那条追番顶到列表最前面

**关键代码**：

`/api/tracks` 一直是 `ORDER BY updated_at DESC` 查的，编辑一条就会 bump 它的 `updated_at`，下次拉取列表这条就跳到最前——本地起服务验证过：加三条测试记录、编辑中间那条的集数，前后顺序都是 `[111111, 222222, 333333]`，改完不再乱序：

```sql
-- server/tracks.ts listStmt（GET 列表和 app 同步共用同一条语句）
-- id 是自增主键、插入顺序，UPDATE 不会挪它
ORDER BY updated_at DESC  →  ORDER BY id ASC
```

### 2026-08-01 perf(web): 番剧周历 / 我的追番加缓存

**效果**：

1. 切一次 tab（周历 ⇄ 追番）不用再重新等一轮网络
2. 番剧周历信 14 天缓存窗口，跟服务端自己的缓存、桌面端一致；「刷新」按钮仍可强制绕过
3. 我的追番改成「秒开缓存 + 后台校验」：有缓存立刻渲染，同时后台悄悄拉一次最新数据按 `updatedAt` 合并（谁更新用谁）——手机改完电脑看、电脑改完手机看，最终都能看到最新数据，不会一直卡在旧的上
4. 追番列表和绑定数据按账号分开缓存，不同用户互不干扰
5. 两页共享同一份追番列表缓存（周历卡片的「已追」高亮和追番页列表本来就是同一批数据），谁先加载过谁替对方省一次请求

> **2026-08-15 复核更正**：本提交的后台校验只在页面挂载时执行一次；「最终都能看到最新数据」要求另一设备重新进入 / 刷新页面，并不覆盖持续打开的页面。现由后续「多端切回页面时自动刷新追番状态」增加恢复前台刷新与 revision 校验。

**关键代码**：

新增 `dataCache.ts`（localStorage 持久化，刷新页面/开新标签页也能秒开）和 `tracksSync.ts`（合并逻辑）：

```ts
// tracksSync.ts —— 以 server 的 id 集合为准，同一条谁 updatedAt 更新就用谁的内容
function mergeByUpdatedAt(server: Track[], local: Track[] | undefined): Track[] {
  const localMap = new Map((local ?? []).map((t) => [t.bgmId, t]))
  return server.map((s) => {
    const l = localMap.get(s.bgmId)
    return l && l.updatedAt > s.updatedAt ? l : s
  })
}
```

### 2026-08-01 style(web): 重构番剧周历 / 我的追番布局

**效果**：

1. 追番角标、BGM 外链、继续看、取消追番这几个核心操作，从「不 hover 就看不见」改成卡片上常驻显示——手机上第一下点击常被浏览器当成「模拟 hover」，不常驻的话这几个操作在触屏上几乎摸不到
2. 番剧周历的星期选择条不再置顶，只有顶部导航栏置顶，滚动时不会再出现画面断层
3. 卡片描边去掉了纯装饰性的 hover 变色

**关键代码**：

已追番的整卡描边之前用 `box-shadow: inset`，会被封面 `<img>` 盖住只在信息区露出一截，看起来像断层；改成两态统一 2px 的真 `border`（只变颜色，不挤动布局），border 是盒子边缘的一部分，不会被子元素内容盖住：

```tsx
<div className={`... border-2 ${on ? 'border-primary' : 'border-outline-variant/15'}`}>
```

### 2026-07-24 fix(sync): 修复追番星期、封面与拉取顺序

**效果**：

1. 从桌面端上传的本季追番可识别每周更新日
2. 外站封面不再误走 BGM 图床代理，手动添加的封面可以正常显示
3. 从网页版拉取后按桌面端原始添加顺序还原，不再被云端更新时间打乱
4. 桌面端手动条目可直接选择每周更新日

### 2026-07-24 fix(sync): 修复桌面端追番同步报错 404

**效果**：

1. 设置页可登录 MapleTools 网页版账号，登录后「我的追番」出现网页版上传 / 拉取入口
2. 同步沿用服务端 `tracks_rev` 冲突保护；两端都有改动时必须二次确认，旧 rev 上传返回 409 且不写入
3. 网页公共字段与 app 富字段分层传输，绑定、好看集、备注、小说进度和「观望」状态同步往返不丢
4. 坚果云手动同步入口保留为独立备份通道，不与网页版 rev 混用

```
renderer 追番记录 → 公共字段（网页可编辑）+ extra（app-only）
                  → 主进程持 JWT → /api/tracks/sync
```

### 2026-07-23 feat(web): 新增追番同步功能

**效果**：

1. 服务端新增 app 同步追番的能力
2. 网页实时直连、app 手动覆盖式拉取 / 上传

```
GET  /api/tracks/sync → { rev, data:[...含 extra] }
POST /api/tracks/sync → { baseRev, force?, data } → baseRev 对不上 = 409，一个字节都不写
```

### 2026-07-23 fix(web): 优化索引同步日志显示

**效果**：

1. 上游档要是出了半份，同步**不会**再把好索引换掉
2. 每周的同步任务挂了，加番弹窗里会直说「索引已 N 天没更新」

```
新库条数 < 上次 90%  →  删 tmp、不 rename、exit 1（cron 日志留痕）
                     →  确认无误要强推：--force
```

### 2026-07-23 feat(web): 搜索兜底在线补充

**效果**：

1. 搜本周刚上架、本地索引还没收录的新番也能搜到了 —— 本地一条都搜不到时，自动退回一次 BGM 在线搜。
2. 结果如实标来源：在线补上来的那批，列表顶上写「本地索引里没有，以下是 BGM 在线补充」。
3. 补不上也说人话：「BGM 限流了，过会儿再试」/「连 BGM 超时了」/「在线补充暂停中，约 N 分钟后恢复」，不糊成「网络请求失败」。

```
本地有结果 → 根本不进来（路由层保证：local.length 非 0 就 return）
├ 缓存命中（30min，含空结果）→ 不联网
├ 冷却中（连挂 3 次 → 停 10min）→ 不联网
├ 超每小时 40 次 → 不联网
├ 距上次不足 2s → 不联网（不排队：让用户干等不如让他改个词）
└ 打一次，失败不重试
```

### 2026-07-22 feat(web): 追番新增搜索功能

**效果**：

1. 追番不再只能从周历（当季）加 —— 新增「加番」搜索，覆盖 **BGM 全量约 3 万部动画**：老番 / 剧场版 / 往季都搜得到（2007 的 sola、辉夜大小姐全季…），搜到即加。
2. **搜索全程本地、零 BGM 在线请求** —— 搜的是本地 SQLite 索引（数据来自 BGM 官方离线档，每周同步一次，见下）。
3. **模糊匹配**：只记大概名字也搜得到（搜「漫画咖啡厅」出「漫画咖啡屋」），像 BGM 那样按共享片段排。
4. 加番自动补封面 + 标签（离线档没封面，加番时那一次 detail 顺带取，填进新追番）。

**数据来源**：BGM 官方数据档（`bangumi/Archive`，每周三更新，419MB zip）。`scripts/build-bgm-index.ts` 下档 → 流式解压取 `subject.jsonlines` → 只留 `type=2`（动画）→ 灌进**独立只读** `bgm_index.db`（原子替换；搜索端按 mtime 变化自动重开，不必重启）：

```
扫 65.8 万条 subject → 收录 3.05 万部动画（索引仅 5.6MB）
```

**模糊搜索**（`anime-index.ts`）—— 查询拆 **CJK 相邻二元组**、按命中片段数排，就软了：

```ts
// 漫画咖啡厅 → [漫画,画咖,咖啡,啡厅]；「漫画咖啡屋」共享 漫画/画咖/咖啡 三个 → 浮上来（拉丁词整段不拆）
const grams = queryGrams(q)
// WHERE 任一片段命中；ORDER BY 精确 > 前缀 > 整串子串 > 部分命中, 再按命中数、BGM 评分
```

搜索**只是查询层改动、不动索引**。加番默认「想看」；封面取 detail 的 `images.large`（前端 `coverUrl` 改写成 `/api/cover` 代理）。

**索引更新**：落在数据目录 `/opt/mapletools-data/bgm_index.db`，上线后先手跑一次，之后 cron 每周四（档周三更新，留一天余量）：

```bash
su -s /bin/bash mapletools -c 'cd /opt/mapletools/web && DATA_DIR=/opt/mapletools-data npm run sync:index'
```

- `DATA_DIR` **必须显式给**：那是 pm2 配置里的变量，cron / 手敲的 shell 不继承，漏了就写进部署目录里、线上永远读不到。
- 跑的时候**站点不用停也不用重启 pm2**（写 `.tmp` → rename 原子替换 → 服务端按 mtime 自动重开句柄）。
- `/api/search?q=` 空查询只回 `{ready,total,builtAt}`，当「索引同步到哪天了」的健康检查。

### 2026-07-22 fix(web): 修复稀饭直连失败问题

**效果**：

1. 追番卡片「继续看」按钮激活（原是灰占位）：点一下 → 定位到稀饭对应番剧 → 直接开播到**下一集**（EP = 已看 +1），跳过「开稀饭 → 搜索 → 输验证码 → 找番 → 翻集」整套。这就是 012 说的「追番 = 在线观看的快捷定位引擎」落地。
2. **首次点弹「选择稀饭片源」**让用户确认是哪部（按名字匹配周表候选），确认即**建绑定并记住**；之后同一部直接是链接、秒开，不再弹。
3. **绑定跨季持久**：周表换季后原番从周表消失，绑定仍在、照常开播。
4. **播放页参考 app 播放器重做**：标题 + EP 徽标、**集数网格**（整季一格一集、当前高亮，点即换集，从 watch 页扒集数列表）、线路卡片，玫瑰主色对齐 app/web 暗色主题。
5. **网盘下载型线路秒切 iframe**：`apn.moedot.net`→`pan.wo.cn/openapi/download` 这类**下载链接**，`<video>` 喂它会触发浏览器**下载 400MB**（还播不了）、白等几秒才切套娃 —— 现在按 URL **直接判死**走 iframe，不碰 `<video>`（`classify()` 里加的规则，各端一致、非 localhost 专属）。

**关键机制**：追番存 **BGM id**，稀饭播放页要**稀饭自己的 animeId**，两套编号、无确定映射，唯一联系是标题；而稀饭 search 有验证码（过不了）。突破口 = 稀饭「追番周表」的数据接口**不设验证码**，直接给出 animeId：

```
追番卡片「继续看」
  ├─ 已绑定 ───────────────────────────────→ 播放页(animeId, EP=已看+1)
  └─ 未绑定 → 周表匹配(免验证码) → 候选选择框 → [点确认 = 建绑定·落库] ─┘（之后走上面那条）
```

```ts
// server/xifan/weekday.ts —— POST 一个中文星期就回那天全部在播番，每条自带 animeId
//   POST /index.php/ds_api/weekday   body: weekday=一   (一/二/…/日)
//   → { code:1, list:[{ vod_id:3552, vod_name:"最强废渣皇子…", vod_remarks:"03|周一22:00" }] }
// vod_id 就是 animeId、vod_name 是中文名 —— 拿它跟追番标题比，把 bgmId 定位到 animeId
```

```tsx
// 卡片：绑过 → 原生 <a>（无异步、不吃弹窗拦截）；没绑 → 点了去周表定位、弹候选让用户确认
{binding
  ? <a href={playPageUrl(binding.xifanId, nextEp(t))} target="_blank">继续看 EP {ep}</a>
  : <button onClick={onContinue}>继续看 EP {ep}</button>}
```

播放路由（`resolve.ts` `classify()`）—— 下载型链接直接判 iframe：

```ts
if (/\.m3u8(\?|$)/i.test(url)) return 'hls'                                   // hls.js
if (/apn\.moedot\.net|pan\.wo\.cn|\/openapi\/download/i.test(url)) return 'iframe' // 302→网盘 download，直接套娃
return 'mp4'                                                                  // xfvod 干净直链 → <video> 直连
```

### 2026-07-21 test(web): 新增稀饭在线观看

**效果**：

1. web 新增稀饭在线观看后端 + 播放器原型（`server/xifan.ts` + `server/xifan/resolve.ts`）：给定稀饭 animeId → **浏览器直连源 CDN 播放，视频字节不经服务器**（零视频带宽，符合 012「视频不给服务器加码」）。目前是独立测试页 `/api/xifan/play-page`，**还没接追番卡片「继续看」按钮**。
2. **懒加载选线**：打开只抓 **1 次**（拿线路 1 地址 + 全部线路名单），线路 2/3 **点了才解析**。不并发、不自动选最优 —— 一串请求砸向稀饭像爬虫、会触发反爬 / 限流。
3. **按类型播 + 套娃兜底**：`.mp4` → `<video>` 直连；`.m3u8` → hls.js（CDN 回 ACAO 直连分片 + 深缓冲 10min、暂停也灌）；直连播不了 → 嵌稀饭真实播放器 iframe，兜住 content-disposition / 空壳 manifest / 编码。
4. **免验证码 + 秒回**：验证码只在 search，播放页 / 周表页都不设 → 当季番从周表页直接拿 animeId；解析结果进共享缓存，刷新 / 换人秒回。

![稀饭在线观看懒加载流程：打开抓一次（线路1+名单）→ 默认线路1 / 手动懒抓2·3 → 按类型播 + 套娃兜底](docs/devlog-assets/web-xifan-line-pipeline.svg)

**关键代码**：

打开只抓 **source 1 页一次**，就同时拿到「线路 1 地址」和「全部线路名单」—— 名单靠正则扒源 tab（web 侧不为几个 `<a>` 加 cheerio），**不用逐条解析**；线路 2/3 等用户点了才抓：

```ts
// server/xifan/resolve.ts —— getPlaylist
const body  = await fetchHtml(`/watch/${animeId}/1/${ep}.html`) // 一次
const first = parsePlayerData(body)?.url        // 线路 1 地址（顺手，打开即播）
const lines = parseSourceTabs(body)             // 源 tab → [{source,name}]，全部线路名，零额外请求
// 线路 N 等 resolveLine(animeId, ep, N) 在点击时才抓，绝不一次性并发（防反爬）
```

### 2026-07-17 feat(web): 新增我的追番

**效果**：

1. **周历卡片上能追番了**：hover 海报 → 右上角「＋追番」；已追的**整卡描边高亮**，逛周历一眼看出哪些在追。未登录不显示这个按钮。
2. **新增「我的追番」页**（`#/tracks`）：卡片墙 + 「今天更新」置顶分组（只算「在追」且今天放送的）。全部 / 在追 / 想看 / 看完四个 tab，搜索（**标题 + 别名**）、类型过滤（弹窗多选、按钮角标显示选了几个）。
3. **点封面开编辑弹窗**：改状态 / 进度 / 总集数 / 自定义标签，**没有保存按钮，改完即生效**。BGM 带来的标签不可编辑，自定义标签点一下删。
4. 进度 +/- 直接做在卡上。**在线观看按钮先占位置灰** —— 播放页还没做，位置是 `CalendarPage.tsx` 原注释就留好的。
5. 沿用 app 的既定语义：`totalEpisodes == null` = **连载中**（不是 0），徽章即手填入口；进度推满**不**自动切「看完」（用户填 12 不一定是看到 12）；只有「想看」首次 +1 自动转「在追」。

**关键代码**：

**写入一律「字段级 patch」，绝不整条替换**（ideas/012 的同步铁律）。现在还没接 app 同步，但这条从第一天就得立住，否则将来 app 推富记录过来会被 web 的瘦数据抹掉。body 里没给的字段**保持沉默、原样不动**：

```ts
// server/tracks.ts —— 只写 body 里明确给了的字段
if ('episode' in body) { sets.push('episode = ?'); args.push(...) }
if ('userTags' in body) { ... }
// 没给 → 那一列压根不进 UPDATE 语句
```

表结构同理为同步留好位置：瘦列（status / episode / 标签…）供 web 查询展示，`extra` JSON 列存 app-only 字段（goodEpisodes / bindings…）**原样过服务器往返**，现在空着但列先建好，将来接同步不用改表。

周历接口**不返标签也不返别名**，只有条目详情有 —— 没有这一步「按类型过滤」永远是空的、搜别名也搜不到。所以加追番后异步补一次 detail（服务端版的 app `ensureBgmTagsFilled`），三个细节都照抄 app：

```ts
// server/tracks.ts —— 抖动 800-2000ms 再发（防连点打出一串请求）
const jitterMs = 800 + Math.random() * 1200
setTimeout(() => {
  const recheck = oneStmt.get(uid, bgmId)          // ← 发前二次检查：这段时间用户可能已取消追番
  if (!recheck || parseList(recheck.bgm_tags).length > 0) return
  const d = await fetchSubjectDetail(bgmId)        // ← 一次请求同时拿回 标签 + 别名 + 放送日期
  // 不动 updated_at —— 这是系统回填，不是用户操作，不该影响「后写者胜」
}, jitterMs)
```

### 2026-07-17 fix(web): 番剧周历封面太糊

**效果**：

1. **周历封面从 150×211 换成 400×563**（11KB → 约 56KB）。原来取周历自带的 `images.common`，注释写「≈200px，卡片够清晰」——实测只有 **150×211**；卡片约 220px，在视网膜屏上是 440 物理像素，等于把 150 的图放大 3 倍，糊得没法看。
2. 全量 112 部约 5.8MB（原 1.2MB），但卡片是 `loading="lazy"`，实际只加载视口内那十几张 ≈ 1MB 上下。**注意周历的 14 天缓存只缓存 JSON，图片不经它**——图片挡在浏览器缓存（`immutable` 30 天）后面，服务器这边每个新访客的首屏都要真代取一次。
3. **没魔法的用户不受影响**：浏览器请求的仍是同源的 `/api/cover/...`，由海外 VPS 代取，链路改前改后一样。

![一张封面从 BGM 到用户屏幕，中间换了尺寸和路径](docs/devlog-assets/web-calendar-cover.svg)

**关键代码**：

周历那套老式路径没有中间档：`common` 之上直接跳到 `large`（2081×2928、916KB），只能改走图床的实时缩放接口 `/r/<宽>/pic/...`（底图就是 large）。**宽度只认白名单 `{100, 200, 400, 600, 800, 1200}`，填 480 这种看着合理的数会 HTTP 400 拿到空图、封面全裂**：

```ts
const COVER_WIDTH = 400
const m = (images.large ?? '').match(/^https?:\/\/[^/]+(\/pic\/.+)$/)
if (m) return `https://lain.bgm.tv/r/${COVER_WIDTH}${m[1]}`
```

封面代理原来只放行 `/pic/` 前缀，新形态是 `/r/400/pic/...`，白名单要跟着放宽——但仍然只认 `pic/` 那一段，不放行图床上的任意路径：

```ts
const COVER_PATH_RE = /^\/(r\/\d{2,4}\/)?pic\//
```

### 2026-07-17 fix(web): 番剧周历缓存丢失

**效果**：

1. **周历的 14 天缓存现在落盘**（`$DATA_DIR/calendar-cache.json`），重启后还在。之前缓存是进程内的 `let cache`，跟进程同生死 —— 而每次上线更新都要重启一次，于是「14 天 TTL」实际上是「14 天或到下次重启为止」，等于没有。开发期重启十几次就等于向 BGM 拉十几次。

![一次请求依次问三个地方，② 是这次新增的那层](docs/devlog-assets/web-calendar-cache.svg)

**关键代码**：

`DATA_DIR` 的解析从 `db.ts` 抽到新的 `server/data-dir.ts`。不直接从 `db.ts` 导出，是因为 `calendar.ts` 只要那个目录，为此 import `db.ts` 会把 `better-sqlite3`（原生模块，`vite.config.ts` 里标了 `ssr.external`）拖进周历的 import 图。

写盘先落临时文件再 `rename`——直接覆盖会在崩溃 / 满盘时留下半个 JSON，之后每次启动都读到坏文件；同分区 `rename` 是原子的，要么旧的要么新的：

```ts
const tmp = `${CACHE_FILE}.${process.pid}.tmp`
writeFileSync(tmp, JSON.stringify(entry))
renameSync(tmp, CACHE_FILE)
```

### 2026-07-17 chore(web): 降低后端为低权限

**效果**：

1. **后端不再用 root 跑**（见下图）。改用专用低权限用户 `mapletools`（系统账号、密码位锁死、无 authorized_keys，登不进来）。原来是 root：万一后端出 RCE，攻击者拿到的直接就是整台机器 —— 读 SSH 私钥顺藤摸到别的机器、删光备份、改 nginx 劫持流量。现在同样的漏洞只能拿到「读写网页版自己那个库」，`/etc/shadow`、root 的 `.ssh`、备份目录、nginx 配置、`sudo` 全部 `Permission denied`。
2. **备份目录故意留给 root**（`/opt/mapletools-backup`，700 root:root）。应用用户读不到也删不掉 —— 勒索软件第一步就是毁备份，备份和它保护的东西不能待在同一个权限域里。
3. **新增 [`docs/术语.md`](docs/术语.md)** —— RCE / 权限隔离 / 纵深防御 这些词的速查，只收这个项目真碰到过的。

![同一个 RCE，用什么身份跑决定损失多大](docs/devlog-assets/least-privilege.svg)

**关键代码**：

应用换用户后，pm2 守护进程是**按用户各一份**的 —— root 敲 `pm2 list` 会是空的。正确命令得 `su` + **`cd`**，而少了那个 `cd` 会报一个指向 node 的假错误（`spawn /usr/bin/node EACCES`，其实是 cwd 继承了 root 的 `/root`、700 进不去）。这种东西靠文档提醒人早晚出事，焊进 `/usr/local/bin/mtweb`：

```bash
exec su -s /bin/bash mapletools -c "cd /opt/mapletools/web && pm2 $*"
```

root 的 cron 备份会**悄悄夺走库文件属主**：root 打开 SQLite 时若 WAL/SHM 不存在，会新建成 root 所有，应用从此写不了自己的库 —— 而且要等到凌晨 4 点之后才爆。备份脚本末尾补一行：

```bash
chown mapletools:mapletools /opt/mapletools-data/web.db{,-wal,-shm}
```

### 2026-07-17 fix(web): 堵住能绕过 HTTPS 的后端直连端口 + 登录限流 + 数据库备份

**效果**：

1. **公网直连 `:3000` 关掉了**（见下图）。node 之前绑 `0.0.0.0` 且服务器没防火墙，`http://<ip>:3000` 从公网直接通 —— nginx 白装：登录密码明文过公网、HSTS/证书全不生效、`X-Forwarded-For` 随便伪造。改成只绑 `127.0.0.1`。
2. **登录 / 注册加了限流**。原来只有 `/forgot` 有 —— 因为密保答案熵低、想得到；`/login` 反而裸奔，连打错密码只会一直 401，从不 429。现在登录按 **IP 20 次 + 账号 10 次 / 15 分钟**双维度挡，注册按 IP 5 次/小时。
3. **数据库有备份了**。每天 04:00 `sqlite3 .backup` + gzip、留 14 天；库文件权限 `644 → 600`。之前线上有真用户数据、零备份。
4. **nginx 补了 HSTS + nosniff + X-Frame-Options + Referrer-Policy**。
5. **设置页「已保存」不再把整行按钮顶下去**，改成占按钮右边的常驻空位。删掉一批自曝式文案（数据存哪、为什么不回显问题、周历缓存多久…）—— 界面自明的东西再解释一遍只剩噪音，理由写进 docs 就够。
6. **补上了实际在用的部署文档**：`docs/web/唐人云部署保姆教程.md`。`docs/web/` 之前只有 Vercel 和 Oracle 两份**备选**方案的教程，真正在跑的这套（git pull + pm2 + nginx + certbot）反而没有，换机器就得从头摸。

![把后端从公网收回内网](docs/devlog-assets/web-loopback-bind.svg)

**关键代码**：

限流的 IP 只能认 `X-Real-IP`。`X-Forwarded-For` 是**追加**的（`$proxy_add_x_forwarded_for` 把真 IP 拼在客户端伪造值的**后面**），所以退化时要取最后一段；而 `X-Real-IP` 被 nginx 用 `$remote_addr` 整个覆写，伪造不了。这两个头可信的前提，正是效果 1 那条 —— nginx 之外没人进得来：

```ts
// server/node.ts —— 默认绑回环，要裸跑再显式给 HOST
const hostname = process.env.HOST || '127.0.0.1'
serve({ fetch: app.fetch, port, hostname }, …)

// server/auth.ts
function clientIp(c: Context): string {
  const real = c.req.header('x-real-ip')
  if (real) return real
  return c.req.header('x-forwarded-for')?.split(',').pop()?.trim() || 'local'
}
```

登录两个维度都要挡，且**放在 `verifySecret` 之前** —— scrypt 很吃 CPU，先限流顺带挡住拿登录接口打 CPU 的玩法。成功后要清账，否则用户自己打错几次的额度会留着替攻击者扣：

```ts
const ipKey = `login-ip:${clientIp(c)}`
const userKey = `login-user:${username.toLowerCase()}`
// 只按账号挡不住「换着号猜」，只按 IP 挡不住「多 IP 盯一个号猜」
if (rateLimited(ipKey, LOGIN_MAX_PER_IP, WINDOW) || rateLimited(userKey, LOGIN_MAX_PER_USER, WINDOW)) {
  return c.json({ error: '尝试次数过多，请 15 分钟后再试' }, 429)
}
const ok = row ? await verifySecret(password, row.pass_hash) : await verifySecret(password, 'x:x')
if (!row || !ok) return c.json({ error: '用户名或密码错误' }, 401)
buckets.delete(ipKey); buckets.delete(userKey)   // ← 登录成功即清账
```

### 2026-07-16 feat(web): 顶栏导航 + 设置页 + 找回密码

**效果**：

1. **顶栏导航**取代原来塞在周历页右上角的登录入口 —— app 是侧边栏（桌面应用的语言），网页的惯例是顶栏，这里不照搬 app。左边品牌 + 「番剧周历」，右边未登录 = 「登录 / 注册」，已登录 = 用户名 chip → 下拉（设置 / 退出）。周历页的面包屑一并去掉：顶栏已经指明在哪，再来一层是冗余。
2. **设置页**（`#/settings`）：左栏身份卡 + 模块导航（个人信息 / 账号安全，「追番偏好 / 数据同步」占位待开发），右栏模块面板。加了 20 行 hash 路由 —— 只有两个页面，引 react-router 不划算，但纯 state 会让地址栏不变、设置页刷新就回周历也收藏不了。
3. **找回密码**：账号 + 密保问题 + 答案 + 新密码。密保问题走**预设下拉**而不是自由填写 —— 自由填写找回时要一字不差重打一遍（没人记得住），按用户名把问题显示出来又等于泄露给任何知道你用户名的人；预设下拉两头都躲开。**问题和答案设置后都不回显**，只报「设没设」（问题本身也是秘密，泄露了等于告诉别人该去查什么）。答案跟密码同样走 scrypt 哈希、比对前 trim + 转小写。
4. **账号安全设置**：新密码留空 = 只改密保。改密码和改密保**两条路都强制验原始密码** —— 否则别人借你没锁屏的电脑就能悄悄把密保换成自己的，从此随时能接管账号。
5. **改密码 / 找回密码现在能真正踢掉所有设备**（见下图）。用户名上限 20 → **12**（顶栏 chip 按内容伸缩，12 个中文 ≈ 205px 放得下，20 个会到 ≈305px）。密保没设时登录后给一条提示条引导去设置（不强制）。

![token_version 让改密码真正吊销所有会话](docs/devlog-assets/web-auth-token-version.svg)

**关键代码**：

无状态 JWT 默认**没法吊销** —— 它自证，验的时候不查库，所以改了 `pass_hash` 那张老 token 照样有效。加一列 `token_version` 塞进 payload，验签后再比一次，就有了真吊销：

```ts
// server/auth.ts —— 验证时多比一次 tv
export async function getSession(c: Context): Promise<Session | null> {
  const payload = (await verify(token, SECRET, 'HS256')) as unknown as Session
  const row = findById.get(payload.uid) as UserRow | undefined
  if (!row || row.token_version !== payload.tv) return null // ← 改过密码 → 老 token 当场作废
  return { uid: row.id, username: row.username, tv: row.token_version }
}

// 改密码 → tv+1 让所有老 token 失效，但得给本机补发，否则自己也被踢下线
bumpPassword.run(await hashSecret(next), s.uid)
const fresh = findById.get(s.uid) as UserRow
await issueSession(c, { uid: fresh.id, username: fresh.username, tv: fresh.token_version })
```

自绘下拉 `Select.tsx` 把 `AI_GUIDELINES`「UI/样式」新增的两条固化成组件（原生 `<select>` 展开是系统弹层跟设计系统无关；浮层宽度要对齐触发器）——顶栏用户名 chip 的下拉同一套做法：外层 `relative` 收缩包裹，浮层 `w-full` 自动跟触发器同宽，用户名多长下拉多宽。

```tsx
<div className="relative">
  <button className="w-full …">…</button>
  <div className="absolute left-0 w-full …">…</div>   {/* ← 100% = 触发器宽 */}
</div>
```

### 2026-07-15 feat(web): 新增注册 / 登录

**效果**：

1. 网页版加**开放注册 + 登录**：注册（用户名 + 密码 + 确认密码）/ 登录（用户名 + 密码）/ 登出；会话是 httpOnly 签名 cookie，刷新 / 换设备自动保持登录态。数据落**本地 SQLite**（`better-sqlite3`），用户名大小写不敏感唯一，密码 **scrypt** 哈希（Node 内置，不加依赖）。
2. 登录入口**融入周历页右上角**：未登录 = 「登录 / 注册」按钮 → 弹窗（压在暗化周历上、MD3 卡片、登录 / 注册分段切换）；已登录 = 用户名 chip + 退出。**周历本身公开**，登录只是附加层（app 版没有账号，这是网页版独有）。

![注册 / 登录会话流](docs/devlog-assets/web-auth-flow.svg)

**关键代码**：

密码 scrypt 存 `salt:hash`、校验走定时安全比较（防时序侧信道）；会话不建 session 表，直接签 JWT 进 httpOnly cookie：

```ts
// server/auth.ts
async function hashPassword(pw: string) {
  const salt = randomBytes(16)
  const derived = (await scryptAsync(pw, salt, 64)) as Buffer
  return `${salt.toString('hex')}:${derived.toString('hex')}` // 存 salt:hash
}
// 登录 / 注册成功 → 签发会话 cookie
const token = await sign({ uid, username, exp }, SECRET, 'HS256')
setCookie(c, 'mt_session', token, { httpOnly: true, secure: PROD, sameSite: 'Lax', maxAge: 30 * 86400 })
```

DB 文件位置有部署铁律：必须放 `/opt/web` 之外（部署一条龙 `rm -rf /opt/web` 会清空），生产走 env `DATA_DIR=/opt/mapletools-data`、dev 落 `web/data/`；上线还要设 `AUTH_SECRET`（JWT 密钥）。详见 `docs/ideas/012-网页版.md`。

### 2026-07-15 fix(web): 修复封面无法显示问题

**效果**：

封面代理从「查询参数带完整图床 URL」（`/api/cover?u=https://lain.bgm.tv/...`）改成**路径式** `/api/cover/pic/...`：前端把图床 URL 的路径拼到 `/api/cover` 后，host 由服务器写死 `lain.bgm.tv`、只放行 `/pic/`。封面 URL 里**不出现被墙域名**，国内免魔法访问时封面也能正常显示；host 写死顺带把 SSRF 面堵死。（查询参数版为什么在国内失败，见 `docs/ideas/012-网页版.md` 的「部署纪要」。）

**关键代码**：

```ts
// server/index.ts
app.get('/api/cover/*', async (c) => {
  const path = c.req.path.replace(/^\/api\/cover/, '')   // /pic/cover/c/48/4a/xxx.jpg
  if (!path.startsWith('/pic/')) return c.text('forbidden', 403)
  const up = await fetch(`https://lain.bgm.tv${path}`, { signal: AbortSignal.timeout(15000) })
  c.header('Cache-Control', 'public, max-age=2592000, immutable')
  return c.body(up.body)
})
```

```tsx
// src/api.ts —— 前端把图床 URL 重写成不含 bgm.tv 的路径
export function coverUrl(raw: string): string {
  const m = raw.match(/^https?:\/\/[^/]+(\/.*)$/)
  return m ? `/api/cover${m[1]}` : ''
}
```

### 2026-07-15 feat(web): 新增网页版 - 番剧周期表

**效果**：

1. 新增 `web/` 子项目 = 网页版（Vite + React + Tailwind 前端 + Hono 后端），**同仓库、结构隔离**：自带独立 `package.json` / `node_modules`，根 `package.json` 一行不动，app 的 tsconfig / electron-vite / electron-builder 都扫不到它 → 对 app 零影响。开发 `cd web && npm run dev`（app 仍是根目录 `npm run dev`，两者不同目录 / 不同运行时，不会混）。
2. 首个功能 **番剧周期表** 端到端跑通：前端 → Hono `/api/calendar` → 抓 `api.bgm.tv/calendar` → 渲染。设计**照搬 app 的 AnimeCalendar**（MD3 色 token / Inter+Space Grotesk 字体 / 3:4 海报卡 / `<1200px` 切「选天 + 多列网格」响应式）；图标改**内联 SVG**（弃 material-symbols 的 3.9MB 字体 —— 网页版按网络下载算这 3.9MB 太亏，app 本地读则无所谓）。
3. 抓取逻辑从 app `src/main/bgm` **拷来、只换传输层**（Electron `net` → `fetch`），app 侧零改动（见 `docs/ideas/012-网页版.md`）。
4. 服务器 / 部署定**海外香港 CN2 VPS**（阿里云大陆机实测 `curl` BGM 超时、够不着 → 走海外）；后端 Hono 一套代码本地 / Vercel / VPS 通吃（`server/node.ts` = `@hono/node-server` 服务 `dist` + `/api` 的生产入口）。

**关键代码**：

封面必须走服务器代理 —— **BGM 图床 `lain.bgm.tv` 国内被墙**，浏览器直连拿不到（国内免魔法用户封面会全裂）；由海外服务器代取，只放行 `bgm.tv` 防 SSRF，并取 `common` 小图（937KB → 11KB，省 6M 小机带宽）：

```ts
// server/index.ts
const COVER_HOST_RE = /(^|\.)bgm\.tv$/
app.get('/api/cover', async (c) => {
  const url = new URL(c.req.query('u')!)
  if (url.protocol !== 'https:' || !COVER_HOST_RE.test(url.hostname)) return c.text('forbidden', 403)
  const up = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) })
  c.header('Cache-Control', 'public, max-age=2592000, immutable')
  return c.body(up.body)
})
```

传输层可挂代理 —— Node 的 `fetch`（undici）默认**不读系统代理**，跟 app 当年 Node `https` 直连 fake-ip 黑洞是同一个坑；`EnvHttpProxyAgent` 认 `HTTPS_PROXY` 环境变量（本地 Clash 非 TUN 时用得上，香港机 / Vercel 没这变量 → 直连）：

```ts
// server/http.ts
setGlobalDispatcher(new EnvHttpProxyAgent())
```

## 妙语库

### 2026-07-13 fix: 妙语库进页面无提示「云端有更新」

**效果**：

1. 别的设备上传后,这台设备一进「妙语库」页,同步条就**主动**显示「云端有更新」;本地有没传的改动显示「本地未上传」,两边都改显示「本地与云端都有变化」——配色/文案跟追番、锦囊妙计一模一样。之前只有点上传/拉取时才知道云端状态。
2. 冲突判定沿用同一套:上传时云端 rev 比上次同步新 / 拉取时本地有未推送改动 → 二次确认才覆盖。

**数据 / 状态流**：

![妙语库同步状态流](docs/devlog-assets/miaoyu-sync-state.svg)

**关键代码**：

进页面后台 pull 一次读 `_rev` → `remoteRev`,`cloudNewer = remoteRev > lastSyncedRev`;push / pull 后把 `remoteRev` 和 `lastSyncedRev` 一起改成新值,自己刚同步不误报。

```tsx
// pages/MiaoyuLibrary.tsx
useEffect(() => {
  window.webdavApi.pull('miaoyu')
    .then((s) => setRemoteRev(parseRemoteBlob(s).rev))
    .catch(() => {})            // 未配置 / 无远端 / 网络 → 静默
}, [])
const cloudNewer = remoteRev !== null && remoteRev > lastSyncedRev
```

这一探测拉的是整份 blob（含图片 base64、体积可能不小）—— 只进页面探一次、不轮询,是为与另两处一致的主动提示而接受的代价（推翻了原来"太重不探测"的注释）。

## 在线观看

### 2026-08-14 fix(xifan): 修复在线观看显示报错却播放问题

**效果**：

1. 点开在线观看，等待期间不再出现「只有声音、没有画面」的播放声；暂停后、退出播放页后也不再有残留声音。
2. 不再出现「稀饭安全检查未完成」报错、但其实能正常播放的矛盾情况。
5. 报错文案会指出**当时真正卡在哪一步**（等待首次加载 / 等待导航落到稀饭域 / 安全检查中 / 页面正在被刷新），不再一律说成「安全检查未完成」。
6. 搜索/取集数速度变快

**关键流程**：

点一次「在线观看」，整条链路怎么走（两个平台同一条路径）：

![点在线观看之后：搜索分支 / 缓存分支 / 解析 / 播放](docs/devlog-assets/xifan-play-entry-flow.svg)

其中主进程隐藏窗口与渲染层播放器的分工，以及本次实测耗时：

![主进程隐藏窗口与渲染进程播放器各自做了什么](docs/devlog-assets/xifan-play-two-lanes.svg)

**边界 / 还存在的问题**：

- **拦截跨源子资源有风险**：若稀饭日后把安全检查改成依赖**跨源**脚本，那个脚本会被过滤器拦掉，表现为检查永远过不去（不是报错，是卡住直到超时）。现有判断是「UAM 的 `fl_ua` 机制与 Cloudflare `/cdn-cgi/` 挑战都是同源」，属于判断而非证据。真出现这种情况，改法是把规则收细成「只拦第三方的 script / image / font / stylesheet」，而不是整个撤掉过滤器 —— 撤掉就退回 45 秒超时。
- 过滤器让后台页不再加载图片和样式，所以它**渲染出来是残缺的**。这不影响读 HTML（我们只要 DOM），但如果日后需要对这张页截图或做视觉判断，得先意识到这一点。
- `dumpInflight` 保留：只在超时时打一次，直接点名是谁没结束。下次再有第三方资源拖垮加载，不用重新加日志就能定位。
- **后台窗口不再常驻的代价**：以前是「一次检查、后续复用同一张已验证的页」，现在每次读页都要新建窗口重新导航。cookie 存在持久分区里，安全检查通常不会重来；但若站点把 UAM 检查放回来，最坏情况是每读一次页都可能重走一次检查。当前站点已很少下发检查页，这笔交换划算；若日后检查回归，正确做法是**把窗口存活期限定在一次播放会话内**，而不是退回无限期常驻。
- 验证码 / 登录 / 登出走「复用当前文档发同源 fetch」，必须留住文档，因此这条路显式把窗口续期 **10 分钟**，到期由定时器回收。这个时长覆盖的是**人的操作时间**（取到验证码图 → 看 → 输入 → 提交），不是几个请求的耗时；调短会正好卡在用户输入中途销毁窗口，验证码上下文丢失。
- `React.StrictMode` 只在开发模式下让播放页挂载两次，因此 dev 日志会出现「已有相同 watch 页在请求中,合并本次调用」。生产构建只挂载一次，没有这行。两种都正常。
- `stopPageMedia` 只处理主文档里的 `<video>/<audio>`，**不进 iframe**。若站点日后把播放器挪进 iframe 这层会失效；不过窗口读完即销毁，仍能兜住。
- 播放中 `media-cache` 偶尔同一偏移（如 32768）被请求两次、均 0ms 命中本地缓存。不产生额外下载，未深究。
- `videoAudit`（每秒审计播放器状态并写 `main.log`）是这次排查加的**临时诊断代码**，问题已定位，确认稳定后应删除。

### 2026-08-13 fix(player): 修复暂停/退出后仍有声音、开播加载缓慢、缓冲时没有任何提示

**效果**：

1. 暂停后、返回或切走播放页、进播放页还显示「解析播放地址中…」时不再有声音；恢复播放不会变成两路声音叠加。
2. 点开一集到出画面明显变快，开场那段不会重复加载。
3. 缓冲时播放区中央有转圈 + 「缓冲中…」：地址解析完到真正出画面之间不再是一整块纯黑。播放中途卡顿、跳转等待同样显示；用户主动暂停不显示。
4. 退出播放页后 temp 目录里的 `play-*.part`（一集几百 MB）会在几秒内真正删掉，不再要等下次启动才被扫掉；
5. `main.log` 的「建流」日志一次正常观看只出第 1 次，可以判断有没有重复下载。

**关键流程**：

![换集/退出播放页时旧播放器怎么停](docs/devlog-assets/detached-video-leak.svg)

**边界 / 还存在的问题**：

- 「靠近文件末尾的请求直连、不建流」按**距文件末尾 4MiB 以内**判定。真的把进度条拖到最后 4MiB（约 1 分钟）以内时，那一段退化成直连：能播，但没有预抓加速，可能比拖到别处更容易卡一下。
- 临时文件的后台重删只试 200ms / 800ms / 3s 三轮。若这三轮里文件仍被占着（几乎只会发生在应用正在退出、进程来不及跑完），仍旧回到由下次启动的 `sweepMediaCacheDir` 收拾，行为与从前一致。
- 缓冲转圈延迟 300ms 才出现，避免几十毫秒的微小卡顿闪一下。代价是极短的卡顿不会有任何提示——这是故意的。
- 「没动进度条却打印『命中本地缓存，0ms 直接续播』」是**正常**的，不是重复下载：Chromium 播一个 mp4 本来就会发好几条 Range，这些被本地文件 0ms 服务掉正是缓存生效。查重复下载看「建流」的次数。

### 2026-08-12 fix(xifan): 稀饭源无法在线观看

**效果**：

1. 稀饭的 `Checking your Browser` 自动检查在不可见的 Chromium WebContents 中完成，播放页不弹出稀饭网页；等待期间只显示「解析播放地址中…」，取到地址后进入播放器。
2. 检查页结束立即读取最终 HTML；站点刷新时 Electron 给出的 `(-3)` / `ERR_ABORTED` 作可恢复的导航交接处理，不当成页面打不开。
3. 每条稀饭线路每一集的最终 MP4 地址按播放页 URL 落到 `userData/xifan-url-cache.json`，24 小时内重复点同一集直接复用；缓存过期或 `<video>` 报错后，才在同一后台页面重新读取该集的 `player_aaaa.url`。同一集的并发解析合并为一次。
4. 已通过检查的页面、验证码和账号接口复用同一浏览器分区，不用主进程 HTTP 再补打一遍。站点的普通图片验证码走现有应用内 `needs_captcha` 界面，不开网站窗口。
5. 自动检查 45 秒仍未结束回到应用错误态：给站点偶发约 28 秒的首访刷新留余量，但不沿用可见窗口时代允许人工操作的 90 秒挂起，也不自动重试。
6. 追番记录里已经填过总集数的番，重新进入播放器时若命中本地 7 天内的 watch 缓存（`userData/xifan-watch-cache.json`），直接用缓存的总集数/线路/地址模板，不产生任何请求，也不会触发后台安全检查；未填总集数的连载番不受影响，仍按站点最新结果来，不会漏看新更新的集数。缓存按 watch 页 URL 存，同名番/不同线路不会串，每次真实请求成功后都覆盖写入，保证下次能命中。
7. 稀饭源站过载/超时时，边缘代理（Peekabo）会渲染一页 `GATEWAY_TIMEOUT` 错误页返回给后台 Chromium。应用识别出这类页面后，会明确提示「站点服务器暂时不可用（网关/源站故障，非本应用问题）」。
8. 稀饭在线播放的每个阶段——请求 watch 页、后台安全检查开始与放行、命中 watch 或 URL 缓存、回源解析某一集、拿到集数、拿到播放地址、搜索页要求验证码——都会记一行日志到 `main.log`（设置 → 关于 →「打开日志目录」查看；开发模式下同时打印到终端），可以据此看到卡在哪一步、当时请求的是哪个 URL。

**关键流程**：

```text
进入稀饭播放器
├─ 追番记录有总集数 → 命中 7 天内的 watch 缓存 → 直接用（零请求）
│                    → 未命中/过期 → 走下方"点开一集"流程，请求成功后写回缓存
└─ 追番记录没填总集数（连载番）→ 照常走下方"点开一集"流程，同样写回缓存

点开稀饭一集
└─ 后台 Chromium 加载对应 watch 页面
   ├─ 首次遇到 Checking your Browser → 站点脚本自行等待 / 刷新（应用只显示「解析播放地址中…」）
   └─ 页面正常 → 读取 player_aaaa.url
      ├─ 该集 24h MP4 缓存命中 → 直接交给 mtmedia://
      └─ 未命中 → 模板直链或在同一后台页面按需读取一次
         └─ 缓存最终 MP4 地址 → 进入 media-cache-state-flow.svg 的原有缓存流程
```

**边界 / 风险**：

- 250ms 轮询不属于站点请求；真正的稀饭 HTML 导航统一经过 400–600ms 的共享间隔器。缓存命中、同一集并发合并和 `<video>` 失败后的单次强制刷新共同避免连续点集形成回源突发。
- 不在 HTTP 层复刻站点脚本、伪造验证请求或模拟验证码点击。若站点将来改成不同于现有图片验证码的人工交互挑战，需要先扩展应用内验证码界面，不能暗中绕过。
- watch 缓存只按 URL 做 7 天 TTL，不联动追番记录总集数被改小的情况——用户事后手动改小总集数，旧缓存不会立即失效，要等过期或被换出才刷新，可接受。老番若小概率补更新集数，最长有 7 天延迟才会在集数网格里出现，期间已缓存范围内的集数仍能正常播放。
- 源站错误页识别只按 HTML 里的固定字符串（`GATEWAY_TIMEOUT` / `ORIGIN_ERROR` 等）匹配，不依赖真实 HTTP 状态码——因为后台 Chromium 页面读出的状态目前固定按 200 处理，拿不到 Peekabo 真实返回的状态。如果代理换了错误页模板、不再包含这些字符串，会退回旧的「解析失败」误判，需要照抓包更新 `scrape-guard.ts` 里的标记列表。
- 阶段日志只在状态**切换**时落一行（比如安全检查命中/放行各记一次，不是每 250ms 轮询都记），避免刷屏；`console.log` 本身不落盘，这里统一走 `logInfo`，保证卡住时事后翻 `main.log` 也能看到完整链路。

### 2026-08-09 perf(player): 优化拖动进度条快进

**效果**：

1. 按住滑块拖动进度条时，手划过的中间位置不再各自去下载一遍。以前是拖过几十个位置就发起几十轮下载（每轮 6 条连接），现在只有**手停下来**的位置才真的开始下载。实测一次长拖动划过 60 个位置，只发起了 4 轮下载，其余 60 条请求全被挡掉。
2. 手停在某处但还没松开，就已经在为这个位置缓冲了，不用等松手——所以松手时经常是立刻就能播。
3. 拖回之前经过、已经缓存到的位置，仍然是 0 等待。
4. 代价：点一下跳转、且该位置本地没缓存时，比上一版多等 0.18 秒。本地有缓存的跳转不受影响，仍是 0 等待。

**关键流程**：

```text
播放器请求某个位置
├─ 本地已经缓存到 → 立刻给数据（0 等待）
└─ 本地没有 → 先等 0.18 秒
   ├─ 期间没有新位置进来（手停了）→ 开始下载这个位置
   └─ 期间又来了新位置（还在拖）→ 这条先挂着不动，等新下载的数据覆盖到它、
                                  再把数据补给它
```

### 2026-08-09 perf(player): 稀饭线路一跳转进度后快速恢复播放，不再反复卡顿

**效果**：

1. 播放稀饭线路一时，跳到之前看过（或已经预下载到）的位置，直接秒开，不会有任何等待。
2. 跳到完全没看过的新位置，会有一小段等待（目标压到约 3 秒左右），之后连续播放不会再中途卡顿——不再是「跳过去播两三秒卡一下、再播两三秒再卡一下」反复好几次。
3. 暂停、继续播放不受影响，继续播放依然是秒接的。

**关键流程**：

![稀饭线路一在线观看是怎么工作的](docs/devlog-assets/media-cache-state-flow.svg)

**还存在的问题 / 使用时要注意的地方**：

1. **约 3 秒是目标，不是已经量出来的保证值**。这版把"跳到新位置要等多久"从实测约 9.5 秒压下来靠两件事：一是不再让 6 条并发连接各自重新问源站要一次地址（复用第一条连接已经问到的地址），二是把每次要的数据块切小（512KiB），让最慢的那一小块也能在 2~3 秒内到位。这两点目前只是分析加小范围验证，还没有拿真机在各种网络环境下正式测过，实际感受可能比目标好，也可能个别情况下更慢。
2. **"复用同一个地址给 6 条连接"这件事本身有过前车之鉴**：早年确实试过复用地址导致某一集播放卡死，后来才改成每条连接各自重新问一次地址。这次复用回去，是因为查证据后判断当年卡死更可能是别的原因（不同连接挤在同一条底层通道上互相卡住），而不是"同一个地址不能被多条连接同时用"，而且下载功能一直是这么做且很稳。但这只是推理判断，不是 100% 确定——如果这次判断错了，症状会是**某一条连接长时间卡住不动、其它几条正常**，而不是整体变慢。

### 2026-08-08 perf(player): 优化稀饭线路一跳转后卡顿

**效果**：

1. 稀饭线路一跳转进度后不再让一条低速连接贴着播放进度追赶；播放器先得到一段连续缓冲，再由当前位置后方的并发窗口持续补充，把「播几秒、停几秒」收敛成一次可预期的加载。
2. 开场仍按真实落盘进度边下边播，不为并发等待首块；Chromium 的开头 / moov 尾部探测也不会立刻扇出多路请求，避免视频刚打开就白打十几次 302。
3. 预抓最多领先播放器 32MiB、最早缺口后最多 12 块；换集、换源、离开播放页和退出应用立即中止并清掉临时文件，不会以「优化播放」为由在后台下完整集。

**关键数据流**：

```text
<video> bytes=N-
  ├─ 开场 / 元数据探测 → 首个 2MiB 单流边写边播 → 稳定后再展开窗口
  └─ 冷 seek            → 6 个独立 Electron Session
                           ├─ 每块 2MiB，各自重取新签名链
                           ├─ 按文件偏移并发落盘
                           └─ 只推进无空洞的连续前缀
                                      ↓
                              连续 6MiB 后开始回流
                                      ↓
                               mtmedia:// → <video>
```

同一个 Electron Session 会把请求复用到同一 HTTP/2 连接池，代码层写了 6 个 Promise 也不等于 6 条有效下载链；因此固定复用 6 个**独立的内存 Session**。每个 worker 都从原始稀饭地址重新走 302，不能复用 pan.wo 最终签名；签名链复用的并发限制仍保持原结论。

![稀饭 mp4 有界并发滑动窗口](docs/devlog-assets/xifan-mp4-sliding-window.svg)

### 2026-08-08 feat(bili): 新增独立短信登录并重构登录入口

**效果**：

1. B 站「扫码登录」恢复为纯二维码功能，不再在二维码弹窗里塞短信页签或「登录窗打开中」占位；设置页与播放页都改成「扫码登录 / 短信登录」两个语义明确的并列入口。
2. 短信登录使用独立表单：手机号 → 极验 → 发送短信 → 6 位验证码登录。关闭极验窗会立即回到可操作状态，接口失败会落在表单的常驻反馈位，不再靠整张官方登录页的窗口生命周期猜登录结果。
3. 登录成功后，短信与 TV 扫码写入同一个 `persist:bili` 分区；设置页登录态和 B 站 DASH 播放无需分辨登录渠道。
4. 窄窗口下登录方式会移到说明文字下方，不挤压说明、不产生横向滚动；二维码弹窗本身未改协议与轮询行为。

**短信协议实践**：

```text
GET  /x/passport-login/captcha?source=main_web
  → initGeetest({ gt, challenge, product: 'bind' })
  → validate / seccode / challenge / token
POST /x/passport-login/web/sms/send            (multipart/form-data)
  → captcha_key
POST /x/passport-login/web/login/sms           (multipart/form-data)
  → Set-Cookie(SESSDATA …)
```

![B 站短信登录数据流](docs/devlog-assets/bili-sms-login-flow.svg)

**状态与凭证边界**：

- `captcha_key` 只在主进程内存保留 10 分钟，renderer 只拿一次性 `flowId`；手机号改变时表单立即丢弃旧 `flowId`，退出 B 站时清空主进程全部 flow。
- 极验组件的 15 秒计时只检查「组件有没有 ready」，不限制用户完成图片 / 滑块验证的时间；取消、组件错误和 B 站接口错误都只结束本次动作，不做自动重试。
- `login/sms` 返回成功后还会 `flushStore()` 并再次检查 `SESSDATA`；没有真正写入共享分区就不向 UI 报登录成功。

### 2026-07-30 perf(player): 稀饭 mp4 预抓缓存 + Girigiri 分片并发预取

**效果**：
1. 稀饭（mp4 直链）边下边看：后台一条顺序流一直往前跑，播放位置前方攒出越来越厚的缓冲，突发延迟被吃掉；整集只解析一次签名链（原先**每个 Range 都重走一次 302**）
2. Girigiri（HLS）分片提前 6 片并发预取，不再是 hls.js 默认的「单连接一片接一片」；播放路径用上和下载路径同一档并发
3. 离开播放页 / 换集换源 / 退出应用都会收摊：中止后台流、删临时文件、清分片内存；被强杀留下的临时文件下次启动扫掉

**关键代码/决策**：两条路径卡的机制不同，所以是两个模块，不是一套「并发下载」。

```
mtmedia:// 请求进来
├ .m3u8  → 重写地址时把分片顺序记进 hls-prefetch（rememberPlaylist）
├ 分片   → tryServeSegment 命中内存 → 顺带并发预取后 6 片（8 路信号量，与 girigiri/download.ts 同口径）
└ .mp4   → tryServeFromCache：开放式 Range（bytes=N-）接管，带结束位的小段（moov）放行直连
```

临时文件的清理

```
换集/换源      → 新 target 顶掉旧 session
离开 /play     → 渲染层 media:release
退出应用       → app 'before-quit'（**同步** rmSync：dev 下紧接着 process.exit(0)，异步 unlink 等不到）
强杀/崩溃/占用 → 下次启动 sweepMediaCacheDir() 扫 play-*.part
```

idle 看门狗（60s 无人读）**只在没有读取流挂着时**动手：`<video>` 暂停时它那条响应流并不关，强行收摊会把流 error 掉，用户恢复播放直接变播放失败。

### 2026-07-30 perf(xifan): 修复稀饭源点开播放缓慢

**效果**：
1. 稀饭在线播放点开即播（原先要先等 3~6 条线路全部解析完）——改为用户没点的线路一次请求都不发
2. 下载配置面板照旧一次性列出全部线路,但改成并发拉齐,不再一条等一条
3. 面板被稀饭限流 / CF 拦截时提示真实原因 + 倒计时重试,不再显示成「这几条线路没源」

**关键代码/决策**：`watch()` 里除当前激活源外,每条线路的 `template` 都得各回一次它自己的播放页才能拿到。旧实现在 `for` 里逐条 `await`,一部番常见 3~6 条源,单条几百 ms 顺序累加就是几秒,而**播放器只用得到一条**——稀饭网站本身也只在用户点某条线路时才加载它。

所以按调用方的真实需求分成两条路径,而不是简单把 `for` 换成 `Promise.all`(那仍是为播放器付了 N 条线路的钱)：

```
watch()  → 只解析 idx===1,其余源 template: null,name/epPage/epLabels 用本页 HTML 填(零请求)
├ 播放器(OnlinePlayer)      → 不补全,切线路时走 resolveStream() 已有的兜底按需解析那一集
└ 下载配置面板(AnimeInfo /   → 要展示全部线路供选,调新增 xifan:resolve-all-sources
   SearchDownload)             → resolveAllSources() 对 template === null 的源 Promise.all 补全
```

`resolveAllSources(animeId, sources)` 幂等:已有 `template` 的源原样透传,不重复请求。`XifanSource` 因为要跨 IPC 传,从 `types/xifan.ts` 里 `export` 出来。

1. **补节流**。同域一瞬间打 3~6 个是明显的 bot-like 突发,而稀饭这条链路上原本一个限流器都没有。加 `sourceLimiter`,只错开**发起时刻**、不退回排队：

```ts
// 150~400ms 远小于单条请求本身的几百 ms → 请求仍然重叠,面板照样快
const sourceLimiter = new RateLimiter({ minGapMs: 150, jitterMs: 250, name: 'xifan-source' })
```

不设滚动窗口配额:面板是用户手点触发、低频,没有累计预算要守。

2. **`fetchSourceEp1` 不再 `catch {}` 全吞**。旧实现把所有异常压成 `template: null`,于是被限流时 UI 显示的是「这几条线路没源」——用户只会去换线路反复点,把限流踩得更深。现在分两类：

```
解析不出播放数据(站点改版 / 该源真空)  → template: null,只损失这一条,其余照常展示
HTTP 非 2xx / CF 拦截(限流、风控、故障) → assertScrapePageOk 抛错 → Promise.all reject
                                       → ErrorPanel 走 friendlyError + 倒计时重试按钮
```

### 2026-07-28 style: 消除播放页原生控件的焦点描边

**效果**：

1. **按 Tab 全程无感**。原先 Tab 会依次停进 Chromium 原生播放器控件,每停一站都甩出跟随系统强调色的焦点描边(macOS 上是黄框),停在静音键上还会把音量条**展开**。现在 Tab 直接从播放区一侧跨到另一侧,焦点不进控件。对齐参照站(稀饭网页版,自研播放器)的观感。
2. **页内 Tab 该有的都还在**。只绕开 `<video>` 本身,内联搜索框、B 站登录弹窗、各类表单的 Tab 跳转不受影响,也不会把焦点困在播放区。
3. **空格暂停变可靠**。以前只有焦点恰好落在 `<video>` 上才管用,点过下方线路按钮后空格就是翻页;现在播放页自己接管空格,不看焦点在哪。
4. 全局去掉原生焦点描边:原来只管 `button`,Tab 走一圈会发现链接 / `tabindex` 容器 / `<video>` 都还会冒出同一圈框。

**关键代码/决策**：

**`<video>` 前后各放一个哨兵,焦点要落进去时按方向交给对应一侧**。原生控件在 UA shadow DOM 里,描边压不住,只能不让焦点进。

```tsx
// pages/OnlinePlayer.tsx —— 哨兵必须紧贴 <video>,焦点才能从这一侧直接跨到那一侧
<span ref={tabHopPreRef} tabIndex={0} className="pointer-events-none absolute h-px w-px opacity-0" />
<video ref={videoRef} controls … />
<span ref={tabHopPostRef} tabIndex={0} className="pointer-events-none absolute h-px w-px opacity-0" />
```

```ts
// hooks/usePlayerKeys.ts —— 两条进入路径都要堵,少一条就漏
const onKeyDown = (e) => {
  if (e.key === 'Tab') {
    tabDir = e.shiftKey ? -1 : 1
    // 路径 B:焦点已在 video 上,再按 Tab 不会触发 focusin,只能在这里截
    if (document.activeElement?.tagName === 'VIDEO') { e.preventDefault(); hop(!e.shiftKey) }
    return
  }
  …空格:preventDefault + 直接切 videoRef 的 play/pause(输入框内放行)
}
// 路径 A:焦点在 video 外面按 Tab
const onFocusIn = (e) => {
  if (!tabDir) return                                   // 鼠标点进来的不弹开
  if (e.target.tagName !== 'VIDEO') return
  hop(tabDir > 0)
}
```

`tabDir` 由 `keydown`/`keyup` 在**捕获阶段**维护 —— `focusin` 是在 Tab 的默认行为里同步派发的,方向标记必须先于它落定。鼠标点击时 `tabDir` 为 0、不弹开,`document.activeElement === video` 得以保留(空格接管虽已不依赖它,但原生控件的其余键位还要用)。

焦点流向

```
路径 A  前一个元素 → [video 控件] ⇢ post 哨兵 → 下一个元素     (focusin 拦)
路径 B  video(点过画面) → [video 控件] ⇢ post 哨兵 → 下一个元素 (keydown 拦,focusin 不触发)
Shift+Tab 同理,反向落到 pre 哨兵
```

### 2026-07-13 style: 优化自定义源播放页样式结构

**效果**：

1. **双滚动条的违和感没了**。自定义源(webview 嵌真实播放页)那页原先是「16:9 矮盒子里塞整张网页」——盒子外是 app 的页面滚动条,盒子里是网页自己的滚动条,鼠标压在 webview 上滚的永远是网页那条,想滚 app 那条得把鼠标挪到盒子和窗口之间的缝里。现在**整页固定高度、页面自身不滚动**,webview 吃掉标题/切换器下方的全部剩余高度,**只剩站点自己的一条滚动条**,且永远在鼠标底下。
2. **应用内「铺满」按钮删了**。播放区右上角那个「铺满/退出」按钮连同它的 state、Esc 监听一并去掉——它做的是「webview 铺满窗口但显示整张网页(导航/广告位都在)」,不是用户要的「只剩视频画面」。
3. **全屏 = 只剩视频画面、覆盖整扇窗**(对齐稀饭/Girigiri/B 站原生 `<video>` 全屏)。点站点播放器自己的全屏按钮:之前 webview 只在「盒子」里全屏、顶部 app chrome 还露着(用户实拍);现在铺满整窗,只剩视频。

**关键代码/决策**：

**全屏靠站点自己的按钮 + 监听 webview 全屏事件把容器铺满窗口**。根因:webview 内 `<video>` 请求 HTML5 全屏时窗口是全屏了,但 app 布局把 webview 钉在 `flex-1` 盒子里、顶部标题栏没让位,所以只在盒子里全屏。修法——

```tsx
// pages/OnlinePlayer.tsx
const [embedFs, setEmbedFs] = useState(false)
el.addEventListener('enter-html-full-screen', () => setEmbedFs(true))
el.addEventListener('leave-html-full-screen', () => setEmbedFs(false))
// 容器:平时 relative 盒子,全屏时整块 fixed inset-0 铺满窗口(webview 原地不动)
<div className={embedFs ? 'fixed inset-0 z-[80] bg-black' : 'relative flex-1 min-h-0 …'}>
```

`enter-html-full-screen` / `leave-html-full-screen` 是 Electron `<webview>` 的 DOM 事件,由站点自己的全屏按钮(guest 调 `requestFullscreen`)触发;退出(站点按钮 / Esc)自动派发 leave,**不用自己接键盘**。只切容器 class、webview 元素原地不动 ⇒ **不重载、不丢播放进度**(与被删的旧「铺满」同一套「不 remount」手法,只是触发源从我们的按钮换成站点全屏事件)。

### 2026-07-11 feat: 自定义源新增应用内播放

**效果**：

1. 加过的自定义链接（B 站以外的番剧站，多是盗版站）现在**在应用里直接看**，不用再开浏览器进站搜番。用的是站点自己的播放页 —— 剧集列表、画质菜单、播放器全在，换任何站都有。
2. **弹窗广告拦了**。盗版站点哪弹哪的 `window.open` 被拦死（实测 guest 里返回 `null`，不弹新窗）。
3. **能铺满窗口全屏看**。播放区右上角一个「铺满」按钮把网页铺满整个应用窗口，Esc 退出；站点自己的全屏按钮也照常能用。
4. 顺带做了两件隐性的：自定义站换到独立分区 `persist:webplay`（不受信站点的 cookie/storage 跟应用默认会话隔开）；「添加观看源」弹窗文案改成「应用内直接播放」（旧文案只说"chip 在浏览器打开"）。

**关键代码**：

① 主进程硬化（对所有 webview 生效，B 站分区也一样）：

```ts
// main/index.ts
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() === 'webview') contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-attach-webview', (_evt, webPreferences) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
  })
})
```

`<webview>` 不带 `allowpopups` 时默认就拦弹窗，这道 handler 是**第二层**防御（防以后手滑开 `allowpopups` + 拦 guest 自己派生的子 webContents），不是从零到一的新能力。

② 铺满切换**不重载 webview**——容器 class 在「16:9 盒子 / `fixed inset-0`」间切，但 webview 保持在树里同一位置（换位置会 remount → 页面重载 → 丢播放进度）：

```tsx
// pages/OnlinePlayer.tsx
<div className={embedExpanded ? 'fixed inset-0 z-[70] bg-black' : 'relative aspect-video …'}>
  <webview key={`${view.url}#${webviewKey}`} src={view.url}
    partition={view.isBili ? 'persist:bili' : 'persist:webplay'} className="h-full w-full" />
</div>
```

### 2026-07-10 feat(bili): B 站源在线播放 —— 真 1080P + 扫码登录

**效果**：

播放：

1. **画质是真的了**。之前用 B 站官方外链播放器（`player.bilibili.com/player.html`），它的画质菜单里明明列着 1080P，**点了没反应**——那个「进入哔哩哔哩，观看更高清」的浮层就是它在告诉你被锁在 360P，登不登录都一样。现在自己问 API 要地址，1080P/720P/480P/360P 四档任选，选哪档就是哪档。
2. **暂停不再弹一堆推荐视频**，画面上也没有任何引流层——播放器是我们自己的 `<video>`。
3. **合集终于有集数列表了**。像 `BV1zAQGB8Eqq` 这种「1-12 话全集」的稿件，12 个分 P 直接铺成集数网格，点第 5 集就是 `&p=5` 那一集。单 P 稿件就一格，形态和稀饭/Girigiri 一致。
4. 番剧链接（`/bangumi/play/ep…`）仍走原来的外链播放器——它是另一套 pgc 接口，这次没动。

登录：

5. 扫码能登进去了。之前弹一个 BrowserWindow 加载 `passport.bilibili.com/login` 让用户扫官方页面的码，手机上点「确认」直接报 **API校验密匙错误**——B 站 2026-06 起收紧了 **web 端**扫码接口的风控（同期 downkyi 等工具一起中招）。
6. 登录入口进了「设置 → 通用 → B 站账号」，扫一次长期有效，不用每次进播放页才能登。播放页提示条上的登录按钮还在，点开是同一个扫码弹窗。
7. 顺手修了提示条上「登录 B 站」按钮的下划线：整个按钮加 `hover:underline`，而图标是**字体字形**、基线和文字不同，下划线被画成高低两截。改成只给文字那个 `<span>` 加下划线。

![B 站 DASH 数据流](docs/devlog-assets/online-bili-dash.svg)

**关键决策（都是实测出来的，别推翻）**：

- **1080P 只存在于 DASH 里**。mp4 直链（`fnval=0/1`）的 `accept_quality` 只有 `[64, 16]`，容器本身封顶 720P。想要 1080P 就必须走音视频分轨 + MSE，没有第二条路。
- **画质由登录态决定**。匿名最高 480P，登录后 `dash.video` 里才出现 `id=80`。所以自研播放的 B 站源也要查登录态、也放登录入口，不是只有 webview 那条才需要。
- **MPD 里只放 avc1**。B 站每档画质同时给 avc1 / hev1 / av01 三种编码；三者编码不同不能塞进同一个 AdaptationSet，而 avc1 是唯一各平台都能硬解的。
- **画质档只列「真有」的**。`accept_quality`（账号能选的）与 `dash.video`（这个稿件实际存在的）求交后才上屏——外链播放器摆着点不动的 1080P 就是这么坑人的，别重蹈。
- **ABR 关掉**。用户点了 1080P 就该一直是 1080P，不能让自适应在背后偷偷降档。
- **不给 `mtmedia` 加 `corsEnabled`**（011 已经踩过一次）：shaka 的 fetch 和 hls.js 一样直通，加了反而要补 ACAO。
- **登录改 TV 端扫码**，不走 web 扫码：TV 端（`/x/passport-tv-login/qrcode/*`）用 appkey + appsec 的 md5 签名校验，不吃 web 那套风控；代价是登录成功后**不发 `Set-Cookie`**，cookie 在响应体里，要自己逐条写进 `persist:bili` 分区。

**关键代码**：

① 签名——固定 appsec，参数排序拼接后 md5，不需要运行时反推（登录 / playurl 共用）：

```ts
// bili/api.ts - signParams()
const query = Object.keys(all).sort().map((k) => `${k}=${encodeURIComponent(all[k])}`).join('&')
const sign = createHash('md5').update(query + TV_APPSEC).digest('hex')
```

② TV 端登录不发 `Set-Cookie`，凭证在响应体里，逐条写进分区：

```ts
// bili/api.ts - tvPoll()
for (const c of env.data.cookie_info?.cookies ?? []) {
  await ses.cookies.set({ url: 'https://bilibili.com/', domain: '.bilibili.com', name: c.name, value: c.value, /* … */ })
}
```

③ Referer 钉在代理 URL 上——B 站 CDN 不带 Referer 一律 403（实测 403 → 206），而 shaka 是在**渲染进程**里逐段发 Range 的，直取必死。所以主进程取到地址时就把 Referer 封进 `mtmedia://`，渲染层永远见不到裸签名链，也就不可能忘了带头：

```ts
// bili/api.ts - toTrack()
baseUrl: toMediaProxyUrl(t.baseUrl, BILI_REFERER),

// shared/media-proxy.ts - protocol.handle()
if (referer && /^https?:\/\//i.test(referer)) headers['Referer'] = referer
```

④ B 站只给 dash JSON 不给 MPD，但每路轨都是「单文件 fMP4 + SegmentBase 字节范围」，正好是 DASH 的 on-demand profile——一个 `<BaseURL>` 加一个 `<SegmentBase indexRange>` 就描述完了：

```ts
// utils/biliMpd.ts - representation()
`<BaseURL>${xmlEscape(t.baseUrl)}</BaseURL>`,
`<SegmentBase indexRange="${t.indexRange}"><Initialization range="${t.initRange}"/></SegmentBase>`,
```

顺带给 `netRequest` 补了 **POST body** 和 **session**（用某个分区的 cookie 罐发请求）两个能力。`session` 一传就自动开 `useSessionCookies`——net 默认**不带**该 session 的 cookie，两个开关分开只会制造「传了 session 却没带 cookie」的静默失败。

**这不算违反「不自动重试」红线**：扫码每 2s 问一次「扫了没」是 B 站定义的轮询协议，只在弹窗开着、二维码有效时问，关窗即停；请求真出错就停下来报错，交给用户点重试。

**已验**（CDP 驱动真实 app）：

- 播放：`BV1zAQGB8Eqq` 播起来 1920×1080、`readyState=4`、时间轴推进、零 error；集数网格 12 格；画质条 4 档；点 720P 后 `videoHeight` 真的变 720；切第 5 集正常续播且保留画质档；页面上不存在「进入哔哩哔哩」字样。`file://` 与 `http://127.0.0.1` 两种 origin 各跑一遍（011 早期栽在 origin 上）。脚本 `verify-bili-play.mjs` / `verify-bili-dev-origin.mjs`。
- 登录：`bili:qr-create` 返回合法 authCode + PNG data URL，首次 `bili:qr-poll` 返回 `pending`（不再是「API校验密匙错误」）；设置页「B 站账号」区块正常渲染并如实显示登录态。脚本 `verify-bili-qr.mjs`。

### 2026-07-10 fix: 播放页默认从「卡片上显示的那一集」开始播

**效果**：

1. 之前：追番卡片写着 `1 / 12`，点「播放」却从**第 2 集**开始（默认选的是「下一集」`episode + 1`）；现在：**所见即所播** —— 卡片写 1 就从第 1 集播，写 2 就从第 2 集播。
2. 边界收敛：`episode = 0`（还没看过）→ 第 1 集；`N` 超出该线路的集数（BD 线只有特典之类）→ 最后一集。想看别的集，集数网格里照样随便点。

![播放页默认选集：修复前后](docs/devlog-assets/online-default-episode.svg)

**关键代码**：

`track.episode` 的语义是「最后看到的那一集」，正是卡片上那个数字 —— 所以直接拿它当默认选集，不再 `+1`。选不中时 clamp，不报错：

```tsx
// pages/OnlinePlayer.tsx —— 集列表就绪后定默认选集
const wanted = track?.episode ?? 0
const last = eps[eps.length - 1]
const target =
  eps.find((e) => e.idx === wanted) ??      // 该线路有第 N 集 → 第 N 集
  (wanted > last.idx ? last : eps[0])       // 超出 → 最后一集;否则(含 0)→ 第一集
setEp(target.idx)
```

播放页只读 `track.episode`、**不回写**，观看进度仍由卡片上的 `+1` 手动推进（沿用原状，本次不动）。

### 2026-07-10 fix: Girigiri 换域名后搜索与在线播放全部失败

**效果**：

1. Girigiri 的搜索 / 下载 / 在线播放恢复可用 —— 站点主域从 `bgm.girigirilove.com` 换到了 `ani.girigirilove.com`（旧域名现在 301 过去）。
2. 顺带修掉一个潜伏的传输层 bug：`netRequest` 的 `redirect:'manual'` 从来没处理过 3xx，**任何**重定向都会以 `Redirect was cancelled` 失败。修完之后站点再换域名，只是多跟一跳而已。

![redirect:'manual' 修复前后的数据流](docs/devlog-assets/net-request-manual-redirect.svg)

**关键代码**：

① 传输层——manual 模式必须接 `redirect` 事件，把 3xx 原样交回调用方：

```ts
// shared/net-request.ts - netRequest()
if (redirect === 'manual') {
  request.on('redirect', (statusCode, _method, _redirectUrl, responseHeaders) => {
    // 3xx 的 status/headers 原样 resolve 出去(body 空),让 HttpSession 自己读
    // Location、ingest Set-Cookie 再跟下一跳。不接这个事件,请求会被作废。
    finish(() => resolve({
      status: statusCode,
      headers: responseHeaders as Record<string, string | string[] | undefined>,
      body: Buffer.alloc(0),
    }))
    try { request.abort() } catch { /* 已结束 */ }
  })
}
```

② 主域收敛成单一事实源，`download.ts` 注 cookie 时也跟着它走（写死旧域名的话，站点换域后 cookie 落在错误的 domain 上，注进去等于没注）：

```ts
// girigiri/api.ts
export const BASE_DOMAIN = 'https://ani.girigirilove.com'

// girigiri/download.ts - captureM3u8()
ses.cookies.set({ url: BASE_DOMAIN, name, value })
```

### 2026-07-10 feat: 新增Girigiri在线播放

**效果**：
1. Girigiri 源可在线播放
2. 播放页默认选中的源改成「任一已绑定的内置源」

**数据流**：

播放地址直接从播放页 HTML 的 `player_aaaa` 解析（`encrypt=2` → base64 再 urldecode），一次 GET 就够，**不用起隐藏窗口截流**（截流降级为兜底，站点改版时才走）；拿到的可能是 m3u8 也可能是 mp4，按后缀分流。HLS 那条把播放列表 / 分片全部经 mtmedia 代理，主进程把列表里每条 URI 重写成 `mtmedia://` 再回给 hls.js。

![Girigiri HLS 数据流](docs/devlog-assets/online-girigiri-hls.svg)

**关键代码**：

① 地址解析——`player_aaaa` 是 MacCMS 通用结构（与稀饭同源），`encrypt` 决定 url 的编码方式：

```ts
// girigiri/api.ts - extractPlayerUrl()
const decoded =
  data.encrypt === 2 ? decodeURIComponent(Buffer.from(raw, 'base64').toString('utf-8'))
  : data.encrypt === 1 ? decodeURIComponent(raw)
  : raw
return /^https?:\/\//i.test(decoded) ? decoded : ''
```

② 播放列表重写——hls.js 是在**渲染进程里**逐条取变体列表 / 分片 / `#EXT-X-KEY` 密钥的，拿原始 CDN 地址会被跨源策略拦（那些 CDN 不带 CORS 头）。所以主进程把列表里每条地址都换成同源的 `mtmedia://`；相对地址按**重定向后的最终列表地址**解析，否则 302 过的列表会解错：

```ts
// shared/media-proxy.ts - rewritePlaylist()
const abs = (u: string): string => toMediaProxyUrl(new URL(u, baseUrl).href)

// # 开头是标签行:只有 #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA 把地址放在 URI="..." 里
if (line.startsWith('#')) return raw.replace(/URI="([^"]+)"/i, (_m, u) => `URI="${abs(u)}"`)
return abs(line) // 分片,或 master 列表里的变体列表
```

③ girigiri **不全是 HLS**——部分老番线路直接给 `.mp4` 直链，按后缀分流，mp4 走和稀饭一样的直喂路径：

```tsx
// pages/OnlinePlayer.tsx - resolveStreamUrl()
return { url, isHls: /\.m3u8(\?|$)/i.test(url) }
```

④ 失败接线——HLS 的 `fatal` 错误接到既有的线路兜底（换下一条线路的同一集）；非 fatal 交给 hls.js 自己重试。HLS 时 `<video>` 不设 `src`、不挂 `onError`，免得同一次失败触发两遍换线路：

```tsx
hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) onFatalRef.current() })
```

### 2026-07-09 refactor: 优化自动更换线路结构

**效果**：

1. 之前：换集 / 手动切线路 / 点重试都会清空「已试线路」记忆；现在：记忆在整部番的
   一次观看里持续累积，只在**换站 / 换番**时清零。

![线路兜底状态机](./docs/devlog-assets/online-line-fallback copy.svg)

### 2026-07-09 feat: 011 在线观看 —— 应用内播放页 + 三源切换 + mtmedia 流代理 + 线路兜底

**效果**：
1. 追番卡片新增「在线观看」按钮，进应用内沉浸式播放页（/play）：稀饭 / Girigiri / 嗷呜三源常驻切换 + 该番自定义链接（B 站等）追加，换集 / 换源 / 全屏都在应用内；原「在线观看」行的源 chips 外跳浏览器行为保留。
2. 稀饭 / 嗷呜解析 mp4 直链用 `<video>` 播放；B 站用 `<webview partition="persist:bili">` 嵌官方外链播放器（登录后第一方 cookie 完整观看）；Girigiri（HLS）应用内播放暂占位（TODO，待 hls.js）。
3. 未播出条目不显示播放按钮（airDate 三态判定）。
4. 播放失败自动切下一条线路兜底，三条都失败才报错。

**底层关键决策 / 踩过的坑**：

**1. mtmedia 同源流代理（`src/main/shared/media-proxy.ts`）** —— 同一条稀饭主线直链，浏览器 / 打包版能播，dev 里 `<video>` 报 code 4，差在**页面 origin**：dev 的 `http://localhost` 下 Chromium 拒绝播放带 `content-disposition: attachment` 的跨源媒体，打包后 `file://` 不拦，所以**只在 dev 复现**

![mtmedia 同源流代理原理](docs/devlog-assets/online-media-proxy.svg)

**2. 线路兜底** —— 播放失败切下一条线路的**同一集**（不是跳集），三条都试完才报错。

![线路兜底状态机](docs/devlog-assets/online-line-fallback.svg)

**3. airDate 三态（`src/renderer/src/utils/airDate.ts`）** —— 未播出条目不显示播放按钮，判定三态零迁移。

![airDate 三态判定](docs/devlog-assets/online-airdate-states.svg)

**4. B 站 webview** —— main 开 `webviewTag`；登录窗与播放 webview 共用 `persist:bili` 分区、同 UA，cookie 第一方；分区**惰性初始化**（`session.fromPartition` 必须等 app ready）。

调研 / 踩坑全纪要与 TODO 见 `docs/ideas/011-在线观看.md`。

## BGM登陆功能

### 2026-07-06 fix: BGM 登录状态不一致bug

**效果**：

1. 之前：每次启动 chip 从「已登录」跳「未登录」，点「登录」窗口秒关又显示已登录，实际搜索**一直**走匿名通道（提速从 06-29 上线起就没真正生效过）；现在：登录窗/verify/带登录 cookie 的搜索统一用同一个 UA，令牌真正可复用，关窗后立刻 verify 自证，UI 显示的登录态即真实登录态
2. 之前：BGM 偶发 502/限流时 `verifyBgmLogin` 会把还有效的 cookie 误判过期清掉；现在：只有 HTTP 200 的页面才有资格下「过期」结论，非 200 保持原状
3. 补齐观测盲区：登录捕获 / verify 结论 / 每页搜索的「耗时 + 服务端实际登录态」都落 main.log，不用再猜提速有没有生效

**底层逻辑**（登录时发生了什么、搜索为什么一直带错 UA——修复前后对比）：

![BGM 登录态绑定 UA 修复前后对比](docs/devlog-assets/bgm-ua-binding-fix.svg)

**修法**（关键代码）：

① 总根因——登录窗分区固定 UA，token绑在和 verify / 搜索同一个 UA 上：

```ts
// bgm/credentials.ts - openBgmLogin()
const part = session.fromPartition('persist:bgm-login')
part.setUserAgent(DESKTOP_USER_AGENT)
```

② 搜索请求的 UA 分两种情况——**未登录：随机伪装 UA 照旧；已登录：固定 UA 顶掉伪装**。

随机伪装 UA 的来源（app 每次启动随机挑一个 Chrome 版本，整个会话期固定不变）：

```ts
// shared/browser-session.ts —— 反爬伪装层,和登录无关
function pickRandomVariant(): UAVariant {
  const pool = chromeVariants(process.platform) // Chrome 119~123 五个版本的 UA
  return pool[Math.floor(Math.random() * pool.length)]
}

export class BrowserSession {
  private readonly variant: UAVariant = pickRandomVariant() // 构造时随机挑定

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      // ...
      'sec-ch-ua': this.variant.secChUa, // 和 UA 版本号保持一致,防指纹自相矛盾
      'User-Agent': this.variant.ua,     // ← 随机伪装 UA 在这里进入每一个请求
      // ...
    }
    // ...
  }
}
```

搜索发请求时先拿到上面这套伪装头，然后**只在有登录 cookie 时**才改写 UA：

```ts
// bgm/search.ts - rawGet()
const headers = session.headers({ ... }) // 此刻 User-Agent = 随机伪装 UA

const loginCookie = getBgmCookie()
if (loginCookie) {
  // —— 已登录分支 ——
  headers['Cookie'] = mergeCookieHeader(headers['Cookie'], loginCookie)
  // BGM 把登录态绑定在登录时的 UA 上。带登录 cookie 时必须用登录窗同款固定
  // UA 顶掉 jar 的随机伪装 UA,否则登录 cookie 形同虚设。
  headers['User-Agent'] = DESKTOP_USER_AGENT
  // sec-ch-ua 一并对齐——只换 UA 不换客户端提示会造成 (UA, sec-ch-ua) 版本
  // 自相矛盾的指纹(jar 变体是随机 Chrome 119~123,UA 却固定 120),比不发更
  // 可疑;DESKTOP_USER_AGENT 又写死 Windows,在 macOS 上还会平台对不上。
  headers['sec-ch-ua'] = DESKTOP_SEC_CH_UA
  headers['sec-ch-ua-platform'] = DESKTOP_SEC_CH_UA_PLATFORM
}
// —— 未登录分支 ——
// 不进 if,headers 没有任何改动:User-Agent / sec-ch-ua 原样保留
// session.headers() 给的随机伪装变体,匿名请求的反爬伪装策略完全不变。

const res = await netRequest(url, { headers, timeoutMs: 25000 })
```

配套常量的定义——sec-ch-ua 的版本号**直接从 UA 串里解析**，单一事实源，升级 UA 只改一处、提示头自动跟随，杜绝「改了 UA 忘了改 sec-ch-ua」：

```ts
// shared/download-types.ts
export const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// 与 DESKTOP_USER_AGENT 配套的客户端提示头 —— (UA, sec-ch-ua) 版本不一致的
// 指纹自相矛盾,反而可疑。版本号直接从上面的 UA 串里解析,单一事实源:
// 将来升级 UA 只改上面一处,这里自动跟随,不存在「改了 UA 忘了改提示头」。
// 平台写死 Windows:DESKTOP_USER_AGENT 本身就刻意全平台统一用 Windows UA。
const CHROME_MAJOR = /Chrome\/(\d+)/.exec(DESKTOP_USER_AGENT)?.[1] ?? '120'
export const DESKTOP_SEC_CH_UA = `"Not.A/Brand";v="8", "Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}"`
export const DESKTOP_SEC_CH_UA_PLATFORM = '"Windows"'
```

③ 捕获不再「见到 `chii_auth` 秒关窗」——等落地页加载完再取最终 cookie，关窗后立刻自证：

```ts
// bgm/credentials.ts - openBgmLogin()
// 实测:「即见即存即关窗」会掐断登录后的落地页导航,存下半成品。等落地页
// did-finish-load 再缓 800ms(容纳尾部 Set-Cookie/二跳)取最终 cookie,10s 兜底防悬死。
const scheduleFinalize = (): void => {
  if (finalizeScheduled || settled || win.isDestroyed()) return
  finalizeScheduled = true
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => { void capture() }, 800)
    })
    setTimeout(() => { void capture() }, 10000)
  } else {
    setTimeout(() => { void capture() }, 800)
  }
}

win.on('closed', () => {
  // ...
  if (settled) {
    // 捕获成功后立刻实测令牌在窗口外能否复用 —— UI 拿到的是实测过的登录态,
    // 日志立辨真伪,不再出现「显示已登录、实际匿名」的假象
    void verifyBgmLogin().then(resolve)
  } else {
    resolve(getBgmAuthStatus())
  }
})
```

④ verify 加 200 门槛——BGM 偶发 502/限流的错误页同样没有 `/logout`，不能当「过期」证据：

```ts
// bgm/credentials.ts - verifyBgmLogin()
if (res.status !== 200) {
  // 非 200(限流/502/CF 拦截)不能下「过期」结论 —— 否则 BGM 偶发故障
  // 会把还有效的登录态误清掉。保持原状态,下次再查。
  logInfo('bgm-auth', `verify 探测无效(HTTP ${res.status}),保持原登录状态`)
  return getBgmAuthStatus()
}
const html = res.body.toString('utf-8')
if (!html.includes('/logout')) {
  // 200 且无「退出」入口 = 服务端确实不认这份 cookie。本地 + 登录窗分区一起清。
  clearBgmCookie()
}
```

⑤ 堵死旧死循环入口——本地未登录时，进登录页前清空分区残留（否则残留的 `chii_auth` 会让捕获逻辑秒判成功、把死 cookie 原样存回）；退出登录 / verify 判失效也同步清分区：

```ts
// bgm/credentials.ts
void win.loadURL(LOGIN_SPLASH).then(async () => {
  // 存储层认为未登录时,分区残留的 chii_auth 多半是已被服务端作废的旧凭证,
  // 不清掉的话 capture 一看到它就「秒登录成功」——假登录死循环的入口。
  if (!cookie) await clearLoginPartitionCookies()
  if (!win.isDestroyed()) void win.loadURL('https://bgm.tv/login')
})

export function clearBgmCookie(): void {
  setBgmCookie('')
  // 分区一起清:退出/失效后留着旧 chii_auth 只会制造「假登录成功」
  void clearLoginPartitionCookies()
}
```

### 2026-06-29 feat: BGM 登录状态UI(设置账号区 + 查询页登录提示)

**效果**：

1. 动漫查询页顶部新增登录状态：未登录/过期显示「点此登录提速」按钮，已登录显示「BGM 已登录」（可点重新校验）
2. 之前登录状态只能在设置页看，容易忘记去看；将自动检查改为进入动漫查询 tab 时自动检查一次

**状态流转**（`BgmLoginChip` 组件）：

![BgmLoginChip 状态流转](docs/devlog-assets/bgm-login-chip-states.svg)

节流判断是这个组件的核心——不是"每 24 小时查一次"，是按自然天的 8 点分界（早于 8 点算前一天）：

```ts
// utils/bgmAuth.ts
// 同一个"逻辑日"（8点到次日8点算一天）只自动查一次，避免每次切 tab 都打一次 BGM 的验证接口
function windowStart(ts: number): number {
  const d = new Date(ts)
  if (d.getHours() < 8) d.setDate(d.getDate() - 1) // 8点前算"昨天"的窗口
  d.setHours(8, 0, 0, 0)
  return d.getTime()
}
export function needsAutoVerify(): boolean {
  if (!cachedStatus) return true            // 从没查过，必须查一次
  return cachedAt < windowStart(Date.now())  // 上次查的时间早于本次窗口起点 → 已跨天，要重查
}
```

### 2026-06-29 feat: BGM 搜索带登录cookie提速 + 修正限流/CF报错分类

**效果**：
1. 之前：匿名搜索被 BGM 故意拖慢到 ~16s，10s 超时直接报错；现在：带登录 cookie 后 ~0.6s 秒回，未登录也放宽到 25s 等真实响应，不再误报「请求超时」
2. 之前：诊断信息里出现裸 `cloudflare` 字样就判定被拦截（BGM 诊断串本身恒带 `server=cloudflare`，会把正常 5xx 也误判成拦截）；现在：只认强特征

**数据流向**（一次搜索请求会怎么被分类）：

![BGM 搜索请求结果分类](docs/devlog-assets/bgm-search-classify.svg)


**"只认强特征"——失败时 UI「Show details」里真实会看到的内容**

场景 A：BGM 后端偶发 502，CF 只是照常转发，没拦任何东西：

```bash
[bgm-search-diag] HTTP 502 on https://bgm.tv/subject_search/xxx
  status=502 server=cloudflare cf-ray=8a1e2f9d3b1c-SJC cf-mitigated=- cf-cache-status=- via=- content-type=text/html retry-after=- | body[0:300]=<html><title>502 Bad Gateway</title><body>upstream connect error or disconnect/reset before headers...
```

场景 B：CF 真的弹出人机验证拦了这次请求：

```bash
[bgm-search-diag] HTTP 403 on https://bgm.tv/subject_search/xxx
  status=403 server=cloudflare cf-ray=9c2f3a8e4d5b-SJC cf-mitigated=challenge cf-cache-status=- via=- content-type=text/html retry-after=- | body[0:300]=<html><title>Just a moment...</title><body class="no-js">...
```

两条都有 `server=cloudflare 。区别在 `cf-mitigated`：场景 A 是 `-`（没值 = 没动作），场景 B 是 `challenge`（有值 = CF 真的拦了）；场景 B 的 body 里还有 "Just a moment" 原文，场景 A 没有。

判断代码只认这两个信号：

```ts
// utils/errorMessage.ts
const cfBlocked =
  /cf-mitigated=\s*(challenge|block|managed)/i.test(msg) || // 场景B命中，场景A不命中(值是"-")
  lower.includes('just a moment') ||                        // 场景B的body命中，场景A不命中
  lower.includes('cf-chl') ||
  lower.includes('attention required')
```

**两个 cookie 到底怎么用——流程**

![BGM 两个 cookie 的说明](docs/devlog-assets/bgm-cookie-flow.svg)

- 匿名 cookie jar（`BrowserSession`）是反爬虫伪装的一部分，跟登录无关
- 固定 UA/请求头 + 把服务器发的 `Set-Cookie` 存下来下次带上，
- 让请求看起来像"同一个人在持续访问"，而不是每次都是零 cookie 的全新访客。
- 登录后两个 cookie 一起带——这就是真实浏览器本来的行为。
- 浏览器的 Cookie 机制不区分"登录 cookie"和"其他 cookie"，
- 同一域名下所有没过期的 cookie 都在同一个罐子里，每次请求原样一起发出去；
- 登录不会清掉你登录前就有的 cookie，只是往罐子里加新的。
- 反过来登录后特意把匿名 cookie 摘掉、只发登录 cookie，才是不像真实浏览器的可疑做法。

### 2026-06-29 feat: BGM 令牌 + 内嵌登录窗自动填充鉴权

**效果**：
1. 设置页填「BGM 访问令牌」后，`api.bgm.tv` 请求（详情/别名搜索）带登录态，限额更宽松
2. 新增「登录 BGM」按钮：弹内嵌真实登录页，登录成功自动关窗，不用手动复制 cookie

**登录流程**（点击"登录 BGM"之后，数据怎么流动）：

![BGM 内嵌登录数据流程](docs/devlog-assets/bgm-login-flow.svg)

「怎么判断登录成功了」——监听 cookie 变化，只认 `chii_auth` 这个 BGM 的关键登录态 cookie：

```ts
// bgm/credentials.ts
const captureIfLoggedIn = async () => {
  const cookies = await part.cookies.get({ domain: 'bgm.tv' })
  const hasAuth = cookies.some((c) => c.name === 'chii_auth' && c.value) // 这个cookie出现=登录成功
  if (!hasAuth) return
  setBgmCookie(cookies.map((c) => `${c.name}=${c.value}`).join('; ')) // 存下全部cookie，供后续搜索请求用
  win.close() // 自动关掉登录窗，用户不用手动关
}
part.cookies.on('changed', (_e, c, _cause, removed) => {
  if (!removed && c.domain?.includes('bgm.tv') && c.name === 'chii_auth') captureIfLoggedIn()
})
```

「怎么判断登录过期了」——不是猜 cookie 有效期，是主动拉一次首页看有没有退出链接：

```ts
// bgm/credentials.ts
const html = res.body.toString('utf-8')
if (!html.includes('/logout')) setBgmCookie('') // 页面上没有"退出"入口 = 其实没登录了，清掉本地cookie
// 这行在try块里，请求本身失败（网络问题）会走catch、不清cookie —— 避免把"网络抖了一下"误判成"登录过期"
```

有 token 时给 API 请求加认证头，跟上面的 cookie 是两套独立的凭证（token 管 API，cookie 管网页搜索）：

```ts
// bgm/api-client.ts
const token = getBgmToken()
if (token) headers['Authorization'] = `Bearer ${token}`
```

## 稀饭账号

### 2026-07-28 feat(xifan): 新增稀饭动漫登录

**效果**：
1. 设置页新增「稀饭账号」区，账号/密码/验证码登录

**接口是拿真实登录表单反出来的**（浏览器里跑一遍）：

```
POST /index.php/user/login   body: user_name / user_pwd / verify（form-urlencoded）
→ {"code":1,...} 成功；否则 msg 已是人话（如 {"code":1002,"msg":"验证码错误"}），直接透传给 UI，不用再套一层错误分类
```

验证码图复用了搜索验证码的同一个接口（`/index.php/verify/index.html`，跟 `PHPSESSID` 绑定）

「判断登录成功」——看 cookie 罐里有没有种下 `user_id`（抄的站点自己前端 `EC.Cookie.Get('user_id')` 那行逻辑）：

```ts
// xifan/api.ts
export function getXifanAuthStatus(): XifanAuthStatus {
  const uid = xifanSession.getCookie('user_id')
  return { loggedIn: !!uid && uid !== '0' }
}
```

`HttpSession` 之前只有 `get()`，登录要发表单只能补个 `post()`——抽了个私有 `request()` 让 get/post 共用同一套「逐跳跟重定向 + 每跳 ingest Set-Cookie」逻辑。

## 动漫查询

### 2026-08-06 fix(bgm): 搜索无精确结果时显示前三个候选

**效果**：

1. 只记得大概番名时，不再因为应用的严格匹配把 BGM 已返回的候选全部过滤掉；搜「今天的猫」会显示 BGM 相关度最高的 3 条，其中包含《能干的猫今天也忧郁》
2. BGM 本身没有返回任何条目时仍显示“未找到”，网络错误与限流错误也继续原样反馈

**关键代码**：

```ts
// bgm/search.ts
if (matched.length === 0) {
  matched.push(...allItems.slice(0, 3))
}
```
