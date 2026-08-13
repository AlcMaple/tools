import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react'

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]

// 时间格式:mm:ss,超过 1 小时补 hh:mm:ss
function fmtTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0
  const s = Math.floor(t)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

function readBuffered(v: HTMLVideoElement): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const b = v.buffered
  for (let i = 0; i < b.length; i++) out.push([b.start(i), b.end(i)])
  return out
}

export default function PlayerControls({
  videoRef,
  containerRef,
  videoKey,
  onFullscreenChange,
}: {
  videoRef: RefObject<HTMLVideoElement | null>
  containerRef: RefObject<HTMLDivElement | null>
  // 换集/换源会重建 <video> 元素,用它触发一次状态重置与事件重挂
  videoKey: string
  onFullscreenChange?: (fs: boolean) => void
}): JSX.Element {
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState<Array<[number, number]>>([])
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [rate, setRate] = useState(1)
  const [fs, setFs] = useState(false)
  const [visible, setVisible] = useState(true)
  const [hoverRatio, setHoverRatio] = useState<number | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  const [speedOpen, setSpeedOpen] = useState(false)

  const barRef = useRef<HTMLDivElement | null>(null)
  const volRef = useRef<HTMLDivElement | null>(null)
  const hideTimer = useRef<number | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // 只引用 ref 与稳定的 setter,允许事件里用到「旧一次渲染」的闭包也不会错值
  const armHide = (): void => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      const v = videoRef.current
      if (v && !v.paused) setVisible(false)
    }, 2600)
  }

  const seekTo = (ratio: number): void => {
    const v = videoRef.current
    if (!v) return
    const d = v.duration
    if (!Number.isFinite(d) || d <= 0) return
    const t = Math.min(1, Math.max(0, ratio)) * d
    v.currentTime = t
    setCurrent(t)
  }

  const ratioAt = (clientX: number): number => {
    const el = barRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    if (r.width <= 0) return 0
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  }

  const togglePlay = (): void => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => {})
    else v.pause()
  }

  const toggleMute = (): void => {
    const v = videoRef.current
    if (!v) return
    v.muted = !v.muted
    setMuted(v.muted)
  }

  const setVolumeTo = (r: number): void => {
    const v = videoRef.current
    if (!v) return
    v.volume = r
    v.muted = r === 0
    setVolume(r)
    setMuted(r === 0)
  }

  const volRatioAt = (clientX: number): number => {
    const el = volRef.current
    if (!el) return 1
    const r = el.getBoundingClientRect()
    if (r.width <= 0) return 1
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  }

  const setSpeed = (r: number): void => {
    const v = videoRef.current
    if (v) v.playbackRate = r
    setRate(r)
    setSpeedOpen(false)
  }

  const toggleFs = (): void => {
    if (fs) {
      void document.exitFullscreen().catch(() => {})
      return
    }
    const box = containerRef.current
    if (!box) return
    void box.requestFullscreen().catch(() => {})
  }

  // 换集/换源:重置为新 <video> 的实际状态,并重挂全部媒体事件
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    setRate(video.playbackRate)
    setVolume(video.volume)
    setMuted(video.muted)
    setPlaying(!video.paused)
    setCurrent(video.currentTime || 0)
    setDuration(Number.isFinite(video.duration) ? video.duration : 0)
    setBuffered(readBuffered(video))
    setHoverRatio(null)
    setScrubbing(false)

    const onPlay = (): void => {
      setPlaying(true)
      armHide()
    }
    const onPause = (): void => {
      setPlaying(false)
      setVisible(true)
    }
    const onTime = (): void => setCurrent(video.currentTime)
    const onDuration = (): void => setDuration(Number.isFinite(video.duration) ? video.duration : 0)
    const onProgress = (): void => setBuffered(readBuffered(video))
    const onVolume = (): void => {
      setVolume(video.volume)
      setMuted(video.muted)
    }
    const onRate = (): void => setRate(video.playbackRate)
    const onClick = (): void => {
      if (video.paused) void video.play().catch(() => {})
      else video.pause()
    }

    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('durationchange', onDuration)
    video.addEventListener('loadedmetadata', onDuration)
    video.addEventListener('progress', onProgress)
    video.addEventListener('volumechange', onVolume)
    video.addEventListener('ratechange', onRate)
    video.addEventListener('click', onClick)
    return () => {
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('durationchange', onDuration)
      video.removeEventListener('loadedmetadata', onDuration)
      video.removeEventListener('progress', onProgress)
      video.removeEventListener('volumechange', onVolume)
      video.removeEventListener('ratechange', onRate)
      video.removeEventListener('click', onClick)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef, videoKey])

  // 自动隐藏:鼠标在播放区移动即显示,停止 2.6s 且仍在播放则收起;暂停时强制常显
  useEffect(() => {
    const box = containerRef.current
    if (!box) return
    const onMove = (): void => {
      setVisible(true)
      armHide()
    }
    box.addEventListener('mousemove', onMove)
    box.addEventListener('touchstart', onMove)
    return () => {
      box.removeEventListener('mousemove', onMove)
      box.removeEventListener('touchstart', onMove)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef])

  // 全屏状态跟随浏览器,并回报父组件(父容器据此去掉圆角/改为铺满)
  useEffect(() => {
    const onChange = (): void => {
      const on = document.fullscreenElement === containerRef.current
      setFs(on)
      onFullscreenChange?.(on)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [containerRef, onFullscreenChange])

  // 拖动进度条:scrubbing 期间跟随窗口 mousemove,松手结束
  useEffect(() => {
    if (!scrubbing) return
    const onMove = (e: MouseEvent): void => {
      const r = ratioAt(e.clientX)
      setHoverRatio(r)
      seekTo(r)
    }
    const onUp = (): void => setScrubbing(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubbing])

  // 倍速菜单点击外部关闭
  useEffect(() => {
    if (!speedOpen) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setSpeedOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [speedOpen])

  const onBarMove = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const r = ratioAt(e.clientX)
    setHoverRatio(r)
    if (scrubbing) seekTo(r)
  }
  const onBarLeave = (): void => setHoverRatio(null)
  const onBarDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setScrubbing(true)
    const r = ratioAt(e.clientX)
    setHoverRatio(r)
    seekTo(r)
  }
  const onVolDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setVolumeTo(volRatioAt(e.clientX))
    const onMove = (ev: MouseEvent): void => setVolumeTo(volRatioAt(ev.clientX))
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const playedPct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0
  const tip = hoverRatio !== null && duration > 0
  const tipLeftPct = hoverRatio !== null ? hoverRatio * 100 : 0

  const iconBtn =
    'pointer-events-auto p-1 rounded-md text-white/90 hover:text-primary hover:bg-white/10 transition-colors shrink-0'

  return (
    <div
      ref={rootRef}
      className={`pointer-events-none absolute inset-0 flex flex-col justify-end transition-opacity duration-200 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <div
        className={`bg-gradient-to-t from-black/85 via-black/30 to-transparent px-3 pb-2 pt-10 md:px-4 ${
          visible ? 'pointer-events-auto' : 'pointer-events-none'
        }`}
      >
        {/* 进度条:悬停/拖动时上方浮出时间提示(核心诉求,替代原生控件做不到的部分) */}
        <div className="relative mb-1">
          {tip && (
            <div
              className="pointer-events-none absolute bottom-full -translate-x-1/2 mb-1.5 rounded-md bg-black/85 px-2 py-0.5 font-label text-[11px] tabular-nums text-white whitespace-nowrap"
              style={{ left: `${tipLeftPct}%` }}
            >
              {fmtTime(hoverRatio! * duration)}
            </div>
          )}
          <div
            ref={barRef}
            onMouseMove={onBarMove}
            onMouseLeave={onBarLeave}
            onMouseDown={onBarDown}
            className="relative h-1.5 w-full cursor-pointer rounded-full bg-white/20"
          >
            {buffered.map(([s, e], i) => {
              if (duration <= 0) return null
              const l = (s / duration) * 100
              const w = ((e - s) / duration) * 100
              return (
                <div
                  key={i}
                  className="absolute top-0 h-full rounded-full bg-white/25"
                  style={{ left: `${l}%`, width: `${w}%` }}
                />
              )
            })}
            <div
              className="absolute left-0 top-0 h-full rounded-full bg-primary"
              style={{ width: `${playedPct}%` }}
            />
            <div
              className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary"
              style={{ left: `${playedPct}%` }}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 md:gap-3">
          <button type="button" onClick={togglePlay} title={playing ? '暂停' : '播放'} className={iconBtn}>
            <span className="material-symbols-outlined leading-none" style={{ fontSize: 24 }}>
              {playing ? 'pause' : 'play_arrow'}
            </span>
          </button>

          <span className="font-label text-[11px] tabular-nums text-white/90 whitespace-nowrap">
            {fmtTime(current)} / {duration > 0 ? fmtTime(duration) : '--:--'}
          </span>

          <div className="ml-auto flex items-center gap-1.5 md:gap-2">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={toggleMute}
                title={muted ? '取消静音' : '静音'}
                className={iconBtn}
              >
                <span className="material-symbols-outlined leading-none" style={{ fontSize: 20 }}>
                  {muted || volume === 0 ? 'volume_off' : volume < 0.5 ? 'volume_down' : 'volume_up'}
                </span>
              </button>
              <div
                ref={volRef}
                onMouseDown={onVolDown}
                className="relative hidden h-1 w-16 cursor-pointer rounded-full bg-white/20 sm:block"
              >
                <div
                  className="absolute left-0 top-0 h-full rounded-full bg-white"
                  style={{ width: `${muted ? 0 : volume * 100}%` }}
                />
              </div>
            </div>

            <div className="relative">
              <button
                type="button"
                onClick={() => setSpeedOpen((o) => !o)}
                title="播放速度"
                className={iconBtn}
              >
                <span className="font-label text-[11px] tabular-nums leading-none">{rate}x</span>
              </button>
              {speedOpen && (
                <div className="absolute bottom-full right-0 mb-2 w-16 rounded-lg border border-outline-variant/20 bg-surface-container-high p-1 shadow-2xl">
                  {RATES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setSpeed(r)}
                      className={`w-full rounded-md py-1 text-center font-label text-[11px] tabular-nums transition-colors ${
                        r === rate ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'
                      }`}
                    >
                      {r}x
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button type="button" onClick={toggleFs} title={fs ? '退出全屏' : '全屏'} className={iconBtn}>
              <span className="material-symbols-outlined leading-none" style={{ fontSize: 20 }}>
                {fs ? 'fullscreen_exit' : 'fullscreen'}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
