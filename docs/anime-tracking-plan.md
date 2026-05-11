# Anime 追番 / 周历 / 跳转 — 实施计划与待办清单

> 这份文档是给**未来的 Claude / 自己**看的接力棒。它总结了围绕"番剧追踪"功能的设计讨论，已经完成的工作，以及还要做的事 — 目的是在被打断（比如修 bug、隔天再回来）之后能立刻接续上下文。

---

## 1. 起源：用户最初的三个功能想法

用户在某个其它项目里看到三个有意思的功能：

1. **本周/本月周历**：看这周各星期几播什么番（番剧周期表，每季度一更）
2. **追番记录**：自己关注了什么、看了什么、看到哪里
3. **只做简单跳转，不做内置播放**：以 xifan 为例，点一下就跳到该集在线观看页面（外部浏览器）

**用户判断**：周历好做（半季度一次抓 BGM），追番记录只能手动录入（看番途径太多无法自动追踪），跳转就是 `shell.openExternal()` + 维护源链接。

---

## 2. 统一的心智模型（一定要看）

三件事**不能孤立设计**，它们围绕同一份核心实体：

```
一部番 (canonical = BGM subject id)
  ├─ 周历视角：哪天播、第几集
  ├─ 追番视角：我的状态、看到第几集、备注
  └─ 跳转视角：在 xifan/girigiri/aowu/B站/自填 URL 上叫什么、URL 多少
```

**关键决定 — BGM ID 是唯一锚点**

跨入口的 join key 是 BGM subject id。所有功能（周历、追番、源跳转、SearchDownload 的卡片角徽章）都通过这个 id 关联回同一条 `AnimeTrack` 记录。**不做模糊字符串匹配** — "葬送的芙莉莲第二季" vs "葬送的芙莉莲 2" 这种跨源标题差异，靠**用户一次性手动关联**（在 SearchDownload 卡片上点 "+ 关联追番"，弹出 BGM 搜索，让用户从结果里选一个对的）。绑定关系存在 `AnimeTrack.bindings[]`，绑定后该 (source, sourceKey) 永久对应到同一条 track。

**自动 vs 手动**

| 数据 | 来源 | 维护成本 |
|---|---|---|
| 周历（这周谁更新） | BGM `/calendar` API，按天缓存 | 全自动 |
| 番元数据（封面/总集数/标题） | BGM `/subject/{id}` API | 全自动 |
| 我的状态（看到第几集、追/弃） | 必须手动 | 手动，但有 +1 按钮可以非常顺手 |
| 源链接（xifan 等的具体 URL） | 半自动：已有搜索 API 给候选，用户确认绑定 | 一次设置长期复用 |

---

## 3. 实现切分（一步一步来）

用户明确要求 *"一步一步来，一个功能一个功能慢慢完善"*，避免返工。当前阶段在 **步骤 1a**：

### 步骤 1a：AnimeInfo 嵌入追番 toggle ✅（已完成）

详情见第 4 节"已完成的工作"。

### 步骤 1b：SearchDownload 接入追番状态（待做）

- 每张搜索结果卡片角落显示"已追·ep N/M"徽章（已绑定时）
- 卡片角加 `+ 关联追番` 按钮（未绑定时）
- 点 `+ 关联追番` 弹一个 mini BGM 搜索弹窗
  - 预填关键词 = 把源标题里"第二季"、" 2"、" II"、"(2024)"、【】这类去掉
  - 用户从 BGM 候选里选对应番
  - 把当前 (source, sourceKey, sourceTitle, sourceUrl?) 写入对应 `AnimeTrack.bindings[]`
- 从此 SearchDownload 的同一条结果可直接 join 到 track

### 步骤 2：「我的追番」汇总页（待做）

`/my-anime` 路由，侧栏新增一项。这是状态/集数/备注的**真正编辑场所**（AnimeInfo 已简化成纯 toggle）。

- 列表展示所有 track，按状态分组（在追 / 想看 / 看完 / 暂停 / 弃番）
- 每行：封面 + 标题 + 状态 chip + 进度计数器（−/数字/+）+ 备注 chips
- 行操作：编辑状态、+1 集、删除追番、查看源跳转
- 同步：挂到现有 homework 的 WebDAV 同步 blob 里（_v bump，加 `tracks` 字段）

### 步骤 3：番剧周历页（待做）

`/calendar` 路由，侧栏新增一项。

