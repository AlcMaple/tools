import { useEffect, useState } from 'react'
import { CURRENT_ANNOUNCEMENT } from '../shared/announcement'
import { dismissCurrentAnnouncement, fetchAnnouncementStatus } from './api'
import { useAuth } from './auth'
import { Ic } from './SketchIcon'

const localDismissKey = `mt-announcement-dismissed:${CURRENT_ANNOUNCEMENT.id}`

function isLocallyDismissed(): boolean {
  try {
    return localStorage.getItem(localDismissKey) === '1'
  } catch {
    return false
  }
}

function dismissLocally(): void {
  try {
    localStorage.setItem(localDismissKey, '1')
  } catch {
    // 隐私模式不能写本机偏好时，仍允许用户关闭本次弹窗。
  }
}

type Phase = 'checking' | 'visible' | 'hidden'

/**
 * 只由首页开屏结束事件激活。登录用户的“近期不再出现”落服务端；匿名用户退化为本机偏好，
 * 不把无账号访客硬塞进用户表，也不会在非首页自行触发。
 */
export function AnnouncementModal({ active, onClose }: { active: boolean; onClose: () => void }): JSX.Element | null {
  const { user, ready } = useAuth()
  const [phase, setPhase] = useState<Phase>('checking')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!active || !ready) {
      setPhase('checking')
      setError(null)
      return
    }

    let live = true
    const finish = (next: Phase): void => {
      if (live) setPhase(next)
    }

    if (!user) {
      finish(isLocallyDismissed() ? 'hidden' : 'visible')
      return () => {
        live = false
      }
    }

    void fetchAnnouncementStatus()
      .then((status) => {
        if (!live) return
        // 前后端短暂错版时不要因为旧服务端的 id 误判为已静音；让用户仍能看到公告。
        finish(status.id === CURRENT_ANNOUNCEMENT.id && status.muted ? 'hidden' : 'visible')
      })
      .catch(() => {
        // 网络短暂失败不挡住公告；本机已经明确静音过才继续收起。
        finish(isLocallyDismissed() ? 'hidden' : 'visible')
      })

    return () => {
      live = false
    }
  }, [active, ready, user?.username])

  useEffect(() => {
    if (phase !== 'visible') return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, onClose])

  const mute = async (): Promise<void> => {
    if (saving) return
    if (!user) {
      dismissLocally()
      onClose()
      return
    }

    setSaving(true)
    setError(null)
    try {
      await dismissCurrentAnnouncement()
      dismissLocally()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : '暂时没能记住这个偏好')
      setSaving(false)
    }
  }

  if (!active || !ready || phase !== 'visible') return null

  return (
    <div
      className="dlg-backdrop open announcement-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="dlg announcement-dlg" role="dialog" aria-modal="true" aria-labelledby="announcement-title">
        <span className="tape tl teal" style={{ width: 100 }} />
        <button className="dlg-close" type="button" onClick={onClose} aria-label="关闭公告" title="下次开场再看">
          <Ic name="x" cls="ic ic-sm" />
        </button>

        <div className="announcement-head">
          <img className="announcement-face" src="/assets/sagiri-nudge.webp" alt="" />
          <div>
            <p className="announcement-eyebrow">{CURRENT_ANNOUNCEMENT.eyebrow}</p>
            <h2 id="announcement-title" className="dlg-title">{CURRENT_ANNOUNCEMENT.title}</h2>
          </div>
          <span className="stamp small st-sakura" aria-hidden="true">公告</span>
        </div>

        <p className="announcement-lead">「{CURRENT_ANNOUNCEMENT.lead}」</p>
        <div className="announcement-list">
          {CURRENT_ANNOUNCEMENT.sections.map((section) => (
            <section key={section.title} className="announcement-item">
              <h3>{section.title}</h3>
              <p>{section.body}</p>
            </section>
          ))}
        </div>

        {error && <p className="form-note err announcement-error" role="status">⚠ {error}</p>}
        <div className="announcement-actions">
          <button type="button" className="announcement-snooze" onClick={() => void mute()} disabled={saving}>
            {saving ? '正在收好这张便签…' : user ? '这条近期不再出现' : '这台设备近期不再出现'}
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            知道啦
          </button>
        </div>
      </section>
    </div>
  )
}
