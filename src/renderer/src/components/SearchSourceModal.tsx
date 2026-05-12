// 补搜其他源弹窗 —— MyAnime「+ 搜 Xifan / + 搜 Girigiri / + 搜 Aowu」入口。
//
// 这里只负责 UI：搜索框 / 加载 / 结果列表 / 验证码。搜索 / 缓存 / 验证码 /
// Aowu 流式 / 请求竞速等业务逻辑全在 useSourceSearch hook 里，和
// SearchDownload 共用同一套实现，行为不会漂移。

import { useState } from 'react'
import { ModalShell } from '../pages/homework/shared'
import type { Source, SearchCard } from '../types/search'
import { useSourceSearch } from '../hooks/useSourceSearch'

interface Props {
  source: Source
  /** 初始关键词，一般传 track.titleCn || track.title。 */
  initialKeyword: string
  /** 头部展示用，让用户知道在为哪部番找。 */
  animeTitle: string
  onClose: () => void
  /** 用户挑了一个结果。调用方根据 source 自己处理（Aowu 要再 resolveShareUrl）。 */
  onConfirm: (card: SearchCard) => void | Promise<void>
}

export function SearchSourceModal({ source, initialKeyword, animeTitle, onClose, onConfirm }: Props): JSX.Element {
  const [keyword, setKeyword] = useState(initialKeyword)
  const [captchaInput, setCaptchaInput] = useState('')
  const [confirming, setConfirming] = useState(false)
  const { state, search, refreshCaptcha, verifyCaptcha } = useSourceSearch(source, {
    initialKeyword,
  })

  // Captcha 切到下一题时清空输入，避免上次的错误码残留
  const handleRefreshCaptcha = async (): Promise<void> => {
    setCaptchaInput('')
    await refreshCaptcha()
  }

  const handleVerify = async (): Promise<void> => {
    const code = captchaInput.trim()
    if (!code) return
    setCaptchaInput('')
    await verifyCaptcha(code)
  }

  const pickCard = async (card: SearchCard): Promise<void> => {
    setConfirming(true)
    try {
      await onConfirm(card)
      // 不在这里 setConfirming(false)：onConfirm 通常会 setSearching(null) 关
      // 父组件的 modal state，本组件直接被卸载。失败时调用方一般 console.warn,
      // 这里走 finally 兜底防止悬挂。
    } catch (err) {
      console.error('[SearchSourceModal] confirm failed:', err)
    } finally {
      setConfirming(false)
    }
  }

  const isBusy =
    state.status === 'searching' ||
    state.status === 'verifying' ||
    confirming

  return (
    <ModalShell onBackdrop={onClose}>
      <div className="flex flex-col max-h-[70vh]">
        {/* Header */}
        <div className="p-5 border-b border-outline-variant/20 bg-surface-container-low">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-headline font-black text-base text-on-surface">
                补绑 {source} 源
              </h3>
              <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest mt-1">
                {animeTitle}
              </p>
              <p className="font-body text-[11px] text-on-surface-variant/60 mt-1.5">
                从 {source} 的搜索结果里挑一个对应条目，绑定后这个源也会出现在「在线观看」chip 里。
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-on-surface-variant/60 hover:text-on-surface transition-colors shrink-0"
            >
              <span className="material-symbols-outlined leading-none">close</span>
            </button>
          </div>
        </div>

        {/* Search box */}
        <div className="p-5 pb-3 shrink-0">
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center bg-surface-container border border-outline-variant/20 rounded-lg px-3.5 py-2.5 gap-2 focus-within:border-primary/40 transition-colors">
              <span className="material-symbols-outlined text-on-surface-variant/40 text-base leading-none">search</span>
              <input
                type="text"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !isBusy) void search(keyword) }}
                placeholder={`${source} 关键词...`}
                autoFocus
                spellCheck={false}
                className="flex-1 bg-transparent outline-none text-sm text-on-surface placeholder:text-on-surface-variant/35"
              />
            </div>
            <button
              onClick={() => void search(keyword)}
              disabled={!keyword.trim() || isBusy}
              className="px-4 py-2.5 rounded-lg bg-primary text-on-primary font-label text-xs font-bold tracking-widest hover:brightness-110 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              搜索
            </button>
          </div>
          {state.status === 'results' && state.fromCache && (
            <p className="mt-1.5 font-label text-[10px] text-on-surface-variant/40">
              来自缓存 · 修改关键词再搜会重新拉取
            </p>
          )}
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-3 pb-5 min-h-[180px]">
          {(state.status === 'searching' || state.status === 'verifying' || confirming) && (
            <div className="flex flex-col items-center justify-center py-10 gap-3">
              <span
                className="material-symbols-outlined text-primary/60 text-3xl animate-spin"
                style={{ animationDuration: '1.2s' }}
              >
                progress_activity
              </span>
              <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest">
                {state.status === 'verifying'
                  ? 'Verifying captcha...'
                  : confirming
                    ? 'Binding...'
                    : `Querying ${source}...`}
              </p>
            </div>
          )}

          {state.status === 'captcha' && (
            <div className="px-2 pt-2 flex flex-col gap-3">
              <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest">
                {source} 需要先过验证码
              </p>
              <img
                src={`data:image/gif;base64,${state.imageB64}`}
                alt="captcha"
                className="w-full max-w-[280px] rounded-lg border border-outline-variant/20"
              />
              <input
                type="text"
                value={captchaInput}
                onChange={(e) => setCaptchaInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && captchaInput.trim()) void handleVerify() }}
                placeholder="输入验证码"
                autoFocus
                className="w-full max-w-[280px] bg-surface-container border border-outline-variant/20 rounded-lg px-3 py-2 text-sm text-on-surface tracking-[0.2em] outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30"
              />
              {state.error && <p className="font-label text-xs text-error">{state.error}</p>}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void handleVerify()}
                  disabled={!captchaInput.trim()}
                  className="px-4 py-2 rounded-lg bg-primary text-on-primary font-label text-xs font-bold tracking-widest hover:brightness-110 disabled:opacity-40"
                >
                  确认
                </button>
                <button
                  onClick={() => void handleRefreshCaptcha()}
                  className="px-3 py-2 rounded-lg border border-outline-variant/20 text-on-surface-variant/70 font-label text-[10px] uppercase tracking-widest hover:bg-surface-container-high transition-colors flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-[14px] leading-none">refresh</span>
                  换一张
                </button>
              </div>
            </div>
          )}

          {state.status === 'empty' && (
            <div className="flex flex-col items-center justify-center py-10 gap-2 text-on-surface-variant/40">
              <span className="material-symbols-outlined text-3xl">search_off</span>
              <p className="font-label text-xs">{source} 里没找到，换关键词试试</p>
            </div>
          )}

          {state.status === 'error' && (
            <div className="flex flex-col items-center justify-center py-10 gap-2 text-error">
              <span className="material-symbols-outlined text-3xl">error_outline</span>
              <p className="font-body text-xs text-on-surface-variant text-center px-6">{state.message}</p>
            </div>
          )}

          {state.status === 'results' && (
            <ul className="space-y-1.5 px-2 pt-1">
              {state.cards.map((card) => (
                <li key={card.key}>
                  <button
                    onClick={() => void pickCard(card)}
                    disabled={confirming}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-lg bg-surface hover:bg-surface-container-highest border border-outline-variant/10 hover:border-primary/30 text-left transition-all group disabled:opacity-50"
                  >
                    {card.cover ? (
                      <img
                        src={card.cover}
                        alt=""
                        className="w-10 aspect-[2/3] object-cover rounded shrink-0 bg-surface-container"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-10 aspect-[2/3] flex items-center justify-center text-on-surface-variant/20 bg-surface-container rounded shrink-0">
                        <span className="material-symbols-outlined text-base">image</span>
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-on-surface text-sm group-hover:text-primary transition-colors truncate">
                        {card.title}
                      </p>
                      <p className="font-label text-[10px] text-on-surface-variant/50 mt-0.5 uppercase tracking-widest">
                        {[card.year, card.tag, card.count].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <span className="material-symbols-outlined text-on-surface-variant/20 group-hover:text-primary/60 transition-colors text-base shrink-0">
                      arrow_forward
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </ModalShell>
  )
}
