# Sentry 监控接入通用指南

一次接入的经验抽成可复用的东西。本项目（`anime.alcmaple.cn`）已按此实现，代码见
`web/src/monitoring.ts` / `web/server/monitoring.ts` / `web/vite.config.ts` /
`web/public/white-screen-probe.js`，SPA 之外那张裸 HTML 页另见
`web/src/player-monitoring.ts` / `web/scripts/build-player-monitor.ts`（§7）；本机落地步骤见
[`唐人云部署保姆教程.md`](唐人云部署保姆教程.md) 的「异常与性能监控」节。

这份文档的用法：

- **落地本项目** —— 照「§4 本项目落地值」那张表填，代码已经写好，不用动。
- **接一个新项目 / 新服务器** —— 「§1 照抄」整段搬过去，「§2 每实例单独生成」逐项走一遍生成流程，
  再按「§5 换个项目 / 服务器」的顺序拼起来。
- **项目里有 SPA 之外的页面**（服务端渲染的裸 HTML、独立入口）—— 上面那套**覆盖不到它**，
  补 §7；页面里自己打的日志怎么进 Sentry 见 §8；Sentry 天生看不到、必须自己造遥测的那类问题见 §9。

---

## §0 这套东西是什么形状（不变的骨架）

```
浏览器：@sentry/react，懒加载（无 DSN 的构建不打进首屏包）
          │  未处理异常 + React 可恢复错误 + 低采样 trace + Web Vitals
          │  只向本站 /api 传播 trace，不发第三方
          ▼
        Sentry 项目 A（<app>-web）
                                        ← 两个项目，issue 不混
        Sentry 项目 B（<app>-server）
          ▲
          │  未处理异常（强制 capture）+ 每请求 X-Request-ID + 低采样 trace
          │  只采样 /api，静态资源和健康探测不计额度
服务端：@sentry/node，模块加载即 init，手动埋 Hono 请求 span
          （不依赖自动 HTTP integration → VPS / serverless 行为一致）

构建期：@sentry/vite-plugin —— 仅当注入了 SENTRY_AUTH_TOKEN 才启用
          sourcemap:'hidden'（产出 .map 但不写 sourceMappingURL 注释）
          → 上传 .map 到 Sentry（用 debug id 关联）
          → filesToDeleteAfterUpload 立刻从 dist 删掉 .map
```

两端都 `sendDefaultPii:false`，事件出站前再清一遍：URL 查询串、Cookie、请求体、用户身份全去掉，
请求头**只留 `User-Agent`**（Sentry 服务端靠它还原 browser/os/device，排障常用）。不启用 Session Replay。

> **这张图只覆盖「SPA + 服务端」。** 浏览器那一路的 DSN 是**构建时**注入 SPA bundle 的，
> 所以任何**不由 SPA bundle 驱动**的页面都在盲区外面 —— 见 §7。

---

## §1 照抄（架构，跨项目原样搬）

以下东西换项目**不用改一个字**（除了 §2 标出的几处占位）。直接把本项目对应文件复制过去。

| # | 文件 | 作用 | 换项目要动的地方 |
|---|---|---|---|
| 1 | `package.json` deps | `@sentry/react` `@sentry/node`（dep）、`@sentry/vite-plugin`（devDep） | 无 |
| 2 | `web/src/monitoring.ts` | 浏览器 init + PII 清洗 + 白屏探针接口 | **仅** `tracePropagationTargets` 里的域名正则（§2-F） |
| 3 | `web/server/monitoring.ts` | 服务端 init + 请求中间件 + 未处理异常兜底 | 无（除非不是 Hono，见 §3） |
| 4 | `web/vite.config.ts` 的 `sentryVitePlugin(...)` 段 + `build.sourcemap` | source map 上传，token 缺失时自动跳过 | **仅** `filesToDeleteAfterUpload` 的 glob 要匹配你的构建输出目录（§2-J） |
| 5 | `web/src/main.tsx` 的 `bootstrap()` | 有 `VITE_SENTRY_DSN` 才动态 import 监控模块 | 无 |
| 6 | `web/index.html` 末尾 `<script src="/white-screen-probe.js">` + `web/public/white-screen-probe.js` | 主包渲染失败兜底 | **仅** 探针里的挂载点 id（`#root` / `#app`…，§2-I） |
| 7 | `web/src/vite-env.d.ts` 的 `Window.__mapleMonitoring` 声明 | 类型 | 无 |

