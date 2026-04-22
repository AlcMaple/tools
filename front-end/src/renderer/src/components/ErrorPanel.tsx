import { useState } from 'react'
import { friendlyError } from '../utils/errorMessage'

interface Props {
  error: unknown
  onRetry?: () => void
  retryLabel?: string
  compact?: boolean
}

export default function ErrorPanel({ error, onRetry, retryLabel = 'Try again', compact = false }: Props): JSX.Element {
  const [showRaw, setShowRaw] = useState(false)
  const { title, hint, raw } = friendlyError(error)

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
        {onRetry && (
          <button
            onClick={onRetry}
            className="font-label text-xs text-primary hover:underline underline-offset-4"
          >
            {retryLabel}
          </button>
        )}
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
