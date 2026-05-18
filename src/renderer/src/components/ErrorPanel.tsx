import { useEffect, useState } from 'react'
import { friendlyError } from '../utils/errorMessage'

interface Props {
  error: unknown
  onRetry?: () => void
  retryLabel?: string
  compact?: boolean
}

/**
 * 限流错误的倒计时 retry 按钮 —— 倒计时只是**提示**用户建议等多久，按钮
 * 永远可点（用户想立刻试就立刻试，风险自负）。
 *
 * 设计要点：倒计时数字本身**不可信** —— 它来自 BGM 这次响应里的 waitSec,
 * 但 BGM 真正的惩罚窗口对用户来说是黑盒。用户在倒计时未结束时点击 →
 * BGM 可能加重处罚（实际等待远超我们显示的数字）。我们必须把这个
 * "曾经提前点过 → 倒计时已不可信"的风险信号清楚展示给用户：
 *
 *   首次显示：       [⏱ 25s · Try again]    （灰 clock + 数字，普通色）
 *   用户提前点过后：  [⚠ 约 25s · Try again]  （琥珀 warning + 约 + 数字）
 *
 * tooltip 也会从"建议 N 秒后再试"切换到"BGM 可能已加重限流，倒计时仅供
 * 参考"。这样用户清楚知道自己已经触发了不确定性，不会傻等 30s 觉得到点
 * 就稳过。
 *
 * 倒计时基于绝对时间戳，免受 setInterval 漂移 / tab 后台节流影响。
 * `prematureClickCount` 在组件 unmount 时自然清零（错误消失即组件销毁），
 * 不需要外部状态管理。
 */
function CountdownRetryButton({
  totalSec,
  onRetry,
  retryLabel,
  errorVersion,
}: {
  totalSec: number
  onRetry: () => void
  retryLabel: string
  errorVersion: number
}): JSX.Element {
  const [endAt, setEndAt] = useState(() => Date.now() + totalSec * 1000)
  const [now, setNow] = useState(() => Date.now())
  const [prematureClickCount, setPrematureClickCount] = useState(0)
  const remaining = Math.max(0, Math.ceil((endAt - now) / 1000))
  const inCountdown = remaining > 0
  const aggravated = prematureClickCount > 0

  // 新错误来时重置 endAt（但保留 prematureClickCount —— 警告是跨 error
  // version 持续的"前科记录"，让用户始终知道这次 cooldown 数字不可信）
  useEffect(() => {
    setEndAt(Date.now() + totalSec * 1000)
    setNow(Date.now())
  }, [totalSec, errorVersion])

  useEffect(() => {
    if (!inCountdown) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [inCountdown])

  const handleClick = (): void => {
    if (inCountdown) setPrematureClickCount((c) => c + 1)
    onRetry()
  }

  return (
    <button
      onClick={handleClick}
      className="group inline-flex items-center gap-1.5 font-label text-xs text-primary hover:underline underline-offset-4 transition-colors"
      title={
        aggravated
          ? `你已经提前点过 ${prematureClickCount} 次，BGM 可能已加重限流。倒计时显示的是 BGM 这次响应里说的秒数，实际等待时长可能更长 —— BGM 不会告诉我们累积惩罚多重。`
          : inCountdown
            ? `BGM 仍在限流冷却中，建议 ${remaining} 秒后再试。提前点击可能加重限流。`
            : '立即重试'
      }
    >
      {inCountdown && (
        <span
          className={`material-symbols-outlined leading-none transition-colors ${
            aggravated
              ? 'text-amber-500'
              : 'text-on-surface-variant/60 group-hover:text-primary'
          }`}
          style={{ fontSize: 14, fontVariationSettings: aggravated ? "'FILL' 1" : undefined }}
        >
          {aggravated ? 'warning' : 'schedule'}
        </span>
      )}
      {inCountdown && (
        <span
          className={`font-mono text-[11px] tabular-nums transition-colors ${
            aggravated
              ? 'text-amber-600'
              : 'text-on-surface-variant/70 group-hover:text-primary'
          }`}
        >
          {aggravated && '约 '}
          {remaining}s
        </span>
      )}
      <span>{retryLabel}</span>
    </button>
  )
}

export default function ErrorPanel({
  error,
  onRetry,
  retryLabel = 'Try again',
  compact = false,
}: Props): JSX.Element {
  const [showRaw, setShowRaw] = useState(false)
  // 每次 error 实例变化时 +1，用于驱动倒计时组件 reset。React 用对象 ===
  // 判断，error 是从 props 来的所以每次重渲染都是同一个对象，但用户重新
  // 触发错误时父组件会传新的 error 对象 → ref 不等 → version++
  const [errorVersion, setErrorVersion] = useState(0)
  const [lastError, setLastError] = useState(error)
  if (error !== lastError) {
    setLastError(error)
    setErrorVersion((v) => v + 1)
  }

  const { title, hint, raw, retryAfterSec } = friendlyError(error)

  const py = compact ? 'py-12' : 'py-24'
  const iconSize = compact ? 'text-4xl' : 'text-5xl'

  return (
    <div className={`flex flex-col items-center justify-center ${py} gap-4 px-6`}>
      <span className={`material-symbols-outlined text-error/70 ${iconSize}`}>error_outline</span>
      <div className="text-center space-y-1.5 max-w-md">
        <p className="font-label text-sm font-bold text-error uppercase tracking-[0.2em]">{title}</p>
        <p className="font-body text-sm text-on-surface-variant leading-relaxed">{hint}</p>
      </div>
      <div className="flex items-center gap-4 mt-1">
        {onRetry &&
          (retryAfterSec ? (
            <CountdownRetryButton
              totalSec={retryAfterSec}
              onRetry={onRetry}
              retryLabel={retryLabel}
              errorVersion={errorVersion}
            />
          ) : (
            <button
              onClick={onRetry}
              className="font-label text-xs text-primary hover:underline underline-offset-4"
            >
              {retryLabel}
            </button>
          ))}
        <button
          onClick={() => setShowRaw((v) => !v)}
          className="font-label text-xs text-on-surface-variant/50 hover:text-on-surface-variant underline underline-offset-4"
        >
          {showRaw ? 'Hide details' : 'Show details'}
        </button>
      </div>
      {showRaw && (
        <pre className="mt-2 max-w-xl text-[11px] text-on-surface-variant/50 font-mono whitespace-pre-wrap break-all bg-surface-container-lowest/60 rounded-lg px-4 py-3 border border-outline-variant/10">
          {raw}
        </pre>
      )}
    </div>
  )
}
