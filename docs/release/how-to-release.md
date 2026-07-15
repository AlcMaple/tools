# 如何发布 MapleTools

## 发布流程概览

发布由 GitHub Actions 自动完成。你只需要做三件事：

1. 写好 release notes
2. 推一个 `v*` tag
3. Actions 跑完后，编辑 draft release 并发布

---

## 什么时候该发布

| 情况 | 建议版本号 | 徽章 |
|---|---|---|
| 修了几个 bug，体验有改善 | 递增 PATCH，如 `v0.1.1` | Latest |
| 新增了功能 | 递增 MINOR，如 `v0.2.0` | Latest |
| 紧急修复刚发布版本的严重 bug | 递增 PATCH | Latest |

统一打 **Latest**。没有自动更新机制，用户都是手动下载，Pre-release 对当前阶段没有实际意义。

---

## 发布步骤

### 第一步：写 release notes

在 `docs/release-notes/` 下新建本次版本的 md 文件，如 `v0.1.1.md`。

参考 [v0.1.0.md](../release-notes/v0.1.0.md) 的格式：标题含版本号和日期，分"新增 / 优化 / 修复"三节，只写本版变更。

### 第二步：推 tag，触发构建

```bash
# 确保本地代码已 push
git push

# 打 tag 并推送（Windows x64 + macOS arm64 并行构建，约 10 分钟）
git tag v0.1.1
git push --tags
```

### 第三步：等 Actions 跑完

去 GitHub → Actions 页面确认两个 build job 都绿了。

### 第四步：编辑 draft release

Actions 成功后会自动创建一个 draft release。点铅笔图标编辑：

- **Title**：`0.1.1 (YYYY-MM-DD)`（不带 v）
- **Body**：把对应 release notes md 的内容粘贴进来
- **勾选 Set as the latest release**

### 第五步：点 Publish release

发布后 GitHub 仓库主页侧栏会出现 Release 入口，Watch 了仓库的用户会收到通知。

---

## 打错 tag 怎么办

如果 tag 打在了错误的 commit 上，或者 Actions 失败需要重跑：

```bash
# 删本地 tag
git tag -d v0.1.1

# 删远端 tag（会同时取消 Actions 触发）
git push origin :refs/tags/v0.1.1

# 修好问题，重新打
git tag v0.1.1
git push --tags
```

---

## 构建成功、但最后「Create draft release」失败（Not Found）

**现象**：两个 build job(Windows / macOS)全绿、包都造好了，只有汇总的 `release` job 挂在
`Create draft release` 这步，注解报 `Not Found - .../releases/assets#update-a-release-asset`，
往往十几秒就失败。（v0.12.0 / run#20 踩过一次。）

**原因**：`softprops/action-gh-release` 的偶发抖动 —— 它先建草稿、紧接着传资产，GitHub API
偶尔因同步延迟对刚建的 release 返回 404。**与代码 / 版本号 / workflow 无关**：`@v2` 解析到的
action 版本和上次成功那次是同一份，唯一变量是时机。（那条 `Node.js 20 is deprecated` 是 warning，
不是失败原因，忽略。）

**修法（不用重打 tag、不用重新构建）**：

1. 去 [Releases 页] 看有没有一个**残缺的 v0.12.x draft**——失败那次可能已建了半个草稿。有就
   **Delete draft** 删掉（留着它，重跑会撞「资产已存在」再次 404）。
2. 回到失败的那次 run → 右上角 **Re-run jobs → Re-run failed jobs**。只重跑 `release` job，
   直接复用已造好的包(artifact 保留 7 天)，约 1 分钟。换个时机通常就过。

**只有 re-run 仍反复失败**才是真回归，届时再动 workflow（把 `softprops/action-gh-release@v2`
钉到确定可用的版本 / 加重试），别一上来就改。

---

## 注意事项

- `.npmrc` 里有国内镜像配置，CI 会在构建前自动清空它（见 workflow）。本地开发不受影响。
- 不需要 Windows 电脑，构建全在 GitHub Actions 云端完成。
- 每次 tag 只能对应一次 Actions 触发；删掉重打才会重新触发。
- draft release 随时可以编辑，但 tag 一旦发布出去就不要改名。
