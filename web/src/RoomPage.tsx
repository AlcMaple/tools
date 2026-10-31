import { useEffect, useState } from 'react'
import { listCachedEpisodes, mediaCacheSupported, removeCachedEpisode, type CachedEpisode } from './mediaCache'
import { toast } from './Toast'

// 设计稿：docs/design-mockups/线路状态与本地缓存.html

interface Bar { t: number; bps: number; users: number }
interface LineStatus { source: number; name: string; bps: number; users: number; samples: number; mine: number; bars: (Bar | null)[] }
interface Status { lines: LineStatus[]; me: { n: number; rank: number; days: number[] } }
type Load = Status | null | 'error' | 'login'

// 6Mbps 与播放页「够快不换」同一条线；2.7Mbps 是稀饭常见码率（AGENTS.md：单连接 2.2 < 码率 2.67 就会卡）
const FAST = 6e6
const OK = 2.7e6
type Level = 'fast' | 'ok' | 'slow' | 'none'
const level = (bps: number): Level => (bps >= FAST ? 'fast' : bps >= OK ? 'ok' : bps > 0 ? 'slow' : 'none')
const WORD: Record<Level, string> = { fast: '畅通', ok: '偶尔卡', slow: '好慢', none: '还没人量过' }
const mbps = (bps: number): string => (bps / 1e6).toFixed(1)

function size(bytes: number): string {
  return bytes >= 1024 ** 3 ? (bytes / 1024 ** 3).toFixed(1) + ' GB' : Math.round(bytes / 1024 ** 2) + ' MB'
}

function playHref(item: CachedEpisode): string {
  const q = new URLSearchParams({ src: item.src, id: item.id, ep: String(item.ep) })
  if (item.bgmId) q.set('bgmId', String(item.bgmId))
  return '/api/player/page?' + q.toString()
}

function ago(ms: number): string {
  const d = Math.floor((Date.now() - ms) / 86400000)
  return d <= 0 ? '今天' : d === 1 ? '昨天' : `${d} 天前`
}

function barTitle(b: Bar): string {
  const s = new Date(b.t), e = new Date(b.t + 3 * 3600 * 1000)
  const hh = (d: Date): string => String(d.getHours()).padStart(2, '0') + ':00'
  return `${s.getMonth() + 1}/${s.getDate()} ${hh(s)}–${hh(e) === '00:00' ? '24:00' : hh(e)} · ${mbps(b.bps)} Mbps · ${b.users} 人`
}

function Lines({ status }: { status: Load }): JSX.Element {
  if (status === 'login') return <p className="muted small">登录以后才能看大家量的线路哦</p>
  if (status === 'error') return <p className="muted small">线路记录没拿到，等会儿再来看看</p>
  if (!status) return <p className="muted small">翻手帐中</p>
  if (status.lines.length === 0) return <p className="muted small">还没有人量过线路</p>
  return (
    <div className="ls-lines">
      {status.lines.map((l) => {
        const lv = level(l.bps)
        return (
          <div key={l.source} className="ls-line">
            <div className="ls-line-top">
              <div>
                <div className="ls-line-name">{l.name}</div>
                <div className="ls-line-site">稀饭</div>
              </div>
              <div className="ls-speed">{l.bps ? mbps(l.bps) : '—'}{l.bps > 0 && <small>Mbps</small>}</div>
              <span className={`ls-pill ${lv}`}>{WORD[lv]}</span>
            </div>
            <div className="ls-bars">
              {l.bars.map((b, i) => <span key={i} className={`ls-c-${b ? level(b.bps) : 'none'}`} title={b ? barTitle(b) : undefined} />)}
            </div>
            <div className="ls-bar-foot"><span>7 天前</span><span>现在</span></div>
            <div className="ls-line-foot"><span><b>{l.users}</b> 位观测员</span><span><b>{l.samples}</b> 次测速</span></div>
          </div>
        )
      })}
    </div>
  )
}

interface Show { key: string; title: string; eps: CachedEpisode[]; bytes: number; lastAt: number }

