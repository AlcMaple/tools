import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Track } from '../api'
import { useAuth } from '../auth'
import { Ic, Spinner } from '../SketchIcon'
import { toast } from '../Toast'
import {
  byokDraftStream,
  byokQuestions,
  materialToText,
  readByokKey,
  type AiConfig,
  type ByokSettings,
} from './byok'
import {
  deleteReview,
  fetchMaterial,
  fetchReviewsState,
  generateDraftStream as apiGenerateDraftStream,
  generateQuestions as apiGenerateQuestions,
  MODE_LABEL,
  publishReview,
  retractReview,
  saveDraft,
  EMPTY_ANSWERS,
  LENGTH_WORDS,
  SPOILER_LABEL,
  TONE_HINT,
  type Material,
  type ModeState,
  type ReviewAnswers,
  type ReviewMode,
  type ReviewQuestion,
  type ReviewsState,
  type Spoiler,
  type WritingSettings,
} from './reviewsApi'

type Step = 'mode' | 'setup' | 'questions' | 'draft'

const TONES = ['真诚', '克制', '热情', '幽默', '毒舌']
const LENGTHS = ['简短', '中等', '详细']
const SPOILERS: Spoiler[] = ['none', 'aired', 'all']

function defaultSettings(track: Track): WritingSettings {
  return {
    episode: track.status === 'watching' ? track.episode : (track.totalEpisodes ?? track.episode),
    spoiler: 'none',
    tone: '真诚',
    length: '中等',
  }
}