### 环境变量契约（名字和语义固定，值见 §2）

| 变量 | 端 | 时机 | 缺失时 |
|---|---|---|---|
| `SENTRY_DSN` | 服务端 | 运行时 | 不初始化 SDK，不上报 |
| `VITE_SENTRY_DSN` | 浏览器 | **构建时** | 监控代码被 tree-shake，首屏包里没有 SDK |
| `SENTRY_AUTH_TOKEN` | 构建机 | 构建时 | 不产出/不传 source map，栈是压缩的（监控本身照常） |
| `SENTRY_ORG` / `SENTRY_PROJECT` | 构建机 | 构建时 | 配了 token 就必须一起给（插件定位上传目标） |
| `SENTRY_RELEASE` / `VITE_SENTRY_RELEASE` | 服务端 / 浏览器 | 运行时 / **构建时** | 无 release 分组，其余正常。**两个值必须相等**（同一次部署的前后端） |
| `SENTRY_ENVIRONMENT` / `VITE_SENTRY_ENVIRONMENT` | 各自 | — | 退回 `NODE_ENV` / Vite mode |
| `SENTRY_TRACES_SAMPLE_RATE` / `VITE_SENTRY_TRACES_SAMPLE_RATE` | 各自 | — | 默认 `0.05`（异常不受采样影响） |

### 发布流程的形状（平台无关）

```
1. 取一个 release 标识：RELEASE=$(git rev-parse --short HEAD)
2. 注入构建期密钥（source 那个只读文件）
3. 构建：VITE_SENTRY_RELEASE=$RELEASE <build>
   └─ 有 SENTRY_AUTH_TOKEN → 自动传 map、删 map
4. 让服务端进程拿到 SENTRY_RELEASE=$RELEASE（与第 3 步同值）+ SENTRY_DSN 等
5. 重启服务端进程
6. 验收（§4 末 / §5 末）
```

变的只有第 2、4、5 步「怎么注入 / 怎么重启」——那是平台差异，见 §2-H。

---

## §2 每个实例单独生成的部分（+ 生成流程）

这些是**不能照抄**的：同一个 DSN 不能给两个项目、一个 auth token 泄了要重开而不是各机传阅、
release 必须跟着 commit 走……就像两个服务不能绑同一个端口。原理不变，变的是这些「现生成的标识」。

### A. 两个 Sentry 项目

**为什么两个**：浏览器错误和服务端错误混在一个项目里，`TypeError` 一多就分不清是前端还是后端；
issue 编号、告警规则、采样额度也都搅在一起。

**怎么生成**：登录 sentry.io → `Projects → Create Project` ×2

| 项目 | Platform 选 | 名字建议 | Products |
|---|---|---|---|
| 前端 | **React**（Vue 项目选 Vue） | `<app>-web` | Error monitoring + Tracing。**不开** Session Replay / Logging / Profiling |
| 后端 | **Node.js**（框架无对应选项就选纯 Node，我们是手动埋点） | `<app>-server` | 同上 |

### B. 两个 DSN

一个项目一个。**是公开值**（本来就写在浏览器代码里），泄露无所谓，但仍别写进 git（跟着环境变量走）。

**怎么拿**：项目建好后的引导页直接显示；或 `项目 Settings → Client Keys (DSN)`。
形如 `https://<hash>@o<orgid>.ingest.<region>.sentry.io/<projectid>`。

