// 「继续看」的两个弹窗，对所有在线源通用（源差异全部收在 api.ts 的 OnlineSource 适配器里）。
//
// - SourceBindPickerModal：首次继续看时弹，把周表里名字相近的候选列出来让用户点一个确认
//   （= 建绑定）。**不自动认**（跟 app「绝不模糊匹配自动绑源」同一条原则）。
// - SourceSearchModal：周表定位没命中（旧番 / 剧场版 / 名字对不齐）时弹的全站搜索。搜索页有
//   站点验证码，流程与桌面端一致：搜索 → 验证码 → 重搜 → 点结果确认绑定。
//
// 两个弹窗的候选 / 结果行都保留原生 <a>：点一下同时完成绑定并在用户手势内打开新标签，
// 不让异步绑定请求吃掉浏览器的弹窗手势。href 按 mode 在「我们的播放页 / 源站站内页」间切。
import { useEffect, useRef, useState } from 'react'
import type { OnlineSource, SourceCandidate, SourceId, SourceSearchHit, Track, WatchMode } from '../api'
import { Ic, Spinner } from '../SketchIcon'
import { SHORT_DAY, watchEp } from './common'

export interface PickerFlow {
  source: SourceId
  track: Track
  candidates: SourceCandidate[]
  mode: WatchMode
}

export interface SearchFlow {
  source: SourceId
  track: Track
  mode: WatchMode
}

function linkFor(source: OnlineSource, mode: WatchMode, id: string, ep: number, bgmId: number): string {
  return mode === 'source' ? source.sourcePageUrl(id, ep) : source.playPageUrl(id, ep, bgmId)
}

