// 跳转按钮组:列出这部番已绑定的源,点一个就在外部浏览器打开对应详情页。
//
// **不为每个源去算「下一集」的具体播放页 URL** —— 那要把 watchInfo 全量抓一遍,重得离谱。
// 直接开源站详情页,让用户在那儿自己选集;chip 上的 "ep N" 用来提醒进度。
// 没有任何绑定时返回 null,由父组件决定要不要显示「先去关联」。
//
// 三个变种:`row` 横向 chips(详情页左栏)、`inline` 紧凑横排(追番行尾)、
// `play-menu` 单个「▶ 播放」按钮(周历卡 hover 遮罩)—— 遮罩空间小,平铺最多 4 个源会溢出卡片
// 所以改成单按钮:1 个源直接打开,≥2 个源弹窗挑选,这样无论几个源遮罩高度都恒定。

import { useEffect, useRef, useState } from 'react'
import type { AnimeBinding, AnimeTrack } from '../stores/animeTrackStore'
import { animeTrackStore, useAnimeTrack } from '../stores/animeTrackStore'

interface Props {
  bgmId: number
  variant?: 'row' | 'inline' | 'play-menu'
  /** 为 true 时显示「还没关联」的占位,而不是返回 null。 */
  showEmpty?: boolean
}

export function WatchHere({ bgmId, variant = 'row', showEmpty = false }: Props): JSX.Element | null {
  const track = useAnimeTrack(bgmId)
  useAowuShareUrlBackfill(bgmId, track)
  if (!track || track.bindings.length === 0) {
    return showEmpty ? <EmptyPlaceholder /> : null
  }
  // 周历遮罩：单按钮 + 多源弹窗，详见 PlayMenu。
  if (variant === 'play-menu') {
    return <PlayMenu bindings={track.bindings} />
  }
  return (
    <div className={variant === 'inline'
      ? 'inline-flex flex-wrap items-center gap-1.5'
      : 'flex flex-wrap items-center gap-2'}
    >
      {track.bindings.map((b, i) => (
        <SourceButton
          key={`${b.source}-${i}`}
          binding={b}
          variant={variant}
        />
      ))}
    </div>
  )
}

// ── Play menu (周历卡 hover 遮罩) ──────────────────────────────────────────────

/**
 * 单个「▶ 播放」按钮。1 个源直接 window.open(主进程会转成外部浏览器打开);≥2 个源弹居中弹窗。
 * 弹窗是 fixed 的顶层独立图层,与 hover 遮罩物理隔离 —— 否则鼠标一离开卡片遮罩消失,弹窗就点不着了。
 */
function PlayMenu({ bindings }: { bindings: AnimeBinding[] }): JSX.Element {
  const [picking, setPicking] = useState(false)
  const multi = bindings.length > 1

  const handleClick = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (multi) {
      setPicking(true)
    } else {
      const url = resolveUrl(bindings[0])
      if (url) window.open(url, '_blank', 'noreferrer')
    }
  }

  return (
    <>
      <button
        onClick={handleClick}
        title={multi ? `${bindings.length} 个播放源，点击挑选` : `播放 · ${chipLabel(bindings[0])}`}
        className="w-full text-[10px] font-label tracking-widest uppercase py-1.5 rounded-md flex items-center justify-center gap-1 bg-primary hover:bg-primary/90 text-on-primary border border-primary transition-colors"
      >
        <span className="material-symbols-outlined leading-none" style={{ fontSize: 12, fontVariationSettings: "'FILL' 1" }}>play_arrow</span>
        <span>播放{multi ? ` · ${bindings.length}` : ''}</span>
      </button>
      {picking && <SourcePicker bindings={bindings} onClose={() => setPicking(false)} />}
    </>
  )
}

