# MapleTools 开发规范

## 1. 项目是什么

MapleTools 是一个**桌面端**（Electron）动漫搜索 / 下载 / 管理工具，集成两个流媒体站
（Xifan、Girigiri、Aowu）+ Bangumi（BGM）元数据 + 本地媒体库。标准 Electron 三进程：

| 进程 | 环境 | 职责 | 入口 |
|---|---|---|---|
| **main** | Node.js | IPC、下载队列、文件 IO、ffmpeg、抓取 | `src/main/index.ts` |
| **preload** | 桥接 | `contextBridge` 暴露 `window.*Api` | `src/preload/index.ts` |
| **renderer** | Chromium | React + Tailwind SPA | `src/renderer/src/` |

**渲染进程永远不直接碰网络 / 文件 / Node API** —— 一切经 IPC 走主进程。

---

## 2. 协作要求

- **对话用中文**回复。
- **代码注释用中文**。
  注释重点写**为什么**（决策、踩过的坑、约束），不写「这行代码做了什么」这种废话。
  代码自解释「做什么」，注释负责「为什么这么做 / 为什么不那么做」。
- **改已有代码时，不动无关的部分**。不要顺手重排 import、改格式、重命名无关变量 ——
  让 diff 只包含本次意图，方便 review 和回滚。
- **commit / push 只在用户明确要求时做**（见第 11 节）。
- 发现顺手能修但会让本次改动膨胀的问题 → 记下来单独处理，不混进当前改动。

---

## 3. 完成度要求

- 以**生产级**标准写代码，不写 toy / demo。
- **跨平台**：必须同时支持 **Windows 和 macOS**（CI 两个平台并行打包）。平台相关逻辑
  （路径分隔符、回收站、PowerShell 辅助脚本）要分支处理，见 `src/main/recycle/`。
  - 当前 Electron 版本 **^28**，**不**需要兼容 Windows 7。
  - PowerShell 辅助脚本只在 Windows 路径用（`resources/recycle-helper.ps1`，经 `extraResources` 打包），
    macOS 分支不依赖它。
- **目前没有测试**（package.json 无 test 脚本，无测试框架）。新增纯逻辑模块时鼓励补测，
  但不要假装项目里已有测试体系。

---

## 4. 技术栈与选型理由

| 层 | 选型 | 理由 |
|---|---|---|
| 构建 | **electron-vite** | 一套配置同时管 main/preload/renderer 三端，HMR 快 |
| 语言 | **TypeScript 5**，`strict: true` | 三个 tsconfig：`tsconfig.node.json`（main+preload）/ `tsconfig.web.json`（renderer）|
| UI | **React 18 + Tailwind 3** | 路由用 `react-router-dom` v6 |
| 设计系统 | **Material Design 3 颜色 token**（CSS 变量） | 见 `src/renderer/src/index.css`，深浅色两套 |
| 抓取/解析 | **cheerio**（静态 HTML） | 不引重型浏览器，详见第 6 节 |
| 字体/图标 | **自托管**（`@fontsource/*` + `material-symbols`） | 不依赖 CDN，断网 / 无代理也能显示 |
| 文件监听 | **chokidar** | 本地库增量扫描 |
| 邮件 | **nodemailer** | 周历邮件提醒 |
| 更新 | **electron-updater** | GitHub Releases 自动更新 |

**减依赖原则**：能用 Node 内置 / Electron 自带能力解决的，不引第三方库。HTTP 用 Electron `net`
（第 6 节），不引 axios / undici / node-fetch。

---

## 5. 目录结构与职责

```
src/
├── main/                  主进程
│   ├── index.ts           应用入口：窗口、协议、IPC 注册、生命周期
│   ├── ipc/               IPC handler，按域拆分（bgm / xifan / library / system ...）
│   │   └── index.ts       registerAllIpc() 统一注册
│   ├── bgm/ xifan/ girigiri/ aowu/   各站点 API + 下载
│   ├── moegirl/           萌娘百科简介兜底
│   ├── library/           本地媒体库扫描 + ffmpeg 缩略图
│   ├── mail/ recycle/ updater/   周边能力
│   └── shared/            跨站点共享工具（net-request / browser-session / rate-limit / http-client / http-session / scrape-guard ...）
├── preload/index.ts       contextBridge 暴露 window.*Api
└── renderer/src/
    ├── pages/             一个路由一个文件（PascalCase：MyAnime.tsx ...）
    ├── components/        可复用组件（PascalCase：WatchHere.tsx ...）
    ├── stores/            可观察 store（camelCase：animeTrackStore.ts ...）
    ├── hooks/             React hooks（useCover.ts ...）
    ├── utils/ types/      纯函数 / 类型
    ├── env.d.ts           window.*Api 的 TS 类型声明
    └── index.css          MD3 颜色 token + Tailwind 入口
```

