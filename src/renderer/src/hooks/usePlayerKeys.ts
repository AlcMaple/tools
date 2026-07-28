import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * 在线播放页的键盘行为:让 Tab 绕开原生播放器控件 + 自己接管空格。
 *
 * Chromium 原生控件活在 UA shadow DOM 里,Tab 会依次停在播放 / 静音 / 全屏 / ⋮ 上,
 * 每一站都甩出跟随系统强调色的焦点描边(macOS 上是黄框),停在静音键上还会把音量条
 * 展开。这些既够不着也压不住(详见 AI_GUIDELINES.md),只能不让焦点进去。
 *
 * 只绕开 <video>,不禁用 Tab —— 页内的内联搜索框、B 站登录弹窗、各种表单都还要靠
 * Tab 跳转。做法是在 <video> 前后各放一个 1×1 全透明哨兵,焦点要落到 video 上时,
 * 按方向把它交给对应一侧的哨兵,于是焦点从「video 之前」直接跨到「video 之后」,
 * 后续 Tab 序列照常继续,也不会把人困在播放区里。
 *
 * 两条进入路径都要堵,少一条就漏:
 *   - 焦点在 video **外面**按 Tab → focusin 触发(target 被 shadow DOM 重定向成宿主)
 *   - 焦点**已在** video 上(点过画面就是这个状态)按 Tab → 宿主自始至终没变,
 *     focusin **不触发**,只能在 keydown 里看 activeElement
 *
 * 空格另行接管:原来能暂停是因为焦点恰好在 video 上、由原生控件处理,焦点在别处
 * (比如点过下方的线路按钮)空格就变成翻页。这里统一拦下直接操作 videoRef。
 */
export function usePlayerKeys(videoRef: RefObject<HTMLVideoElement | null>) {
  const preRef = useRef<HTMLSpanElement>(null)
  const postRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null
      if (!el) return false
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
    }
    const hop = (forward: boolean) => (forward ? postRef : preRef).current?.focus()

    // 0 = 非 Tab 触发(鼠标点击),1 = Tab,-1 = Shift+Tab
    let tabDir = 0

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        tabDir = e.shiftKey ? -1 : 1
        // 焦点已在 video 上:再按 Tab 会走进 shadow 控件,且不会触发 focusin,
        // 必须在这里截下来手动跳到哨兵。
        if (document.activeElement?.tagName === 'VIDEO') {
          e.preventDefault()
          hop(!e.shiftKey)
        }
        return
      }
      // e.code 兜住带修饰键时 e.key 不为 ' ' 的情况
      if (e.key !== ' ' && e.code !== 'Space') return
      if (isTyping(e.target)) return
      const video = videoRef.current
      if (!video) return
      // 拦下默认行为:焦点在 video 上时原生控件也会切一次,不拦会来回抵消;
      // 焦点在别处时默认行为是翻页。
      e.preventDefault()
      if (video.paused) void video.play().catch(() => {})
      else video.pause()
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Tab') tabDir = 0
    }

    const onFocusIn = (e: FocusEvent) => {
      if (!tabDir) return // 鼠标点进来的不弹开,否则空格暂停失去焦点依据
      if ((e.target as HTMLElement | null)?.tagName !== 'VIDEO') return
      hop(tabDir > 0)
    }

    // 捕获阶段:focusin 是在 Tab 的默认行为里同步派发的,方向标记必须先于它落定
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [videoRef])

  return { preRef, postRef }
}
