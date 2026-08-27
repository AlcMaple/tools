import { useEffect, useRef, useState } from 'react'
import type { BgmImportStatus } from '../api'
import { Ic, Spinner } from '../SketchIcon'
import { toast } from '../Toast'

function emptyImportStatus(state: BgmImportStatus['state'] = 'running'): BgmImportStatus {
  return { state, total: 0, processed: 0, added: 0, updated: 0, failed: 0, error: null }
}

export function BgmImportModal({
  initialUserId,
  onImport,
  onClose,
}: {
  initialUserId: string
  onImport: (bgmUserId: string, onProgress: (status: BgmImportStatus) => void) => Promise<BgmImportStatus>
  onClose: () => void
}): JSX.Element {
  const [bgmUserId, setBgmUserId] = useState(initialUserId)
  const [view, setView] = useState<'idle' | BgmImportStatus['state']>('idle')
  const [status, setStatus] = useState<BgmImportStatus>(() => emptyImportStatus())
  const mounted = useRef(true)
  const busy = view === 'running'

  useEffect(() => {
    // StrictMode 会执行 setup → cleanup → setup；第二次 setup 必须把标记恢复。
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const start = async (): Promise<void> => {
    const userId = bgmUserId.trim()
    if (!userId) {
      setView('error')
      setStatus({ ...emptyImportStatus('error'), error: '请输入 Bangumi UID 或用户名' })
      return
    }

    setView('running')
    setStatus(emptyImportStatus())
    try {
      const result = await onImport(userId, (next) => {
        if (!mounted.current) return
        setStatus(next)
        setView(next.state)
      })
      if (!mounted.current) return
      setStatus(result)
      setView(result.state)
      if (result.state === 'done') {
        toast(`Bangumi 导入完成：新增 ${result.added} 部，更新 ${result.updated} 部。标签我还在后台慢慢贴，晚点再回来看`)
      }
    } catch (error) {
      if (!mounted.current) return
      setView('error')
      setStatus((previous) => ({
        ...previous,
        state: 'error',
        error: error instanceof Error ? error.message : 'Bangumi 导入失败',
      }))
    }
  }

  const percentage = status.total > 0
    ? Math.min(100, Math.round((status.processed / status.total) * 100))
    : view === 'done' ? 100 : 0
  const progressText = view === 'idle'
    ? '等待开始导入'
    : view === 'running'
      ? status.total > 0
        ? `已处理 ${status.processed}/${status.total} 部${status.processed < status.total ? ` · 正在处理第 ${status.processed + 1} 部` : ''}`
        : '正在读取 Bangumi 收藏…'
      : view === 'done'
        ? `导入完成 · 共处理 ${status.processed}/${status.total} 部 · 标签还在后台慢慢贴，晚点回来看`
        : status.error || '导入没有完成'

  return (
    <div
      className="dlg-backdrop open"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="从 Bangumi 导入" className="dlg bgm-import-dlg">
        <span className="tape tl teal" />
        <button
          type="button"
          className="dlg-close"
          onClick={onClose}
          disabled={busy}
          aria-label="关闭"
          title={busy ? '导入完成后可关闭' : '关闭'}
        >
          <Ic name="x" cls="ic" />
        </button>

        <h3 className="dlg-title">从 Bangumi 导入</h3>
        <p className="dlg-sub">
          再次导入时，Bangumi 有值的标题、进度、状态和封面会覆盖本站；自定义标签与播放绑定会保留。
          标签要我一条一条问 Bangumi 要来，导入完成不会立刻贴好——晚一点再回来看，应该就贴齐了，不是漏掉了。
        </p>

        <label className="field mb16" htmlFor="bgm-import-user-id">
          <span className="field-label">Bangumi UID / 用户名</span>
          <span className="field-row">
            <input
              id="bgm-import-user-id"
              type="text"
              value={bgmUserId}
              onChange={(event) => setBgmUserId(event.target.value)}
              placeholder="数字 UID 或自定义用户名"
              autoComplete="off"
              spellCheck={false}
              maxLength={100}
              disabled={busy}
              autoFocus
            />
          </span>
        </label>

        <div className={`bgm-import-progress${view === 'error' ? ' has-error' : ''}`}>
          <div className="bgm-import-progress-head" aria-live="polite">
            <span>{progressText}</span>
            <b>{percentage}%</b>
          </div>
          <div
            className="prog"
            role="progressbar"
            aria-label="Bangumi 导入进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percentage}
          >
            <i style={{ width: `${percentage}%` }} />
          </div>
          <div className="bgm-import-counts">
            <div><b>{status.added}</b><span>新增</span></div>
            <div><b>{status.updated}</b><span>更新</span></div>
            <div><b>{status.failed}</b><span>失败</span></div>
          </div>
        </div>

        <div className="dlg-actions bgm-import-actions">
          <button className="btn btn-ghost" type="button" onClick={onClose} disabled={busy}>
            {view === 'idle' ? '取消' : busy ? '导入中' : '关闭'}
          </button>
          <button className="btn btn-primary" type="button" onClick={() => void start()} disabled={busy}>
            {busy ? <Spinner size={16} /> : <Ic name="refresh" cls="ic ic-sm" />}
            {busy ? '正在导入' : view === 'done' ? '再次导入' : view === 'error' ? '重新尝试' : '开始导入'}
          </button>
        </div>
      </div>
    </div>
  )
}
