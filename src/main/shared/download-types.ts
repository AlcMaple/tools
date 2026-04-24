export interface DlEvent {
  type: 'ep_start' | 'ep_progress' | 'ep_done' | 'ep_error'
  ep?: number
  pct?: number
  bytes?: number
  msg?: string
}

export function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_')
}

export const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
