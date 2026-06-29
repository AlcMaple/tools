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

用户明确要求 *"一步一步来，一个功能一个功能慢慢完善"*，避免返工。所有 4 步已完成，详见下一节。

### 步骤 1a：AnimeInfo 嵌入追番 toggle ✅（已完成）

详情见第 4 节"已完成的工作"。

### 步骤 1b：SearchDownload 接入追番状态 ✅（已完成）

- 每张搜索结果卡片角落显示"EP N/M"徽章（已绑定时，封面左上角）
- 卡片 hover overlay 加 `+ 关联追番` 按钮（未绑定时）
- 点 `关联追番` 弹一个 mini BGM 搜索弹窗（LinkTrackModal）
  - 预填关键词 = cleanForBgmSearch(card.title)，去掉"第二季"、" 2"、"(2024)"、【】等噪声
  - 用户从 BGM 候选里选对应番
  - 把当前 (source, sourceKey=card.key, sourceTitle=card.title) 写入对应 `AnimeTrack.bindings[]`
- store 加 findByBinding / bind / useAnimeTrackByBinding

提交：`4984845`

### 步骤 2：「我的追番」汇总页 ✅（已完成）

`/my-anime` 路由 + 侧栏入口（bookmarks 图标）。AnimeInfo 简化成 toggle，编辑全部在这页。

- 顶栏搜索（标题 + 别名 + 备注 + 来源标题模糊匹配）
- 5 段状态 chip 筛选（全部 / 在追 / 想看 / 看完 / 暂停 / 弃番）
- 每行：封面 + 标题 + 状态 segment + 集数 −/数字/+1 + 备注 chips + 来源 chip
- +1 自动逻辑：plan 状态 +1 自动 → watching；达总集数自动 → completed
- 集数支持点开输入框直接跳转
- 备注：默认 chip 展示，点编辑切到 NoteTagInput
- 删除：单击亮红色，再点一次才真删
- 同步：HomeworkLookup 的 WebDAV blob 加 `tracks` 字段，`_v` bump 4→5；parseRemoteBlob / rebuildIfSchemaDrift / snapshotOf 全链路都带上

提交：`8b13e66`

### 步骤 3：番剧周历页 ✅（已完成）

`/calendar` 路由 + 侧栏入口（calendar_month 图标）。

- 主进程：`src/main/bgm/calendar.ts` 拉 BGM `/calendar` API，24h TTL 缓存到 `userData/bgm_calendar.json`
- IPC：`bgm:calendar` 接 `update?` 参数强制刷新；preload + types 全套
- 页面：7 列 weekday 网格，按 BGM 顺序 Mon→Sun，当日列高亮
- 每张番卡：封面 + 标题 + 评分 + 集数；hover 显示「追番」/「BGM」按钮
- 已追番显示左上角 EP 徽章
- 顶栏刷新按钮强制 update=true

提交：`b876b20`

### 步骤 4：跳转按钮组件 ✅（已完成）

`src/renderer/src/components/WatchHere.tsx` — 给定 bgmId，列出已绑定的源 chip，点击在外部浏览器打开。

- 不计算 ep+1 的具体播放页 URL（要重新抓 watchInfo，太重），直接打开源详情页
- chip 上显示 "ep N/M" 提醒用户当前进度
- 两个变种：`variant="row"`（AnimeInfo 左栏）/ `variant="inline"`（MyAnime 行尾 / Calendar 卡）
- bindings 空时组件返回 null（不占位），可选 `showEmpty` 显示「未关联源」占位
- 集成：AnimeInfo 左栏「Official Site」下、MyAnime 每行「在线观看」、Calendar 每卡底部

提交：(本步骤)

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

## 8. 待办清单

四个步骤已全部完成（见第 3 节及 commit 记录）。后续若有迭代需求：

### 可能的后续优化（用户未明确要求，按需考虑）

- [ ] WatchHere 计算 ep+1 的具体播放页 URL（要重抓 watchInfo，懒触发）
- [ ] MyAnime 同状态内可拖拽排序（目前按 updatedAt 倒序）
- [ ] Calendar 卡支持点封面跳转 AnimeInfo（目前只能点 BGM 链接外部打开）
- [ ] 追番列表的纯文本导出 / 导入（独立于 WebDAV blob，便于本地备份）
- [ ] +1 按钮长按重复触发（一晚补 5 集需要点 5 次的体验问题）
- [ ] AnimeInfo 详情已知 BGM id 时自动 lazily 写回 `track.totalEpisodes` / `cover`（用户绑定时这些字段就锁定了 BGM 当下数据，季终后总集数变更不会反向同步）

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

## 10. 当前状态

四步全部完成。功能已可用：
- BGM 详情页加追番（AnimeInfo）
- 搜索结果卡关联追番（SearchDownload）
- 我的追番汇总管理（MyAnime） + WebDAV 同步
- 番剧周历（AnimeCalendar）
- 跨页跳转按钮（WatchHere）

**下一次需要扩展时**：先读这份 md 第 9 节决策回放对齐心智模型，然后参考第 8 节的后续优化清单。

**跨会话上下文**：这份 md 的位置是 `docs/anime-tracking-plan.md`。

---

_最后更新：四步全部完成，截至 step 4 commit。后续若有迭代继续在此文档追加变更记录。_
