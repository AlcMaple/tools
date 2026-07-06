export interface DlEvent {
  // ep_url: 某集的真实直链与模板拼出的不同(如 OVA 集回源解析出 .../OVA.mp4),
  // 通知渲染层记下来,「复制 mp4 直链」要用这条而不是模板拼的。
  type: 'ep_start' | 'ep_progress' | 'ep_done' | 'ep_error' | 'ep_url'
  ep?: number
  pct?: number
  bytes?: number
  msg?: string
  url?: string
}

export function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_')
}

export const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// 与 DESKTOP_USER_AGENT 配套的客户端提示头 —— (UA, sec-ch-ua) 版本不一致的
// 指纹自相矛盾,反而可疑。版本号直接从上面的 UA 串里解析,单一事实源:
// 将来升级 UA 只改上面一处,这里自动跟随,不存在「改了 UA 忘了改提示头」。
// 平台写死 Windows:DESKTOP_USER_AGENT 本身就刻意全平台统一用 Windows UA。
const CHROME_MAJOR = /Chrome\/(\d+)/.exec(DESKTOP_USER_AGENT)?.[1] ?? '120'
export const DESKTOP_SEC_CH_UA = `"Not.A/Brand";v="8", "Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}"`
export const DESKTOP_SEC_CH_UA_PLATFORM = '"Windows"'
