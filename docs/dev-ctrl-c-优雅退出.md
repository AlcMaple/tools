# 开发模式下 Ctrl+C 优雅退出 Electron

在终端里 `Ctrl+C` 停掉 `pnpm dev`，大多数 Electron + 打包器组合(vite-plugin-electron、electron-vite、自写脚本等)会留下一段报错或崩溃提示，比如:

```
[electron] exited with signal SIGINT
App threw an error during load
Electron exited unexpectedly
Error: write EPIPE
```

而本项目 `pnpm dev` 后按 `Ctrl+C` 能干净退出,没有任何红色错误。本文拆解项目在这上面做的四层处理,可直接搬运到其他 Electron 项目。

## TL;DR

要让 `Ctrl+C` 不触发崩溃提示,需要同时满足:

1. **父进程(rsbuild/vite/webpack)收到 SIGINT 后,把信号转发给 Electron 子进程,而不是自己先退出。**
2. **Electron 主进程在 `will-quit` 里走 `process.exit(0)`(仅限 dev),避免被信号中断后以 `code=null, signal=SIGINT` 的方式退出。**
3. **父进程监听子进程的 `close`,只在 `code === null`(被信号杀死)时才报错;正常退出码一律静默。**
4. **主进程挂 `uncaughtException` 兜底,异常时也走 `app.quit()` 而不是让进程裸崩。**

四者缺一不可。

## 本项目的实现

### 1. 父进程:Rsbuild 插件启动 + 转发信号

