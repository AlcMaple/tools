import { useEffect, useRef, useState } from 'react'
import { coverageLabel, DOWNLOAD_KINDS, infoHash, type DownloadGroup, type DownloadLink, type DownloadPanelData, type DownloadResults, type Release } from '../shared/catalog-downloads'
import { DownloadConflict, fetchDownloadReleases, fetchManualDownloads, saveManualDownloads } from './api'
import { Ic, Spinner } from './SketchIcon'

const GROUPS: Record<DownloadGroup, string> = { season: '整季合集', range: '分集合集', episode: '单集', mixed: '混合收录', other: '其他发布' }
const ACTION = { file: '下载文件', magnet: '打开下载器', torrent: '下载种子', page: '查看发布页' }
const SOURCES: Record<string, string> = { dmhy: '动漫花园', moe: '萌番组', mikan: '蜜柑计划' }

function DownloadRow({ release, onEdit }: { release: Release; onEdit?: () => void }): JSX.Element {
  const [copy, setCopy] = useState<'idle' | 'ok' | 'manual'>('idle')
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => { if (copy === 'manual') { field.current?.focus(); field.current?.select() } }, [copy])
  const tag = release.group === 'range' || release.group === 'episode' ? coverageLabel(release) : ''
  const metadata = [tag, ...release.sources.map(s => SOURCES[s] ?? s), release.quality, release.nameMatch ? '按片名匹配' : ''].filter(Boolean)
  const copyLabel = release.kind === 'magnet' ? '磁力' : '直链'
  return <li className="download-row">
    <strong>{release.title}</strong>
    <p className="muted small">{metadata.join(' · ')}</p>
    <div className="download-actions">
      <a className="btn btn-sm" href={release.url} target={release.kind === 'magnet' ? undefined : '_blank'} rel="noopener noreferrer" download={release.kind === 'file' || release.kind === 'torrent' || undefined}>{ACTION[release.kind]}</a>
      {release.kind !== 'page' && <button className="btn btn-ghost btn-sm download-copy" type="button" onClick={() => {
        void (async () => { try { await navigator.clipboard.writeText(release.url); setCopy('ok') } catch { setCopy('manual') } })()
      }}>{copy === 'ok' ? '已复制' : '复制'}{copyLabel}</button>}
      {release.torrentUrl && <a className="download-text" href={release.torrentUrl} target="_blank" rel="noopener noreferrer" download>下载种子</a>}
      {release.pageUrl && <a className="download-text" href={release.pageUrl} target="_blank" rel="noopener noreferrer">发布页</a>}
      {onEdit && <button className="download-text" type="button" onClick={onEdit}>编辑链接</button>}
    </div>
    {copy === 'manual' && <label className="field"><span className="field-label">手动复制{copyLabel}</span><span className="field-row"><input ref={field} value={release.url} readOnly /></span></label>}
  </li>
}

