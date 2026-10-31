import { useEffect, useState } from 'react'
import { listCachedEpisodes, mediaCacheSupported, removeCachedEpisode, type CachedEpisode } from './mediaCache'
import { toast } from './Toast'

function size(bytes: number): string {
  return bytes >= 1024 ** 3 ? (bytes / 1024 ** 3).toFixed(2) + ' GB' : Math.round(bytes / 1024 ** 2) + ' MB'
}

function playHref(item: CachedEpisode): string {
  const q = new URLSearchParams({ src: item.src, id: item.id, ep: String(item.ep) })
  if (item.bgmId) q.set('bgmId', String(item.bgmId))
  return '/api/player/page?' + q.toString()
}

export function MediaCacheModule(): JSX.Element {
  const [items, setItems] = useState<CachedEpisode[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = (): void => {
    listCachedEpisodes()
      .then(setItems)
      .catch((err: unknown) => {
        console.error('[media-cache] 列出缓存失败', err)
        toast('读不到本地缓存：' + (err instanceof Error ? err.message : String(err)))
        setItems([])
      })
  }
  useEffect(load, [])

  const remove = async (item: CachedEpisode): Promise<void> => {
    setBusy(item.hash)
    try {
      await removeCachedEpisode(item.hash)
      setItems((list) => (list ?? []).filter((x) => x.hash !== item.hash))
    } catch (err) {
      console.error('[media-cache] 删除缓存失败', item.title, item.ep, err)
      toast('没删掉：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(null)
    }
  }

  if (!mediaCacheSupported()) return <p className="muted small" style={{ paddingTop: 10 }}>这个浏览器不支持本地缓存</p>
  if (!items) return <p className="muted small" style={{ paddingTop: 10 }}>读取中</p>

  const used = items.reduce((sum, x) => sum + x.bytes, 0)
  return (
    <div className="mc-module">
      <div className="kv-row">
        <span className="kv-label">已用空间</span>
        <span className="kv-val">{size(used)} · {items.length} 集</span>
      </div>
      {items.length === 0 ? (
        <p className="muted small mt8">还没有缓存的视频</p>
      ) : (
        <ul className="mc-list">
          {items.map((item) => (
            <li key={item.hash} className="mc-row">
              <div className="mc-main">
                <b className="mc-title">{item.title || '未命名'}</b>
                <span className="mc-meta">
                  EP {item.ep} · {size(item.bytes)}
                  {!item.complete && (item.total > 0 ? ' / ' + size(item.total) : ' · 下载中')}
                  {' · '}
                  {item.good ? <span className="mc-good">★ 神回，一直保留</span> : `还剩 ${item.daysLeft} 天`}
                </span>
              </div>
              {item.complete && (
                <a className="btn btn-sm" href={playHref(item)} target="_blank" rel="noopener">
                  播放
                </a>
              )}
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy === item.hash} onClick={() => void remove(item)}>
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