[plugins/electron-dev.ts:86-96](plugins/electron-dev.ts#L86-L96) 用 Node 原生 `child_process.spawn` 拉起 Electron,并注册了两个信号转发器:

```ts
const handleTerminationSignal = (signal: any) => {
  process.on(signal, () => {
    if (electronProcess && !electronProcess.killed) {
      electronProcess.kill(signal);
    }
    watcher.close().catch(() => void 0);
  });
};

handleTerminationSignal("SIGINT");
handleTerminationSignal("SIGTERM");
```

关键点:

- **没有调用 `process.exit()`**。父进程只把信号转给 Electron,然后等 Electron 自己退出驱动 `close` 回调。如果这里直接 `process.exit(0)`,Electron 子进程会被操作系统强杀,留下一堆日志。
- **同步关闭 chokidar watcher**,避免 watcher 还在轮询文件时父进程已退。

### 2. 子进程 `close` 回调:区分信号退出 vs 正常退出

[plugins/electron-dev.ts:29-41](plugins/electron-dev.ts#L29-L41):

```ts
electronProcess?.on("close", (code: number, signal: unknown) => {
  if (isRestarting) {
    logger.info("Electron closed for restart; relaunching...");
    spawnElectron();
    isRestarting = false;
    return;
  }
  if (code === null) {
    logger.error("exited with signal", signal);
    process.exit(1);
  }
  process.exit(code);
});
```

`code === null` 才会打印错误。也就是说:**只要 Electron 主进程能走到自己的 `process.exit(0)`,父进程就看到 `code=0, signal=null`**,直接静默退出。

如果 Electron 是被 SIGINT 直接杀死的(没有走 `will-quit` 钩子),Node 会把它报告为 `code=null, signal='SIGINT'`,这时候父进程才会打 `"exited with signal"` 的红色日志。

### 3. Electron 主进程:dev 模式下强制 `process.exit(0)`

[electron/main.ts:185-209](electron/main.ts#L185-L209):

```ts
app.on("will-quit", () => {
  try {
    quitAndSaveTasks();
  } catch (err) {
    log.error("[main] quitAndSaveTasks failed:", err);
  }
  // ... destroyTray / destroyDesktopLyricsWindow / destroyMiniPlayer
  // ... stopCheckForUpdates / unregisterAllShortcuts

  if (isDev) {
    process.exit(0);
  }
});
```

这一句 `if (isDev) process.exit(0)` 是整条链路里最容易被忽略的一环。原理:

- 终端发 SIGINT 时,默认被送往整个前台进程组。Rsbuild 父进程和 Electron 子进程(因为 `stdio: "inherit"` 共享 TTY)**都会**收到。
- Electron 自己的 SIGINT 默认处理是:让主进程标记为退出、触发 `before-quit` → `will-quit` 流程。
- 但走完 `will-quit`、浏览器窗口关闭之后,Electron **不会自动把退出码清成 0**——它仍然记得"是被信号杀掉的",最终进程会以 `signal=SIGINT` 退出。
- `process.exit(0)` 在 `will-quit` 末尾强制把退出路径改写成"正常退出,码 0"。父进程看到的就是干净的 `close(0, null)`。

生产环境不加这个:因为生产是独立 app,不经过 Rsbuild 父进程,也没人关心退出码是不是 0,不需要覆盖 Electron 默认行为。

### 4. 兜底:`uncaughtException` 也走 `app.quit()`

[electron/main.ts:235-243](electron/main.ts#L235-L243):

```ts
process.on("uncaughtException", err => {
  log.error("[uncaughtException]", err);
  (app as any).quitting = true;
  app.quit();
});

process.on("unhandledRejection", reason => {
  log.error("[unhandledRejection]", reason);
});
```

这段和 Ctrl+C 不是直接相关,但能阻止开发过程中主进程出异常时进程"僵尸化"——否则你会看到进程没退,但窗口已经白屏,下次再 `pnpm dev` 还要手动 `kill`。

### 配合:`app.quitting` 标记

[electron/main.ts:120-135,181-183](electron/main.ts#L120-L135):

```ts
mainWindow.on("close", event => {
  const closeWindowOption = appSettingsStore.get("appSettings").closeWindowOption;
  if ((app as any).quitting) return;
  if (closeWindowOption === "hide") {
    event.preventDefault();
    mainWindow?.hide();
  }
  // ...
});

app.on("before-quit", () => {
  (app as any).quitting = true;
});
```

"关闭窗口=隐藏到托盘"这种 UX 下,用户点关闭不应该真退;但 `Ctrl+C` / 菜单"退出"应该真退。通过在 `before-quit` 里标记 `app.quitting = true`,窗口的 `close` 处理器就能识别出这是真退出,不再拦截。

没有这个标记的话,Ctrl+C 的时候窗口会被偷偷隐藏,主进程卡在那里等不到 `window-all-closed`。

## 在你自己的项目里复刻

假设你用 vite / webpack / esbuild + 自己 spawn Electron,按以下步骤对照:

### 父进程端(构建脚本里拉起 Electron 的那块)

1. 用 `child_process.spawn(electron, ["."], { stdio: "inherit" })` 启动。
2. 注册 SIGINT / SIGTERM 处理器,只做一件事:`electronProcess.kill(signal)`。**不要** `process.exit`。
3. 监听子进程 `close`:
   - `code === null`(被信号杀死): 打日志 + `process.exit(1)`。
   - 其他情况: `process.exit(code)`。

### Electron 主进程端

1. `app.on("will-quit", () => { /* 清理 */ if (isDev) process.exit(0); })`——关键一步。
2. `process.on("uncaughtException", err => { app.quit(); })` 作为兜底。
3. 如果有"关闭到托盘"逻辑,一定要用 `app.quitting` 这种显式标记区分"主动退出 vs 关窗隐藏"。
4. 不要在 dev 模式开启 `electron-squirrel-startup` 之类会吃 SIGINT 的启动器。

### 验证

```bash
pnpm dev
# 等窗口出来,终端按 Ctrl+C
```

期望输出:只看到构建工具的日志停止,没有 `exited with signal`、`App threw an error`、`EPIPE` 之类的红字。再试一次 `pnpm dev` 能干净启动(没有 "another instance is running" 或端口占用)。

## 踩坑记录

- **不要用 `concurrently` + 单独一个 `electron .` 脚本**:concurrently 收到 SIGINT 只会给子 shell 发,而 Electron 经常拿不到,最后留一个孤儿 Electron 进程。自己用 `child_process.spawn` + 信号转发最可靠。
- **`windowsHide: false`**:Windows 下 spawn 默认会隐藏子窗口控制台,Ctrl+C 的 CTRL_C_EVENT 传不过去。显式设 false 才能让 Windows 的 Ctrl+C 正常工作。
- **`process.exit(0)` 的位置**:必须在 `will-quit` **末尾**。放在 `before-quit` 里会跳过清理;放在最外层顶层也不行,因为那时候 `app.quit()` 还没触发。
- **生产环境不要加 `process.exit(0)`**:正常安装包里 Electron 自己管理退出码,强制 exit 可能导致 `electron-updater`、`electron-log` 的异步写入被截断。用 `if (isDev)` 守住。
- **chokidar / nodemon 之类的 watcher**:SIGINT 时也要显式 `watcher.close()`,否则 Node 事件循环里留着句柄,`process.exit` 前会有一小段延迟或报错。

## 涉及文件

- [plugins/electron-dev.ts](plugins/electron-dev.ts) — 父进程启动/转发/监听
- [plugins/rsbuild-plugin-electron.ts](plugins/rsbuild-plugin-electron.ts) — Rsbuild 插件入口
- [electron/main.ts](electron/main.ts) — 主进程 will-quit / uncaughtException / quitting 标记
