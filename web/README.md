# MapleTools 网页版（`web/`）

MapleTools 桌面应用的网页版，**独立子项目**：自带 `package.json` / `node_modules`，与根目录的 Electron app 物理隔离

## 技术栈

- 前端：React 18 + Vite + Tailwind 3
- 后端：Hono
- 环境：Node.js 20 或更高版本

## 本地开发

```bash
cd web
npm install
npm run dev
```

打开 http://localhost:5173 —— 番剧周期表

### 邮箱验证码注册 / 登录（可选）

邮箱入口统一发送一次性验证码：已有邮箱账号验证后直接登录，新邮箱验证后自动创建账号并登录，不设置密码。它不会自动把邮箱绑定到已有的用户名账号，旧账号继续使用原登录方式。开发环境默认把验证码打印到服务端控制台，生产环境必须配置 SMTP；没有 SMTP 时不影响原有的用户名 / 密码登录，只会停用邮箱入口

```bash
EMAIL_MODE=smtp \
SMTP_HOST=smtp.example.com \
SMTP_PORT=587 \
SMTP_SECURE=false \
SMTP_USER=mapletools@example.com \
SMTP_PASS='不要写进仓库' \
SMTP_FROM='MapleTools <mapletools@example.com>' \
npm run dev
```

验证码是短时、单次、限次数的邮箱所有权确认，不把浏览器自动填充或设备信息当作身份凭据。登录后的安全 Cookie 最长保留 30 天；退出、换设备或 Cookie 失效后需要重新验证邮箱。生产部署时这些变量应放在部署目录外的进程管理器环境文件中

### 代理（仅本地、按需）