### C. 组织 slug

`@sentry/vite-plugin` 上传时定位组织用。

**怎么拿**：看 Sentry 后台 URL —— `https://<这一段>.sentry.io/...`。

### D. Auth Token（源码映射上传凭证）

**极敏感**：能往你的 Sentry 组织写 release / 传文件。**绝不进仓库**，Sentry **只明文显示一次**。

**怎么生成**：`Settings → Auth Tokens`（组织级，`/settings/auth-tokens/`）→ `Create New Token`
→ 起个名（如 `<app> source maps`）→ 组织级 token 自带 `project:releases` 等所需 scope
→ **立刻复制**，粘到服务器的密钥文件里（§2-G）→ 点「I've saved it」。

丢了不用找，删掉重开一个。

### E. Release 标识

**为什么要**：把「同一版代码」的前端异常、后端异常、性能数据归到一组；也是 Sentry 拿 debug id
之外再对齐 source map 的锚。**前端构建注入的值** 和 **后端进程环境的值** 必须**逐字符相等**。

**怎么生成**：每次部署现算，别写死。`RELEASE="$(git rev-parse --short HEAD)"`。
服务端配置里写成读环境变量（见 §2-G），这样「忘了改」这个坑就不存在。

### F. `tracePropagationTargets` 里的域名

`web/src/monitoring.ts` 里这一行的第二个正则：

```ts
tracePropagationTargets: [/^\/api(?:\/|$)/, /^https:\/\/[^/]*\balcmaple\.cn\/api(?:\/|$)/],
```

第一个（相对路径 `/api`）通用，别动。第二个把 `alcmaple\.cn` 换成**新项目的生产域名**。
作用：只给「打到自己后端」的请求附加 `sentry-trace` 头，第三方接口（CDN、图床、播放源）不加。

### G. 密钥文件的位置

原则：**在 git 工作区之外**，而且在**「部署时会被清空 / 覆盖」的目录之外**。

- 本项目：`/opt/mapletools-data/.env.sentry`（跟 `AUTH_SECRET` 同级，`git reset --hard` 碰不到）
- 一般 VPS：跟你其它部署密钥放一起（systemd `EnvironmentFile=` 指向的文件 / pm2 数据目录 / …）
- 权限：`chmod 600`，属主是**跑构建的那个用户**（本项目构建用 root，所以 root）

文件内容（占位换成 §2-B/C/D 生成的值）：

```bash
export SENTRY_AUTH_TOKEN="sntrys_..."
export SENTRY_ORG="<slug>"
export SENTRY_PROJECT="<前端项目名，如 anime-web>"
export VITE_SENTRY_DSN="https://<前端 DSN>"
export VITE_SENTRY_ENVIRONMENT="production"
export VITE_SENTRY_TRACES_SAMPLE_RATE="0.05"
```

服务端运行时变量（`SENTRY_DSN` 用**后端** DSN）进你的进程管理器配置：

```
SENTRY_DSN=https://<后端 DSN>
SENTRY_ENVIRONMENT=production
SENTRY_TRACES_SAMPLE_RATE=0.05
SENTRY_RELEASE=            # 留空/占位；由部署脚本 export 后进程读 process.env
```

> pm2 的 `ecosystem.config.cjs` 里写 `SENTRY_RELEASE: process.env.SENTRY_RELEASE || ''`，
> 部署时 `SENTRY_RELEASE=$RELEASE pm2 start ecosystem.config.cjs --update-env` 就自动对齐。
> systemd 用 `Environment=` 或部署脚本写 drop-in。

### H. 「注入变量 / 重启」的命令

平台差异，按你的实际来：