export function ReviewAssistantModal({
  track,
  initialMode,
  onClose,
}: {
  track: Track
  initialMode?: ReviewMode
  onClose: () => void
}): JSX.Element {
  const { user } = useAuth()
  const aiConfig: AiConfig = user?.aiConfig ?? { provider: 'server', endpoint: '', model: '' }
  const title = track.titleCn || track.title

  const [loading, setLoading] = useState(true)
  const [state, setState] = useState<ReviewsState | null>(null)
  const [mode, setMode] = useState<ReviewMode | null>(initialMode ?? null)
  const [step, setStep] = useState<Step>('mode')
  const [settings, setSettings] = useState<WritingSettings>(defaultSettings(track))
  const [questions, setQuestions] = useState<ReviewQuestion[]>([])
  const [answers, setAnswers] = useState<ReviewAnswers>(EMPTY_ANSWERS)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [reconnecting, setReconnecting] = useState<number | null>(null) // 第几次重连中，null=没在重连
  const [savedTick, setSavedTick] = useState(0)

  const material = useRef<Material | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 打开即拉服务端状态：有草稿就直接进对应步骤恢复（跨设备恢复靠这里）。
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const s = await fetchReviewsState(track.bgmId)
        if (!alive) return
        setState(s)
        const pick = initialMode ?? (s.review.draft ? 'review' : s.recommend.draft ? 'recommend' : null)
        if (pick) enterMode(pick, s)
      } catch (err) {
        toast(err instanceof Error ? err.message : '……打不开，等下再试试', { err: true })
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.bgmId])

  function enterMode(m: ReviewMode, s: ReviewsState): void {
    setMode(m)
    const d = s[m].draft
    const c = s[m].content
    if (d) {
      setSettings({ episode: d.episode, spoiler: d.spoiler, tone: d.tone || '真诚', length: d.length || '中等' })
      setQuestions(d.questions)
      setAnswers(d.answers)
      setBody(d.body)
      setStep(d.body ? 'draft' : d.questions.length ? 'questions' : 'setup')
    } else if (c) {
      // 已发布 / 已撤回：进入编辑当前内容（重新提交只覆盖该模式）
      setSettings({ episode: c.episode, spoiler: c.spoiler, tone: c.tone || '真诚', length: c.length || '中等' })
      setBody(c.body)
      setQuestions([])
      setAnswers(EMPTY_ANSWERS)
      setStep('draft')
    } else {
      setSettings(defaultSettings(track))
      setStep('setup')
    }
  }

  // ── 自动保存草稿（防抖）──────────────────────────────────────────────────────
  const saveTimer = useRef<number | undefined>(undefined)
  const scheduleSave = useCallback(
    (patch: Parameters<typeof saveDraft>[2]) => {
      if (!mode) return
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        void saveDraft(track.bgmId, mode, patch)
          .then(() => setSavedTick((t) => t + 1))
          .catch(() => {
            /* 自动保存失败不打断编辑；下次输入会再试 */
          })
      }, 800)
    },
    [mode, track.bgmId],
  )
  useEffect(() => () => window.clearTimeout(saveTimer.current), [])

  const currentContent: ModeState['content'] = mode && state ? state[mode].content : null

  // ── AI 调用（服务器 / BYOK 两条路）────────────────────────────────────────────
  async function ensureMaterial(): Promise<Material> {
    if (material.current) return material.current
    const m = await fetchMaterial(track.bgmId)
    material.current = m
    return m
  }

  function byokKeyOrThrow(): string {
    const key = readByokKey()
    if (!key) throw new Error('你自己的 API key 还没填……去设置里填一下，或者用我这边的')
    return key
  }

  async function runQuestions(): Promise<void> {
    if (!mode) return
    setBusy(true)
    try {
      let qs: ReviewQuestion[]
      if (aiConfig.provider === 'byok') {
        const m = await ensureMaterial()
        qs = await byokQuestions(aiConfig, byokKeyOrThrow(), mode, byokSettings(), {
          material: materialToText(m),
          confirmed: confirmedText(),
        })
      } else {
        const r = await apiGenerateQuestions(track.bgmId, mode, settings)
        qs = r.questions
      }
      // 换了一批问题，旧勾选和逐题补充对不上新选项，清掉。
      const nextAnswers: ReviewAnswers = { picks: {}, custom: {} }
      setQuestions(qs)
      setAnswers(nextAnswers)
      await saveDraft(track.bgmId, mode, { ...settings, questions: qs, answers: nextAnswers })
      setStep('questions')
    } catch (err) {
      toast(err instanceof Error ? err.message : '……没写出来，再让我试一次', { err: true })
    } finally {
      setBusy(false)
    }
  }

  // BYOK 的剧透边界要知道「在追 / 看完」——WritingSettings 本身不带 status，这里从 track 补上。
  function byokSettings(): ByokSettings {
    return { ...settings, status: track.status === 'done' ? 'done' : 'watching' }
  }

  function confirmedText(): string {
    const parts: string[] = []
    // 「看到第 N 集」容易被读成「看完了第 N 集」，模型也确实会这样理解——跟服务器 AI
    // 那边的 progressText() 保持同一套措辞，把边界说死。
    if (track.status === 'watching') {
      const through = settings.episode - 1
      parts.push(
        through >= 1
          ? `观看进度：已看完第 1~${through} 集，正在看第 ${settings.episode} 集（这一集还没看完，不能当成已经看过）`
          : '观看进度：还没看完第 1 集',
      )
    } else {
      parts.push('观看进度：已看完')
    }
    if (track.userTags.length) parts.push(`用户标签：${track.userTags.join('、')}`)
    return parts.join('\n')
  }

  // 选择题的「回答」= 勾选的选项原文 + 这道题下手打的补充
  function qaFromPicks(): { question: string; answer: string }[] {
    return questions
      .map((quest, i) => {
        const parts = [...(answers.picks[String(i)] ?? [])]
        const c = answers.custom[String(i)]?.trim()
        if (c) parts.push(c)
        return { question: quest.q, answer: parts.join('；') }
      })
      .filter((x) => x.answer)
  }

  async function runDraft(): Promise<void> {
    if (!mode) return
    setBusy(true)
    setStreaming(true)
    setReconnecting(null)
    setBody('')
    setStep('draft') // 立刻切到正文步骤，让用户看着字一段段冒出来
    // 闭包里拿不到最新的 body state，用本地累加器
    let acc = ''
    const push = (piece: string): void => {
      acc += piece
      setBody(acc)
      setReconnecting(null) // 又有字了 = 重连成功
    }
    const onRetry = (attempt: number): void => setReconnecting(attempt)
    try {
      // 先把当前勾选和补充落库，避免防抖没来得及保存就生成
      await saveDraft(track.bgmId, mode, { ...settings, questions, answers })
      let truncated = false
      if (aiConfig.provider === 'byok') {
        const m = await ensureMaterial()
        const r = await byokDraftStream(
          aiConfig,
          byokKeyOrThrow(),
          mode,
          byokSettings(),
          { material: materialToText(m), confirmed: confirmedText() },
          qaFromPicks(),
          (n) => (n.t === 'delta' ? push(n.v) : onRetry(n.attempt)),
        )
        acc = r.text || acc
        truncated = r.truncated
        setBody(acc)
        await saveDraft(track.bgmId, mode, { ...settings, body: acc })
      } else {
        const r = await apiGenerateDraftStream(track.bgmId, mode, settings, { onDelta: push, onRetry })
        acc = r.body || acc
        truncated = r.truncated
        setBody(acc)
        // 服务端流结束时已落库，这里不再重复 saveDraft
      }
      if (truncated) toast('网络太抖，写到一半就断了……这是已有的部分，你接着改', { err: true })
    } catch (err) {
      toast(err instanceof Error ? err.message : '……没写出来，再让我试一次', { err: true })
      // 一个字都没有就退回问题步骤；有半截就留在正文让用户改
      if (!acc) setStep(questions.length ? 'questions' : 'setup')
    } finally {
      setReconnecting(null)
      setStreaming(false)
      setBusy(false)
    }
  }

  // ── 操作 ────────────────────────────────────────────────────────────────────
  async function onSaveDraft(): Promise<void> {
    if (!mode) return
    window.clearTimeout(saveTimer.current)
    setBusy(true)
    try {
      await saveDraft(track.bgmId, mode, { ...settings, questions, answers, body })
      toast('存好了，别弄丢')
      onClose()
    } catch (err) {
      toast(err instanceof Error ? err.message : '没存上……再试一次', { err: true })
    } finally {
      setBusy(false)
    }
  }

  const [confirmPublish, setConfirmPublish] = useState(false)
  async function onPublish(): Promise<void> {
    if (!mode) return
    if (!body.trim()) {
      toast('还什么都没写呢', { err: true })
      return
    }
    setBusy(true)
    try {
      const next = await publishReview(track.bgmId, mode, {
        ...settings,
        body,
        tagsShown: track.userTags.slice(0, 5),
      })
      setState((s) => (s && mode ? { ...s, [mode]: next } : s))
      toast(user?.tracksPublic ? '发出去了……哼，别紧张' : '发出去了')
      onClose()
    } catch (err) {
      toast(err instanceof Error ? err.message : '没发出去……再试一次', { err: true })
    } finally {
      setBusy(false)
      setConfirmPublish(false)
    }
  }

  async function onRetract(): Promise<void> {
    if (!mode) return
    setBusy(true)
    try {
      const next = await retractReview(track.bgmId, mode)
      setState((s) => (s && mode ? { ...s, [mode]: next } : s))
      toast('收回来了')
    } catch (err) {
      toast(err instanceof Error ? err.message : '没收回来……再试一次', { err: true })
    } finally {
      setBusy(false)
    }
  }

  async function onDeleteDraft(): Promise<void> {
    if (!mode) return
    setBusy(true)
    try {
      const next = await deleteReview(track.bgmId, mode, 'draft')
      setState((s) => (s && mode ? { ...s, [mode]: next } : s))
      toast('扔掉了')
      onClose()
    } catch (err) {
      toast(err instanceof Error ? err.message : '没删掉……再试一次', { err: true })
    } finally {
      setBusy(false)
    }
  }

  function onCopy(): void {
    void navigator.clipboard
      .writeText(body)
      .then(() => toast('复制好了'))
      .catch(() => toast('没复制上……自己选一下吧', { err: true }))
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────────
  const hasDraftForOtherMode = useMemo(() => {
    if (!state) return null
    const other: ReviewMode = mode === 'review' ? 'recommend' : 'review'
    return state[other].draft ? other : null
  }, [state, mode])

  return (
    <div
      className="dlg-backdrop open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="写点评" className="dlg" style={{ maxWidth: 560 }}>
        <span className="tape tl teal" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭">
          <Ic name="x" cls="ic" />
        </button>

        <h3 className="dlg-title">{title}</h3>
        <p className="dlg-sub">
          {mode ? MODE_LABEL[mode] : '点评还是推荐，写哪个都随你'}
          {track.status === 'watching' ? ` · 看到第 ${settings.episode} 话` : ' · 已经看完了'}
        </p>

        {loading ? (
          <div className="page-state">
            <Spinner size={28} />
          </div>
        ) : step === 'mode' ? (
          <ModeStep
            state={state}
            onPick={(m) => {
              if (state) enterMode(m, state)
            }}
          />
        ) : step === 'setup' ? (
          <SetupStep
            track={track}
            settings={settings}
            onChange={(s) => setSettings(s)}
            busy={busy}
            onNext={runQuestions}
          />
        ) : step === 'questions' ? (
          <QuestionsStep
            questions={questions}
            answers={answers}
            busy={busy}
            onChange={(next) => {
              setAnswers(next)
              scheduleSave({ ...settings, questions, answers: next })
            }}
            onRegenQuestions={runQuestions}
            onGenerate={runDraft}
            onBack={() => setStep('setup')}
          />
        ) : (
          <DraftStep
            body={body}
            busy={busy}
            streaming={streaming}
            reconnecting={reconnecting}
            savedTick={savedTick}
            hasContent={!!currentContent?.published}
            hasQuestions={questions.length > 0}
            onBody={(v) => {
              setBody(v)
              scheduleSave({ ...settings, questions, answers, body: v })
            }}
            onRegen={runDraft}
            onBackToQuestions={() => setStep('questions')}
            onSaveDraft={onSaveDraft}
            onPublish={() => setConfirmPublish(true)}
            onRetract={onRetract}
            onCopy={onCopy}
            onDeleteDraft={onDeleteDraft}
          />
        )}

        {hasDraftForOtherMode && step !== 'mode' && (
          <p className="faint small mt8">
            「{MODE_LABEL[hasDraftForOtherMode]}」那边还有一份没写完呢{' '}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => state && enterMode(hasDraftForOtherMode, state)}
            >
              去看看
            </button>
          </p>
        )}

        {confirmPublish && (
          <div className="dlg-backdrop open" onMouseDown={(e) => e.target === e.currentTarget && setConfirmPublish(false)}>
            <div role="dialog" aria-modal="true" className="dlg" style={{ maxWidth: 380 }}>
              <span className="tape tl sakura" />
              <h3 className="dlg-title">真的要发出去了？</h3>
              <p className="dlg-sub">
                {user?.tracksPublic
                  ? '哼……你的手帐是摊开的，发出去同好就看得到了，到时候别脸红。'
                  : '现在只有你自己看得到。想让别人也看到，去设置里公开追番。'}
              </p>
              <div className="dlg-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setConfirmPublish(false)}>
                  再想想
                </button>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={onPublish}>
                  发
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}

function ModeStep({
  state,
  onPick,
}: {
  state: ReviewsState | null
  onPick: (m: ReviewMode) => void
}): JSX.Element {
  const tag = (m: ReviewMode): string => {
    const s = state?.[m]
    if (s?.content?.published) return '已经发出去了'
    if (s?.content) return '收回来了'
    if (s?.draft) return '写了一半'
    return ''
  }
  return (
    <div className="mode-pick" style={{ display: 'grid', gap: 12, marginTop: 8 }}>
      <p className="faint small">哼，想写就写吧。两种都写也可以，我又不拦你。</p>
      {(['review', 'recommend'] as ReviewMode[]).map((m) => (
        <button key={m} type="button" className="btn btn-ghost" style={{ justifyContent: 'space-between' }} onClick={() => onPick(m)}>
          <span>{MODE_LABEL[m]}</span>
          {tag(m) && <span className="faint small">{tag(m)}</span>}
        </button>
      ))}
    </div>
  )
}

function Seg<T extends string>({
  label,
  value,
  options,
  render,
  hint,
  onChange,
}: {
  label: string
  value: T
  options: readonly T[]
  render?: (v: T) => string
  /** 选项本身放不下「大致意思」，这行放当前选中项的说明，跟着选择变 */
  hint?: string
  onChange: (v: T) => void
}): JSX.Element {
  return (
    <div className="field mb16">
      <span className="field-label">{label}</span>
      <div className="status-seg" style={{ marginLeft: 0, flexWrap: 'wrap' }} role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            className={`seg-btn${value === o ? ' on' : ''}`}
            aria-pressed={value === o}
            onClick={() => onChange(o)}
          >
            {render ? render(o) : o}
          </button>
        ))}
      </div>
      {hint && (
        <p className="faint small mt8" aria-live="polite">
          {hint}
        </p>
      )}
    </div>
  )
}