**文件命名约定**（既有规律，照着来）：
- 主进程 / shared / 工具：**kebab-case**（`net-request.ts`、`cover-cache.ts`、`http-session.ts`）
- 渲染页面 / 组件：**PascalCase**（`AnimeInfo.tsx`、`TopBar.tsx`）
- store / hook：**camelCase**（`downloadStore.ts`、`useCover.ts`）

渲染进程内 import 用 `@renderer` alias 指向 `src/renderer/src/`。

---

## 6. 网络与抓取规范（最重要，先看 [`docs/scraping/bgm-集成参考手册.md`](./docs/scraping/bgm-集成参考手册.md)）

### 6.1 传输层一律走 Electron `net`，不用 Node `https`

所有主进程抓取走 `src/main/shared/net-request.ts` 的 `netRequest()`（Electron `net` =
Chromium 网络栈）。

**为什么**：Node `https` **不读系统代理**。用户开 Clash 系 fake-ip 代理时，域名解析成
`198.18.x` 假地址，Node 直连这个不可路由地址 → 黑洞 → 超时；而 Electron `net` 自动走系统
代理 + PAC + IPv4/IPv6 happy-eyeballs，跟浏览器行为一致。无代理用户走 net 也自动直连，更稳。
完整根因见 BGM 集成参考手册 第 10 节。

- ❌ 新增抓取又写 `https.get` / `https.request`
- ✅ 一律 `import { netRequest } from '../shared/net-request'`

**例外边界**：红线只约束 **HTML / API 抓取**。下载器和特殊协议走 Node `http`/`https`/裸 `fetch` 是**既有例外**，不算违规 —— mp4 Range 续传（`shared/mp4-range-downloader.ts`）、HLS 分片（`girigiri/download.ts`）、aowu secure 加密协议（`aowu/secure.ts`）、WebDAV（`ipc/webdav.ts`）、封面图直取。判断准则：抓「页面 / 接口数据」走 `netRequest`；拉「二进制流 / 走私有协议」才用 Node。

### 6.2 User-Agent 区分对待

- **API 端点**（`api.bgm.tv`）：规范 UA `MapleTools/${app.getVersion()} (仓库地址)` —— 老实自报家门
- **HTML 抓取**（`bgm.tv` 等）：浏览器伪装 UA（`BrowserSession` 从池子随机挑 + 对齐 `sec-ch-ua`）

两者**相反**，别混用。详见 BGM 集成参考手册 第 2 节。

#### 6.2.1 BGM 登录鉴权（token + cookie，新增于 `1329c37`/`6277487`/`f524a73`）

BGM 现支持登录态，会给抓取附加两类凭证（UA 之外的认证维度）：

- **token → `api.bgm.tv` 作 `Authorization: Bearer`**：有 token 时 API 端走登录态，详情 / 别名搜索限额更宽松（`bgm/api-client.ts`）。
- **cookie → `bgm.tv` HTML 作 `Cookie` 头**：登录态 HTML 搜索 ~0.6s 秒回，匿名被站点故意拖慢到 ~16s（所以 timeout 给到 25s）（`bgm/search.ts`）。
- **凭证存 `userData/bgm_auth.json`**（token + 网页 cookie + 登录邮箱），**不回传 renderer 明文**，只回 `{ hasToken, loggedIn }`（`bgm/credentials.ts`）。
- **cookie 捕获**靠内嵌 BrowserWindow 打开真 bgm.tv 登录页，监听 `chii_auth` cookie 出现即抓取全部 bgm.tv cookie。
- **登录态校验 `verifyBgmLogin`** 仅由 `bgm:verify-login` IPC **显式触发，无轮询**；网络失败时保持原登录状态不误清（别误判为过期）。

### 6.3 限流防御核心原则：失败后不重试、不试探

这是项目的**红线**，违反会加重用户被限流的程度：

