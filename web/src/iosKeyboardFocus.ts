// iOS 让输入框获得焦点时会把根文档滚到「输入框可见」的位置（真机量到每次 +51px，收键盘也不滚回），
// fixed 弹窗、底栏跟着在屏幕上跳。照 React Aria usePreventScroll 的做法全站统一接管：
// 1. 用户点输入框：拦下 touchend 自己 focus，focus 那一帧把输入框挪到屏幕外，iOS 判定「无需滚动」；
// 2. 代码触发的 focus（autoFocus、点「改名」后聚焦）在触屏上不执行——键盘只在用户点输入框时出现；
// 3. 键盘弹出后输入框若真被挡住，只滚它所在的滚动容器把它露出来，没有容器才退回滚根文档。
// 历史：曾用 transform 按 visualViewport.offsetTop 反向补偿（真机不生效），也试过事后 scrollTo
// 把根文档钉回（和 iOS 的滚动打架，点了闪一下、键盘弹不出）。
const TEXT_INPUT = /^(text|search|email|url|tel|password|number)$/
const KEYBOARD_MARGIN = 12

type TextField = HTMLInputElement | HTMLTextAreaElement

function isTextField(el: unknown): el is TextField {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
  return el instanceof HTMLInputElement && TEXT_INPUT.test(el.type) && !el.readOnly && !el.disabled
}

function scrollParent(el: Element): Element | null {
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

function revealAboveKeyboard(field: TextField): void {
  const vv = window.visualViewport
  if (!vv) return
  const hidden = field.getBoundingClientRect().bottom - (vv.offsetTop + vv.height) + KEYBOARD_MARGIN
  if (hidden <= 0) return
  const box = scrollParent(field)
  if (box && box.scrollTop + box.clientHeight < box.scrollHeight) box.scrollBy({ top: hidden, behavior: 'smooth' })
  else window.scrollBy({ top: hidden, behavior: 'smooth' })
}

export function installIosKeyboardFocus(): void {
  if (!/iP(hone|ad|od)/.test(navigator.userAgent)) return
  const nativeFocus = HTMLElement.prototype.focus
  let userTap = false

  HTMLElement.prototype.focus = function (options?: FocusOptions) {
    if (isTextField(this) && !userTap) return
    nativeFocus.call(this, options)
  }

  let startX = 0
  let startY = 0
  document.addEventListener('touchstart', (e) => {
    startX = e.touches[0]?.clientX ?? 0
    startY = e.touches[0]?.clientY ?? 0
  }, { capture: true, passive: true })

  document.addEventListener('touchend', (e) => {
    const end = e.changedTouches[0]
    if (!end || Math.hypot(end.clientX - startX, end.clientY - startY) > 10) return
    const label = e.target instanceof Element ? e.target.closest('label') : null
    const field = isTextField(e.target) ? e.target : label?.control
    if (!isTextField(field) || e.touches.length) return
    const vv = window.visualViewport
    // 键盘已经弹着时再点同一个框是在挪光标，交还给系统。
    if (document.activeElement === field && vv && vv.height < window.innerHeight - 100) return
    e.preventDefault()
    // 已聚焦但键盘被收起时，再点同样会触发 iOS 滚动，先 blur 走同一条路径。
    if (document.activeElement === field) field.blur()
    field.style.transform = 'translateY(-2000px)'
    userTap = true
    nativeFocus.call(field, { preventScroll: true })
    userTap = false
    requestAnimationFrame(() => { field.style.transform = '' })
    // 键盘弹出时 visualViewport 会 resize；已在显示时不会，再兜一个定时。
    let done = false
    const reveal = () => { if (!done) { done = true; revealAboveKeyboard(field) } }
    window.visualViewport?.addEventListener('resize', reveal, { once: true })
    window.setTimeout(reveal, 600)
  }, { capture: true, passive: false })
}
