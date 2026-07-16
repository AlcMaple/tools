// 设置页 —— 左栏「身份卡 + 模块导航」，右栏模块面板。设计取自参考站的思路（对比后定的）：
//   - 键值用**两列紧挨着**（标签固定窄宽 + 值紧跟其后），不用 space-between 把值甩到最右，
//     否则眼睛要横跳几百 px
//   - 右栏**不套厚卡片边框**，靠标题 + 分隔线 + 间距分组；边框套边框正是「闷」的来源
//   - 表单**限宽**，别把密码框拉成整个面板那么宽
// 模块导航现在只有两个，但结构就是为了长大用的（追番偏好 / 数据同步等）。
import { useEffect, useState } from 'react'
import { auth, fetchQuestions, useAuth } from './auth'
import type { SecurityQuestion } from './auth'
import { Icon } from './Icon'
import { Select } from './Select'

type Module = 'profile' | 'security'

export function SettingsPage(): JSX.Element | null {
  const { user } = useAuth()
  const [module, setModule] = useState<Module>('profile')

  if (!user) return null

  return (
    <div className="px-4 pb-16 md:px-6">
      <div className="pt-4 pb-3">
        <h1 className="text-2xl font-black tracking-tighter text-on-surface md:text-3xl">设置</h1>
        <p className="mt-1.5 font-label text-sm text-on-surface-variant/80">
          账号与安全。你的数据只属于这个账号，和桌面版各自独立。
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-[220px_1fr] md:gap-10">
        <aside className="self-start md:sticky md:top-[72px]">
          <IdCard username={user.username} />
          <nav className="mt-3.5 flex gap-1.5 overflow-x-auto md:flex-col md:overflow-visible">
            <SideItem icon="person" active={module === 'profile'} onClick={() => setModule('profile')}>
              个人信息
            </SideItem>
            <SideItem icon="lock" active={module === 'security'} onClick={() => setModule('security')}>
              账号安全
            </SideItem>
            <div className="hidden px-2.5 pb-1.5 pt-3 font-label text-[10px] uppercase tracking-[0.16em] text-on-surface-variant/35 md:block">
              后续
            </div>
            <SideItem icon="favorite" ghost>
              追番偏好
            </SideItem>
            <SideItem icon="sync" ghost>
              数据同步
            </SideItem>
          </nav>
        </aside>

        <div>{module === 'profile' ? <ProfileModule /> : <SecurityModule />}</div>
      </div>
    </div>
  )
}

function IdCard({ username }: { username: string }): JSX.Element {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-outline-variant/10 bg-surface-container/70 p-4 md:flex-col md:gap-2.5 md:p-5">
      <div className="flex h-[54px] w-[54px] shrink-0 items-center justify-center rounded-xl bg-primary/15 text-[22px] font-extrabold text-primary">
        {username.charAt(0).toUpperCase()}
      </div>
      <div className="min-w-0 md:flex md:flex-col md:items-center md:gap-2">
        <div className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[14.5px] font-extrabold text-on-surface">
          {username}
        </div>
        <span className="mt-1 inline-block rounded bg-primary/10 px-2 py-0.5 font-label text-[10px] font-bold text-primary md:mt-0">
          网页版账号
        </span>
      </div>
    </div>
  )
}