| 平台 | 注入构建变量 | 重启并让服务端读到新 `SENTRY_*` |
|---|---|---|
| 本项目（VPS + pm2 + `mtweb` 包装） | `source .../.env.sentry && export VITE_SENTRY_RELEASE=$RELEASE` | `SENTRY_RELEASE=$RELEASE mtweb start .../ecosystem.config.cjs --update-env`（`restart` 不重读配置文件） |
| 普通 pm2 | 同上 | `SENTRY_RELEASE=$RELEASE pm2 start ecosystem.config.cjs --update-env` |
| systemd | 构建在 CI / 手动 shell | 改 `EnvironmentFile` 后 `systemctl restart <svc>` |
| Docker | build-arg / `--env` | 重建镜像或 `docker compose up -d` |
| Vercel / Netlify | 项目控制台的环境变量 UI（构建时变量勾 "Production"） | 触发一次 redeploy |

### I. 白屏探针的挂载点 id

`web/public/white-screen-probe.js` 里 `document.getElementById('root')` —— 换成你 `index.html`
里真实的挂载点（CRA/Vite 默认 `root`，有的模板是 `app`）。

### J. `filesToDeleteAfterUpload` 的 glob

`web/vite.config.ts` 里 `['./dist/**/*.map']` —— 若你的构建输出不是 `dist/`，改成实际目录。
**这条必须匹配对**：只要有一个 `.map` 留在「对外 serve 的静态目录」里，源码就等于公开了（见 §6）。

---

## §3 服务端不是 Hono 怎么办

`web/server/monitoring.ts` 里跟 Hono 绑定的只有 `monitoringMiddleware()` / `monitoringErrorHandler()`
两个导出（它们造请求 span、塞 `X-Request-ID`、兜未处理异常）。换框架时：

- **`Sentry.init(...)` 那一坨照抄** —— DSN、`sendDefaultPii:false`、`beforeSend` / `beforeSendTransaction`
  的 PII 清洗、过滤掉自动 `Http` integration，这些跟框架无关。
- **中间件换成目标框架的等价物**：Express 用 `Sentry.expressErrorHandler()` + 一个塞 request id 的
  中间件；Fastify 用 `onError` hook；等等。保持「每请求一个隔离 scope、路由名归一化（`stablePath`）、
  只采样业务路由」这三点不变。
- 想省事也可以直接用官方对应框架的 SDK（`@sentry/node` 的 Express/Fastify/NestJS 集成），
  但那样就回到「依赖自动 instrumentation」，serverless / 常驻进程行为差异要自己趟。

前端（`src/monitoring.ts`）与框架无关，任何前端框架都照抄，`@sentry/react` 换成 `@sentry/vue` 等即可。

---

## §4 本项目落地值（`anime.alcmaple.cn`）

代码已实现，AI 落地本项目时对照这张表确认即可（真值不进仓库，存在 `/opt/mapletools-data/`）：

| §2 项 | 本项目的值 |
|---|---|
| A 项目 | `anime-web`（React）、`anime-server`（Node.js / vanilla），org `alcmaple`，都只开 Error + Tracing |
| B DSN | 前端 `…/4511985987354624`、后端 `…/4511986006491136`（完整值在 `.env.sentry` / `ecosystem.config.cjs`） |
| C org slug | `alcmaple` |
| D auth token | 存 `/opt/mapletools-data/.env.sentry`，名字 `anime source maps upload` |
| E release | `git rev-parse --short HEAD`，前后端共用 |
| F 域名正则 | `/^https:\/\/[^/]*\balcmaple\.cn\/api(?:\/|$)/` |
| G 密钥文件 | `/opt/mapletools-data/.env.sentry`（600 root）+ `ecosystem.config.cjs` 的 `env` |
| H 重启 | `SENTRY_RELEASE=$RELEASE mtweb start /opt/mapletools-data/ecosystem.config.cjs --update-env` |
| I 挂载点 | `#root` |
| §7 裸 HTML 页 | 播放页 `/api/xifan/play-page`；DSN 走 `PLAYER_SENTRY_DSN`（= 前端 DSN，写在 `ecosystem.config.cjs`），tag `surface: xifan-player`，bundle 由 `/api/xifan/monitor.js` 发 |
| J glob | `./dist/**/*.map`（`web/server/node.ts` 用 `serveStatic({root:'./dist'})` 对外发整个 dist） |

