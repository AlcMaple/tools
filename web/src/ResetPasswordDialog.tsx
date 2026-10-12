import { useEffect, useState } from 'react'
import { auth, fetchQuestions } from './auth'
import type { SecurityQuestion } from './auth'
import { Ic } from './SketchIcon'
import { PasswordInput } from './PasswordInput'
import { Select } from './Select'

export function ResetPasswordDialog({ token, onClose, onDone }: { token: string; onClose: () => void; onDone: () => void }): JSX.Element {
  const [username, setUsername] = useState<string | null>(null)
  const [questions, setQuestions] = useState<SecurityQuestion[]>([])
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [questionId, setQuestionId] = useState('')
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    void auth.checkReset(token).then((r) => setUsername(r.username)).catch((e) => setError(e instanceof Error ? e.message : '链接校验失败'))
    void fetchQuestions().then(setQuestions).catch(() => undefined)
  }, [token])

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (password !== confirm) { setError('两次输入的新密码不一致'); return }
    setSubmitting(true)
    setError('')
    try {
      await auth.completeReset({ token, newPassword: password, confirm, questionId, answer })
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '重置失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="dlg-backdrop open">
      <div role="dialog" aria-modal="true" aria-label="重置密码与密保" className="dlg">
        <span className="tape tl teal" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭"><Ic name="x" cls="ic" /></button>
        <h2 className="dlg-title">重置密码与密保</h2>
        {done ? (
          <>
            <p className="form-note">已重置，请用新密码登录。</p>
            <button type="button" className="btn btn-primary btn-block mt8" onClick={onDone}>去登录</button>
          </>
        ) : username === null ? (
          <p className={`form-note${error ? ' err' : ''}`} role="status">{error || '正在校验链接…'}</p>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <p className="form-note">正在为 <b>{username}</b> 设置新的密码和密保。</p>
            <label className="field">
              <span className="field-label">新密码</span>
              <PasswordInput value={password} onChange={setPassword} placeholder="设置新密码" autoComplete="new-password" />
              <span className="field-hint">至少 6 位</span>
            </label>
            <label className="field">
              <span className="field-label">确认新密码</span>
              <PasswordInput value={confirm} onChange={setConfirm} placeholder="再输一次密码" autoComplete="new-password" />
            </label>
            <div className="field">
              <span className="field-label">新的密保问题</span>
              <Select options={questions} value={questionId} onChange={setQuestionId} placeholder="请选择一个问题…" />
            </div>
            <label className="field">
              <span className="field-label">答案</span>
              <span className="field-row"><input type="text" value={answer} onChange={(e) => setAnswer(e.target.value)} maxLength={100} /></span>
            </label>
            {error && <p className="form-note err" aria-live="polite">{error}</p>}
            <button type="submit" disabled={submitting || !password || !questionId || !answer.trim()} className="btn btn-primary btn-block mt8">{submitting ? '请稍候…' : '重置'}</button>
          </form>
        )}
      </div>
    </div>
  )
}
