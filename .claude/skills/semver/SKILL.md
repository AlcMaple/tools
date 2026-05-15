---
name: semantic-versioning
description: Apply SemVer rules (MAJOR.MINOR.PATCH) for software releases. Use when determining version numbers for application updates.
---

# Semantic Versioning (SemVer) 规范

## When to use this skill
当需要为软件项目决定发布版本号，或者在评估新增功能、修复 Bug、重构架构到底属于哪种级别的版本迭代时，使用此技能来确保版本号严格遵守工程标准。

## How to apply PATCH (修订号)
1. **核心动作**：进行向下兼容的 Bug 修复、日常维护与 UI 细节微调。
2. **判定标准**：原有接口和功能逻辑完全不变。例如移除冗余的后台运行日志并替换为纯净的进度条显示，或修复 macOS 开发环境与 Windows 测试环境之间的兼容性边界问题。
3. **版本变化**：递增最后一位，例如 `1.1.0` -> `1.1.1`。

## How to apply MINOR (次版本号)
1. **核心动作**：进行向下兼容的新功能扩展。
2. **判定标准**：增加新模块但不破坏原有依赖。例如在歌曲列表中新增排序功能，或是为现有的音频处理系统新增一个将对白从带有人声的 BGM 中精准去除的模块。
3. **版本变化**：递增中间一位，必须将修订号归零。例如 `1.1.2` -> `1.2.0`。

## How to apply MAJOR (主版本号)
1. **核心动作**：进行破坏性更新与底层大重构。
2. **判定标准**：旧有接口完全失效或逻辑彻底推翻。例如将后端脚手架进行彻底重构，升级为专为 AI 辅助编程设计的零配置 v2 架构，导致所有旧版 API 客户端的请求失效。
3. **版本变化**：递增第一位，必须将次版本号和修订号归零。例如 `1.2.5` -> `2.0.0`。

## Execution Constraints
1. **禁止情绪化升号**：严禁因为开发周期长或功能“重磅”而随意升级 MAJOR。只要新功能向下兼容，一律按 MINOR 处理。
2. **单向递增原则**：版本发布后即刻锁定该版本的代码。若发现缺陷，必须通过发布新的 PATCH 来修复，严禁覆盖或回退历史版本。