function SourcePicker({ bindings, onClose }: { bindings: AnimeBinding[]; onClose: () => void }): JSX.Element {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { e.stopPropagation(); onClose() }}
    >
      <div
        className="w-72 max-w-[90vw] bg-surface-container-high rounded-2xl border border-outline-variant/20 p-4 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-1.5 mb-3 text-on-surface">
          <span className="material-symbols-outlined leading-none text-primary" style={{ fontSize: 18 }}>play_circle</span>
          <span className="font-label text-sm font-bold">选择播放源</span>
        </div>
        <div className="flex flex-col gap-2">
          {bindings.map((b, i) => (
            <a
              key={`${b.source}-${i}`}
              href={resolveUrl(b)}
              target="_blank"
              rel="noreferrer"
              onClick={() => onClose()}
              title={`${chipLabel(b)} · ${b.sourceTitle || ''}`}
              className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-primary/10 hover:bg-primary/20 border border-primary/25 hover:border-primary/45 text-primary font-label text-xs font-bold tracking-wider transition-colors"
            >
              <span className="material-symbols-outlined leading-none" style={{ fontSize: 16 }}>play_arrow</span>
              <span className="truncate">{chipLabel(b)}</span>
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * 懒迁移:早期创建的 Aowu 绑定只存了合成的 /v/{id},没有 sourceUrl。首次渲染到这类绑定时
 * 按 (bgmId, sourceKey) 静默调一次 resolveShareUrl 把它补成 /w/{token} 并写回 store。
 * `attemptedRef` 保证同一会话内失败(如断网)不重试,下次启动应用再试。
 * 补完后 chip 的链接就落在真正的观看页;因为是走 store.subscribe 更新,不会闪。
 */
const attemptedAowuBackfill = new Set<string>()

function useAowuShareUrlBackfill(bgmId: number, track: AnimeTrack | null): void {
  const attemptedRef = useRef(false)
  useEffect(() => {
    if (attemptedRef.current) return
    if (!track) return
    const needsFix = track.bindings.filter(b =>
      b.source === 'Aowu' && !b.sourceUrl && /\/v\/\d+/.test(b.sourceKey)
    )
    if (needsFix.length === 0) return
    attemptedRef.current = true

    for (const b of needsFix) {
      const guardKey = `${bgmId}:${b.sourceKey}`
      if (attemptedAowuBackfill.has(guardKey)) continue
      attemptedAowuBackfill.add(guardKey)
      void window.aowuApi.resolveShareUrl(b.sourceKey)
        .then(url => {
          if (url) animeTrackStore.setBindingSourceUrl(bgmId, b.source, b.sourceKey, url)
        })
        .catch(err => {
          // 本次会话就让它保持原样,下次启动再试。记日志便于排查,但不弹 toast 打扰用户。
          console.warn(`[WatchHere] aowu sourceUrl backfill failed for ${b.sourceKey}:`, err)
        })
    }
  }, [bgmId, track])
}

/**
 * chip 的显示名。内置抓取源统一用源名(Bilibili 现在也是搜索关联出来的内置源,不再显示挑中
 * 的那条视频标题——那个标题在 tooltip 里还看得到);只有 Custom 才用用户自己填的
 * `sourceTitle`,因为光显示一个「Custom」在界面上毫无意义。
 */
function chipLabel(b: AnimeBinding): string {
  if (b.source === 'Custom') return b.sourceTitle || '自定义'
  if (b.source === 'Bilibili') return 'B 站'
  return b.source
}

// ── Per-source button ───────────────────────────────────────────────────────

function SourceButton({
  binding, variant,
}: {
  binding: AnimeBinding
  variant: 'row' | 'inline'
}): JSX.Element {
  // Prefer the explicit sourceUrl when provided; fall back to the per-source
  // 内置三源的 sourceKey 本身就是观看页 URL。
  const url = resolveUrl(binding)
  // Chip 不再挂 ep 进度信息。所有源（内置三源 + 用户加的 Bilibili / Custom）
  // 点击跳转的都是**番剧主页**，永远不会自动定位到 ep N 的播放页 ——
  // 在 chip 上挂"ep 16/23"会让用户误以为点了能直接跳到第 16 集播放，
  // 是错的预期。进度显示统一交给 MyAnime 行里的 EpisodeCounter（那里才有
  // 编辑能力 + ±1 按钮），chip 自己只做"打开源"这一件事。
  const label = chipLabel(binding)

  // Chip 永远是纯跳转 <a>，没有删除按钮。删除入口集中在 MyAnime 的
  // EditBindingsModal 里（点行尾「编辑」按钮打开），物理隔离避免误删。
  if (variant === 'inline') {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={`${label} · ${binding.sourceTitle || ''}\n${url}`}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-primary/30 bg-primary/8 hover:bg-primary/15 text-primary font-label text-[10px] tracking-wider transition-colors"
      >
        <span className="material-symbols-outlined leading-none" style={{ fontSize: 11 }}>play_arrow</span>
        <span className="font-bold">{label}</span>
      </a>
    )
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`${binding.sourceTitle || label}\n${url}`}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/25 bg-primary/8 hover:bg-primary/15 hover:border-primary/45 text-primary font-label text-[11px] uppercase tracking-widest transition-colors"
    >
      <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>play_arrow</span>
      <span className="font-bold">{label}</span>
    </a>
  )
}

// ── Placeholder when track has no bindings ───────────────────────────────────

function EmptyPlaceholder(): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-on-surface-variant/40 font-label text-[10px] uppercase tracking-widest">
      <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>link_off</span>
      <span>未关联源 · 去 Search 关联</span>
    </div>
  )
}

// ── URL resolver ─────────────────────────────────────────────────────────────

function resolveUrl(b: AnimeBinding): string {
  if (b.sourceUrl) return b.sourceUrl
  const k = b.sourceKey.trim()
  if (!k) return ''
  // 这些地方写进来的都是完整的 http(s) URL,所以不需要各站的 URL 模板;自定义绑定原样使用,
  // 格式不对交给浏览器报错。
  if (/^https?:\/\//.test(k)) return k
  return k
}
