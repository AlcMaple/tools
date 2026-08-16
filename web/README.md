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
| `DEV_SEARCH_ORIGIN` | 仅本地 dev | 本地没有离线索引时借哪个线上站补搜索 |

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