function lengthHint(length: string): string {
  return `约 ${LENGTH_WORDS[length] ?? LENGTH_WORDS['中等']}`
}

/** 剧透边界跟发帖人自己的观看进度走，不是这部番客观播出到第几集——跟 server/ai.ts 的
 * spoilerInstruction() 同一套语义，这里只是把它翻成一句人话显示在设置项下面。 */
function spoilerHint(settings: WritingSettings, track: Track): string {
  if (settings.spoiler === 'none') return '完全不剧透，只写感受'
  if (settings.spoiler === 'all') return '连这部作品还没动画化的内容也能剧透'
  if (track.status === 'done') return '这部作品播出的内容都能剧透，后续季不算在内'
  const safe = settings.episode - 1
  return safe >= 1
    ? `只剧透到第 ${safe} 集为止，第 ${settings.episode} 集开始不剧透`
    : '还没看完第 1 集，暂时没有能剧透的地方'
}

function SetupStep({
  track,
  settings,
  onChange,
  busy,
  onNext,
}: {
  track: Track
  settings: WritingSettings
  onChange: (s: WritingSettings) => void
  busy: boolean
  onNext: () => void
}): JSX.Element {
  return (
    <>
      {/* 在追时进度直接取追番卡上的集数（顶部副标题已显示「看到第 N 话」），不再让用户在这里
          重选一遍——追番卡才是进度的唯一来源，改进度去卡片上改。 */}
      <Seg
        label="语气"
        value={settings.tone}
        options={TONES}
        hint={TONE_HINT[settings.tone]}
        onChange={(v) => onChange({ ...settings, tone: v })}
      />
      <Seg
        label="篇幅"
        value={settings.length}
        options={LENGTHS}
        hint={lengthHint(settings.length)}
        onChange={(v) => onChange({ ...settings, length: v })}
      />
      <Seg
        label="剧透范围"
        value={settings.spoiler}
        options={SPOILERS}
        render={(v) => SPOILER_LABEL[v]}
        hint={spoilerHint(settings, track)}
        onChange={(v) => onChange({ ...settings, spoiler: v })}
      />
      <div className="dlg-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onNext}>
          {busy ? <Spinner size={12} /> : <Ic name="edit" cls="ic ic-sm" />}
          让我问你几个问题
        </button>
      </div>
    </>
  )
}

