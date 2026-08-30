// 手绘线性图标 —— sprite 与 <use> 引用，符号定义逐字来自原型稿 js/app.js 的 SPRITE
// （设计稿是唯一视觉真相源）。<SketchSprite /> 在 App 顶层挂载一次；用法 <Ic name="pencil" />。
// 线条可见性依赖 sketch-ui.css 的 .ic（fill:none + stroke:currentColor，继承进 <use> 影子内容）。

const SYMBOLS = `
<symbol id="i-pencil" viewBox="0 0 24 24"><path d="M4 20l1.2-4.2L15.6 5.4a2.1 2.1 0 0 1 3 3L8.2 18.8 4 20z"/><path d="M13.6 7.4l3 3"/></symbol>
<symbol id="i-calendar" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></symbol>
<symbol id="i-tracks" viewBox="0 0 24 24"><rect x="6" y="8.5" width="14" height="11.5" rx="2"/><path d="M4 15.5V6a2 2 0 0 1 2-2h9.5"/></symbol>
<symbol id="i-settings" viewBox="0 0 24 24"><path d="M4 6.5h8M17.5 6.5H20M4 12h3M12.5 12H20M4 17.5h10M19 17.5h1"/><circle cx="14.5" cy="6.5" r="2.2"/><circle cx="9.5" cy="12" r="2.2"/><circle cx="16.5" cy="17.5" r="2.2"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L20.5 20.5"/></symbol>
<symbol id="i-user" viewBox="0 0 24 24"><circle cx="12" cy="8.2" r="3.6"/><path d="M5 20c1.2-3.6 4-5.3 7-5.3s5.8 1.7 7 5.3"/></symbol>
<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13"/></symbol>
<symbol id="i-minus" viewBox="0 0 24 24"><path d="M5.5 12h13"/></symbol>
<symbol id="i-play" viewBox="0 0 24 24"><path fill="currentColor" stroke="none" d="M8.5 5.8v12.4l10-6.2z"/></symbol>
<symbol id="i-star" viewBox="0 0 24 24"><path d="M12 3.8l2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4-3.9 5.6-.8z"/></symbol>
<symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></symbol>
<symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 4.5L21 19.5H3z"/><path d="M12 10.2v3.6M12 16.4v.2"/></symbol>
<symbol id="i-chev" viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6"/></symbol>
<symbol id="i-eye" viewBox="0 0 24 24"><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.7"/></symbol>
<symbol id="i-eye-off" viewBox="0 0 24 24"><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.7"/><path d="M4.5 4.5l15 15"/></symbol>
<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5v4.3h-4.3"/></symbol>
<symbol id="i-external" viewBox="0 0 24 24"><path d="M14 4.5h5.5V10M19.5 4.5l-8.5 8.5"/><path d="M18.5 13.5V19a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H11"/></symbol>
<symbol id="i-dots" viewBox="0 0 24 24"><circle fill="currentColor" stroke="none" cx="12" cy="5.5" r="1.6"/><circle fill="currentColor" stroke="none" cx="12" cy="12" r="1.6"/><circle fill="currentColor" stroke="none" cx="12" cy="18.5" r="1.6"/></symbol>
<symbol id="i-logout" viewBox="0 0 24 24"><path d="M9.5 8l-4 4 4 4M5 12h9.5"/><path d="M13 4.5h5.5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H13"/></symbol>
<symbol id="i-clip" viewBox="0 0 24 24"><path d="M16.5 11.5l-6.9 6.9a3.4 3.4 0 0 1-4.8-4.8l8.2-8.2a2.3 2.3 0 0 1 3.2 3.2l-8.2 8.2a1.1 1.1 0 0 1-1.6-1.6l7.2-7.2"/></symbol>
<symbol id="i-tag" viewBox="0 0 24 24"><path d="M4 4.5h7l9 9-7 7-9-9z"/><circle cx="8.5" cy="8.5" r="1.6"/></symbol>
<symbol id="i-edit" viewBox="0 0 24 24"><path d="M12 20.5h8.5"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7.2 18.8 3 20l1.2-4.2z"/></symbol>
<symbol id="i-mail" viewBox="0 0 24 24"><rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3.5 7.5l8.5 6 8.5-6"/></symbol>
<symbol id="i-google" viewBox="0 0 24 24"><path fill="#4285F4" stroke="none" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.46a5.53 5.53 0 0 1-2.4 3.63v3h3.87c2.27-2.09 3.57-5.17 3.57-8.82z"/><path fill="#34A853" stroke="none" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.72-4.96H1.28v3.1A12 12 0 0 0 12 24z"/><path fill="#FBBC05" stroke="none" d="M5.28 14.28A7.2 7.2 0 0 1 4.9 12c0-.79.14-1.56.38-2.28v-3.1H1.28a12 12 0 0 0 0 10.76l4-3.1z"/><path fill="#EA4335" stroke="none" d="M12 4.77c1.76 0 3.35.61 4.6 1.8l3.43-3.43C17.95 1.19 15.23 0 12 0A12 12 0 0 0 1.28 6.62l4 3.1c.94-2.85 3.59-4.95 6.72-4.95z"/></symbol>
<symbol id="i-pause" viewBox="0 0 24 24"><path d="M9 5.5v13M15 5.5v13"/></symbol>
<symbol id="i-back" viewBox="0 0 24 24"><path d="M14.5 5.5L8 12l6.5 6.5"/></symbol>
<symbol id="i-heart" viewBox="0 0 24 24"><path d="M12 20.2S3.5 14.8 3.5 8.9A4.4 4.4 0 0 1 12 6.6a4.4 4.4 0 0 1 8.5 2.3c0 5.9-8.5 11.3-8.5 11.3z"/></symbol>
<symbol id="i-ticket" viewBox="0 0 24 24"><path d="M4 6.5h16v4a2.1 2.1 0 0 0 0 4v3H4v-3a2.1 2.1 0 0 0 0-4z"/><path d="M9 8.5v7"/></symbol>
<symbol id="i-gift" viewBox="0 0 24 24"><path d="M4 10h16v10H4zM3 6.5h18V10H3zM12 6.5V20"/><path d="M12 6.5C9.2 6.5 7 5.5 7 3.9c0-1 1-1.7 2.1-1.4C10.8 3 12 6.5 12 6.5zM12 6.5c2.8 0 5-1 5-2.6 0-1-1-1.7-2.1-1.4C13.2 3 12 6.5 12 6.5z"/></symbol>
`

export function SketchSprite(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'none' }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: SYMBOLS }}
    />
  )
}

export type SketchIconName =
  | 'pencil' | 'calendar' | 'tracks' | 'settings' | 'search' | 'user' | 'plus' | 'minus'
  | 'play' | 'star' | 'x' | 'check' | 'alert' | 'chev' | 'eye' | 'eye-off' | 'refresh'
  | 'external' | 'dots' | 'logout' | 'clip' | 'tag' | 'edit' | 'mail' | 'google' | 'pause' | 'back' | 'heart'
  | 'ticket' | 'gift'

export function Ic({ name, cls = 'ic' }: { name: SketchIconName; cls?: string }): JSX.Element {
  return (
    <svg className={cls} aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  )
}

// 加载圈 —— 墨线风格（.ic 的描边 + Tailwind animate-spin）
export function Spinner({ size = 24, cls = '' }: { size?: number; cls?: string }): JSX.Element {
  return (
    <svg
      className={`ic animate-spin ${cls}`}
      style={{ width: size, height: size }}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" opacity=".25" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  )
}