发布步骤见 [`唐人云部署保姆教程.md`](唐人云部署保姆教程.md) 的「日常发布」。

---

## §5 换个项目 / 服务器：顺序

1. **代码**：§1 表里 7 个文件复制过去，装 §1 的依赖。
2. **改 3 处占位**：§2-F 域名正则、§2-I 挂载点 id、§2-J 输出目录 glob。
3. **建 2 个 Sentry 项目**（§2-A）→ 记下 2 个 DSN（§2-B）、org slug（§2-C）。
4. **生成 auth token**（§2-D）——最后做，因为只显示一次，生成完马上进第 5 步。
5. **写密钥文件**（§2-G）：构建期文件 + 服务端运行时变量，位置按你的服务器布局（git 工作区外 + 部署不清空的地方）。
6. **CSP**（若项目有严格 CSP）：`connect-src` 要放行 Sentry ingest 域（本项目是 `connect-src 'self' https:`，已覆盖）。
   还要确认 `script-src` 允许你的构建产物加载白屏探针（本项目 `'self'` 够用，探针是同源静态文件）。
7. **接进发布流程**（§1 末的形状 + §2-H 的平台命令）。
8. **首次部署验收**（下）。
9. **盘一遍项目里有没有 SPA 之外的页面**（§7 开头那张判据表），有就按 §7 单独接一条。

### 验收（通用，跟平台无关）

1. 打开站点，控制台敲 `setTimeout(() => { throw new Error('sentry test') })`
   → `<app>-web` 项目 Issues 里几秒内出现。
2. 点进那条 issue：
   - **Context 有 browser / os / device** —— 没有的话是请求头被清光了（本项目 `redactRequest` 特意留了 `User-Agent`）。
   - `release` tag = 你这次的 commit —— 没有的话前端构建没注入 `VITE_SENTRY_RELEASE`。
   - `user` 是 `?`、breadcrumb 里 URL 是 `[Filtered]` —— PII 清洗生效。
3. 从**真实业务代码**触发一个错误（不是控制台 eval —— eval 没有源文件，栈只会是 `<anonymous>`），
   确认栈还原到原始 `.ts/.tsx` 行 → source map 通了。
4. 给任意 JS 资源 URL 加 `.map` 后缀访问：SPA 项目会返回 `index.html`（`content-type: text/html`），
   **不是** JSON source map；非 SPA 应返回 404。任一情况都说明 `.map` 没落在对外目录里。
5. 后端：制造一个真实 500（或等自然发生），确认 `<app>-server` 项目收到、带 `X-Request-ID`、
   同一个 id 也在进程日志里。

---

## §6 原理速记（为什么这么设计，改之前先看）

**为什么两个 Sentry 项目**：见 §2-A。

**为什么 `sourcemap: 'hidden'` 而不是 `true`**：`true` 会在打包后的 JS 末尾写
`//# sourceMappingURL=xxx.map` 注释，等于主动告诉所有人「map 在这里」。`hidden` 产出 map 但不写注释，
Sentry 靠打进 bundle 的 debug id 关联，不需要那条注释。

**为什么上传完立刻删 map（`filesToDeleteAfterUpload`）**：source map ≈ 你的源码（完整路径、
原始变量名、注释）。只要它留在「对外 serve 的目录」里，任何人加个 `.map` 后缀就能下载、还原整个前端。
本项目 `serveStatic({root:'./dist'})` 没有白名单，dist 里有什么就发什么 —— 所以 build 结束时 dist 里
**必须一个 `.map` 都没有**。这三条（hidden + 上传 + 删）是一体的，别单独动其中一条。