Node 的 `fetch` 默认不走系统代理。若你的 Clash 是「系统代理模式（非 TUN）」导致直连
BGM 黑洞，跑之前挂上代理环境变量（换成你 Clash 的 HTTP 端口）：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 npm run dev
```

TUN 模式 / Vercel 上不需要

## 环境变量

代码**只读进程环境变量，不读任何 `.env` 文件**（没有 dotenv）。本地开发在命令前临时注入（见上面邮箱示例），生产放在部署目录外的进程环境里（systemd `EnvironmentFile=` / pm2 ecosystem / Vercel 控制台）——密钥永远不进仓库，`.gitignore` 已忽略 `.env`

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `AUTH_SECRET` | 生产必需 | 会话 JWT、验证码 HMAC、OAuth 跳转 cookie 共用的根密钥，至少 32 个随机字符；生产缺失会拒绝启动 |
| `DATA_DIR` | 生产建议 | SQLite（`web.db`）与周历缓存的目录，**必须在部署目录外**（重新部署会清空部署目录），如 `/opt/mapletools-data`；dev 默认 `web/data/` |
| `NODE_ENV` | 生产设 `production` | 切换生产 cookie 名与关掉 dev 专用兜底 |
| `PORT` / `HOST` | 可选 | 默认 `3000` / `127.0.0.1`；nginx 反代场景保持回环默认即可，别绑 `0.0.0.0` |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` `SMTP_USER` `SMTP_PASS` | 可选 | 邮箱验证码发信的 SMTP 凭证（如 Brevo 的 `smtp-relay.brevo.com:587`）。未配置时停用邮箱入口，不影响用户名 / 密码登录 |
| `SMTP_FROM` `SMTP_FROM_NAME` | 可选 | 发件地址与显示名，如 `noreply@example.com` / `MapleTools`。`SMTP_FROM` 需先在发信服务完成自有域名的 DNS 验证（SPF / DKIM），步骤见 [docs/ideas/015](../docs/ideas/015-noreply发信与第三方登录接入指南.md) |
| `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` | 可选 | Google 登录（[Google Cloud 凭据页](https://console.cloud.google.com/apis/credentials)），**二者齐配登录按钮才出现**。OAuth 客户端登记的重定向 URI：`https://<你的域名>/api/auth/oauth/google/callback`；本地联调另加 `http://localhost:5173/api/auth/oauth/google/callback` |
| `SLOW_PLAYBACK_MAX_VIEWERS` | 可选 | 公共慢源容量池的同时观看上限，默认 `2`；只能按真实出口带宽测试结果调整 |
| `SLOW_PLAYBACK_QUEUE_ENABLED` | 可选 | 慢源候补开关，默认开启；关闭后已有空位仍可观看，满员时不再接受新候补 |
| `WEB_PUBLIC_ORIGIN` | 生产建议 | 慢源空位邮件里的站点来源，如 `https://anime.alcmaple.cn`；默认使用该生产域名 |
| `REWARDS_ENABLED` | 生产显式开启 | 积分、权益和兑换总开关；开发默认开启，生产默认关闭 |
| `INVITES_ENABLED` | 生产显式开启 | 邀请码与邀请奖励开关，同时受 `REWARDS_ENABLED` 控制 |
| `LOTTERY_ENABLED` | 生产显式开启 | 幸运扭蛋开关，同时受 `REWARDS_ENABLED` 控制 |
| `REWARD_TEST_USERS` | 测试可选 | 逗号分隔的测试用户名；配置后只有名单账号能使用积分、邀请和扭蛋 |
| `REWARD_TIME_ZONE` | 可选 | 每日首次登录与邮件时间使用的时区，默认 `Asia/Taipei` |
| `DEV_SEARCH_ORIGIN` | 仅本地 dev | 本地没有离线索引时借哪个线上站补搜索 |
| `SENTRY_DSN` | 可选 | 服务端异常与 API 性能监控；不配置时不初始化 SDK、不上传数据 |
| `VITE_SENTRY_DSN` | 可选、构建时 | 浏览器异常、React 可恢复错误、页面 / 请求性能与 Web Vitals；必须在 `npm run build` 时提供，构建后再改 pm2 环境不会生效 |
| `SENTRY_ENVIRONMENT` / `VITE_SENTRY_ENVIRONMENT` | 可选 | 服务端 / 浏览器环境名；默认分别取 `NODE_ENV` / Vite mode |
| `SENTRY_RELEASE` / `VITE_SENTRY_RELEASE` | 生产建议 | 两端使用同一个发布标识（如 Git commit），用于把同一版本的异常与性能数据归组 |
| `SENTRY_TRACES_SAMPLE_RATE` / `VITE_SENTRY_TRACES_SAMPLE_RATE` | 可选 | 性能采样率 `0..1`，默认 `0.05`；异常不受该比例影响 |
| `SENTRY_AUTH_TOKEN` | 可选、构建时 | 浏览器 source map 上传凭证（需 `project:releases` 权限）。**极敏感，不进仓库**；只在 `npm run build` 前注入。不提供时构建不产出、也不上传 map，Sentry 里是压缩栈 |
| `SENTRY_ORG` / `SENTRY_PROJECT` | 配 `SENTRY_AUTH_TOKEN` 时必需 | Sentry 组织与浏览器项目的 slug，供 `@sentry/vite-plugin` 定位上传目标 |

本地开发嫌每次命令前缀麻烦，可把密钥 `export` 进 `~/.zshrc` / `~/.bashrc` 持久生效（新开终端 `npm run dev` 自动带上；密钥只在本机，不进仓库）：

```bash
export GOOGLE_CLIENT_ID="xxx.apps.googleusercontent.com"
export GOOGLE_CLIENT_SECRET="GOCSPX-xxx"
```

Google 登录的重定向 URI 按环境各登记一条，同一客户端可登记多条，服务端按请求来源自动选用：本地 `http://localhost:5173/api/auth/oauth/google/callback`，生产 `https://<你的域名>/api/auth/oauth/google/callback`。

### 异常与性能监控（可选）

> 跨项目复用、「哪些能抄哪些要单独生成」的完整说明见 [`docs/web/Sentry监控接入通用指南.md`](../docs/web/Sentry监控接入通用指南.md)。本机部署步骤见 [`docs/web/唐人云部署保姆教程.md`](../docs/web/唐人云部署保姆教程.md)。

浏览器与服务端建议放在两个 Sentry 项目，避免同名 issue 混在一起。前端监控按需动态加载；没有 `VITE_SENTRY_DSN` 的普通构建不会把浏览器 SDK 打进首屏包。`public/white-screen-probe.js` 是独立静态脚本（CSP 不允许内联），主包渲染失败、`#root` 4 秒后仍为空时兜底上报一条 `fatal`。两端都关闭默认 PII，事件发送前还会清掉 URL 查询串、Cookie、请求体和用户身份，请求头里**只保留 `User-Agent`**（Sentry 服务端据此还原 browser / os / device 上下文，排障常用；Cookie / Authorization / Referer 全丢）；只把 trace 头传播给本站 `/api`，不发给视频源或图床，也不启用 Session Replay。服务端只采样 API，静态资源和 `/api/health` 健康探测不生成性能 span。

```bash
RELEASE="$(git rev-parse --short HEAD)"
VITE_SENTRY_DSN='https://<browser-dsn>' \
VITE_SENTRY_ENVIRONMENT=production \
VITE_SENTRY_RELEASE="$RELEASE" \
VITE_SENTRY_TRACES_SAMPLE_RATE=0.05 \
SENTRY_AUTH_TOKEN='sntrys_...' SENTRY_ORG='<org>' SENTRY_PROJECT='<browser-project>' \
npm run build
```

`SENTRY_AUTH_TOKEN` 存在时，`@sentry/vite-plugin` 会开启 `sourcemap: 'hidden'` 构建、
把 `.map` 上传到 Sentry，再按 `vite.config.ts` 的 `filesToDeleteAfterUpload` 立即从 `dist`
删掉（`server/node.ts` 直接对外 serve 整个 `dist`，留一个 `.map` 就是源码泄露）。不带该
token 时构建行为不变、不产出 map。

服务端变量放在部署目录外的 pm2 / systemd 环境中：

```text
SENTRY_DSN=https://<server-dsn>
SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=<与前端构建相同的 commit>
SENTRY_TRACES_SAMPLE_RATE=0.05
```

每个服务端响应都会带 `X-Request-ID`；Sentry 启用后，同一个 ID 也会写入对应异常和性能 span，未处理异常同时在 pm2 终端日志打印该 ID。浏览器 source map 由 `@sentry/vite-plugin` 在构建时上传（见上，需 `SENTRY_AUTH_TOKEN`）；不注入该 token 时监控照常工作，只是生产压缩栈不还原到 TypeScript。服务端目前不上传 map（未压缩、栈已可读）。

## 目录

```
web/
├─ index.html            # Vite 入口
├─ src/                  # 前端（React）
│  ├─ main.tsx  App.tsx  api.ts  index.css
├─ server/               # 后端（Hono，本地 + Vercel + VPS 共用）
│  ├─ index.ts           # Hono 应用 = API 唯一真相源
│  ├─ http.ts            # 可挂代理的 fetch + 单次瞬时重试
│  └─ bgm/calendar.ts    # 拷自 app，只换传输层
└─ api/[[...route]].ts   # Vercel serverless 适配（唯一平台胶水）
```
