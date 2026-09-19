# 网页版导入导出（意图确认稿）

2026-09-19 通过 interview-me 确认，同日实现（`web/server/backup.ts`）。改动先改这里。

## 要什么

- **Outcome**：网页版加「导出我的数据 / 导入」。导出三选一：JSON→`.zip`（`format=zip`）、JSON+MD→`.zip`（`format=zip-md`）、MD→单个 `.md`（`format=md`）；导入只认 `.zip` / `.json`。
- **User**：网页版登录用户。站长自己是主用户；新用户「拿别人现成追番清单」是次要场景。
- **Why now**：服务器有定期备份，但怕服务器和备份一起没；本地要有一份自己能打开看的。
- **Success**：
  - md 打开能看到每部番的状态 / 集数 / 标签 / 评分 / 好看集及每集备注，以及点评、推荐原文。
  - zip 导回一个空账号后，追番、点评、上传封面原样回来。
  - 新用户导入别人的 zip，得到追番列表（含封面），**没有**对方的点评。

## 约束

### 范围
- `tracks` 整行含 `extra`（goodEpisodes / goodEpisodeNotes / favorite 等）+ `review_drafts` + `review_contents`。
- 其它表（绑定、agent 历史、奖励、公告已读…）不碰。`xifan_binding` / `girigiri_binding` 按 bgm_id 全站共享，不是用户数据。

### 合并规则（导入）
- 按条目合并、后写者胜：同 `bgm_id`（点评再加 `mode`）比 `updated_at`，谁新用谁。
- 文件有、账号没有 → 补进来；账号有、文件没有 → 保留不动。绝不清表。
- 跨用户：JSON 记导出者 `userId`；与当前登录用户不匹配 → 只导追番，点评整体忽略，界面提示「来自其他用户的备份，只导入追番列表」。`episode` 照原样导，不归零。

### 封面
- `cover` 列存原始 `https://lain.bgm.tv/...` URL（前端展示时才换成 `/api/cover/*` 代理），导出即原始 URL，服务器没了也能用。
- 上传封面（`cover_mime` 非空）打进 zip 的 `covers/<bgmId>.<ext>`；`data.json` 对应条目用 `coverFile: "covers/<bgmId>.jpg"` 引用。网络封面**不**下载进包。
- 导入：`coverFile` 存在且包内有文件 → 按当前用户 `<uid>_<bgmId>` 落盘（类型按文件内容识别，限 png/jpeg/webp/gif ≤ 4MB）；写了但缺文件 → 回退 `cover` URL，不报错，结束时汇总「N 张封面缺失」；`covers/` 里未被引用的图忽略。
- 用户可手改：往 `covers/` 放图 + 给条目加 `coverFile` 再重压 zip 即可。`data.json` 允许在根目录或下一层目录（兼容 macOS/Windows 右键压缩文件夹多套一层）。

### 技术
- 不引 Word/Excel 类文档库；压缩用 zlib / fflate 级别小库。
- 不支持 rar / 7z，上传非 zip/json 直接提示。
- md 只读；JSON 允许手改后导回。

## 不做
- 站长级整站备份（走 web.db 文件级拷贝）。
- CSV / xlsx / Word 导出。
- 可编辑后导回的 md、可实时改的 html。
- 替代用户的 Word 手写笔记（想看清单、看番规则不在数据里）。
- 导入别人的点评 / 推荐。
- 网络封面下载进包；跨用户图片共享去重。