**为什么请求头只留 `User-Agent`**：Sentry 服务端**靠 UA 字符串**解析出 `contexts.browser` /
`os` / `device`（浏览器 SDK 不在客户端算这些）。把 headers 整个删掉 → 这三个上下文全空、排障时
「只有 iOS Safari 会崩」这种线索就没了。UA 不算敏感（Cookie / Authorization / Referer 才是），
所以单独放行它一个。

**为什么服务端手动埋 span、还把自动 `Http` integration 过滤掉**：`@sentry/node` 的自动 HTTP
instrumentation 依赖 Node ESM loader hook，VPS 常驻进程和 serverless 冷启动行为不一致、还可能跟
别的库抢 patch。自己给 Hono 建请求 span（`monitoringMiddleware`）行为确定、三处运行环境
（本地 / VPS / serverless）一致。

**为什么 release 前后端必须同值**：Sentry 按 release 聚合「这一版」的所有信号；值不一致，
前端异常和后端异常就归不到一组，性能对比也断了。

**为什么白屏探针是外部文件不是内联 `<script>`**：生产 CSP 是 `script-src 'self' …`（无
`'unsafe-inline'`），`index.html` 里的内联脚本会被浏览器直接拦掉。`/white-screen-probe.js` 是
同源静态文件，走 `'self'` 放行。它覆盖「主包加载了但没渲染进 `#root`」；主包整个加载失败那种，
`window.__mapleMonitoring` 不存在，只能落 `console.error`，得靠 Sentry 之外的手段（拨测 / 日志）发现。

**为什么无 DSN 的构建不该有 SDK**：`main.tsx` 里 `if (import.meta.env.VITE_SENTRY_DSN?.trim())`
构建时被静态替换成 `if (undefined)`，整个 `import('./monitoring')` 分支被 Rollup 消除 ——
没配 Sentry 的构建首屏包里连 SDK 的字节都没有。

---

## §7 SPA 之外的页面（服务端渲染的裸 HTML、独立入口）

**这一节是踩出来的**：本项目的在线播放页（`/api/xifan/play-page`）是服务端返回的一张裸 HTML，
不由 SPA bundle 驱动。它上线后连着**四个 bug** 一个都没进 Sentry —— 页面里未捕获异常一条都不上报，
只能靠用户口述现象。补完这一节之后，同类问题当场就能在 Issues 里看到现场。

### 先判断项目里有没有这种页面

| 典型 | 为什么在盲区 |
|---|---|
| 服务端渲染 / 模板返回的独立页（播放页、打印页、分享页、落地页） | 不加载 SPA 的 JS 入口，`VITE_SENTRY_DSN` 那条构建时注入的链跟它无关 |
| OAuth / 支付回调中转页、错误页、维护页 | 通常是几行内联脚本，越简单越没人想到要监控 —— 而它们恰恰跑在最关键的路径上 |
| iframe 里的子页面、Service Worker、独立 Worker | 不共享主文档的 SDK 实例 |

判据一句话：**这个页面出未捕获异常时，有没有任何一处会知道？** 答不上来就得接。

### 接法（四步，跟 §1 那套并行，不互相干扰）

```
1  单独一个入口文件         只 init + 暴露两个方法（记面包屑 / 主动上报），不掺业务
      ↓
2  打成自托管 IIFE          npm 包里没有现成 CDN bundle，<script src> 引不动
      ↓  （用 esbuild 几行脚本即可，产物进构建输出目录、不进 git）
3  自己的路由发出去          CSP 常见是 script-src 'self'；国内也加载不到 Sentry 的 CDN
      ↓
4  配置运行时注入            服务端渲染的页面可以把 DSN/env/release 直接写进 HTML
```

**四个必须注意的点**（每一条都是当时踩到或差点踩到的）：

1. **构建顺序**：这一步必须排在 SPA 构建**之后** —— 打包器（vite 等）通常会先清空输出目录，
   顺序反了产物当场被删。写进 `"build": "<spa build> && <这一步>"`，别指望人记得。
