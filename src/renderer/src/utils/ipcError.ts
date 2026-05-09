/**
 * Strip the "Error invoking remote method '<channel>': " prefix that Electron
 * adds to thrown errors crossing the IPC bridge, exposing only the underlying
 * message. Falls back to the supplied label if the input isn't an Error.
 */
export function ipcErrMsg(e: unknown, fallback: string): string {
  if (!(e instanceof Error)) return fallback
  return e.message.replace(/^Error invoking remote method '[^']+': /, '') || fallback
}
