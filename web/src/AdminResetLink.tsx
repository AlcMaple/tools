import { useEffect, useState } from 'react'
import { auth } from './auth'
import { Select } from './Select'

export function AdminResetLink(): JSX.Element {
  const [users, setUsers] = useState<{ id: string; text: string }[]>([])
  const [total, setTotal] = useState(0)
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ url: string; expiresAt: number; emailedTo: string | null; emailError: string | null } | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void auth.resetUsers()
      .then((r) => {
        setTotal(r.total)
        setUsers(r.users.map((u) => ({ id: u.username, text: u.self ? `${u.username}（我）` : u.username })))
      })
      .catch((err) => setError(err instanceof Error ? err.message : '用户列表读取失败'))
  }, [])

  async function issue(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError('')
    setResult(null)
    setCopied(false)
    try {
      setResult(await auth.issueReset(username))
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="feedback-reset" onSubmit={(e) => void issue(e)}>
      <span className="feedback-label">重置账号的密码和密保 <span className="faint">（共 {total} 个用户）</span></span>
      <div className="feedback-reset-row">
        <div className="feedback-reset-pick">
          <Select options={users} value={username} onChange={(v) => { setUsername(v); setResult(null) }} placeholder="选择用户…" />
        </div>
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !username}>{busy ? '生成中…' : '生成链接'}</button>
      </div>
      {error && <p className="text-error small">{error}</p>}
      {result && (
        <div className="feedback-reset-result">
          <input readOnly value={result.url} onFocus={(e) => e.currentTarget.select()} aria-label="重置链接" />
          <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(result.url).then(() => setCopied(true))}>{copied ? '已复制' : '复制'}</button>
          <p className="small faint">
            {new Date(result.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 前有效，只能用一次。
            {result.emailedTo ? ` 已发送到 ${result.emailedTo}。` : result.emailError ? ` ${result.emailError}。` : ' 该账号没有可用邮箱，请把链接转交用户。'}
          </p>
        </div>
      )}
    </form>
  )
}