export function SourceBindPickerModal({
  source,
  flow,
  onPick,
  onSearch,
  onClose,
}: {
  source: OnlineSource
  flow: PickerFlow
  onPick: (cand: SourceCandidate) => void
  onSearch: () => void
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const { track, candidates, mode } = flow
  const title = track.titleCn || track.title
  const ep = watchEp(track)

  return (
    <div
      className="dlg-backdrop open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={`选择${source.label}片源`} className="dlg">
        <span className="tape tl teal" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭">
          <Ic name="x" cls="ic" />
        </button>

        <h3 className="dlg-title">{title}</h3>
        <p className="dlg-sub">
          {source.label}用的是另一套编号，纱雾按名字挑出了这几部。<b>点一下告诉我是哪部</b>，之后就记住、
          {mode === 'source' ? '直接送你去源站' : '直接开播'}（EP {ep}）。
        </p>

        {/* candidates 必非空：零候选由上层直接落到搜索弹窗，不会走到这里 */}
        <div className="cand-list custom-scrollbar">
          {candidates.map((c) => (
            <a
              key={c.id}
              className="sugg-item"
              href={linkFor(source, mode, c.id, ep, track.bgmId)}
              target="_blank"
              rel="noreferrer"
              onClick={() => onPick(c)}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {c.name || `${source.label} #${c.id}`}
              </span>
              <span className="sugg-meta">
                {c.day ? `周${SHORT_DAY[c.day]}` : ''}
                {c.remarks ? `${c.day ? ' · ' : ''}${c.remarks.replace('|', ' · ')}` : ''}
              </span>
              <Ic name="play" cls="ic ic-sm" />
            </a>
          ))}
        </div>

        <button className="btn btn-sm btn-ghost btn-block mt16" type="button" onClick={onSearch}>
          <Ic name="search" cls="ic ic-sm" />
          搜索{source.label}全站资源
        </button>
      </div>
    </div>
  )
}

type SearchStatus = 'searching' | 'captcha' | 'verifying' | 'results' | 'error'

export function SourceSearchModal({
  source,
  flow,
  onPick,
  onClose,
}: {
  source: OnlineSource
  flow: SearchFlow
  onPick: (hit: SourceSearchHit) => void
  onClose: () => void
}): JSX.Element {
  const { track, mode } = flow
  const initialKeyword = track.titleCn || track.title
  const [keyword, setKeyword] = useState(initialKeyword)
  const [status, setStatus] = useState<SearchStatus>('searching')
  const [results, setResults] = useState<SourceSearchHit[]>([])
  const [imageB64, setImageB64] = useState('')
  const [mime, setMime] = useState('image/png')
  const [captchaInput, setCaptchaInput] = useState('')
  const [message, setMessage] = useState('')
  const started = useRef(false)
  // 代次守卫 —— 慢到的验证码 / 校验响应不能覆盖新一轮的状态（稀饭跨标签作废会 bump 代次）。
  const captchaGeneration = useRef(0)
  const captchaActive = useRef(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 稀饭：另一个标签取了新验证码图 → 本标签这张作废（Girigiri 没有这套会话联动，captchaEventKey 为空）。
  useEffect(() => {
    const eventKey = source.captchaEventKey
    if (!eventKey) return
    const onStorage = (event: StorageEvent): void => {
      if (
        event.key !== eventKey
        || (!captchaActive.current && status !== 'captcha' && status !== 'verifying')
      ) return
      captchaGeneration.current += 1
      captchaActive.current = false
      setImageB64('')
      setCaptchaInput('')
      setMessage('验证码已在其他页面刷新，请重新获取')
      setStatus('captcha')
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [status, source])

  const refreshCaptcha = async (errorMessage = ''): Promise<void> => {
    const generation = ++captchaGeneration.current
    captchaActive.current = true
    setImageB64('')
    setCaptchaInput('')
    setStatus('captcha')
    try {
      const captcha = await source.fetchCaptcha()
      if (generation !== captchaGeneration.current) return
      setImageB64(captcha.imageB64)
      setMime(captcha.mime || 'image/png')
      setCaptchaInput('')
      setMessage(errorMessage)
      setStatus('captcha')
    } catch (e) {
      if (generation !== captchaGeneration.current) return
      setStatus('error')
      setMessage(e instanceof Error ? e.message : '验证码请求失败')
    } finally {
      if (generation === captchaGeneration.current) captchaActive.current = false
    }
  }

  const runSearch = async (rawKeyword: string): Promise<void> => {
    const q = rawKeyword.trim()
    if (!q) return
    setKeyword(q)
    setResults([])
    setMessage('')
    setStatus('searching')
    try {
      const result = await source.search(q)
      if (result.needsCaptcha) {
        await refreshCaptcha()
      } else {
        setResults(result.data)
        setStatus('results')
      }
    } catch (e) {
      setStatus('error')
      setMessage(e instanceof Error ? e.message : `${source.label}搜索失败`)
    }
  }

  useEffect(() => {
    if (started.current) return
    started.current = true
    void runSearch(initialKeyword)
  }, [])

  const verify = async (): Promise<void> => {
    const code = captchaInput.trim()
    if (!code || status !== 'captcha') return
    setStatus('verifying')
    const generation = captchaGeneration.current
    try {
      const result = await source.verifyCaptcha(code)
      if (generation !== captchaGeneration.current) return
      if (!result.success) {
        await refreshCaptcha('验证码不正确，请重新输入')
        return
      }
      await runSearch(keyword)
    } catch (e) {
      setStatus('error')
      setMessage(e instanceof Error ? e.message : '验证码校验失败')
    }
  }

  const title = track.titleCn || track.title
  const ep = watchEp(track)

  return (
    <div
      className="dlg-backdrop open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${source.label}全站搜索`}
        className="dlg"
        style={{ display: 'flex', flexDirection: 'column', maxHeight: '86vh' }}
      >
        <span className="tape tl teal" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭">
          <Ic name="x" cls="ic" />
        </button>

        <h3 className="dlg-title">{source.label}全站搜索</h3>
        <p className="dlg-sub">
          {title} · 点选正确条目后直接播放 EP {ep}
        </p>

        <div className="field-row mb16">
          <input
            value={keyword}
            spellCheck={false}
            autoComplete="off"
            maxLength={100}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void runSearch(keyword)
            }}
            placeholder="番名 / 别名"
            disabled={status === 'searching' || status === 'verifying'}
          />
          <button
            className="btn btn-sm btn-primary"
            style={{ flex: 'none', marginLeft: 8 }}
            type="button"
            onClick={() => { void runSearch(keyword) }}
            disabled={status === 'searching' || status === 'verifying' || !keyword.trim()}
          >
            <Ic name="search" cls="ic ic-sm" />
            搜索
          </button>
        </div>

        <div className="dlg-scroll custom-scrollbar">
          {status === 'searching' || status === 'verifying' ? (
            <div className="page-state" style={{ padding: '48px 12px' }}>
              <Spinner size={28} />
              <span className="faint small">{status === 'verifying' ? '正在校验验证码' : `正在搜索${source.label}`}</span>
            </div>
          ) : status === 'captcha' ? (
            <div>
              <div className="row mb16" style={{ justifyContent: 'space-between' }}>
                <div>
                  <b>需要验证码</b>
                  <p className="faint small mt8">输入图片中的字符后继续搜索。</p>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  style={{ width: 34, height: 34 }}
                  onClick={() => { void refreshCaptcha() }}
                  title="刷新验证码"
                  aria-label="刷新验证码"
                >
                  <Ic name="refresh" cls="ic ic-sm" />
                </button>
              </div>
              <div className="captcha-img mb16">
                {imageB64 && <img src={`data:${mime};base64,${imageB64}`} alt={`${source.label}验证码`} />}
              </div>
              {message && <p className="form-note err" style={{ marginTop: 0 }}>{message}</p>}
              <div className="field-row">
                <input
                  type="text"
                  autoFocus
                  disabled={!imageB64}
                  value={captchaInput}
                  onChange={(e) => setCaptchaInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && captchaInput.trim()) void verify()
                  }}
                  placeholder="输入验证码"
                  style={{ letterSpacing: '.2em' }}
                />
                <button
                  className="btn btn-sm btn-primary"
                  style={{ flex: 'none', marginLeft: 8 }}
                  type="button"
                  onClick={() => { void verify() }}
                  disabled={!imageB64 || !captchaInput.trim()}
                >
                  验证
                </button>
              </div>
            </div>
          ) : status === 'error' ? (
            <div className="page-state" style={{ padding: '48px 12px' }}>
              <Ic name="alert" cls="ic" />
              <p className="small" style={{ color: 'var(--sakura)', maxWidth: 360 }}>{message || `${source.label}搜索失败`}</p>
              <button className="btn btn-sm" type="button" onClick={() => { void runSearch(keyword) }}>
                <Ic name="refresh" cls="ic ic-sm" />
                再试一次
              </button>
            </div>
          ) : results.length === 0 ? (
            <div className="page-state" style={{ padding: '48px 12px' }}>
              <Ic name="search" cls="ic" />
              <p className="small">没有找到“{keyword}”相关的{source.label}资源</p>
              <p className="faint small">换一个中文名、别名或关键词再搜。</p>
            </div>
          ) : (
            <div>
              <p className="field-label mb16">搜索结果 · {results.length} 部</p>
              <div className="cand-list custom-scrollbar" style={{ maxHeight: '45vh' }}>
                {results.map((hit) => {
                  const meta = [hit.episode, hit.year, hit.area].filter(Boolean).join(' · ')
                  return (
                    <a
                      key={hit.id}
                      className="sugg-item"
                      href={linkFor(source, mode, hit.id, ep, track.bgmId)}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => onPick(hit)}
                    >
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {hit.name}
                      </span>
                      {meta && <span className="sugg-meta">{meta}</span>}
                      <Ic name="play" cls="ic ic-sm" />
                    </a>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