function groupShows(items: CachedEpisode[]): Show[] {
  const map = new Map<string, Show>()
  for (const it of items) {
    const key = it.bgmId ? 'bgm:' + it.bgmId : it.src + ':' + it.id
    const s = map.get(key) ?? { key, title: it.title || '未命名', eps: [], bytes: 0, lastAt: 0 }
    s.eps.push(it)
    s.bytes += it.bytes
    s.lastAt = Math.max(s.lastAt, it.savedAt)
    map.set(key, s)
  }
  return [...map.values()].sort((a, b) => b.lastAt - a.lastAt)
}

const COVER_HUES = ['#9fd3d8,#3f8f99', '#f6c3d3,#c96b8c', '#f3dc9c,#b8861d', '#cfcbe6,#7c74a8']
function coverOf(title: string): string {
  let h = 0
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `linear-gradient(160deg,${COVER_HUES[h % COVER_HUES.length]})`
}

function Cache(): JSX.Element {
  const [items, setItems] = useState<CachedEpisode[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    listCachedEpisodes()
      .then(setItems)
      .catch((err: unknown) => {
        console.error('[media-cache] 列出缓存失败', err)
        toast('读不到本地缓存：' + (err instanceof Error ? err.message : String(err)))
        setItems([])
      })
  }, [])

  const remove = async (list: CachedEpisode[]): Promise<void> => {
    setBusy(true)
    const gone = new Set<string>()
    for (const item of list) {
      try {
        await removeCachedEpisode(item.hash)
        gone.add(item.hash)
      } catch (err) {
        console.error('[media-cache] 删除缓存失败', item.title, item.ep, err)
        toast(`${item.title} 第 ${item.ep} 集没删掉：` + (err instanceof Error ? err.message : String(err)))
      }
    }
    setItems((all) => (all ?? []).filter((x) => !gone.has(x.hash)))
    setPicked((p) => new Set([...p].filter((h) => !gone.has(h))))
    setBusy(false)
  }

  if (!mediaCacheSupported()) return <p className="muted small">这个浏览器存不了视频呢</p>
  if (!items) return <p className="muted small">翻抽屉中</p>

  const used = items.reduce((sum, x) => sum + x.bytes, 0)
  const shows = groupShows(items)
  const pickedItems = items.filter((x) => picked.has(x.hash))
  const toggle = (h: string): void => setPicked((p) => {
    const n = new Set(p)
    if (n.has(h)) n.delete(h)
    else n.add(h)
    return n
  })

  return (
    <div className="ls-drawer">
      <div className="ls-usage">
        <div className="ls-usage-num">{size(used)}<small>{items.length} 集</small></div>
        <div className="ls-meter">
          {used > 0 && shows.map((s) => <span key={s.key} style={{ width: `${(s.bytes / used) * 100}%`, background: coverOf(s.title) }} />)}
        </div>
        {items.length > 0 && <button type="button" className="ls-btn danger" disabled={busy} onClick={() => void remove(items)}>全部清掉</button>}
      </div>
      {items.length === 0 ? (
        <p className="muted small">抽屉还空着，看过的集会自己放进来</p>
      ) : (
        <div className="ls-shows">
          {shows.map((s) => (
            <div key={s.key} className="ls-show">
              <div className="ls-cover" style={{ background: coverOf(s.title) }}>{s.title.slice(0, 1)}</div>
              <div className="ls-show-main">
                <div className="ls-show-title">{s.title}</div>
                <div className="ls-show-meta">{size(s.bytes)} · {ago(s.lastAt)}</div>
                <div className="ls-eps">
                  {s.eps.map((e) => {
                    const cls = ['ls-ep', !e.complete && 'part', e.daysLeft <= 3 && !e.good && 'old', picked.has(e.hash) && 'sel'].filter(Boolean).join(' ')
                    const pct = e.total > 0 ? Math.round((e.bytes / e.total) * 100) : 0
                    const tip = e.good ? '神回，一直留着' : e.complete ? `还能留 ${e.daysLeft} 天` : `下了 ${pct}%`
                    return (
                      <button key={e.hash} type="button" className={cls} style={{ '--p': pct + '%' } as React.CSSProperties} title={tip} onClick={() => toggle(e.hash)}>
                        {e.good && <span className="ls-ep-star">★</span>}
                        {String(e.ep).padStart(2, '0')}
                        <i className="x">×</i>
                      </button>
                    )
                  })}
                </div>
              </div>
              <button type="button" className="ls-show-del" disabled={busy} onClick={() => void remove(s.eps)}>清掉这部</button>
            </div>
          ))}
        </div>
      )}
      {pickedItems.length > 0 && (
        <div className="ls-pick">
          <span>
            选了 {pickedItems.length} 集 · {size(pickedItems.reduce((n, x) => n + x.bytes, 0))}
            {pickedItems.length === 1 && pickedItems[0].complete && <> · <a href={playHref(pickedItems[0])} target="_blank" rel="noopener">播放</a></>}
          </span>
          <button type="button" className="ls-btn" onClick={() => setPicked(new Set())}>算了</button>
          <button type="button" className="ls-btn danger" disabled={busy} onClick={() => void remove(pickedItems)}>清掉</button>
        </div>
      )}
    </div>
  )
}

