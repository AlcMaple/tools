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
    // md 以下没有侧栏可言，整页就是一条**中轴**：标题 / 头像 / tab / 主体全部居中对齐。
    // 之前左对齐 → 右边一大片死区；只把头像居中 → 中轴和左对齐的内容各走各的，更散。
    // md 起恢复「220px 侧栏 + 面板」，一切回到左对齐。
    <div className="px-4 pb-16 md:px-6">
      {/* 标题在**居中列之外** —— 它要贴页面左边距，跟周历页的 h1 同一个位置；
          放进居中列里就会缩到列的左边缘（页面中间偏左），两页对不上 */}
      <div className="pt-4 pb-3">
        <h1 className="text-2xl font-black tracking-tighter text-on-surface md:text-3xl">设置</h1>
      </div>

      <div className="mx-auto w-full max-w-[480px] md:max-w-none">
        <div className="grid gap-6 md:grid-cols-[220px_1fr] md:gap-10">
          <aside className="self-start md:sticky md:top-[72px]">
            <IdCard username={user.username} />
            {/* 窄屏：tab 居中，跟上面的头像页头对齐成一条中轴。md 起回到侧栏的竖排左对齐 */}
            <nav className="mt-4 flex justify-center gap-1.5 md:mt-3.5 md:flex-col md:justify-start">
              <SideItem
                icon="person"
                active={module === 'profile'}
                onClick={() => setModule('profile')}
              >
                个人信息
              </SideItem>
              <SideItem
                icon="lock"
                active={module === 'security'}
                onClick={() => setModule('security')}
              >
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
    </div>
  )
}

// 身份区。两种形态都是「竖排居中」，差别只在**要不要卡片外观**：
//   窄屏 = 页头，不套框 —— 套了就是页面正中一个孤零零的小盒子（撑满又是条空长条，两头不讨好）
//   md 起 = 220px 侧栏里的身份卡，这时框才有意义（它把侧栏和右边面板分开）
function IdCard({ username }: { username: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2.5 md:rounded-xl md:border md:border-outline-variant/10 md:bg-surface-container/70 md:p-5">
      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-primary/15 text-[26px] font-extrabold text-primary md:h-[54px] md:w-[54px] md:rounded-xl md:text-[22px]">
        {username.charAt(0).toUpperCase()}
      </div>
      <div className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-base font-extrabold text-on-surface md:text-[14.5px]">
        {username}
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

// 窄屏只留分隔线，不重复标题 —— 正上方那个高亮的 tab 已经说了在哪个模块，
// 再写一遍是同一件事说两遍。md 起 tab 在侧栏里，面板才需要自己的标题。
function PaneHead({ title }: { title: string }): JSX.Element {
  return (
    <div className="mb-1.5 border-b border-outline-variant/15 md:pb-3">
      <h2 className="hidden text-base font-extrabold text-on-surface md:block">{title}</h2>
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
      <PaneHead title="个人信息" />
      {/* 窄屏把键值块收窄到「标签 + 值刚好填满」再整块居中 —— 铺满整列的话内容只占左边 40%，
          右边一条死区，跟上面居中的头像/tab 对不上。md 起铺满面板（那时右边还有内容撑着）。 */}
      <div className="mx-auto w-full max-w-[320px] md:max-w-none">
        <Kv k="用户名" v={user.username} />
        <Kv k="注册时间" v={user.createdAt.slice(0, 10)} />
        {/* note 只留「没设密保」这种要用户去做点什么的警告；「已设置」不用再解释为什么不显示 */}
        <Kv
          k="密保"
          v={user.hasSecurity ? '已设置' : '未设置'}
          note={user.hasSecurity ? undefined : '忘记密码将无法找回账号'}
        />
      </div>
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
      <PaneHead title="账号安全" />
      {/* md 以下不限宽：外层已经收进 560 的居中列了，再限 440 只会在右边又留一条死区 */}
      <form onSubmit={submit} className="pt-4 md:max-w-[440px]">
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
        {/* 「留空 = 不改」由 placeholder 直接说，不再另开一条提示条重复一遍 */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
        <div className="mb-3.5 flex flex-wrap items-center gap-x-1.5 rounded border border-outline-variant/15 bg-surface-container-high/50 px-3 py-2.5 text-xs text-on-surface-variant/75">
          <span>当前状态：</span>
          <span className={`font-bold ${user?.hasSecurity ? 'text-primary' : 'text-error'}`}>
            {user?.hasSecurity ? '已设置' : '未设置'}
          </span>
        </div>
        <Field label="找回密码问题">
          <Select
            options={questions}
            value={questionId}
            onChange={setQuestionId}
            placeholder="请选择一个问题…"
          />
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
            不区分大小写和首尾空格
          </p>
        </Field>

        {/* 状态位固定在按钮右侧的空位里：出现/消失都不挤动任何东西。
            原来是在按钮上方插一行 <p>，一「已保存」整行按钮就被顶下去。 */}
        <div className="mt-5 flex items-center gap-3.5">
          <button
            type="submit"
            disabled={saving}
            className="shrink-0 rounded-lg bg-primary px-5 py-2.5 text-[13px] font-bold text-on-primary transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? '保存中…' : '保存修改'}
          </button>
          <span className={`font-label text-[11.5px] ${error ? 'text-error' : 'text-primary'}`}>
            {error || okMsg}
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
