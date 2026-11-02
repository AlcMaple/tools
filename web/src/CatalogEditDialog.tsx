// 全部番剧：管理员手改一张卡的中文名、标签和封面。改动全站共用，不是某个用户自己的追番
import { useRef, useState } from 'react'
import type { CatalogItem } from './api'
import { clearCatalogCover, coverUrl, saveCatalogCoverUrl, saveCatalogText, uploadCatalogCover } from './api'
import { Ic, Spinner } from './SketchIcon'

const splitTags = (raw: string): string[] => raw.split(/[\s,，、]+/).map((t) => t.trim()).filter(Boolean)

export function CatalogEditDialog({ item, onSaved, onClose }: {
  item: CatalogItem
  onSaved: (item: CatalogItem) => void
  onClose: () => void
}): JSX.Element {
  const [nameCn, setNameCn] = useState(item.nameCn)
  const [tags, setTags] = useState(item.tags.join(' '))
  // null = 恢复成索引里的；没动过的字段也按 null 发，免得原样保存一遍就被记成「手改过」
  const [resetName, setResetName] = useState(false)
  const [resetTags, setResetTags] = useState(false)
  const [busy, setBusy] = useState<'' | 'text' | 'cover'>('')
  const [error, setError] = useState('')
  const [coverEditing, setCoverEditing] = useState(false)
  const [coverUrlDraft, setCoverUrlDraft] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const edited = item.edited ?? { nameCn: false, tags: false, cover: false }

  const run = async (kind: 'text' | 'cover', task: () => Promise<CatalogItem>, close: boolean): Promise<void> => {
    setBusy(kind)
    setError('')
    try {
      const next = await task()
      onSaved(next)
      if (close) onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy('')
    }
  }

  const commitCoverUrl = (): void => {
    const v = coverUrlDraft.trim()
    setCoverEditing(false)
    if (v && v !== item.cover) void run('cover', () => saveCatalogCoverUrl(item.bgmId, v), false)
  }

  const save = (): void => {
    const nameChanged = !resetName && nameCn.trim() !== item.nameCn
    const tagList = splitTags(tags)
    const tagsChanged = !resetTags && tagList.join(' ') !== item.tags.join(' ')
    void run('text', () => saveCatalogText(item.bgmId, {
      nameCn: resetName ? null : nameChanged || edited.nameCn ? nameCn.trim() : null,
      tags: resetTags ? null : tagsChanged || edited.tags ? tagList : null,
    }), true)
  }

  return (
    <div className="dlg-backdrop open" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div role="dialog" aria-modal="true" aria-label="编辑番剧卡片" className="dlg catalog-edit">
        <span className="tape tl teal" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭"><Ic name="x" cls="ic" /></button>
        <h3 className="dlg-title">编辑卡片</h3>
        <p className="dlg-sub">{item.name}</p>

        <div className="catalog-edit-body">
          <div className="catalog-edit-cover">
            <div className="dlg-cover-edit">
              <button
                type="button"
                className="dlg-cover-btn"
                title="点击编辑封面"
                disabled={!!busy}
                onClick={() => {
                  setCoverUrlDraft(item.cover.startsWith('/api/catalog/') ? '' : item.cover)
                  setCoverEditing((v) => !v)
                }}
              >
                {item.cover ? <img className="dlg-cover" src={coverUrl(item.cover, item.bgmId)} alt="" /> : <span className="dlg-cover dlg-cover-ph">＋ 封面</span>}
              </button>
              {busy === 'cover' && <span className="catalog-edit-cover-busy"><Spinner /></span>}
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
                    <button type="button" onClick={() => fileRef.current?.click()}>本地上传</button>
                  </div>
                </div>
              )}
            </div>
            {edited.cover && (
              <button type="button" className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => void run('cover', () => clearCatalogCover(item.bgmId), false)}>恢复默认</button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                setCoverEditing(false)
                if (file) void run('cover', () => uploadCatalogCover(item.bgmId, file), false)
              }}
            />
          </div>

          <div className="catalog-edit-fields">
            <label className="field">
              <span className="field-label">中文名{edited.nameCn && !resetName && <button type="button" className="field-reset" onClick={() => setResetName(true)}>恢复默认</button>}</span>
              <span className="field-row">
                <input value={resetName ? '' : nameCn} placeholder={resetName ? '保存后恢复成 Bangumi 上的名字' : ''} maxLength={120} onChange={(e) => { setResetName(false); setNameCn(e.target.value) }} />
              </span>
            </label>
            <label className="field">
              <span className="field-label">标签{edited.tags && !resetTags && <button type="button" className="field-reset" onClick={() => setResetTags(true)}>恢复默认</button>}</span>
              <span className="field-row">
                <input value={resetTags ? '' : tags} placeholder={resetTags ? '保存后恢复成 Bangumi 上的标签' : '用空格或逗号分开，最多 10 个'} onChange={(e) => { setResetTags(false); setTags(e.target.value) }} />
              </span>
            </label>
          </div>
        </div>

        <p className={`form-note err catalog-edit-err${error ? '' : ' is-empty'}`} aria-live="polite">{error || ' '}</p>
        <button type="button" className="btn btn-primary btn-block" disabled={!!busy} onClick={save}>{busy === 'text' ? '保存中…' : '保存'}</button>
      </div>
    </div>
  )
}
