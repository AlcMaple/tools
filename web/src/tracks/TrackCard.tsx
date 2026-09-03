import { useEffect, useState } from 'react'
import { SOURCES, coverUrl, type SourceBinding, type SourceId, type Track, type TrackPatch, type TrackStatus, type WatchMode } from '../api'
import { Ic, Spinner } from '../SketchIcon'
import { toast } from '../Toast'
import { SEG_CLS, SEG_ORDER, STAMP_CLS, STATUS_META, USER_TAG_MAX, allTagsOf, tagLimitToast, watchEp } from './common'

// ── 卡片（手帐内页行卡） ───────────────────────────────────────────────────────
export function TrackCard({
  t,
  isToday,
  bound,
  locating,
  onContinue,
  onPatch,
  onStatus,
  onEdit,
  onAskRemove,
  onMarkGood,
  onBackfill,
  onWriteReview,
  onMakePoster,
  posterBusy,
}: {
  t: Track
  isToday: boolean
  bound: Partial<Record<SourceId, SourceBinding>>
  locating: boolean
  onContinue: (source: SourceId, mode: WatchMode, rebind?: boolean) => void
  onPatch: (bgmId: number, p: TrackPatch) => void
  onStatus: (s: TrackStatus) => void
  onEdit: () => void
  onAskRemove: () => void
  onMarkGood: () => void
  onBackfill: () => void
  onWriteReview: () => void
  onMakePoster?: () => void
  posterBusy?: boolean
}): JSX.Element {
  const title = t.titleCn || t.title
  const capped = t.totalEpisodes != null && t.episode >= t.totalEpisodes
  const ep = watchEp(t)
  // 卡片上的行内标签输入（＋ 标签 → 回车贴上）
  const [addingTag, setAddingTag] = useState(false)
  const [tagDraft, setTagDraft] = useState('')
  // 进度条：有总集数按比例；连载中给个「看过的集数」渐增（原型稿同款公式）
  const pct =
    t.totalEpisodes != null
      ? Math.min(100, Math.round((t.episode / t.totalEpisodes) * 100))
      : t.episode > 0
        ? Math.min(100, 8 + t.episode * 6)
        : 0

  const commitTag = (): void => {
    const v = tagDraft.trim()
    if (v && !allTagsOf(t).includes(v)) {
      if (t.userTags.length >= USER_TAG_MAX) {
        tagLimitToast()
      } else {
        onPatch(t.bgmId, { userTags: [...t.userTags, v] })
        toast(`贴上了『${v}』标签`)
      }
    }
    setTagDraft('')
    setAddingTag(false)
  }

  const step = (delta: number): void => {
    const ep = Math.max(0, t.totalEpisodes != null ? Math.min(t.totalEpisodes, t.episode + delta) : t.episode + delta)
    const p: TrackPatch = { episode: ep }
    // 「想看」首次推进 → 自动转「在追」。反方向（推满 → 看完）**不**自动，见文件头注释。
    if (ep > 0 && t.status === 'plan') {
      p.status = 'watching'
      toast(`『${title}』开始追啦`)
    }
    onPatch(t.bgmId, p)
  }

  const considering = t.status === 'considering'
  // 真实 BGM 条目的看完 / 在追才有「写点评」入口；手动条目先回填，避免点到需要正数 bgmId 的接口。
  const canReview = t.bgmId > 0 && (t.status === 'done' || t.status === 'watching')
  // 0–5：翻旧的档位。次数再多也只到 5，痕迹不会无限堆下去。
  const heat = considering ? Math.min(5, t.observeCount) : undefined

  return (
    <article className={`trk-row${considering ? ' is-considering' : ''}`} data-heat={heat}>
      <span className={`tape tr ${considering ? 'lav' : isToday ? 'sakura' : 'teal'}`} />
      {considering && <WearLayer />}
      <div className="trk-cover" onClick={onEdit} title="点封面编辑" style={{ cursor: 'pointer' }}>
        {t.cover ? (
          <img className="cover-img" src={coverUrl(t.cover)} alt={title} loading="lazy" decoding="async" />
        ) : (
          <div className="cover-ph">☆</div>
        )}
        {considering && <span className="cover-seal">観望中</span>}
      </div>
      <div className="trk-body">
        <div className="trk-head">
          <div className="trk-marks">
            <span
              className={`stamp small ${STAMP_CLS[t.status]}`}
            >
              {STATUS_META.find((m) => m.key === t.status)?.label}
            </span>
            {isToday && <span className="chip-today">今天更新</span>}
            <FavHearts value={t.favorite} onChange={(n) => onPatch(t.bgmId, { favorite: n })} />
            <button
              type="button"
              className="trk-edit-mobile"
              onClick={onEdit}
              title="查看封面和标签"
              aria-label={`编辑『${title}』的封面和标签`}
            >
              <Ic name="edit" cls="ic ic-sm" />
              <span>详情</span>
            </button>
          </div>
          <div className="trk-title" title={title}>
            {title}
          </div>
          <span className="trk-ep">
            {considering
              ? '还没开动'
              : t.totalEpisodes != null ? `${t.episode} / ${t.totalEpisodes}` : `${t.episode} 集`}
          </span>
        </div>

        <div className="ep-ctrl">
          {/* 观望：不放集数、不放步进器、不放进度条 —— 那一套是「看到第几集」的语义 */}
          {t.status === 'considering' ? (
            <>
              <WatchMarks value={t.observeCount} onChange={(n) => onPatch(t.bgmId, { observeCount: Math.max(0, n) })} />
              <span className="wm-rule" />
            </>
          ) : (
          <>
          <div className="stepper">
            <button
              type="button"
              className="ep-minus"
              aria-label="减一集"
              onClick={() => step(-1)}
              disabled={t.episode <= 0}
            >
              <Ic name="minus" cls="ic ic-sm" />
            </button>
            <span className="ep-num">EP {t.episode}</span>
            <button
              type="button"
              className="ep-plus"
              aria-label="加一集"
              onClick={() => step(1)}
              disabled={capped}
            >
              <Ic name="plus" cls="ic ic-sm" />
            </button>
          </div>
          <div className={`prog${t.status === 'done' ? ' done' : ''}`}>
            <i style={{ width: `${pct}%` }} />
          </div>
          </>
          )}
        </div>

        {/* 标签：BGM 标签只读；自定义标签卡片上直接增删（原型稿形态） */}
        <div className="tagx-row">
          {t.bgmTags.map((x) => (
            <span key={`b-${x}`} className="tagx" title="来自 Bangumi（不可编辑）">
              {x}
            </span>
          ))}
          {t.userTags.map((x) => (
            <span key={`u-${x}`} className="tagx mine" title={`自定义「${x}」（点击移除）`}>
              {x}
              <button
                type="button"
                aria-label={`删除标签 ${x}`}
                onClick={() => onPatch(t.bgmId, { userTags: t.userTags.filter((y) => y !== x) })}
              >
                <Ic name="x" cls="ic ic-sm" />
              </button>
            </span>
          ))}
          {addingTag ? (
            <input
              className="tagx-input"
              style={{ borderStyle: 'dashed', borderColor: 'var(--teal-line)' }}
              autoFocus
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onBlur={commitTag}
              onKeyDown={(e) => {
                // isComposing 守卫 —— 中文输入法按回车是「确认拼音」，不是「提交标签」
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitTag()
                if (e.key === 'Escape') {
                  setTagDraft('')
                  setAddingTag(false)
                }
              }}
              placeholder="回车贴上，≤20 字"
              maxLength={20}
              spellCheck={false}
            />
          ) : (
            <button type="button" className="tagx tagx-add" onClick={() => setAddingTag(true)}>
              ＋ 标签
            </button>
          )}
        </div>

        <div className={`trk-actions${canReview ? ' has-review' : ''}`}>
          {t.bgmId < 0 ? (
            <button type="button" className="btn btn-sm btn-primary" onClick={onBackfill} title="从这条标题回填 BGM 条目">
              <Ic name="refresh" cls="ic ic-sm" />
              回填 BGM
            </button>
          ) : (
            <>
              <ContinueWatchAction
                label={considering ? '试看一集' : '继续看'}
                ep={ep}
                bound={bound}
                locating={locating}
                onPick={onContinue}
              />
              <a
                className="btn btn-sm btn-ghost"
                href={`https://bgm.tv/subject/${t.bgmId}`}
                target="_blank"
                rel="noreferrer"
                title="在 Bangumi 查看详情"
              >
                <Ic name="external" cls="ic ic-sm" />
                BGM
              </a>
            </>
          )}
          <button
            type="button"
            className={`btn btn-sm btn-ghost${t.goodEpisodes.length > 0 ? ' ge-trigger-on' : ''}`}
            onClick={onMarkGood}
            title={t.goodEpisodes.length > 0 ? `已标 ${t.goodEpisodes.length} 集好看` : '标记好看集'}
          >
            <Ic name="star" cls="ic ic-sm" />
            {t.goodEpisodes.length > 0 ? t.goodEpisodes.length : '好看集'}
          </button>
          {canReview && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={onWriteReview}
              title={t.status === 'watching' ? '写点评（先说看到第几话）' : '写点评，或者推荐给别人'}
            >
              <Ic name="edit" cls="ic ic-sm" />
              点评
            </button>
          )}
          {onMakePoster && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={onMakePoster}
              disabled={posterBusy}
              title="把你的点评做成一张分享图"
            >
              <Ic name="star" cls="ic ic-sm" />
              {posterBusy ? '生成中…' : '分享图'}
            </button>
          )}
          {/* 状态分段与「移出」永远是一个靠右的尾组；卡片变窄时尾组整体换行，
              移出仍贴在右缘，不会因为 flex 折行掉到左下角。 */}
          <div className="trk-tail">
            <StatusSeg t={t} considering={considering} onStatus={onStatus} />
            <RemoveBtn onAskRemove={onAskRemove} />
          </div>
        </div>
      </div>
    </article>
  )
}

