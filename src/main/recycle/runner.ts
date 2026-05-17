// Windows 删除回收站 / 永久删除的薄 TS 运行时 —— spawn PowerShell 调
// `resources/recycle-helper.ps1`，按 exit code 翻译成业务语义。
//
// 业务流（renderer 端控制）：
//   1. 用户点删除 → 主进程调 runRecycle(path, { stage1Only: true })
//      - exit 0  → 整体送回收站成功
//      - exit 3  → Stage 1 失败、Stage 2 未尝试（renderer 弹窗让用户决定）
//      - 其它    → 抛错让 renderer 弹错误弹窗
//   2. 用户确认 Stage 2 → 主进程调 runRecycle(path, {})（不带 stage1Only）
//      - exit 0  → 整体回收（重试中成了，运气好）
//      - exit 4  → 分片回收成功（renderer 必须强提示"散件"）
//      - exit 1  → 两阶段都失败，抛错
//   3. 永久删除 → runRecycle(path, { purge: true })
//      - exit 0  → 成功
//      - exit 1  → 失败，抛错
//
// 设计跟旧版「prepareForDelete + Node fs.rm/shell.trashItem + existsSync」
// 解耦方案的差别：旧版根除了 stdout 编码炸点，但**没**解 AV/Defender 拦截
// 整目录 IFileOperation 移动的根因。新方案的 Stage 2（piecemeal recycle）
// 是真正的根因解 —— 杀软盯的是"整目录树移动"，不盯"单文件送回收站"。
//
// 跟旧版一样：PS 跑完不读 stdout，不依赖输出文本解析，**仅看 exit code**。
// 数据来源（recycle-helper.ps1 的 Write-Verbose 都是日志、不是数据通道）。

import { app } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'

/** Exit codes 跟 .ps1 头部一致（EXIT_FAILED = 1 不列出 —— 是兜底分支，
 *  通过 `default` 路径处理而非 switch 显式匹配）。 */
const EXIT_OK = 0
const EXIT_BAD_PATH = 2
const EXIT_STAGE1_FAILED = 3
const EXIT_FRAGMENTED = 4

export type RecycleStatus =
  /** 路径不存在 —— 直接当成功，不 spawn PS。 */
  | 'already-absent'
  /** exit 0 —— 整体送回收站 / 整体永久删除成功。 */
  | 'success'
  /** exit 4 —— 分片回收成功（renderer 必须强提示"回收站里是散件"）。 */
  | 'fragmented'
  /** exit 3 —— Stage 1 失败，Stage 2 未尝试（仅 stage1Only 模式可能返回）。 */
  | 'stage1-failed'

export interface RecycleOptions {
  /** 只跑 Stage 1（整体送回收站，5s 窗口）。失败时 exit 3 不进 Stage 2。 */
  stage1Only?: boolean
  /** 永久删除（绕开回收站走 Remove-Item → rd /s /q → robocopy /MIR）。 */
  purge?: boolean
}

export interface RecycleResult {
  status: RecycleStatus
}

// ── 解析 helper 路径 ────────────────────────────────────────────────────────

/**
 * 解析 recycle-helper.ps1 的运行时路径。
 * - dev: `__dirname/../../resources/recycle-helper.ps1`（项目根 resources/）
 * - prod (electron-builder): `process.resourcesPath/recycle-helper.ps1`
 * 跟 src/main/tray.ts 解析 icon.ico 的模式一致。
 */
function resolveHelperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'recycle-helper.ps1')
    : join(__dirname, '../../resources/recycle-helper.ps1')
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

/**
 * 调 recycle-helper.ps1 删一个路径。返回 status；调用方自己决定 UI 反馈。
 *
 * 失败（exit 1 / 2 / 任何 spawn 错）都**抛错**，error.message 带：
 *   - `Recycle:` 或 `Purge:` 前缀（让 renderer 的 friendlyError 归类）
 *   - 一段简短英文 / 中文说明
 * exit 1 时 message 不带具体 Windows 原因（PS 已经吞了 stderr）—— renderer
 * 那边的 troubleshooting hints（"FAT32 不支持回收站"/"AV 锁了"等）按这条
 * 前缀关键词归类。
 *
 * **non-Windows 平台**：直接抛错。本工具仅支持 win32。UI 上的删除入口在
 * Mac/Linux 上走 Electron 原生 `shell.trashItem` —— 见 fileExplorer.ts。
 */
export function runRecycle(targetPath: string, opts: RecycleOptions = {}): Promise<RecycleResult> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('runRecycle: 仅支持 Windows'))
      return
    }
    if (!existsSync(targetPath)) {
      resolve({ status: 'already-absent' })
      return
    }

    const helperPath = resolveHelperPath()
    if (!existsSync(helperPath)) {
      reject(new Error(`Recycle: 找不到 helper 脚本: ${helperPath}`))
      return
    }

    const args = [
      '-NoProfile', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', helperPath,
      '-Path', targetPath,
    ]
    if (opts.purge) args.push('-Purge')
    if (opts.stage1Only) args.push('-Stage1Only')

    // spawn 不读 stdout/stderr —— 它们是 .ps1 的 Write-Verbose 日志，业务结果
    // 完全靠 exit code 传递。stdio 'ignore' 让 PS 内的写出直接进黑洞，避免
    // 缓冲区满阻塞子进程。
    const child = spawn('powershell.exe', args, {
      windowsHide: true,
      stdio: 'ignore',
    })

    child.on('error', err => reject(new Error(`Recycle: spawn 失败 — ${err.message}`)))

    child.on('exit', code => {
      const prefix = opts.purge ? 'Purge' : 'Recycle'
      if (code === EXIT_OK) {
        resolve({ status: 'success' })
        return
      }
      if (code === EXIT_FRAGMENTED) {
        resolve({ status: 'fragmented' })
        return
      }
      if (code === EXIT_STAGE1_FAILED) {
        resolve({ status: 'stage1-failed' })
        return
      }
      // exit 1 / 2 / null / 其它 —— 抛错。
      // 兜底再 existsSync 一次：罕见情况下 PS 觉得自己失败但文件实际没了
      // （比如 Windows 杀掉 PS 进程之后异步完成的写入），这种情况按成功
      // 返回避免假错。这条沿用旧版"existsSync 是唯一真理"的精神。
      if (!existsSync(targetPath)) {
        resolve({ status: 'success' })
        return
      }
      if (code === EXIT_BAD_PATH) {
        reject(new Error(`${prefix}: 路径不存在或无法访问`))
        return
      }
      reject(new Error(`${prefix}: 操作未生效（exit ${code}），文件仍存在`))
    })
  })
}
