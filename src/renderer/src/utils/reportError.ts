// 渲染进程统一报错出口 —— 控制台 + 转发主进程落盘(同 main.log,见 main 的
// shared/logger.ts)。让"被 catch 接住的真实失败"留痕可查,而不是无声消失。
export function reportError(scope: string, err: unknown): void {
  const msg = err instanceof Error ? err.stack || `${err.name}: ${err.message}` : String(err)
  console.error(`[${scope}]`, err)
  try {
    void window.systemApi?.logError?.(scope, msg)
  } catch {
    /* preload 不可用(理论上不会)时不二次抛 */
  }
}

/**
 * localStorage 读取解析失败时,把原始坏数据备份到 `${key}.corrupt` 再返回 ——
 * 这样既不静默丢、也不让一份坏 JSON 永久挡住后续写入(下次正常写会覆盖主键)。
 * 备份留作事后人工恢复 / 排查。
 */
export function backupCorrupt(key: string, raw: string | null): void {
  if (!raw) return
  try {
    localStorage.setItem(`${key}.corrupt`, raw)
  } catch {
    /* 备份失败(配额等)不阻断主流程 */
  }
}
