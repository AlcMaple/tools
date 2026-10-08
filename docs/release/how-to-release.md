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

正式版统一打 **Latest**。Windows 支持应用内更新；macOS 需手动下载安装包。

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

如果尚未发布的 tag 打在了错误的 commit 上，需要修正标签：

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

**先看完整日志与资产核验，不要只看红叉**。v0.16.3 / run#30 两个平台构建成功，
上传日志同时出现两个 `builder-debug.yml`，随后资产更新报 404，但最后核验确认 8 个必需资产齐全。
旧 workflow 的 `*.yml` 把两端同名调试文件都收进来；当前已改为只收集 `latest.yml` 与 `latest-mac.yml`。
历史记录将 404 归因为同步延迟，不能直接套用到后续失败。Node.js 弃用警告不是本次失败原因。

**处理流程（不用重打 tag、不用重新构建）**：

1. 查看 `Verify release assets` 与草稿：本版 exe/dmg/zip、各自 blockmap、两份 latest 清单共 8 个必需资产，核对版本、大小和清单引用。
2. 资产齐全时保留草稿，补齐标题与 release notes 后按正常流程发布；不必为红叉重新构建。
3. 资产缺失时先定位原因，再重跑失败的 `release` job，复用 artifact（保留 7 天）。
   重跑使用原 tag 的 workflow，本地修改不会修正旧 run；不要随意删草稿或重打 tag。

同名资产等确定性问题应修正上传范围，不能靠反复重试掩盖。

---

## 注意事项

- `.npmrc` 里有国内镜像配置，CI 会在构建前自动清空它（见 workflow）。本地开发不受影响。
- 不需要 Windows 电脑，构建全在 GitHub Actions 云端完成。
- 推送新 tag 会触发发布；已有 run 可重跑失败 job，无需删掉重打 tag。
- draft release 随时可以编辑，但 tag 一旦发布出去就不要改名。