function StatusSeg({
  t,
  considering,
  onStatus,
}: {
  t: Track
  considering: boolean
  onStatus: (s: TrackStatus) => void
}): JSX.Element {
  return (
    <div className="status-seg" role="group" aria-label="追番状态">
      {SEG_ORDER.map((s) => (
        <button
          key={s}
          type="button"
          className={`seg-btn${t.status === s ? ' on' : ''}`}
          data-status={SEG_CLS[s]}
          aria-pressed={t.status === s}
          onClick={() => onStatus(s)}
        >
          {s === 'watching' && considering && t.observeCount >= NUDGE_AT && <Nudge />}
          {STATUS_META.find((m) => m.key === s)?.label}
        </button>
      ))}
    </div>
  )
}

function RemoveBtn({ onAskRemove }: { onAskRemove: () => void }): JSX.Element {
  return (
    <button className="btn btn-sm btn-danger trk-rm" type="button" onClick={onAskRemove}>
      <Ic name="x" cls="ic ic-sm" />
      移出
    </button>
  )
}

// ── 最爱程度（纱雾贴纸）───────────────────────────────────────────────────────

/**
 * 最爱程度：6 颗爱心贴纸，纱雾口吻。点亮到第 N 颗＝喜欢程度 N；再点同一颗＝清零，
 * 省得单独放个「清除」按钮（跟桌面端 FavoriteStars 同一套交互）。
 */
