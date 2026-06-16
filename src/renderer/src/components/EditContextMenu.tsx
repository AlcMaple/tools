import { useEffect, useRef, useState } from 'react'

// 全局右键编辑菜单:剪切 / 复制 / 粘贴 / 全选。
//
// 实现取舍:
//  - 命令本身走主进程 webContents 的 cut/copy/paste/selectAll(见 systemApi.editCommand)——
//    直接作用在当前聚焦元素/选区上,粘贴也不会被渲染层的 execCommand 限制挡掉。
//  - 只在「真正有用」时才弹:可编辑控件(input/textarea/contenteditable)一定弹;
//    普通文本只有在存在选区时才弹(给「复制 / 全选」)。空白处右键不弹,行为可预期。
//  - 让位于页面内已有的局部右键菜单(FileExplorer 文件菜单、GoodEpisodesEditor 备注)——
//    那些 handler 都调了 e.preventDefault(),这里见到 defaultPrevented 直接跳过。

interface MenuItem {
  label: string
  action: 'cut' | 'copy' | 'paste' | 'selectAll'
  hint: string
  enabled: boolean
}

interface MenuState {
  x: number
  y: number
  flipX: boolean
  flipY: boolean
  items: MenuItem[]
  // 非编辑文本「全选」要选中的目标元素 —— 只选右键所在的这块文本(如标题 / 简介),
  // 而不是 webContents.selectAll() 那样把整页都选上。编辑控件场景为 null。
  selectTarget: HTMLElement | null
}

// mac 用 ⌘,其余用 Ctrl —— 仅快捷键提示文案,不参与逻辑。
const MOD = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl'

// 取最近的可编辑宿主:文本类 input / textarea / contenteditable。
function editableHost(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null
  const el = target.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')
  if (!(el instanceof HTMLElement)) return null
  if (el instanceof HTMLInputElement) {
    // 只对文本类 input 生效;checkbox/range/button 之类没有编辑语义。
    const textual = ['text', 'search', 'url', 'tel', 'password', 'email', 'number', '']
    return textual.includes(el.type) ? el : null
  }
  return el
}

function hasSelectionIn(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.selectionStart != null && el.selectionStart !== el.selectionEnd
  }
  const sel = window.getSelection()
  return !!sel && !sel.isCollapsed && sel.toString().length > 0
}

function hasContentIn(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value.length > 0
  }
  return (el.textContent ?? '').length > 0
}

export default function EditContextMenu(): JSX.Element | null {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onContextMenu(e: MouseEvent): void {
      // 局部右键菜单(文件 / 备注等)已自行 preventDefault,让位给它们。
      if (e.defaultPrevented) return

      const host = editableHost(e.target)
      const winHasSelection =
        !!window.getSelection() && window.getSelection()!.toString().length > 0

      let items: MenuItem[]
      // 非编辑文本「全选」的目标:右键所在元素那块文本。编辑控件下走 webContents,无需此引用。
      let selectTarget: HTMLElement | null = null
      if (host) {
        // 右键即聚焦,保证后续 selectAll/paste 落在这个控件上。
        host.focus()
        const sel = hasSelectionIn(host)
        items = [
          { label: '剪切', action: 'cut', hint: `${MOD}+X`, enabled: sel },
          { label: '复制', action: 'copy', hint: `${MOD}+C`, enabled: sel },
          { label: '粘贴', action: 'paste', hint: `${MOD}+V`, enabled: true },
          { label: '全选', action: 'selectAll', hint: `${MOD}+A`, enabled: hasContentIn(host) },
        ]
      } else if (winHasSelection) {
        // 普通文本(详情简介、标签等)有选区时,给「复制 / 全选」。
        // 「全选」锁定到右键所在的元素 —— 选这一块文本(标题 / 简介…),而非整页。
        selectTarget = e.target instanceof HTMLElement ? e.target : null
        items = [
          { label: '复制', action: 'copy', hint: `${MOD}+C`, enabled: true },
          { label: '全选', action: 'selectAll', hint: `${MOD}+A`, enabled: !!selectTarget },
        ]
      } else {
        return // 空白处 / 无选区的只读区域:不弹菜单。
      }

      e.preventDefault()
      // 翻转定位:贴近视口右/下边缘时把菜单的对角锚到光标,而不是整体平移。
      const MENU_W = 200
      const MENU_H = 200
      const PAD = 8
      setMenu({
        x: e.clientX,
        y: e.clientY,
        flipX: e.clientX + MENU_W + PAD > window.innerWidth,
        flipY: e.clientY + MENU_H + PAD > window.innerHeight,
        items,
        selectTarget,
      })
    }

    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [])

  // 菜单开启时挂上各种"关闭"监听:点外部 / 滚动 / 失焦 / Esc。
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onDocClick = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement).closest('[data-edit-menu]')) close()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close() }
    document.addEventListener('click', onDocClick)
    document.addEventListener('scroll', close, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('scroll', close, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  if (!menu) return null

  function run(item: MenuItem): void {
    if (!item.enabled) return
    if (item.action === 'selectAll' && menu?.selectTarget) {
      // 非编辑文本:只选中右键所在元素的全部文本,不要 webContents.selectAll() 选整页。
      const sel = window.getSelection()
      if (sel) {
        const range = document.createRange()
        range.selectNodeContents(menu.selectTarget)
        sel.removeAllRanges()
        sel.addRange(range)
      }
    } else {
      window.systemApi.editCommand(item.action)
    }
    setMenu(null)
  }

  return (
    <div
      ref={ref}
      data-edit-menu
      // onMouseDown 阻断默认:否则点菜单会让聚焦的输入框失焦、清掉选区,
      // 命令就落空了。preventDefault 只挡焦点转移,不影响后续 click。
      onMouseDown={(e) => e.preventDefault()}
      style={{
        ...(menu.flipX ? { right: window.innerWidth - menu.x } : { left: menu.x }),
        ...(menu.flipY ? { bottom: window.innerHeight - menu.y } : { top: menu.y }),
      }}
      className="fixed z-[60] rounded-lg border border-white/10 shadow-2xl py-1.5 min-w-[180px] bg-surface-container/95 backdrop-blur"
    >
      {menu.items.map((item, i) => (
        <div key={item.action}>
          {/* 全选前加一道分隔线,把它和剪切/复制/粘贴这组分开 */}
          {item.action === 'selectAll' && i > 0 && <div className="h-px bg-white/5 my-1" />}
          <button
            disabled={!item.enabled}
            onClick={() => run(item)}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm text-left enabled:hover:bg-white/5 disabled:opacity-30 disabled:cursor-default"
          >
            <span className="flex-1">{item.label}</span>
            <span className="font-label text-[10px] text-on-surface-variant/40 tracking-widest">{item.hint}</span>
          </button>
        </div>
      ))}
    </div>
  )
}