function LinkEditor({ initial, eps, exists, onCancel, onSave }: {
  initial: DownloadLink; eps: number; exists: boolean; onCancel: () => void; onSave: (link: DownloadLink | null) => Promise<void>
}): JSX.Element {
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  async function submit(link: DownloadLink | null): Promise<void> {
    setBusy(true)
    setError('')
    try { await onSave(link) }
    catch (e) { setError(e instanceof Error ? e.message : '保存链接失败'); setConflict(e instanceof DownloadConflict) }
    finally { setBusy(false) }
  }
  return <form className="download-editor" onSubmit={e => { e.preventDefault(); void submit(draft) }}>
    <h3>{exists ? '编辑下载链接' : '补充下载链接'}</h3>
    <label className="field"><span className="field-label">发布名称</span><span className="field-row"><input autoFocus required maxLength={180} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></span></label>
    <fieldset><legend className="field-label">链接类型</legend><div className="download-choices">{(Object.entries(DOWNLOAD_KINDS) as [DownloadLink['kind'], string][]).map(([kind, label]) =>
      <button key={kind} type="button" aria-pressed={draft.kind === kind} onClick={() => setDraft({ ...draft, kind })}>{label}</button>)}</div></fieldset>
    <label className="field"><span className="field-label">链接地址</span><span className="field-row"><input type="text" required maxLength={16384} spellCheck={false} value={draft.url} placeholder={draft.kind === 'magnet' ? 'magnet:?xt=urn:btih:…' : 'https://…'} onChange={e => setDraft({ ...draft, url: e.target.value })} /></span></label>
    <fieldset><legend className="field-label">收录范围</legend><div className="download-choices">{(Object.entries(GROUPS) as [DownloadGroup, string][]).map(([group, label]) =>
      <button key={group} type="button" aria-pressed={draft.group === group} onClick={() => setDraft({ ...draft, group })}>{label}</button>)}</div></fieldset>
    {(draft.group === 'range' || draft.group === 'episode') && <div className="download-episodes">
      <label className="field"><span className="field-label">{draft.group === 'episode' ? '集数' : '起始集'}</span><span className="field-row"><input type="number" required min={1} max={eps || undefined} value={draft.first ?? ''} onChange={e => setDraft({ ...draft, first: e.target.value ? Number(e.target.value) : null })} /></span></label>
      {draft.group === 'range' && <label className="field"><span className="field-label">末集</span><span className="field-row"><input type="number" required min={(draft.first ?? 0) + 1} max={eps || undefined} value={draft.last ?? ''} onChange={e => setDraft({ ...draft, last: e.target.value ? Number(e.target.value) : null })} /></span></label>}
    </div>}
    <label className="field"><span className="field-label">字幕和画质（选填）</span><span className="field-row"><input maxLength={80} value={draft.quality} onChange={e => setDraft({ ...draft, quality: e.target.value })} placeholder="如 1080p · 简繁内封" /></span></label>
    <div className="download-actions download-save">
      {error && <p role="alert" className="download-notice">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy || conflict}>保存链接</button>
      <button type="button" className="btn" onClick={onCancel} disabled={busy}>取消</button>
      {exists && <button type="button" className="download-text" disabled={busy || conflict} onClick={() => void submit(null)}>移除此链接</button>}
    </div>
  </form>
}

function mergePages(previous: Release[], added: Release[]): Release[] {
  const merged = new Map(previous.map(r => [r.id, r]))
  for (const release of added) {
    const old = merged.get(release.id)
    if (!old) merged.set(release.id, release)
    else merged.set(release.id, { ...(release.group === 'season' ? release : old), sources: [...new Set([...old.sources, ...release.sources])] })
  }
  return [...merged.values()]
}

