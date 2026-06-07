// 持久化日志 —— 主进程唯一的"报错落地点"。
//
// 为什么需要：打包后的 app 里 `console.error` 没有任何可见出口,于是"报错被
// catch 吞掉"本质上是"报错无处可查"。这里把日志追加写到 OS 惯例的日志目录
// (`app.getPath('logs')`,macOS: ~/Library/Logs/MapleTools/,Windows:
// %APPDATA%/MapleTools/logs/),用户能直接翻、对排查 bug / 性能回溯都有用。
// 设置→关于 有「打开日志目录」按钮(shell.openPath)。
//
// 渲染进程的错误经 IPC `log:error` 转发到这同一个文件,全项目一处汇总。

import { app, ipcMain, shell } from 'electron'
import { appendFile, rename, mkdir, stat } from 'fs/promises'
import { join } from 'path'

// 在任何 patch 之前抓住原生 console 引用 —— logger 自身的 dev 回显与 console
// 透传都用它们,避免 patch 后递归 / 重复落盘。
const nativeError = console.error.bind(console)
const nativeWarn = console.warn.bind(console)
const nativeLog = console.log.bind(console)

const MAX_BYTES = 2 * 1024 * 1024 // 单文件 2MB 上限,超了转存 main.1.log
const LOG_DIR = (): string => app.getPath('logs')
const LOG_FILE = (): string => join(LOG_DIR(), 'main.log')
const ROTATED_FILE = (): string => join(LOG_DIR(), 'main.1.log')

// 写入串行化 —— 多处并发 logXxx 时用一条 promise 链排队,避免追加交织 / 轮转竞态。
let writeChain: Promise<void> = Promise.resolve()
let dirReady = false

type Level = 'INFO' | 'WARN' | 'ERROR'

function format(level: Level, scope: string, message: string): string {
  // 时间戳用本地时区可读格式,方便对照用户操作;ISO 也行但本地更直观。
  const ts = new Date().toISOString()
  return `${ts} [${level}] [${scope}] ${message}\n`
}

// err 可能是 Error / 字符串 / 任意抛出物,统一成"消息 + 栈(若有)"。
function describe(err: unknown): string {
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

async function rotateIfNeeded(): Promise<void> {
  try {
    const { size } = await stat(LOG_FILE())
    if (size >= MAX_BYTES) {
      // 只保留两代(main.log + main.1.log)——足够回溯近期,又不无限占盘。
      await rename(LOG_FILE(), ROTATED_FILE())
    }
  } catch {
    // 文件还不存在 → 无需轮转;其他 stat 错误也不该阻断写入,忽略。
  }
}

function enqueueWrite(line: string): void {
  writeChain = writeChain
    .then(async () => {
      if (!dirReady) {
        await mkdir(LOG_DIR(), { recursive: true })
        dirReady = true
      }
      await rotateIfNeeded()
      await appendFile(LOG_FILE(), line, 'utf-8')
    })
    .catch(() => {
      // 日志自身写失败时不能再抛(否则递归)——只在 dev 控制台兜底提示一次。
      if (!app.isPackaged) nativeError('[logger] 写日志失败')
    })
}

function emit(level: Level, scope: string, message: string): void {
  const line = format(level, scope, message)
  enqueueWrite(line)
  // dev 下同时打到控制台,开发期不用去翻文件。用原生引用,避免被 console 捕获重复落盘。
  if (!app.isPackaged) {
    const fn = level === 'ERROR' ? nativeError : level === 'WARN' ? nativeWarn : nativeLog
    fn(line.trimEnd())
  }
}

// 把任意抛出物 / 参数拼成一行可读文本(console.error 可能传多个参数 / 非字符串)。
function argsToText(args: unknown[]): string {
  return args.map((a) => describe(a)).join(' ')
}

/**
 * 接管 console.error / console.warn,让现有(及将来)所有 console 报错在保留
 * 原控制台输出的同时**自动落盘**到 main.log —— 不必逐处改成 logError。
 * 在 app 启动时调一次。
 */
export function initConsoleCapture(): void {
  console.error = (...args: unknown[]): void => {
    nativeError(...args)
    enqueueWrite(format('ERROR', 'console', argsToText(args)))
  }
  console.warn = (...args: unknown[]): void => {
    nativeWarn(...args)
    enqueueWrite(format('WARN', 'console', argsToText(args)))
  }
}

export function logError(scope: string, err: unknown): void {
  emit('ERROR', scope, describe(err))
}

export function logWarn(scope: string, message: string): void {
  emit('WARN', scope, message)
}

export function logInfo(scope: string, message: string): void {
  emit('INFO', scope, message)
}

/** 打开日志所在目录(设置→关于 的「打开日志目录」用)。 */
export async function openLogDir(): Promise<void> {
  try {
    await mkdir(LOG_DIR(), { recursive: true })
  } catch {
    /* 目录已存在 / 创建失败都直接尝试打开 */
  }
  await shell.openPath(LOG_DIR())
}

/** 注册渲染进程错误转发 + 打开日志目录的 IPC。由 registerAllIpc 调用。 */
export function registerLogIpc(): void {
  ipcMain.handle('log:error', (_event, scope: unknown, message: unknown) => {
    logError(typeof scope === 'string' ? scope : 'renderer', String(message))
  })
  ipcMain.handle('log:perf', (_event, message: unknown) => {
    logInfo('perf', String(message))
  })
  ipcMain.handle('log:open-dir', () => openLogDir())
}