2. **产物缺失要优雅降级**：本地 dev 没跑过完整构建时那个文件不存在。路由发一段空脚本，
   页面里所有调用做判空 —— **不能白屏**，监控本身不值得赔上页面。
3. **配置走运行时不走构建时**：SPA 那边 DSN 是构建期快照（§1 环境变量契约），但这类页面是服务端
   渲染的，直接读进程环境注进 HTML 即可。好处：换 release 不用重新构建前端。
4. **剪裁**：只留「抓未捕获异常 + 记面包屑」，把 Tracing / Replay / Feedback / Profiling 全过滤掉，
   `tracesSampleRate: 0`。这类页面通常就几个接口，采上来没人看；bundle 也小一半。

### 复用哪个 Sentry 项目

**复用 `<app>-web`，不要为它再建第三个项目。** 它本来就是浏览器错误，分开只会让告警规则和额度更碎。
用 tag 区分即可（本项目是 `surface: xifan-player`），Issues 里按 tag 一筛就只剩这个页面的。

### 环境变量

沿用 §1 的契约，只多一个**运行时**变量（服务端读了注进 HTML）：

| 变量 | 端 | 时机 | 值 |
|---|---|---|---|
| `<PAGE>_SENTRY_DSN`（本项目 `PLAYER_SENTRY_DSN`） | 服务端读、浏览器用 | **运行时** | **浏览器项目**的 DSN，跟 `VITE_SENTRY_DSN` 同一个值 |

`environment` / `release` 直接复用服务端进程已有的 `SENTRY_ENVIRONMENT` / `SENTRY_RELEASE` ——
**顺带解决了「两端 release 必须同值」那条**（§2-E）：同一个进程环境变量，想不一致都难。

> ⚠️ 别把**服务端** DSN 填进来。两个 DSN 长得几乎一样，填错的结果是浏览器错误跑进 server 项目，
> 而且没有任何报错提示。

### 本项目落地位置（照着找对应文件）

| 角色 | 本项目 |
|---|---|
| 入口 | `web/src/player-monitoring.ts`（**不被 SPA import**，独立于 `src/monitoring.ts`） |
| 打包脚本 | `web/scripts/build-player-monitor.ts`（esbuild → IIFE，87 KB） |
| 构建链 | `package.json` 的 `"build": "vite build && tsx scripts/build-player-monitor.ts"` |
| 发布路由 | `web/server/xifan.ts` 的 `/api/xifan/monitor.js`（同 `/api/xifan/hls.js` 的自托管路子） |
| 配置注入 | 同文件 `playerMonitorConfig()` → 模板占位 `__MONITOR_CONFIG__` |

**source map 不生成**：这类页面真正会出错的是**页面自己那段内联脚本**（写在 HTML 里，本来就没压缩，
栈里是原样行号），SDK 内部的帧压不压缩都不用读。省一次上传，也少一份泄露源码的风险（§6）。

---

## §8 页面里自己打的日志怎么进 Sentry（三个去处 + 去重）

很多页面在装 SDK 之前就有一套「自己打点回传服务端」的土办法（本项目是 `slog()` → `POST /client-log`
→ 服务端 `console.log`）。装了 SDK **不要把它删掉**，改成三个去处分工：

| 去处 | 收什么 | 为什么 |
|---|---|---|
| **面包屑**（页面 SDK） | 每一条 | 出异常时**整条时间线**跟着事件一起走，而不是散成 N 条互不相干的记录 |
| **上报**（页面 SDK 主动 capture） | 只有失败类 | 普通日志开 issue 纯属占配额 |
| **服务端 stdout** | 每一条 | 页面 SDK 没加载起来时（被拦截 / 产物缺失 / 老浏览器），它是唯一通路 |

