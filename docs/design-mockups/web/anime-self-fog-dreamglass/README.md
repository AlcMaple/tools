# 「雾境梦璃 Misty Yume-Glass」设计稿

网页版视觉重构的**设计基线**：先在此目录迭代设计稿，审查通过后按本规范重构 `web/src` 真实代码，
重构后的线上效果必须与本目录 HTML 一致。对应任务约定：不再随意设计，先定风格主题。

## 怎么看

```bash
cd web/design && python3 -m http.server 8931   # 任意静态服务均可
# 打开 http://localhost:8931/ —— 说明书页；双击 index.html 直接打开也可（全部资源本地化）
```

| 文件 | 对应真实页面 | 覆盖交互 |
| --- | --- | --- |
| `index.html` | （设计说明书） | 风格来源、色板、圆角/阴影/字体、组件总览、交互规约 |
| `login.html` | `AuthModal.tsx` | 密码/验证码/注册/找回四模式、明文切换、发码倒计时、错误抖动、Google 按钮、整页 hero ⇄ 应用内弹窗双形态 |
| `calendar.html` | `CalendarPage.tsx` | 7 列海报墙、hover 遮罩（追番/详情）、今日缎带+脉冲、回到今天、刷新、NagBar、窄屏日选模式 |
| `tracks.html` | `TracksPage.tsx` | 今天更新置顶、进度 +1/−1、星形进度条、标签增删、搜索（筛选+加番建议）、卡片菜单、移除确认、同步、空态 |
| `settings.html` | `SettingsPage.tsx` | 身份卡、三模块面板切换（含 hash 深链）、自绘下拉、换绑两步流、解绑、密码、密保、稀饭验证码（大小写不敏感、点图换一张）、内联保存反馈 |

共享层：`css/tokens.css`（变量/字体/背景）、`css/mist-ui.css`（组件）、`js/app.js`（主题、粒子、对话盒 Toast、下拉、弹窗、倒计时、图标 sprite）。

## 风格定义

**自研二次元风格，配方 = 三种成熟风格各取一层：**

1. **梦可爱 Yume Kawaii** → 色彩与母题层：雾蓝 / 樱粉 / 香芋紫 / 星黄粉彩、星月花瓣装饰
2. **玻璃拟态 Glassmorphism** → 结构层：磨砂半透明面板 + backdrop-blur + 顶部高光，承载全部内容
3. **视觉小说 UI 语法** → 交互层：立绘在场感、名牌对话盒（全局通知 = 纱雾说话）、选项肢按钮（✦ 引导星 + 果冻回弹）、打字机渐显

气质基调：轻小说封面式渐变天空 + 星屑/花瓣粒子。默认**夜雾**（纱雾的深夜画室），可切**晨雾**。
刻意避开 loud 路线（如孟菲斯/新波普粗野主义的强撞色几何）——本主题走柔和梦境系。

**为什么是纱雾**：名字里的"雾" = 磨砂玻璃与晨/夜雾主题；官方立绘的银发蓝瞳 = 雾蓝主色；
插画师身份 = 星屑粒子与"帮你排番"的对话盒人格。

## Token 速查

双主题 CSS 变量在 `css/tokens.css`（`html[data-mist='night']` 默认 / `'day'`）：

- **色**：`--mist`(雾蓝主色) `--sakura`(樱粉) `--star`(星黄) `--matcha`(成功) `--coral`(错误) `--lilac`；文字 `--ink / --ink-sub / --ink-faint`；玻璃 `--glass / --glass-strong / --glass-border / --glass-blur`
- **圆角**：`--r-xs 8 / sm 12 / md 16 / lg 22 / xl 30 / pill 999`（软萌大圆角，对齐现有 Tailwind 圆角刻度需整体放大）
- **阴影**：`--shadow-1/2`（面板/弹层）+ `--glow-mist / --glow-sakura`（主题色光晕）
- **字体**：Baloo 2（拉丁/数字圆体，本地 woff2 已带 400–800）+ 系统中文；标题 800、正文 14–15.5px
- **动效**：`--ease-moe`（果冻回弹，按钮/入场）、`--ease-dream`（缓浮，面板/主题切换）

对比度已按 WCAG 核算：夜雾正文 ≥7.6:1；晨雾 sub 文字调至 .80 透明度后 ≥4.5:1（faint 仅用于装饰性 kicker）。

## 交互规约（重构时一并继承 AI_GUIDELINES 红线）

- hover / 临时提示（「已保存」等）只准 transform、filter、光晕、绝对定位——**禁止改变盒模型尺寸**
- 下拉一律自绘（`.dd`，浮层与触发器同宽）；滚动条统一 4px；不弹系统层控件
- 全局通知统一走**对话盒 Toast**（成功/失败同组件，失败换珊瑚色描边+名牌）
- **立绘只大出面两处**：整页登录 hero（全身）+ 空状态/头像（半身），功能页克制
- 动效克制；`prefers-reduced-motion` 下全部关闭；粒子画布在页面隐藏时暂停

## 迁移到真实代码（重构执行清单）

1. `web/src/index.css`：MD3 变量 → 本主题双套变量（RGB 三元组格式保持，供 Tailwind alpha 修饰符使用）；Tailwind 圆角刻度替换为大圆角
2. 字体：`npm i @fontsource/baloo-2`，替换/叠加 Inter（`@fontsource/inter` 可退役）
3. 逐页重构顺序建议：`Nav + 通知组件`（对话盒 Toast 替换现有行内提示）→ `AuthModal` → `CalendarPage` → `TracksPage` → `SettingsPage`，每页对照本目录同名 HTML 验收
4. 组件对照：`.dd` ↔ `Select.tsx` 扩展、`.toast-vn` ↔ 新 Toast 组件、`.poster/.ribbon/.progress` ↔ 页面内组件
5. 粒子/极光斑背景：`App.tsx` 挂一次 `<MistBackground/>`（canvas + blob），代码照抄 `js/app.js` 的 IIFE 即可
6. 验收口径：逐页与本目录 HTML 并排对比（同视口截图），交互行为逐条过上表

## 素材与版权

- `assets/sagiri-full.png / sagiri-face.png`：TV 动画《埃罗芒阿老师》和泉纱雾**官方立绘**，取自 Aniplex 美版官网角色页（eromanga-sensei.com/character/，官网 HTML 明确标注「和泉紗霧」）。个人自用项目；**不得用于公开分发/商用**
- `assets/fonts/*.woff2`：Baloo 2（OFL 许可），经 fontsource 分发