- ❌ **失败后应用层自动重试**（限流 / 5xx 之后再发一次 = 在惩罚窗口里加戳）
- ❌ **失败后周期性探测**「现在恢复了没」
- ❌ **静默吞错**（catch 后 return null，让用户以为「没结果」而不停手动重试）
- ✅ **失败一律 throw 到 UI**，由用户通过倒计时按钮 / Try again 主动决定何时重试
- ✅ **正常情况下的派生调用是允许的**（SWR 后台刷新、`ensureBgmTagsFilled` 补全），
  只要满足「**失败即作废，不重试不探测**」。区分「失败后行为（禁止）」vs「正常派生（允许）」，
  判定准则见 BGM 集成参考手册 第 3 节。

唯一允许的代码层重试是**传输层瞬时错误**（`withTransientRetry`：ECONNRESET 这类 socket 抖动，
单次、200-500ms 内、用户无感）—— 这是「把没连上的连上」，不是「突破限流」。

- ❌ **不要上 IP 池 / 代理轮换 / Playwright 来「绕过限流」** —— 都被否决过，理由见 BGM 集成参考手册 第 4 / 10 节。

**L3 熔断器是允许的防御**（`bgm/api-circuit.ts`，不算「试探」）：连续失败后阶梯冷却，半开恢复**仅靠下一个自然请求**当探针、**绝不主动发探测请求**，冷却状态还持久化防重启重撞。它守住了「不主动试探」红线，别误删或误判为违规。

### 6.4 限流节流

外部 API 走 `shared/rate-limit.ts` 的 `RateLimiter`（间隔 + 抖动），多端点共享同一个 limiter
串行节流。`RateLimiter` 另支持滚动窗口配额（`maxPerWindow` / `windowMs`，分钟级总量上限）+ `softThrottle` 软恢复慢跑。

### 6.5 Cloudflare（CF）报错分类（新增于 `6277487`）

HTML / API 抓取失败时由 `diagnoseFailure()`（`bgm/search.ts`）+ `scrape-guard.ts` 抓 CF 指纹（`server` / `cf-ray` / `cf-mitigated` 响应头 + body 前段「Just a moment」挑战页），区分「CF 盾挑战」vs「纯网关 5xx」，**原样 `throw` 给 UI，不上隐藏 BrowserWindow 过盾、不重试**。分类原则详见第 9 节。

> 注：`diagnoseFailure` 内有一段自标「临时诊断」的指纹日志，待 CF 行为确认清楚后可清理；CF 的**分类逻辑**（渲染层 `errorMessage.ts`）是永久的。

---

## 7. 进程间通信（IPC）

新增一个 IPC channel 固定四步，缺一不可：

1. **主进程**：在 `src/main/ipc/{域}.ts` 里 `ipcMain.handle('域:动作', handler)`
2. **preload**：在 `src/preload/index.ts` 的对应 `window.*Api` 里加方法，转发 `ipcRenderer.invoke`
3. **类型**：在 `src/renderer/src/env.d.ts` 给该 `*Api` 补 TS 声明
4. **渲染调用**：`window.bgmApi.xxx(...)`

**约定**：
- channel 名用 `域:动作` 格式（`bgm:search`、`system:disk-free`、`bgm:cache-cover`）。
- 请求/响应优先用 `invoke/handle`（有返回值）；单向通知用 `send`（如 `app:renderer-ready`）。
- 事件流（进度推送）用 `ipcRenderer.on` + 返回 unsubscribe 函数（见 `downloadApi.onProgress`）。
- 当前 `window.*Api` surface（13 个）：`bgmApi` / `xifanApi` / `girigiriApi` / `aowuApi` / `downloadApi` / `libraryApi` / `systemApi` / `fileExplorerApi` / `webdavApi` / `mailApi` / `miaoyuApi`（妙语库）/ `updaterApi` / `screenshotApi`。新增功能复用既有 surface 或新开一个，都走上面四步。

正例（来自 `preload/index.ts`）：

```ts
contextBridge.exposeInMainWorld('bgmApi', {
  search: (keyword: string, update?: boolean, cat?: 1 | 2) =>
    ipcRenderer.invoke('bgm:search', keyword, update, cat),
})
```

---

## 8. 状态管理（渲染进程）

