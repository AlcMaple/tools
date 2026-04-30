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

参考 [v0.1.0.md](release-notes/v0.1.0.md) 的格式：标题含版本号和日期，分"新增 / 优化 / 修复"三节，只写本版变更。

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

## 注意事项

- `.npmrc` 里有国内镜像配置，CI 会在构建前自动清空它（见 workflow）。本地开发不受影响。
- 不需要 Windows 电脑，构建全在 GitHub Actions 云端完成。
- 每次 tag 只能对应一次 Actions 触发；删掉重打才会重新触发。
- draft release 随时可以编辑，但 tag 一旦发布出去就不要改名。