const FAV_LINES = [
  '……才没有很喜欢啦',
  '唔……稍微、有一点点在意而已',
  '……还、还可以吧',
  '算是……蛮喜欢的了',
  '真的很喜欢呢……不要笑我',
  '全部点亮了……笨蛋，是最喜欢的意思啦！！',
]
function FavHearts({ value, onChange }: { value: number; onChange: (n: number) => void }): JSX.Element {
  const pick = (n: number): void => {
    const next = value === n ? 0 : n
    onChange(next)
    // 点击才是真触发（手机没有 hover），所以气泡话靠 toast 念出来，不靠 title
    toast(next > 0 ? `纱雾：${FAV_LINES[next - 1]}` : '纱雾把爱心擦掉了……')
  }
  return (
    <div className="fav-hearts" title={value > 0 ? `喜欢程度 ${value}/6（点同一颗清空）` : '点颗心，把喜欢程度告诉纱雾嘛…'}>
      {Array.from({ length: 6 }, (_, i) => {
        const n = i + 1
        const filled = n <= value
        return (
          <button
            key={n}
            type="button"
            className={`fav-heart${filled ? ' on' : ''}`}
            onClick={() => pick(n)}
            aria-label={`设为喜欢程度 ${n}`}
          >
            <Ic name="heart" cls="ic ic-sm" />
          </button>
        )
      })}
    </div>
  )
}

/**
 * 「瞄了一眼」印记条 —— 观望态下替掉集数步进器和进度条那一整行。
 *
 * 观望的番压根没在看，「看到第几集」的那套控件在这儿全是空转。点第 N 枚眼睛章直接记成
 * N 次，点当前最后一枚退回 N−1；盖满 5 枚之后章不再增加，靠末尾的 ＋ 继续累计，总数写成
 * 右上角那个手写小字。总数**绝对定位**：插进流里会在盖第 6 章的瞬间把 ＋ 往右顶，
 * 按钮从指尖底下跑掉。次数不设上限（跟评分类字段有意区分：一个是行为统计，一个是评分）。
 */
const WM_SLOTS = 5
function WatchMarks({ value, onChange }: { value: number; onChange: (n: number) => void }): JSX.Element {
  return (
    <div className="watchmarks" title={`观望 ${value} 次`}>
      <span className="wm-cap">瞄了</span>
      {Array.from({ length: WM_SLOTS }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          className={`wm-eye${n <= value ? ' on' : ''}`}
          aria-label={`记成观望 ${n} 次`}
          // 点当前最后一枚 = 撤回一次，省掉一个专门的「−」按钮
          onClick={() => onChange(value === n ? n - 1 : n)}
        >
          <Ic name="eye" cls="ic ic-sm" />
        </button>
      ))}
      <button type="button" className="wm-add" aria-label="再瞄一眼" onClick={() => onChange(value + 1)}>
        <Ic name="plus" cls="ic ic-sm" />
      </button>
      {value > WM_SLOTS && <span className="wm-more">{value}</span>}
    </div>
  )
}