function QuestionsStep({
  questions,
  answers,
  busy,
  onChange,
  onRegenQuestions,
  onGenerate,
  onBack,
}: {
  questions: ReviewQuestion[]
  answers: ReviewAnswers
  busy: boolean
  onChange: (next: ReviewAnswers) => void
  onRegenQuestions: () => void
  onGenerate: () => void
  onBack: () => void
}): JSX.Element {
  const toggle = (qi: number, opt: string, multi: boolean): void => {
    const key = String(qi)
    const cur = answers.picks[key] ?? []
    let next: string[]
    if (multi) next = cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt]
    else next = cur.includes(opt) ? [] : [opt]
    const picks = { ...answers.picks }
    if (next.length) picks[key] = next
    else delete picks[key]
    onChange({ ...answers, picks })
  }
  const setCustom = (qi: number, v: string): void => {
    const custom = { ...answers.custom }
    if (v.trim()) custom[String(qi)] = v.slice(0, 300)
    else delete custom[String(qi)]
    onChange({ ...answers, custom })
  }
  const hasAny = (i: number): boolean =>
    (answers.picks[String(i)] ?? []).length > 0 || !!answers.custom[String(i)]?.trim()
  const answeredCount = questions.filter((_, i) => hasAny(i)).length

  return (
    <>
      <p className="faint small" style={{ marginTop: 8 }}>
        挑几个符合你想法的就行，能多选的题可以多选；选项不对味就在下面那行自己补一句
      </p>
      <div style={{ display: 'grid', gap: 16, marginTop: 10, maxHeight: '46vh', overflowY: 'auto', paddingRight: 4 }}>
        {questions.map((quest, i) => {
          const picked = answers.picks[String(i)] ?? []
          const custom = answers.custom[String(i)] ?? ''
          return (
            <div key={i} className="field">
              <span className="field-label" style={{ whiteSpace: 'normal' }}>
                {i + 1}. {quest.q}
                {quest.multi && <span className="faint"> · 可多选</span>}
              </span>
              <div className="tagx-row" style={{ marginTop: 4 }}>
                {quest.options.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    className={`tagx tagx-opt${picked.includes(opt) ? ' mine' : ''}`}
                    style={{ cursor: 'pointer' }}
                    aria-pressed={picked.includes(opt)}
                    onClick={() => toggle(i, opt, quest.multi)}
                  >
                    {opt}
                  </button>
                ))}
              </div>
              <input
                className="tagx-input"
                style={{ marginTop: 6, width: '100%', borderStyle: 'dashed' }}
                value={custom}
                onChange={(e) => setCustom(i, e.target.value)}
                placeholder="选项没说到的，自己补一句（可留空）"
                spellCheck={false}
              />
            </div>
          )
        })}
      </div>
      <div className="dlg-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack} disabled={busy}>
          回上一步
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRegenQuestions} disabled={busy}>
          换几个问题
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onGenerate}
          disabled={busy || answeredCount === 0}
        >
          {busy ? <Spinner size={12} /> : <Ic name="edit" cls="ic ic-sm" />}
          照这些写一版
        </button>
      </div>
    </>
  )
}