- 新增 IPC：`bgm:calendar` → 拉 BGM `/calendar` API，按日缓存到 `userData/bgm_calendar.json`
- 7 列 weekday 网格，每列展示番卡
- 卡片角徽章：已追/未追 + ep
- 点卡 → 跳 AnimeInfo（已有路由，传 BGM id 进去）

### 步骤 4：跳转按钮组件（贯穿，跨页复用）

- 一个 `<WatchHere bgmId={N} />` 组件
- 列出此番已绑定的源，给每个源算出当前 ep+1 的 URL
- 调 `window.open` 或 IPC `system:open-external` 打开浏览器
- 在 AnimeInfo / 我的追番 / 周历 三处复用

---

## 4. 已完成的工作（步骤 1a，commit 范围 fd537ec ~ 003cd1c）

### 数据底座 — `src/renderer/src/stores/animeTrackStore.ts`

- 类型：`AnimeStatus = 'plan' | 'watching' | 'completed' | 'paused' | 'dropped'`
- 类型：`AnimeBinding` — 单条源绑定（source, sourceTitle, sourceKey, sourceUrl?）
- 类型：`AnimeTrack` — 完整追番条目（bgmId 为 key，含 status/episode/totalEpisodes/bindings/notes/startedAt/updatedAt）
- 类：`AnimeTrackStore` — plain class + 手动 subscribe，沿用 homework store 同款架构
  - `upsert(patch)` / `getByBgmId(id)` / `delete(id)` / `list()` / `subscribe(cb)`
  - localStorage key：`maple-anime-tracks-v1`
  - normalize-on-read 容错老数据
- Hook：`useAnimeTrack(bgmId)` — 订阅式 React hook，单条 track 变化时重渲

### UI — `src/renderer/src/pages/AnimeInfo.tsx`

详情页左栏「Add to Archive / Official Site」两按钮之下加了**单按钮 toggle**：

- **未追态**：`Track this anime`（bookmark_add 图标，surface-container 底色，hover primary）
- **已追态**：`已加入追番`（bookmark filled 图标，primary-container/15 底色 + primary 文字，hover 切到 error-container/15 提示"现在点会移除"）
- 单击切换：未追 → `upsert({ status: 'plan', episode: 0 })`；已追 → `delete()`

**简化历史**：最初版本是一张完整的状态编辑卡片（5 段状态 + 进度 +/- + 备注 chip + 页脚时间戳）。
按用户反馈和 ui-integration skill 第 2/5 条 audit 后简化为 toggle，因为：
1. 详情页右栏内容很长，左栏 sticky 之下海报已占满首屏，编辑卡片要滚到右栏底部才能看到
2. 详情页角色是"发现/了解一部番"，不是"管理观看进度"
3. 状态/集数/备注的编辑搬到**步骤 2 的「我的追番」汇总页**，那里有充分布局空间

同时把左栏 sticky `top-28 → top-20`、海报 wrapper `mb-16 → mb-10`，让三个按钮在首屏可见。

### 设计约束遵循（ui-integration skill）

`.claude/skills/ui-integration/SKILL.md` 是项目专属的 UI 集成指导，**任何新 UI 工作之前都要先读一遍**。核心原则：

1. **找自然宿主** — 操作的对象在哪展示，宿主就是那
2. **信息优先，操作次之** — 信息常驻，操作 hover 揭示
3. **复用不叠加** — 加新元素后检查并删旧重复入口
4. **用现有视觉语言** — 不引入新颜色 token / 字号 / 圆角
5. **不为功能创造新视觉层级** — 能寄生就别新建 card/section
6. **下拉菜单宽度跟随触发器** — `w-full` not `min-w-[180px]`

步骤 1a 现行版按这套原则做。后续每步同样要 audit。

### 其它 skill 关联

- `.claude/skills/frontend-integration/SKILL.md` — HTML mockup → React 页面的 SOP，本次没用到（没有 mockup），但**步骤 2/3 如果有设计稿就要走这个流程**

---

## 5. 数据模型（当前）

```ts
type AnimeStatus = 'plan' | 'watching' | 'completed' | 'paused' | 'dropped'

interface AnimeBinding {
  source: 'Xifan' | 'Girigiri' | 'Aowu' | 'Bilibili' | 'Custom'
  sourceTitle: string   // 在该源上叫什么（"葬送的芙莉莲 2"）
  sourceKey: string     // slug 或 URL
  sourceUrl?: string    // 可选显式 URL；否则按 source 约定从 sourceKey 推
}

interface AnimeTrack {
  bgmId: number               // 唯一 key
  title: string               // BGM 标题（原文）
  titleCn?: string            // BGM 中文译名
  cover?: string              // 封面 URL
  status: AnimeStatus
  episode: number             // 看到第几集（0 = 未开始）
  totalEpisodes?: number      // BGM 已知时；ongoing 时 undefined
  bindings: AnimeBinding[]    // 步骤 1a 始终为 []，步骤 1b 起开始写入
  notes: string[]             // chip 备注，复用 homework/shared 的 NoteTagInput
  startedAt: string           // ISO
  updatedAt: string           // ISO
}
```