export function CatalogDownloads({ id, season }: { id: number; season?: string }): JSX.Element {
  const [manual, setManual] = useState<DownloadPanelData | null>(null)
  const [manualError, setManualError] = useState('')
  const [garden, setGarden] = useState<DownloadResults | null>(null)
  const [ani, setAni] = useState<DownloadResults | null>(null)
  const [nextPage, setNextPage] = useState(2)
  const [paging, setPaging] = useState(false)
  const [episode, setEpisode] = useState('')
  const [editing, setEditing] = useState<DownloadLink | null>(null)
  const controller = useRef<AbortController>()
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const ctl = new AbortController()
    controller.current = ctl
    const active = () => !ctl.signal.aborted
    void fetchManualDownloads(id, ctl.signal, season).then(r => { if (active()) setManual(r) }).catch((e: Error) => { if (active()) setManualError(e.message) })
    for (const source of ['garden', 'ani'] as const) {
      const set = source === 'garden' ? setGarden : setAni
      void fetchDownloadReleases(id, source, 1, ctl.signal, season).then(r => { if (active()) set(r) }).catch((e: Error) => { if (active()) set({ items: [], warning: e.message }) })
    }
    return () => ctl.abort()
  }, [id, season])
  async function more(): Promise<void> {
    const signal = controller.current!.signal
    setPaging(true)
    try {
      const result = await fetchDownloadReleases(id, 'garden', nextPage, signal, season)
      if (signal.aborted) return
      setGarden(old => ({ ...result, items: mergePages(old?.items ?? [], result.items), more: result.more ?? old?.more }))
      if (result.more !== undefined) setNextPage(n => n + 1)
    } catch (e) { if (!signal.aborted) setGarden(old => ({ ...old, items: old?.items ?? [], warning: (e as Error).message })) }
    finally { if (!signal.aborted) setPaging(false) }
  }
  async function save(link: DownloadLink | null): Promise<void> {
    if (!manual || !editing) return
    const links = manual.links.filter(l => l.id !== editing.id)
    if (link) links.push(link)
    try {
      const saved = await saveManualDownloads(id, { revision: manual.revision, links }, season)
      setManual(saved)
      setEditing(null)
    } catch (e) {
      if (e instanceof DownloadConflict) {
        try { setManual(await fetchManualDownloads(id, controller.current!.signal, season)) }
        catch (readError) { setManual(null); setManualError((readError as Error).message) }
      }
      throw e
    }
  }
  function edit(link: DownloadLink): void {
    setEditing(link)
    panel.current?.closest('.catalog-details-body')?.scrollTo(0, 0)
  }
  if (editing) return <LinkEditor initial={editing} eps={manual?.episodes ?? 0} exists={!!manual?.links.some(l => l.id === editing.id)} onSave={save} onCancel={() => setEditing(null)} />
  const discovered = new Map([...(ani?.items ?? []), ...(garden?.items ?? [])].map(r => [r.id, r]))
  const supplied = manual?.links.map(link => {
    const key = link.kind === 'magnet' ? infoHash(link.url) : link.url
    const found = discovered.get(key)
    const match = found?.kind === link.kind ? found : undefined
    if (match) discovered.delete(key)
    return { ...match, ...link, sources: ['管理员补充', ...(match?.sources ?? [])] }
  }) ?? []
  const all = [...supplied, ...discovered.values()]
  const loading = !garden || !ani || (!manual && !manualError)
  const errors = [...new Set([manualError, garden?.warning, ani?.warning].filter(Boolean))]
  const filtered = episode ? all.filter(l => l.group === 'season' || (l.first !== null && l.last !== null && l.first <= Number(episode) && l.last >= Number(episode))) : all
  return <div ref={panel} className="catalog-downloads">
    <div className="download-tools">
      {!!all.length && <label className="download-filter field-row">按集筛选<input aria-label="按集筛选" type="number" min={1} value={episode} placeholder="全部" onChange={e => setEpisode(e.target.value)} /></label>}
      {manual?.canEdit && <button type="button" className="btn btn-sm" onClick={() => edit({ id: crypto.randomUUID(), kind: 'file', url: '', title: '', group: 'other', first: null, last: null, quality: '' })}><Ic name="plus" cls="ic ic-sm" />补充链接</button>}
    </div>
    {loading && <p className="row muted small" role="status"><Spinner size={16} />正在查找下载资源…</p>}
    {errors.map((error, i) => <p className="download-warning" key={i} role="status"><Ic name="alert" cls="ic ic-sm" />{error}</p>)}
    {Object.entries(GROUPS).map(([group, label]) => {
      const rows = filtered.filter(r => r.group === group).sort((a, b) => (a.first ?? 0) - (b.first ?? 0))
      return rows.length > 0 && <section key={group}><h3>{label}</h3><ul>{rows.map(r => <DownloadRow key={r.id} release={r} onEdit={manual?.canEdit && manual.links.some(l => l.id === r.id) ? () => edit(r) : undefined} />)}</ul></section>
    })}
    {!loading && !filtered.length && <p className="muted">{episode ? '已列出的资源里没有这一集' : errors.length ? '目前没有可显示的链接' : garden?.more ? '当前页没有匹配的发布' : '暂未找到这部作品的下载资源'}</p>}
    <div className="download-actions download-more">
      {garden?.more && <button type="button" className="btn btn-sm" disabled={paging} aria-busy={paging} onClick={() => void more()}>更多 AnimeGarden 发布</button>}
      <a className="download-text" href="https://open.ani.rip/" target="_blank" rel="noopener noreferrer">ANi 往期目录</a>
    </div>
    {all.some(r => r.kind === 'magnet') && <details className="download-help">
      <summary>怎样打开磁力？</summary>
      <p>Windows 和 macOS 都可以用 <a href="https://www.qbittorrent.org/download" target="_blank" rel="noopener noreferrer">qBittorrent</a> 或 <a href="https://transmissionbt.com/download" target="_blank" rel="noopener noreferrer">Transmission</a>。安装后点「打开下载器」，也可以复制磁力到下载器里选集</p>
    </details>}
  </div>
}