function Mine({ status }: { status: Load }): JSX.Element | null {
  if (!status || typeof status === 'string') return null
  const measured = status.lines.filter((l) => l.mine > 0 || l.bps > 0)
  const top = Math.max(1, ...measured.flatMap((l) => [l.mine, l.bps]))
  const peak = Math.max(1, ...status.me.days)
  return (
    <div className="ls-contrib">
      <div className="ls-card">
        {measured.length === 0 ? <p className="muted small">哥哥还没在稀饭看过番呢</p> : measured.map((l) => (
          <div key={l.source} className="ls-vs">
            <span>{l.name}</span>
            <div className="ls-track">
              <div className="all" style={{ width: `${(l.bps / top) * 100}%` }} />
              <div className="me" style={{ width: `${(l.mine / top) * 100}%` }} />
            </div>
            <span className="val">{l.mine ? mbps(l.mine) : '—'} / {l.bps ? mbps(l.bps) : '—'}</span>
          </div>
        ))}
        <div className="ls-k"><span><i className="me" />哥哥</span><span><i className="all" />大家</span><span>单位 Mbps</span></div>
      </div>
      <div className="ls-card ls-stamp">
        <div className="ls-stamp-ring"><b>{status.me.n}</b><small>次测速</small></div>
        <p>{status.me.n > 0 ? `哥哥是第 ${status.me.rank} 勤快的观测员呢` : '看一集稀饭的番就能盖上章啦'}</p>
        <div className="ls-dots">
          {status.me.days.map((n, i) => (
            <span key={i} className={n === 0 ? 'd0' : n / peak < 0.34 ? 'd1' : n / peak < 0.67 ? 'd2' : 'd3'} />
          ))}
        </div>
      </div>
    </div>
  )
}

export function RoomPage(): JSX.Element {
  const [status, setStatus] = useState<Load>(null)
  useEffect(() => {
    fetch('/api/player/line-status', { cache: 'no-store' })
      .then(async (r) => {
        if (r.status === 401) return setStatus('login')
        if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.json().catch(() => ({})) as { code?: string }).code ?? ''}`)
        setStatus((await r.json()) as Status)
      })
      .catch((err: unknown) => {
        console.error('[line-status] 读取失败', err)
        setStatus('error')
      })
  }, [])

  return (
    <div className="ls-page">
      <div className="ls-hero">
        <h1 className="title-sketch" style={{ fontSize: 34 }}>纱雾的放映室</h1>
        <img className="ls-avatar" src="/assets/sagiri-avatar.webp" alt="" />
        <div className="ls-bubble">哥哥看番的时候，顺手帮大家量了线路哦</div>
      </div>
      <section className="ls-sec">
        <div className="ls-sec-head">
          <h3>放映机跑得顺不顺</h3>
          <div className="ls-legend"><span><i className="ls-c-fast" />畅通</span><span><i className="ls-c-ok" />偶尔卡</span><span><i className="ls-c-slow" />好慢</span><span><i className="ls-c-none" />没人看</span></div>
        </div>
        <Lines status={status} />
      </section>
      <section className="ls-sec">
        <div className="ls-sec-head"><h3>胶片柜</h3></div>
        <Cache />
      </section>
      <section className="ls-sec">
        <div className="ls-sec-head"><h3>哥哥的贡献</h3></div>
        <Mine status={status} />
      </section>
    </div>
  )
}
