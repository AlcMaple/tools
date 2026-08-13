/**
 * 剥掉 Electron 在跨 IPC 抛错时加的「Error invoking remote method '<channel>': 」前缀
 * 只留下真正的错误消息;传入的不是 Error 时回落到给定的标签。
 */
export function ipcErrMsg(e: unknown, fallback: string): string {
  if (!(e instanceof Error)) return fallback
  return e.message
    .replace(/^Error invoking remote method '[^']+': /, '')
    .replace(/^Error: /, '') || fallback
}
