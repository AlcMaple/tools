import { useEffect, useRef, useState } from 'react'
import { Ic, Spinner } from '../SketchIcon'
import { toast } from '../Toast'
import { downloadBlob, renderPoster, type PosterInput } from './poster'
import { MODE_LABEL } from './reviewsApi'

// 分享海报预览弹窗：进来就渲染，给「存图」。移动端 <a download> 常失效，同时提示长按保存。
export function PosterModal({
  input,
  fileTitle,
  onClose,
}: {
  input: PosterInput
  fileTitle: string
  onClose: () => void
}): JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const blobRef = useRef<Blob | null>(null)

  useEffect(() => {
    let alive = true
    let objectUrl = ''
    void (async () => {
      try {
        const blob = await renderPoster(input)
        if (!alive) return
        blobRef.current = blob
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      } catch (err) {
        if (!alive) return
        setFailed(true)
        toast(err instanceof Error ? err.message : '海报没做成……', { err: true })
      }
    })()
    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [input])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function onSave(): void {
    if (!blobRef.current) return
    downloadBlob(blobRef.current, `${fileTitle}-${MODE_LABEL[input.mode]}.png`)
  }

  return (
    <div className="dlg-backdrop open" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="分享海报" className="dlg" style={{ maxWidth: 460 }}>
        <span className="tape tl sakura" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭">
          <Ic name="x" cls="ic" />
        </button>
        <h3 className="dlg-title">给这篇{MODE_LABEL[input.mode]}做张分享图</h3>
        <p className="dlg-sub">哼，做好了……要发出去别忘了是谁帮你写的。手机长按图片也能保存。</p>

        <div
          style={{
            marginTop: 12,
            borderRadius: 10,
            overflow: 'hidden',
            border: '1px solid var(--line)',
            minHeight: 240,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--paper-2)',
          }}
        >
          {url ? (
            <img src={url} alt="分享海报预览" style={{ width: '100%', display: 'block' }} />
          ) : failed ? (
            <p className="faint small" style={{ padding: 40 }}>
              没画出来……关掉重开试试
            </p>
          ) : (
            <div style={{ padding: 60 }}>
              <Spinner size={28} />
            </div>
          )}
        </div>

        <div className="dlg-actions" style={{ marginTop: 14 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            不了
          </button>
          <button type="button" className="btn btn-primary" onClick={onSave} disabled={!url}>
            <Ic name="check" cls="ic ic-sm" />
            保存图片
          </button>
        </div>
      </div>
    </div>
  )
}
