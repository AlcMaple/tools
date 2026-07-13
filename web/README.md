# MapleTools 网页版（`web/`）

MapleTools 桌面应用的网页版，**独立子项目**：自带 `package.json` / `node_modules`，与根目录
的 Electron app 物理隔离（根 `package.json` 一行不动）。详见
[docs/ideas/012-网页版.md](../docs/ideas/012-网页版.md)。

## 技术栈

- 前端：React 18 + Vite + Tailwind 3
- 后端：Hono（一套代码本地 / Vercel serverless / 未来 VPS 通吃）
- 抓取：BGM 逻辑从 app `src/main/bgm` 拷来，只把 Electron `net` 换成 `fetch`（`server/http.ts`）

## 本地开发

```bash
cd web
npm install
npm run dev          # 一条命令跑通前后端：Vite 出页面，Hono 接管 /api/*
```

打开 http://localhost:5173 —— 番剧周期表。

### 代理（仅本地、按需）

Node 的 `fetch` 默认不走系统代理。若你的 Clash 是「系统代理模式（非 TUN）」导致直连
BGM 黑洞，跑之前挂上代理环境变量（换成你 Clash 的 HTTP 端口）：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 npm run dev
```

TUN 模式 / Vercel 上不需要。

## 部署（Vercel）

见 [docs/web/Vercel部署保姆教程.md](../docs/web/Vercel部署保姆教程.md)。要点：Root Directory
设 `web`、Framework 选 Vite，`api/` 下的 Hono 自动成为 serverless 函数。

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