/**
 * 翻旧痕迹层 —— 观望次数越多，这一页被翻回来看过的证据越多（铅笔线 / 补的胶带 /
 * 圈一圈 / 茶渍 / 折角）。哪一档显示哪几样全在 CSS 的 `[data-heat]` 里，这里只负责
 * 把这些痕迹摆进 DOM。整层 `pointer-events:none` 且绝对定位，翻得再旧也不动布局。
 * 铅笔波浪线和圈是 CSS 伪元素，长在标题和印记条自己身上，不在这儿。
 */
function WearLayer(): JSX.Element {
  return (
    <div className="wear" aria-hidden="true">
      <span className="w-stain s1" />
      <span className="w-stain s2" />
      <span className="w-tape" />
      <span className="w-dogear" />
    </div>
  )
}

/** 观望次数够多时，纱雾从「在追」上方探头催一句。沿用页尾立绘那套「头像 + 手写气泡」。 */
const NUDGE_AT = 4
function Nudge(): JSX.Element {
  return (
    <span className="nudge" aria-hidden="true">
      <img className="nudge-face" src="/assets/sagiri-nudge.webp" alt="" />
      <span className="bubble">追吧！</span>
    </span>
  )
}

/**
 * 「继续看」入口 —— 点一下不直接开，先弹个便签问纱雾：用哪个源、在站内看还是跳源站。
 * 用弹窗而非下拉：窄屏（iPhone SE 375）下卡片里塞不下 2×2 的按钮网格，会挤成换行；
 * 弹窗跟本页其它绑定 / 搜索流程也是同一套 .dlg 语汇。
 * 文案统一走和泉纱雾口吻（傲娇 + 手帐语气）。已认出来的源直接开；没认出来的
 * 走定位/搜索流程（验证码在我们站里过），认出来后按当时选的「站内 / 源站」落地。
 */
export function ContinueWatchAction({
  label,
  ep,
  bound,
  locating,
  onPick,
}: {
  label: string
  ep: number
  bound: Partial<Record<SourceId, SourceBinding>>
  locating: boolean
  onPick: (source: SourceId, mode: WatchMode, rebind?: boolean) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const choose = (source: SourceId, mode: WatchMode): void => {
    setOpen(false)
    onPick(source, mode)
  }
  const rebind = (source: SourceId): void => {
    setOpen(false)
    onPick(source, 'online', true)
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-primary"
        disabled={locating}
        onClick={() => setOpen(true)}
        title={`挑个源看第 ${ep} 话`}
      >
        {locating ? <Spinner size={12} /> : <Ic name="play" cls="ic ic-sm" />}
        <span>{locating ? '找片源中…' : label}</span>
      </button>
      {open && (
        <div
          className="dlg-backdrop open"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false)
          }}
        >
          <div role="dialog" aria-modal="true" aria-label="挑个播放源" className="dlg dlg-wsrc">
            <span className="tape tl teal" />
            <button type="button" className="dlg-close" onClick={() => setOpen(false)} aria-label="关闭" title="关闭">
              <Ic name="x" cls="ic" />
            </button>
            <h3 className="dlg-title">要看第 {ep} 话啦</h3>
            <p className="dlg-sub">
              从哪儿看呀……笨、笨蛋，才不是催你。挑个源，再挑「在纱雾这儿看」还是「跳去源站」。
            </p>
            <div className="wsrc-list">
              {SOURCES.map((s) => {
                const b = bound[s.id]
                return (
                  <div key={s.id} className="wsrc-grp">
                    <div className="wsrc-head">
                      <span className="wsrc-name">{s.label}</span>
                      {b
                        ? (
                          <>
                            <span className="wsrc-bound" title={`已认作《${b.name}》`}>《{b.name}》</span>
                            <button type="button" className="wsrc-relink" onClick={() => rebind(s.id)} title="认错了？重新挑一个">
                              不对，重认
                            </button>
                          </>
                        )
                        : <em className="wsrc-tag">还没认出来</em>}
                    </div>
                    <div className="wsrc-btns">
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => choose(s.id, 'online')}>
                        <Ic name="play" cls="ic ic-sm" />
                        在纱雾这儿看
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => choose(s.id, 'source')}>
                        <Ic name="external" cls="ic ic-sm" />
                        跳去源站看
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