store 是**纯可观察对象，不是 React state**：内部 `Map` + listener 集合 + `localStorage` 持久化，
组件通过 hook 订阅（见 `stores/animeTrackStore.ts`、`stores/downloadStore.ts`）。

### 8.1 持久化数据必须零迁移向后兼容

每个 store 有 `normalize()`，对**老数据缺字段一律给默认值**，新增字段不写迁移脚本：

```ts
// 老 track 没 observeCount / aliases / subjectType 时给默认值，read 时一次性收敛
const observeCount = typeof t.observeCount === 'number' && t.observeCount >= 0 ? Math.floor(t.observeCount) : 0
const aliases = normalizeTagList(t.aliases)            // 缺 → []
const subjectType = ...                                // 缺 → 'anime'
```

### 8.2 lock-on-first-content

某些字段（如 `bgmTags`）**首次有内容后锁定**，之后再 fetch 即使源数据变了也不覆盖 ——
保证用户看到的快照稳定、跨设备同步友好。新增同类字段照这个模式。

### 8.3 同步可移植性：禁止持久化机器相关路径

track 数据要跨设备 WebDAV 同步，**绝不能把本机绝对路径写进去**。

- ❌ 把 `archivist:///Users/xxx/.../cover.jpg`（本机 userData 绝对路径）写进 `track.cover` 落盘
  → 同步到设备 B 路径不存在 → 封面全裂（**踩过这个坑**）
- ✅ `track.cover` 永远存**可移植 URL**；本地化只在**显示时**由 `hooks/useCover.ts` 按设备各自做

### 8.4 store 的两类合规例外

- **瞬时 UI store 不必持久化**：纯 UI 态（如 `uiStore` 的抽屉开合）可以不写 `localStorage`、不需要 `normalize()`。只有**落盘的** store 才必须 normalize。
- **页面级 localStorage 状态是合法的第二模式**：不是所有持久化状态都得抽成 `stores/` 下的独立 store。像妙语库把状态写在 `pages/MiaoyuLibrary.tsx` 内（自带 `normalize()`、图片只存 `{hash, ext}` 不存机器路径）是允许的 —— 只要守住 8.1 / 8.3 的精神。等规模长大、需要跨页共享时再抽 store。
- 当前 store 清单：`animeTrackStore`（追番，lock-on-first-content 范例）/ `downloadStore`（三源下载中枢）/ `recommendationStore`（推荐）/ `updateStore`（更新横幅）/ `uiStore`（瞬时 UI）。注：`siteApi.ts` 虽放在 `stores/` 下但**不是 store**（无 Map / listener / 持久化，是按源派发的 IPC 表）。

---

## 9. 错误处理与用户反馈

- 主进程抛**具体错误类型**：限流抛 `RateLimitError(waitSeconds, msg)`，其余抛普通 `Error(msg)`。（注：`waitSeconds` 是主进程构造参数；渲染层 `FriendlyError` 的字段叫 `retryAfterSec`，别混。）
- 渲染进程 `utils/errorMessage.ts` 的 `friendlyError()` 把原始错误**分类**成
  `{ title, hint, raw, retryAfterSec? }`，每类有针对性文案 + 行动指引。
- ❌ **统一兜底文案**（早期所有错误都是「网络请求失败」，用户被限流时以为自己网断了一直重试，
  反而加重限流）。新错误模式 → 在 `errorMessage.ts` 加分类，不要重设计这套机制。
- ❌ **错误黑盒**（catch 后 return null）。
- **CF（Cloudflare）分类**：命中 `cf-mitigated=challenge/block/managed`、`Just a moment`、`cf-chl` 等严格特征才判 CF 拦截，**绝不用裸 `cloudflare` 关键词**（BGM 诊断串恒带 `server=cloudflare`，会误判）。
- **登录 / 鉴权失败不进 friendlyError**：它是**状态**不是错误，走 `getBgmAuthStatus` 状态位 + `BgmLoginChip` 呈现（未登录 / 已过期 → 提示 + 登录按钮），不弹 ErrorPanel。
- 错误分类已细到 20+ 类（限流 / 超时 / CF / 4xx / 5xx / 文件占用 / 权限 ...），**完整清单以 `errorMessage.ts` 为准**；改时守住 CF / 限流 / 鉴权三类最易误改的原则，别回退成统一兜底。

---

## 10. 代码风格

### 10.1 TypeScript

> 项目**没有 ESLint / Prettier 配置**，风格靠约定维持。照下面既有风格写：

