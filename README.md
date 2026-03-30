# tools

本项目是基于 Electron 构建的桌面端应用。

## 依赖与运行指南

进入 `front-end` 目录进行前端项目的相关操作：

```bash
cd front-end
```

### 1. 安装依赖

```bash
npm install
```

### 2. 本地开发运行

启动开发环境，支持热更新（推荐）：

```bash
npm run dev
```

### 3. 项目打包分发

生成适用于当前操作系统的安装包及可执行文件。一键即可完成打包，不依赖额外的无头浏览器安装。

```bash
npm run dist
```

打包产物通常会输出在 `front-end/dist` 目录下（如 `.exe`, `.dmg` 等）。