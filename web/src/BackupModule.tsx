// 设置页「备份与恢复」口袋 —— 手帐口吻（纱雾）。导出：先挑一种形态（贴纸单选），再按一个按钮。
// 下载：先 POST 要一张 2 分钟票据，再用带票据的普通链接触发。直接 <a href="/api/…"> 会被下载管理器
// 插件（NDM 之类）抢去、没 Cookie 只能 401；fetch → blob: 插件又接管不了、用户嫌浏览器自带下载限速。
// 票据挂在 URL 上两边都吃：有插件走插件，没插件浏览器自己下。
// 导入结果按服务端汇总展示；追番列表页靠 rev 轮询自己刷新，这里不碰缓存。
import { useRef, useState } from 'react'
import { requestBackupExportUrl, importBackup, type BackupExportFormat, type BackupImportResult } from './api'
import { Ic, Spinner } from './SketchIcon'
import { toast } from './Toast'

const EXPORTS: { format: BackupExportFormat; label: string; hint: string }[] = [
  { format: 'zip', label: '整本抄走（ZIP）', hint: '能贴回来，连你自己上传的封面一起' },
  { format: 'zip-md', label: '整本抄走 + 一页速览（ZIP）', hint: '能贴回来，另附一份 Markdown 随手翻' },
  { format: 'md', label: '只要那页速览（Markdown）', hint: '只能看，不能贴回来' },
]

async function downloadExport(format: BackupExportFormat): Promise<void> {
  const url = await requestBackupExportUrl(format)
  const a = document.createElement('a')
  a.href = url
  a.download = ''
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function summarize(r: BackupImportResult): string[] {
  const lines: string[] = []
  const t = r.tracks
  const parts: string[] = []
  if (t.added) parts.push(`新贴了 ${t.added} 部`)
  if (t.updated) parts.push(`改了 ${t.updated} 部`)
  if (t.skipped) parts.push(`${t.skipped} 部手帐里的更新、没动`)
  lines.push(`追番：${parts.length ? parts.join('，') : '没有要贴的'}`)
  if (r.foreignBackup) lines.push('这是别人的本子，只把追番贴过来了，点评没碰。')
  else if (r.reviews && (r.reviews.imported || r.reviews.skipped)) {
    lines.push(`点评 / 推荐：贴了 ${r.reviews.imported} 条${r.reviews.skipped ? `，${r.reviews.skipped} 条没动` : ''}`)
  }
  if (r.covers.imported || r.covers.missing) {
    lines.push(`封面：贴了 ${r.covers.imported} 张${r.covers.missing ? `，${r.covers.missing} 张文件里找不到、先用网上的图顶着` : ''}`)
  }
  return lines
}

export function BackupModule(): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null)
  const [format, setFormat] = useState<BackupExportFormat>('zip')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<BackupImportResult | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const onExport = async (): Promise<void> => {
    if (exporting) return
    setExporting(true)
    setExportError(null)
    try {
      await downloadExport(format)
      toast('拿去吧，收好别弄丢。')
    } catch (err) {
      setExportError(err instanceof Error ? err.message : '没抄成，等会儿再试试')
    } finally {
      setExporting(false)
    }
  }

  const onPick = async (file: File | undefined): Promise<void> => {
    if (!file || importing) return
    setImporting(true)
    setImportError(null)
    setResult(null)
    try {
      const r = await importBackup(file)
      setResult(r)
      toast('贴回来了。')
    } catch (err) {
      setImportError(err instanceof Error ? err.message : '没贴上，等会儿再试试')
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="backup-module">
      <section className="backup-part">
        <div className="privacy-copy">
          <b>要把手帐抄一份带走吗？</b>
          <p className="muted small mt8">哼……服务器那边我会看着的。不过你自己手里也留一份，我才放心。</p>
        </div>
        <div className="backup-opts" role="radiogroup" aria-label="抄成什么样">
          {EXPORTS.map((e) => {
            const on = e.format === format
            return (
              <label key={e.format} className={`backup-opt${on ? ' on' : ''}`}>
                <input type="radio" name="backup-format" value={e.format} checked={on} onChange={() => setFormat(e.format)} />
                <span className="backup-opt-mark" aria-hidden="true">
                  {on && <Ic name="check" cls="ic ic-sm" />}
                </span>
                <span className="backup-opt-text">
                  <b>{e.label}</b>
                  <small>{e.hint}</small>
                </span>
              </label>
            )
          })}
        </div>
        <div className="backup-act">
          <button type="button" className="btn btn-primary" disabled={exporting} onClick={() => void onExport()}>
            {exporting ? <Spinner /> : <Ic name="clip" />}
            {exporting ? '正在抄…' : '抄一份给我'}
          </button>
          <span className="field-hint">抄的是追番（进度、标签、评分、好看集）和你写的点评 / 推荐。</span>
        </div>
        {exportError && <p className="form-note err">{exportError}</p>}
      </section>

      <section className="backup-part">
        <div className="privacy-copy">
          <b>把之前抄走的贴回来</b>
          <p className="muted small mt8">
            拿之前抄的 .zip 或里面的 data.json 来。同一部番谁改得晚听谁的，手帐里已有的不会被撕掉；别人的本子只贴追番，不贴点评。
          </p>
        </div>
        <div className="backup-act">
          <input
            ref={fileRef}
            type="file"
            accept=".zip,.json,application/zip,application/json"
            hidden
            onChange={(e) => void onPick(e.target.files?.[0])}
          />
          <button type="button" className="btn" disabled={importing} onClick={() => fileRef.current?.click()}>
            {importing ? <Spinner /> : <Ic name="tracks" />}
            {importing ? '正在贴…' : '选文件贴回来'}
          </button>
        </div>
        {importError && <p className="form-note err">{importError}</p>}
        {result && (
          <ul className="backup-result">
            {summarize(result).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
