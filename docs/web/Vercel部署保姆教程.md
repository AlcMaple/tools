# Vercel 免费部署 —— 从 0 到 1（GitHub 登录，不用卡）

> 配套 [012-网页版.md](../ideas/012-网页版.md)。目标：一个免费 Vercel 账号，连上你的
> GitHub 仓库，把 `web/` 子目录部署成能用浏览器访问的网址（每次 push 自动出预览）。
> **全程不用信用卡。**
> ⚠️ 按 2026 年初的 Vercel 界面写，按钮文案偶尔变，按同名功能找即可。

## 前提

- 一个 GitHub 账号（你的 `AlcMaple`，仓库 `tools` 已在 GitHub 上）。

## 第 1 步：注册（不用卡）

1. 打开 **vercel.com** → 右上 **Sign Up**。
2. 选 **Hobby**（个人免费档）→ **Continue with GitHub**。
3. GitHub 跳到授权页 → **Authorize Vercel**。
4. 可能让你填个用户名 / 团队名，随便起 → 完成，进 Dashboard。

> Hobby 档**永久免费、不问信用卡**。它偶尔弹窗推销 Pro，忽略即可。

## 第 2 步：授权 Vercel 访问你的仓库

1. 首次导入会让你 **Install Vercel**（GitHub App）。
2. 选 **Only select repositories** → 勾 **AlcMaple/tools** → **Install**。
   （只授权这一个仓库，最小权限。）

## 第 3 步：导入项目（等 `web/` 推上 GitHub 之后再做）

> ⚠️ 这步要等我把 `web/` 脚手架建好、你 **push 到 GitHub** 之后才做 —— 现在仓库里还没
> `web/`，导入会找不到东西构建。

1. Dashboard → **Add New… → Project**。
2. 找到 **tools** 仓库 → **Import**。
3. **配置（关键两项）**：
   - **Root Directory** → 点 **Edit** → 选 **`web`**。
     👉 这样 Vercel **只构建网页版**，碰不到 Electron app。
   - **Framework Preset**：应自动识别 **Vite**（没识别出就手选 Vite）。
   - Build / Output 命令用默认即可（我会在 `web/` 里配好）。
4. **Deploy** → 等 1–2 分钟，拿到一个 `https://xxx.vercel.app` 网址。

## 之后怎么用（这就是我们的「真机验证」通道）

- 每次往 GitHub **push**：Vercel 自动出一个**预览部署**（Preview URL）；`main` 分支出
  **生产**部署。
- 验证节奏：本地 `cd web && npm run dev` 先验一遍 → push 后在 `*.vercel.app` 再验一遍，
  防「本地过了线上用不了」。

## 常见坑速查

| 症状 | 十有八九是 |
|---|---|
| 导入时找不到 `tools` 仓库 | 第 2 步 GitHub App 没授权到 `tools`；去 vercel.com 账号设置 → Git Integration 重装 |
| 构建失败、说找不到 package.json | **Root Directory 没设成 `web`** |
| 让我绑卡 | Hobby 档不用；那是推销 Pro，忽略 |
| 部署了但 API 404 | 我这边 `web/api` 还没配好或没 push，等脚手架就绪 |

## 做好之后

把你的 **Vercel 项目地址**（`*.vercel.app`）告诉我，我接上做线上双验证。账号 / 授权是
你的动作，我不碰你的登录。