function DraftStep({
  body,
  busy,
  streaming,
  reconnecting,
  savedTick,
  hasContent,
  hasQuestions,
  onBody,
  onRegen,
  onBackToQuestions,
  onSaveDraft,
  onPublish,
  onRetract,
  onCopy,
  onDeleteDraft,
}: {
  body: string
  busy: boolean
  streaming: boolean
  reconnecting: number | null
  savedTick: number
  hasContent: boolean
  hasQuestions: boolean
  onBody: (v: string) => void
  onRegen: () => void
  onBackToQuestions: () => void
  onSaveDraft: () => void
  onPublish: () => void
  onRetract: () => void
  onCopy: () => void
  onDeleteDraft: () => void
}): JSX.Element {
  // 生成时把 textarea 滚到底，跟着新字走
  const taRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (streaming && taRef.current) taRef.current.scrollTop = taRef.current.scrollHeight
  }, [body, streaming])

  return (
    <>
      <div className="field" style={{ position: 'relative' }}>
        <span className="field-label">
          正文
          {/* 生成中 / 已保存 都绝对定位浮在旁边，不插进流里挤动布局 */}
          {streaming ? (
            <span className="faint small" style={{ position: 'absolute', right: 0, top: 0 }}>
              {reconnecting ? `网络抖了下，重连中…（第 ${reconnecting} 次）` : '正在写……'}
            </span>
          ) : (
            savedTick > 0 && (
              <span className="faint small" style={{ position: 'absolute', right: 0, top: 0 }}>
                ……存好了
              </span>
            )
          )}
        </span>
        <textarea
          ref={taRef}
          value={body}
          onChange={(e) => onBody(e.target.value.slice(0, 4000))}
          rows={9}
          readOnly={streaming}
          placeholder={streaming ? '' : '我写得不好的话，你自己改就是了……哼'}
          style={{ width: '100%', resize: 'vertical', opacity: streaming ? 0.75 : 1 }}
        />
      </div>
      <div className="dlg-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
        {hasQuestions && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onBackToQuestions} disabled={busy}>
            改改选项
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRegen} disabled={busy}>
          {streaming ? '写着呢…' : '重写一版'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCopy} disabled={!body.trim() || streaming}>
          复制
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDeleteDraft} disabled={busy}>
          扔掉草稿
        </button>
        <button type="button" className="btn btn-ghost" onClick={onSaveDraft} disabled={busy}>
          先存着
        </button>
        {hasContent && (
          <button type="button" className="btn btn-ghost" onClick={onRetract} disabled={busy}>
            收回来
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={onPublish} disabled={busy || !body.trim()}>
          <Ic name="check" cls="ic ic-sm" />
          发出去
        </button>
      </div>
    </>
  )
}