存储：localStorage key `maple-anime-tracks-v1`，数组形式 `AnimeTrack[]`。

---

## 6. 文件地图

```
src/renderer/src/
├── stores/
│   └── animeTrackStore.ts        ← store + useAnimeTrack hook
└── pages/
    ├── AnimeInfo.tsx              ← 已嵌入 Track/Cancel toggle 按钮（左栏第三个按钮）
    ├── SearchDownload.tsx         ← [步骤 1b] 卡片角徽章 / 关联追番 按钮要落到这
    ├── (新建) MyAnime.tsx         ← [步骤 2] 汇总页
    ├── (新建) AnimeCalendar.tsx   ← [步骤 3] 周历页
    └── (新建) anime/WatchHere.tsx ← [步骤 4] 跳转按钮组件

src/main/
├── bgm/
│   ├── search.ts / detail.ts     ← 已有
│   └── (新建) calendar.ts        ← [步骤 3] BGM /calendar IPC

src/preload/index.ts              ← [步骤 3] expose bgmApi.calendar
```

---

## 7. 后续接入同步的方案

WebDAV 同步基础设施已经为 homework 系列搭好（HomeworkLookup.tsx 里的 `parseRemoteBlob` / `executePush` / `executePull` / `snapshotOf` / `rebuildIfSchemaDrift`）。追番数据接入的步骤（**等步骤 2 完成后再做**）：

1. `snapshotOf` 加入 `tracks: AnimeTrack[]` 参数
2. `parseRemoteBlob` 兜底 `tracks: []`
3. `executePush` 把 `animeTrackStore.list()` 写进 blob，`_v` bump 到 5
4. `executePull` 反向写：`animeTrackStore` 替换全量（需要新增一个 `replaceAll` 方法或 import/export pair）
5. `rebuildIfSchemaDrift` 同步处理

不要为追番单独开一份 WebDAV 同步，叠加到现有 blob 即可。

---

## 8. 待办清单（机器可读 / 人也好读）

### 步骤 1b：SearchDownload 接入

- [ ] 在 `SearchDownload.tsx`（或它使用的卡片组件）每张卡片上加角徽章
  - [ ] 通过 `(source, sourceKey)` 在 `animeTrackStore.list()` 里反查 `bindings[]`
  - [ ] 找到 → 渲染紧凑徽章 "在追·ep N/M"（用现有 token，参考已追按钮配色）
  - [ ] 未找到 → 卡片角一个不抢眼的 `+ 关联追番` 按钮
- [ ] 实现 mini BGM 搜索弹窗
  - [ ] 用 `<ModalShell>` from `pages/homework/shared.tsx` 起壳
  - [ ] 关键词预填：写一个 `cleanForBgmSearch(title)` 工具函数，去掉常见后缀
  - [ ] 调 `window.bgmApi.search()` 拿结果列表
  - [ ] 用户选一个 → 调 `animeTrackStore.upsert({ bgmId, title, ..., bindings: [...existing, newBinding] })`
- [ ] 测试用例：手工验证"葬送的芙莉莲第二季 ↔ 葬送的芙莉莲 2"绑定流程

### 步骤 2：「我的追番」汇总页

- [ ] 先读 ui-integration skill 一遍
- [ ] 新页面 `src/renderer/src/pages/MyAnime.tsx`
- [ ] Sidebar.tsx 加导航项「我的追番」（位置在 Anime Info 之后或 Homework 之前）
- [ ] App.tsx 加路由 `/my-anime`
- [ ] 列表按状态分组（在追/想看/看完/暂停/弃番 — 5 段或者 tab 切换）
- [ ] 每行的状态编辑 UI（segment）、进度计数器、备注 chip
  - 这些 UI 之前在 `pages/anime/AnimeStatusCard.tsx` 里写过，已删除，可以从 git log 找到设计参考（commit fd537ec）