function SideItem({
  icon,
  active,
  ghost,
  onClick,
  children,
}: {
  icon: 'person' | 'lock' | 'favorite' | 'sync'
  active?: boolean
  ghost?: boolean
  onClick?: () => void
  children: React.ReactNode
}): JSX.Element {
  if (ghost) {
    return (
      <span className="hidden items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] font-semibold text-on-surface-variant/30 md:flex">
        <Icon name={icon} size={15} className="shrink-0" />
        {children}
        <span className="ml-auto rounded bg-on-surface-variant/10 px-1 py-px font-label text-[9px]">待开发</span>
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 py-2 text-left text-[13.5px] font-semibold transition-colors ${
        active
          ? 'bg-primary/10 text-primary'
          : 'text-on-surface-variant/75 hover:bg-on-surface/5 hover:text-on-surface'
      }`}
    >
      <Icon name={icon} size={15} className="shrink-0" />
      {children}
    </button>
  )
}

function PaneHead({ title, desc }: { title: string; desc: string }): JSX.Element {
  return (
    <div className="mb-1.5 border-b border-outline-variant/15 pb-3">
      <h2 className="text-base font-extrabold text-on-surface">{title}</h2>
      <p className="mt-1 font-label text-xs text-on-surface-variant/55">{desc}</p>
    </div>
  )
}

// 键值行 —— 两列紧挨着（标签 96px + 值），值左对齐紧跟标签
function Kv({ k, v, note }: { k: string; v: string; note?: string }): JSX.Element {
  return (
    <div className="grid grid-cols-[96px_1fr] items-baseline gap-4 border-b border-outline-variant/10 py-3.5 last:border-b-0">
      <div className="text-[13px] font-semibold text-on-surface-variant/70">{k}</div>
      <div className="text-[13.5px] text-on-surface">
        {v}
        {note && <span className="mt-1 block text-[11.5px] text-on-surface-variant/40">{note}</span>}
      </div>
    </div>
  )
}

function ProfileModule(): JSX.Element | null {
  const { user } = useAuth()
  if (!user) return null
  return (
    <>
      <PaneHead title="个人信息" desc="你在 MapleTools 网页版的身份。" />
      <Kv k="用户名" v={user.username} note="登录用，创建后不可修改，最长 12 个字符" />
      <Kv k="注册时间" v={user.createdAt.slice(0, 10)} />
      <Kv k="数据归属" v="仅此账号" note="网页版数据存在服务器，和桌面版各自独立" />
      <Kv
        k="密保"
        v={user.hasSecurity ? '已设置' : '未设置'}
        note={
          user.hasSecurity
            ? '出于安全，问题和答案都不会显示出来'
            : '没设密保，忘记密码将无法找回账号'
        }
      />
    </>
  )
}

function SecurityModule(): JSX.Element {
  const { user } = useAuth()
  const [questions, setQuestions] = useState<SecurityQuestion[]>([])
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [questionId, setQuestionId] = useState('')
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void fetchQuestions().then(setQuestions).catch(() => undefined)
  }, [])

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
    setOkMsg(null)
    if (next && next !== confirm) {
      setError('两次输入的新密码不一致')
      return
    }
    setSaving(true)
    try {
      await auth.saveSettings({
        currentPassword: current,
        newPassword: next || undefined,
        confirm: confirm || undefined,
        questionId: questionId || undefined,
        answer: answer || undefined,
      })
      setOkMsg('已保存')
      setCurrent('')
      setNext('')
      setConfirm('')
      setQuestionId('')
      setAnswer('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <PaneHead title="账号安全" desc="修改密码或密保，都需要先验证原始密码。" />
      <form onSubmit={submit} className="max-w-[440px] pt-4">
        <Field label="原始密码" required>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            placeholder="输入当前密码以验证身份"
            autoComplete="current-password"
            className={inputCls}
          />
        </Field>

        <SegNote>修改密码</SegNote>
        <div className="flex items-start gap-2 rounded border border-primary/15 bg-primary/5 px-3 py-2.5 text-[11.5px] leading-relaxed text-on-surface-variant/75">
          <span>💡</span>
          <span>
            只想改密保、<b className="text-primary">不改密码</b>？下面两个框
            <b className="text-primary">留空</b>就行。
          </span>
        </div>
        <div className="mt-3.5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="新密码" tight>
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder="留空 = 不改"
              autoComplete="new-password"
              className={inputCls}
            />
            <p className="mt-1.5 font-label text-[11px] text-on-surface-variant/40">至少 6 位</p>
          </Field>
          <Field label="确认新密码" tight>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="留空 = 不改"
              autoComplete="new-password"
              className={inputCls}
            />
          </Field>
        </div>

        <SegNote>找回密码用的密保</SegNote>
        {/* 只报「设没设」，绝不回显问题和答案 —— 问题本身也是秘密 */}
        <div className="mb-3.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded border border-outline-variant/15 bg-surface-container-high/50 px-3 py-2.5 text-xs text-on-surface-variant/75">
          <span>当前状态：</span>
          <span className={`font-bold ${user?.hasSecurity ? 'text-primary' : 'text-error'}`}>
            {user?.hasSecurity ? '已设置' : '未设置'}
          </span>
          <span className="opacity-60">· 出于安全，已设置的问题和答案都不会显示出来</span>
        </div>
        <Field label="找回密码问题">
          <Select
            options={questions}
            value={questionId}
            onChange={setQuestionId}
            placeholder="请选择一个问题…"
          />
          <p className="mt-1.5 font-label text-[11px] text-on-surface-variant/40">
            从预设里选而不是自己写 —— 找回时只要从同一个列表里选，不用一字不差地回忆。
          </p>
        </Field>
        <Field label="找回密码答案">
          <input
            type="text"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="输入答案"
            className={inputCls}
          />
          <p className="mt-1.5 font-label text-[11px] text-on-surface-variant/40">
            答案会像密码一样加密保存，我们也看不到。不区分大小写和首尾空格。
          </p>
        </Field>

        {error && <p className="mb-3 font-label text-[11.5px] text-error">{error}</p>}
        {okMsg && <p className="mb-3 font-label text-[11.5px] text-primary">{okMsg}</p>}

        <div className="mt-5 flex items-center gap-3.5">
          <button
            type="submit"
            disabled={saving}
            className="shrink-0 rounded-lg bg-primary px-5 py-2.5 text-[13px] font-bold text-on-primary transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? '保存中…' : '保存修改'}
          </button>
          <span className="font-label text-[11.5px] text-on-surface-variant/45">
            改密码会让其它设备上的登录立即失效。
          </span>
        </div>
      </form>
    </>
  )
}

const inputCls =
  'w-full rounded-lg border border-outline-variant/30 bg-surface-container-high px-3 py-2.5 text-sm text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/35 focus:border-primary/70'

function Field({
  label,
  required,
  tight,
  children,
}: {
  label: string
  required?: boolean
  tight?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className={tight ? '' : 'mb-4'}>
      <label className="mb-1.5 block font-label text-[10px] uppercase tracking-wider text-on-surface-variant/80">
        {label}
        {required && <span className="ml-1.5 normal-case tracking-normal text-error">必填</span>}
      </label>
      {children}
    </div>
  )
}

function SegNote({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="my-4 flex items-center gap-2.5 font-label text-[10.5px] uppercase tracking-[0.14em] text-on-surface-variant/40 before:h-px before:flex-1 before:bg-outline-variant/15 after:h-px after:flex-1 after:bg-outline-variant/15">
      {children}
    </div>
  )
}
