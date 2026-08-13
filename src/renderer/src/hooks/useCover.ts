import { useEffect, useState } from 'react'

/**
 * 封面解析 —— 把远程封面 URL 解析成本地 `archivist://` 路径(本地没有就后台下载,下载完自动切)。
 *
 * **为什么在显示层做,而不是把本地路径直接存进 track.cover**:track.cover 要跨设备同步,而
 * `archivist://` 路径里含本机的 userData 绝对路径,同步到别的设备那个路径根本不存在、封面就裂了。
 * 所以 track.cover **永远存可移植的 URL**,本地化只在显示时按设备各自做。
 *
 * 模块级 Map 缓存已解析的路径,避免同一封面在多组件 / 多次渲染里重复发 IPC。
 * 下载失败保留原 URL,**不重试**。
 *
 * 缓存键**必须带尺寸** —— 同一封面的列表档和详情档是两条独立缓存,不能互相覆盖。
 */
const resolved = new Map<string, string>()
const resolvedKey = (key: string, maxWidth?: number): string =>
  maxWidth ? `${key}@${maxWidth}` : key

/**
 * @param maxWidth 缓存封面的最大宽度。省略 = 默认缩略尺寸（480，列表/周历用）;
 *   AnimeInfo 详情页大封面传 600 拿更清晰的版本。
 */
export function useCover(
  key: string,
  url: string | undefined,
  maxWidth?: number,
): string | undefined {
  const rkey = resolvedKey(key, maxWidth)
  const [src, setSrc] = useState<string | undefined>(() => {
    if (!url || url.startsWith('archivist://')) return url
    return resolved.get(rkey) ?? url
  })

  useEffect(() => {
    if (!url || url.startsWith('archivist://')) {
      setSrc(url)
      return
    }
    const cached = resolved.get(rkey)
    if (cached) {
      setSrc(cached)
      return
    }
    let cancelled = false
    window.bgmApi
      .cacheCover(key, url, maxWidth)
      .then((local) => {
        if (cancelled || !local || !local.startsWith('archivist://')) return
        resolved.set(rkey, local)
        setSrc(local)
      })
      .catch(() => {
        /* 保留原 URL，不重试 */
      })
    return () => {
      cancelled = true
    }
  }, [rkey, key, url, maxWidth])

  return src
}