**去重是必须的**：服务端那条通路通常也会顺手转发一份到 Sentry。页面自己报过的，请求里带个
标记（本项目是 `sdk: 1`），服务端见到就跳过 —— 否则**同一件事在浏览器项目和服务端项目各开一个 issue**，
两边还都不完整。

**这个回传接口通常无鉴权**，三道闸必须有：

```text
单条长度上限        （本项目 300 字）
附带数据的条数 × 单条长度上限   （本项目 40 行 × 120 字）
服务端转发 Sentry 的频率上限    （本项目每小时 80 条，超出仍进 stdout）
```

否则它就是一个「任何人都能往你日志和 Sentry 配额里写东西」的入口。

---

## §9 Sentry 天生看不到的那类问题（要自己造遥测）

**先记住这条判据**：Sentry（含 Session Replay）看得见的是 **DOM 和抛出来的异常**。
凡是「没有异常、状态又不在 DOM 里」的问题，它一概看不见。

本项目最贵的一次教训：播放时进度条来回倒退（1:33 → 1:31），**没有任何报错**，
而 `currentTime` / `buffered` / `readyState` 都是 `<video>` 的内部状态，
**Session Replay 录下来也只是「一个几乎不动的页面」**。同类还有：canvas、WebGL、音视频、
IndexedDB 状态、Worker 内部进度。

### 三个补位手段（都跟 Sentry 无关，是你自己写的几十行）

| 手段 | 做什么 | 解决什么 |
|---|---|---|
| **环形缓冲「胶片」** | 每 N 秒采一格关键状态（本项目 2 秒一格、留最近 30 格 ≈ 一分钟），失败上报时整卷随事件送走 | 「只有连着看才看得出来」的问题 —— 单帧快照全是正常值 |
| **主动探针** | 失败时对同一个地址补打一次请求，把状态码/字节数/耗时报上来 | 分清「网络根本不通」和「组件自己不干活」。跨域读不到响应时，再补一枪 `no-cors`：**只要它 resolve 就说明请求真的出去又回来了** |
| **哨兵** | 把「已经修过的 bug 的现象」写成自动检测（本项目：进度无故倒退就上报） | 回归时自动喊，不用等下一个用户来告诉你 |

胶片和探针都要**限流**（本项目哨兵 15 秒内只报一次、探针每个地址只打一次），
否则一个循环失败就能把配额烧光。

### 要不要装 Session Replay

本项目的结论是**不装**，判据可以直接抄：

- 问题状态**在不在 DOM 里**？不在（媒体、canvas、Worker）→ 装了也白装。
- 主要用户在**移动端**吗？Replay 的持续上报对流量和电量都不便宜。
- 配额扛得住吗？Replay 是按会话计费的大头。

三条里中两条就别装 —— 把同样的精力放到上面那三个手段上，回报高得多。

---

## §10 验收补充（有 §7 那类页面时加做）

在 §5 的 5 条验收之外，对每一个裸 HTML 页面再走一遍：

1. 打开该页面，控制台敲 `typeof window.<你暴露的全局>` → 是 `object`（不是 `undefined`）。
   是 `undefined` 说明 DSN 没注进去或 bundle 没加载 —— 看页面源码里那段配置和
   `<script src>` 的响应码。
2. 主动报一条 → **确认它进的是浏览器项目**（`<app>-web`），不是服务端项目。进错了就是 DSN 填反了。
3. 点进那条 issue 确认三件事：URL **不带 query**（脱敏生效）、`release` 是本次 commit、
   **面包屑里有页面加载时那几条自动记录的请求** —— 这条最能说明「装 SDK 而不是继续手打日志」值在哪。
4. 再打开一次该页面，触发一条**普通日志**（非失败类），确认它**没有**在浏览器项目里开 issue，
   而是在服务端日志里 —— §8 的分工和去重生效。
5. 给该页面的 bundle URL 加 `.map` 后缀访问 → 404（§7 那套本来就不生成 map）。