- **2 空格**缩进
- **不写分号**
- **单引号**
- `strict: true`，不要 `any` 兜底（实在要用窄化的 `unknown` + 类型守卫）
- 卫语句优先于深层嵌套：检查失败早 return
- 注释写**为什么**，踩过的坑直接写进注释（带 commit hash 更好）

### 10.2 React

- 函数组件 + hooks，不用 class 组件
- 副作用清理要返回 teardown（订阅类 hook 必须 unsubscribe）
- 显示层的「按设备解析」逻辑走 hook（参考 `useCover` 的模式），不要污染持久化数据

### 10.3 Tailwind / 样式

- **只用 MD3 颜色 token**（`bg-surface-container`、`text-on-surface`、`text-primary` ...），
  **不写裸色值**（`#xxx` / `bg-[#...]`）—— 否则深浅色主题切换会失效。
- 启动相关的极早期样式（React 挂载前）才内联进 `src/renderer/index.html`（见启动屏处理）。
- **选中/非选中（active/selected/hover/error...）两态切换时，盒模型尺寸必须保持不变**——
  否则相邻元素会被「挤一下」，产生布局抖动（chip / tab / pill / 列表项尤其高发）。
  写按状态切换的条件 className 时守住三条：
  - **border 有无要对称**：一态有 `border` / `border-2` / `border-r-2`，另一态必须补**等宽透明边**
    （`border border-transparent` / `border-r-2 border-transparent`），不能直接没有。
    只换 border **颜色**（宽度相同）不算问题。
  - **字重不随状态变**：不要选中态 `font-bold`、非选中态不加粗——中文/英文加粗会变宽挤同行。
    要强调选中态就靠颜色 / 底色（`text-primary` + `bg-primary/15` 等），两态保持同一字重。
  - **padding / 字号 / 宽高不随状态变**：`px-*` / `py-*` / `text-*` / `w-*` / `h-*` 两态要一致。
  口诀：**状态切换只改"看得见的样子"（颜色、底色、阴影、填充图标），不改"占多大地方"。**

---

## 11. Git / 提交 / 版本 / 发布

### 11.1 提交

- **只在用户要求时** commit / push。
- 在默认分支上要先开分支再提交。
- commit message 用**中文 Conventional Commits**：`feat(scope): 描述` / `fix(scope): 描述` /
  `chore(scope): 描述`。
- **标题写读者能看懂的「现象 / 结果」**，别堆底层术语。
  例：`fix(bgm): 修复搜索动漫时报 net::ERR_INVALID_ARGUMENT`，
  而不是 `netRequest 跳过 Host/Connection 头`（这种是底层细节，放正文）。
- **正文按需写，不是每次都要**：简单改动只要标题；必要 / 大 / 复杂的改动才写正文，
  放底层原因 / 关键决策。正文**尽量简短说重点**（一两句或几条要点都行），不写长篇大论。
- **不加任何 AI 署名 trailer**（如 `Co-Authored-By: Claude ...`）。

### 11.2 版本号（SemVer）

- **PATCH**：bug 修复 / UI 微调 / 兼容性修补，向下兼容（`0.4.0` → `0.4.1`）
- **MINOR**：向下兼容的新功能（`0.4.x` → `0.5.0`）
- **MAJOR**：破坏性重构 / 接口失效（`0.x` → `1.0.0`）
- 禁止情绪化升号（功能「重磅」但向下兼容 = 仍是 MINOR）。发布后版本锁定，缺陷靠新 PATCH 修。

### 11.3 发布（GitHub Actions）

push `v*` tag 触发 `.github/workflows/release.yml`，Windows + macOS 并行打包出 draft release，
再手动编辑 + 发布。完整流程（含 `.npmrc` 镜像坑）见 electron-release skill。
产物命名 `${productName}_${version}_${platform}_${arch}.${ext}`。

**发版前必做**：bump 完 `package.json` 版本号后，跑一次 `npm run sync:manifest` 把
`update-manifest.json` 的 `version` 同步成新版本号，和 release commit 一起提交。这份清单是
「国内加速更新」让无魔法客户端发现新版本的唯一入口——不更新它，所有走国内源的用户都收不到
更新。机制 + 换代理见 [`docs/release/自动更新-国内加速.md`](./docs/release/自动更新-国内加速.md)。
