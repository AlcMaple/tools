import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { coverUrl, type Track, type TrackPatch } from '../api'
import { Ic, Spinner } from '../SketchIcon'
import { SEG_CLS, SEG_ORDER, SHORT_DAY, STATUS_META, USER_TAG_MAX, allTagsOf, tagLimitToast } from './common'

// ── 编辑弹窗 ───────────────────────────────────────────────────────────────────
// 没有保存按钮 —— 改完即生效。
export function EditModal({
  t,
  onPatch,
  onUploadCover,
  onClose,
}: {
  t: Track
  onPatch: (bgmId: number, p: TrackPatch) => void
  onUploadCover: (bgmId: number, file: File) => Promise<void>
  onClose: () => void
}): JSX.Element {
  const [totalDraft, setTotalDraft] = useState(t.totalEpisodes != null ? String(t.totalEpisodes) : '')
  const [adding, setAdding] = useState(false)
  const [tagDraft, setTagDraft] = useState('')
  const [coverEditing, setCoverEditing] = useState(false)
  const [coverUrlDraft, setCoverUrlDraft] = useState('')
  const [coverUploading, setCoverUploading] = useState(false)
  const coverFileRef = useRef<HTMLInputElement>(null)
  const title = t.titleCn || t.title
  const sub = t.titleCn && t.title !== t.titleCn ? t.title : ''
  // 副标题行只在真有内容时才占位 —— 没有副标题也没有放送日 / 评分,就当这行容器不存在。
  const subLine = [sub, t.airWeekday ? `周${SHORT_DAY[t.airWeekday]}更新` : '', t.score > 0 ? `★ ${t.score.toFixed(1)}` : '']
    .filter(Boolean)
    .join(' · ')

  const commitCoverUrl = (): void => {
    const v = coverUrlDraft.trim()
    setCoverEditing(false)
    setCoverUrlDraft('')
    if (v && v !== t.cover) onPatch(t.bgmId, { cover: v })
  }

  const pickCoverFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setCoverUploading(true)
    void onUploadCover(t.bgmId, file).finally(() => setCoverUploading(false))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const commitTotal = (): void => {
    const raw = totalDraft.trim()
    const n = parseInt(raw, 10)
    // 清空 = 连载中（app 的语义，placeholder 也这么写）
    const total = raw === '' || !Number.isFinite(n) || n <= 0 ? null : n
    if (total !== t.totalEpisodes) onPatch(t.bgmId, { totalEpisodes: total })
    setTotalDraft(total != null ? String(total) : '')
  }

  const commitTag = (): void => {
    const v = tagDraft.trim()
    if (v && !allTagsOf(t).includes(v)) {
      if (t.userTags.length >= USER_TAG_MAX) tagLimitToast()
      else onPatch(t.bgmId, { userTags: [...t.userTags, v] })
    }
    setTagDraft('')
    setAdding(false)
  }

  return (
    <div
      className="dlg-backdrop open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="编辑追番" className="dlg">
        <span className="tape tl teal" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭">
          <Ic name="x" cls="ic" />
        </button>

        <h3 className="dlg-title">{title}</h3>
        {subLine && <p className="dlg-sub">{subLine}</p>}

        <div className="mb16" style={{ display: 'flex', gap: 14 }}>
          <div className="dlg-cover-edit">
            <button
              type="button"
              className="dlg-cover-btn"
              onClick={() => {
                setCoverUrlDraft(t.cover && !t.cover.startsWith('/api/tracks/') ? t.cover : '')
                setCoverEditing((v) => !v)
              }}
              title="点击编辑封面"
              disabled={coverUploading}
            >
              {t.cover ? (
                <img className="dlg-cover" src={coverUrl(t.cover)} alt="" />
              ) : (
                <span className="dlg-cover dlg-cover-ph">{coverUploading ? <Spinner /> : '＋ 封面'}</span>
              )}
            </button>
            {coverEditing && (
              <div className="dlg-cover-pop">
                <input
                  value={coverUrlDraft}
                  onChange={(e) => setCoverUrlDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitCoverUrl()
                    if (e.key === 'Escape') setCoverEditing(false)
                  }}
                  placeholder="网图 URL"
                  autoFocus
                />
                <div className="dlg-cover-pop-actions">
                  <button type="button" onClick={commitCoverUrl}>确定</button>
                  <button type="button" onClick={() => coverFileRef.current?.click()}>本地上传</button>
                </div>
                <input
                  ref={coverFileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    setCoverEditing(false)
                    pickCoverFile(e)
                  }}
                />
              </div>
            )}
          </div>
          <div className="field" style={{ flex: 1, minWidth: 0 }}>
            <span className="field-label">状态</span>
            <div className="status-seg" style={{ marginLeft: 0 }} role="group" aria-label="追番状态">
              {SEG_ORDER.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`seg-btn${t.status === s ? ' on' : ''}`}
                  data-status={SEG_CLS[s]}
                  aria-pressed={t.status === s}
                  onClick={() => onPatch(t.bgmId, { status: s })}
                >
                  {STATUS_META.find((m) => m.key === s)?.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="field mb16">
          <span className="field-label">进度</span>
          <div className="ep-ctrl">
            <div className="stepper">
              <button
                type="button"
                className="ep-minus"
                aria-label="减一集"
                disabled={t.episode <= 0}
                onClick={() => onPatch(t.bgmId, { episode: Math.max(0, t.episode - 1) })}
              >
                <Ic name="minus" cls="ic ic-sm" />
              </button>
              <span className="ep-num">EP {t.episode}</span>
              <button
                type="button"
                className="ep-plus"
                aria-label="加一集"
                disabled={t.totalEpisodes != null && t.episode >= t.totalEpisodes}
                onClick={() =>
                  onPatch(t.bgmId, { episode: t.episode + 1, ...(t.status === 'plan' ? { status: 'watching' as const } : {}) })
                }
              >
                <Ic name="plus" cls="ic ic-sm" />
              </button>
            </div>
            <span className="field-row" style={{ flex: 1 }}>
              <input
                value={totalDraft}
                onChange={(e) => setTotalDraft(e.target.value.replace(/[^0-9]/g, ''))}
                onBlur={commitTotal}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitTotal()
                }}
                placeholder="总集数，留空 = 连载中"
                inputMode="numeric"
                maxLength={4}
                style={{ width: '100%', maxWidth: 180 }}
              />
            </span>
          </div>
        </div>

        <div className="field">
          <span className="field-label">类型标签（BGM 的不可改 · 自定义的点一下删）</span>
          <div className="tagx-row">
            {t.bgmTags.map((x) => (
              <span key={`b-${x}`} className="tagx" title="来自 Bangumi（不可编辑）">
                {x}
              </span>
            ))}
            {t.userTags.map((x) => (
              <span key={`u-${x}`} className="tagx mine" title={`自定义「${x}」（点击移除）`}>
                {x}
                <button type="button" aria-label={`删除标签 ${x}`} onClick={() => onPatch(t.bgmId, { userTags: t.userTags.filter((y) => y !== x) })}>
                  <Ic name="x" cls="ic ic-sm" />
                </button>
              </span>
            ))}
            {adding ? (
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
                    setAdding(false)
                  }
                }}
                placeholder="例：下饭"
                maxLength={20}
                spellCheck={false}
              />
            ) : (
              <button type="button" className="tagx tagx-add" onClick={() => setAdding(true)}>
                ＋ 标签
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// 取消追番二次确认 —— 删除是不可逆操作，且追番带着进度 / 自定义标签，不能点一下就没。
export function ConfirmRemoveModal({
  t,
  onConfirm,
  onClose,
}: {
  t: Track
  onConfirm: () => void
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const title = t.titleCn || t.title
  // 会一并丢失的本地数据 —— 有才提，让用户据此判断
  const lost: string[] = []
  if (t.episode > 0) lost.push(`第 ${t.episode} 集的进度`)
  if (t.userTags.length > 0) lost.push(`${t.userTags.length} 个自定义标签`)

  return (
    <div
      className="dlg-backdrop open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="移出追番" className="dlg">
        <span className="tape tl sakura" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭">
          <Ic name="x" cls="ic" />
        </button>
        <h3 className="dlg-title">移出追番</h3>
        <p className="dlg-sub">
          确定把『<b style={{ color: 'var(--sakura)' }}>{title}</b>』从手帐里撕掉吗？
          {lost.length > 0 && <span className="faint">{lost.join(' 和 ')}会一并删除，无法恢复。</span>}
        </p>
        <div className="dlg-actions">
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            先留着
          </button>
          <button className="btn btn-danger" type="button" onClick={onConfirm}>
            <Ic name="x" cls="ic ic-sm" />
            移除
          </button>
        </div>
      </div>
    </div>
  )
}
