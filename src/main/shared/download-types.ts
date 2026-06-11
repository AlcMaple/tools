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