- [ ] +1 进度按钮做大做显眼 — 这是日常最高频操作
- [ ] 行尾加 `<WatchHere>` 跳转按钮（步骤 4 完成后接入）
- [ ] WebDAV 同步：把 `tracks` 字段加进 HomeworkLookup 的 snapshot / push / pull
- [ ] 空态：还没追任何番时，给一句话引导"从 AnimeInfo 加入第一部番"

### 步骤 3：番剧周历

- [ ] 先读 ui-integration skill 一遍
- [ ] Main 进程：`src/main/bgm/calendar.ts`
  - [ ] 调 BGM `/calendar` endpoint
  - [ ] 缓存到 `userData/bgm_calendar.json`，TTL 一天
  - [ ] 在 `src/main/index.ts` 注册 IPC `bgm:calendar`
- [ ] Preload：在 `bgmApi` 上 expose `calendar()`
- [ ] env.d.ts：补类型
- [ ] 新页面 `src/renderer/src/pages/AnimeCalendar.tsx`
- [ ] Sidebar / 路由挂载
- [ ] 7 列 weekday 网格（横向滑动？还是固定 7 列？看屏宽）
- [ ] 每张番卡：封面 + 标题 + 这周 ep + 已追徽章
- [ ] 点卡 → `navigate('/anime-info', { ... })`（已有路由）
- [ ] 卡片角加 `+ 加入追番` 操作（hover 时出现），点击后调 `animeTrackStore.upsert`
  - 注意：周历直接拿 BGM id，不需要做"关联"动作（区别于 SearchDownload 必须的关联流程）

### 步骤 4：跳转按钮组件

- [ ] `src/renderer/src/components/WatchHere.tsx` 或 `pages/anime/WatchHere.tsx`
- [ ] Props：`bgmId: number`，组件内自己 `useAnimeTrack(bgmId)` 拿绑定列表
- [ ] 每个绑定渲染一个按钮："西番 · ep 5"、"Girigiri · ep 5"…
- [ ] 点击：根据 source 约定算出 ep+1 URL，调 `window.open(url, '_blank')` 或 IPC
- [ ] 没绑定时：渲染一个"先去关联"提示
- [ ] 在 AnimeInfo（左栏 Official Site 之下？）、MyAnime（每行）、Calendar（每卡）三处复用
- [ ] **注意**：AnimeInfo 左栏空间紧，跳转按钮组要紧凑（可能 split button 形式 — split button 下拉宽度务必 `w-full`，见 ui-integration skill 第 6 条）

---

## 9. 决策回放（"为什么这样选"）

| 决策 | 替代方案 | 选择理由 |
|---|---|---|
| BGM ID 作 join key | 字符串模糊匹配 | 模糊匹配在中日番剧标题上踩过坑无数；显式绑定一次解决 |
| 手动关联 SearchDownload 卡片 | 自动扫描所有源建关联 | 用户判断比启发式准确，绑定后永久有效，成本一次 |
| AnimeInfo 不放完整编辑卡片 | 完整 5 段+进度+备注 | 左栏 sticky 之下海报已撑满首屏，编辑 UI 实际看不见；编辑搬到汇总页更合适 |
| 步骤拆 1a/1b 而非一次完成 | 一次做完两侧 | 用户明确要求小步验证 |
| 不开新页给追番列表（早期讨论） | 强行嵌进 LocalLibrary | 后续讨论改判：值得开新页，因为它是高频独立入口 |
| 周历开新页 | 嵌进 SearchDownload | 视觉密集，逻辑独立（网络播出表 vs 本地/下载逻辑） |
| 跳转做组件不做新页 | 跳转独立页 | 跳转是动作集合，要在 AnimeInfo/汇总/周历都复用，组件化合理 |
| 沿用 homework WebDAV blob | 给追番单开同步通道 | 一份同步配置已足够，叠加 `tracks` 字段更轻 |

---

## 10. 当前阻塞 / 注意事项

- **修 bug 优先**：用户表示要先修一些 bug，可能花较长时间。所有上述步骤都是断点续传式的，不影响 bug 修复。
- **下一次回到这个功能时**：先 `git log --oneline | grep -i 'anime\|track\|bgm'` 看看是否有同步相关的 commit；读这份 md；然后从"步骤 1b"开始（除非你想换顺序）。
- **跨会话上下文**：这份 md 的位置是 `docs/anime-tracking-plan.md`，未来的 Claude 应该被引导读这个。

---

_最后更新：基于截至 commit `003cd1c` 的状态。后续每完成一步请回来更新待办清单 + 决策回放。_
