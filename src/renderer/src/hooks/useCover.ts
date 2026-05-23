import { useEffect, useState } from 'react'

/**
 * 封面解析 hook —— 把远程封面 URL 解析成本地 `archivist://` 路径（本地没有
 * 就后台下载，下载完自动切到本地）。
 *
 * **为什么在显示层做，而不是把本地路径存进 track.cover：**
 * track.cover 要跨设备 WebDAV 同步。`archivist://` 路径含本机 userData
 * 绝对路径（如 `/Users/macA/Library/.../covers/123.jpg`），同步到别的设备
 * 那个路径根本不存在 → 封面裂开。所以 track.cover **永远存可移植的 URL**,
 * 本地化只在显示时按设备各自做 —— 每台机器自己下到自己的 userData。
 *
 * **统一覆盖所有封面场景**（不用各处单独写下载逻辑）：
 *   - MyAnime 列表（含老数据"回填"：渲染时自动下载，下次走本地）
 *   - Calendar 周历网格
 *   - AnimeInfo 详情页封面
 *
 * 模块级 `resolved` Map 缓存已解析路径，避免同一封面在多组件 / 多次渲染里
 * 重复发 IPC。下载失败保留原 URL（不重试，符合 BGM 集成参考手册原则）。
 *
 * @param key  封面缓存 key（一般 `String(bgmId)`）
 * @param url  原始封面 URL；为 archivist:// 或空时原样返回不处理
 */
// 缓存键带尺寸 —— 同一封面的 480（列表/周历）和 600（详情页）是两条独立
// 缓存条目，不能互相覆盖。
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
