// 在线播放媒体流代理 —— 把远端 mp4 直链在主进程用 Electron net 取回,再以**同源**
// 自定义协议 mtmedia:// 回给渲染进程的 <video>。
//
// 为什么需要它(011 在线观看实测结论,见 DEVLOG):渲染进程的 <video> 直连远端
// mp4 时,能不能播**取决于页面 origin**。dev 下 origin 是 http://localhost:5173,
// Chromium 会拒绝播放带 `content-disposition: attachment` 的**跨源**媒体
// (稀饭主线的 pan.wo.cn 联通网盘签名直链正是这种)→ <video> 直接报 code 4;
// 打包后 origin 是 file:// 不拦,所以只在 dev 挂。根治办法:媒体统一经主进程
// 取流、剥掉 content-disposition,用同源协议回给渲染进程,dev/正式都不受 origin 限制。
//
// 为什么用 net.fetch 而不是 netRequest():netRequest 把整个 body Buffer.concat
// 缓冲,视频几百 MB 会爆内存。这里要边下边播的**流**,net.fetch(同样走 Chromium
// 网络栈 + 系统代理,与红线一致)返回可读流直接透传。redirect 默认 follow
// (apn.moedot.net→pan.wo.cn 的签名跳转靠它跟)。
//
// 注:不缓存最终签名直链、每个 Range 都重走一遍 302 是**故意的**——pan.wo.cn
// 对单条签名链有并发限制,复用一条链去打多个并发 Range 反而会被卡死(实测 rs=0);
// 每个 Range 各拿一条新鲜签名链才稳。302 那点开销远小于卡死的代价。
import { protocol, net } from 'electron'
import { DESKTOP_USER_AGENT } from './download-types'

export const MEDIA_PROXY_SCHEME = 'mtmedia'

// 渲染进程用:把 http(s) 直链包成同源代理 URL 喂给 <video>。非 http(s) 原样返回。
export function toMediaProxyUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url
  return `${MEDIA_PROXY_SCHEME}://media/?u=${encodeURIComponent(url)}`
}

export function registerMediaProxy(): void {
  protocol.handle(MEDIA_PROXY_SCHEME, async (request) => {
    const target = new URL(request.url).searchParams.get('u')
    if (!target || !/^https?:\/\//i.test(target)) return new Response(null, { status: 400 })

    // 只带 UA(与下载器一致,不带 Referer/Cookie);<video> 的 Range 原样转发,
    // moov 在文件尾部的非 faststart mp4 靠它取索引。
    const headers: Record<string, string> = { 'User-Agent': DESKTOP_USER_AGENT }
    const range = request.headers.get('Range')
    if (range) headers['Range'] = range

    // Electron 的 protocol.handle 里 request.signal **不会**在渲染进程取消时触发
    // (实测),所以自己用 AbortController:返回流的 cancel() 里 abort 上游 net.fetch。
    // 否则 seek / 切集 / 销毁 <video> 时被丢弃的直链会在后台继续下载,抢带宽 +
    // 占满 pan.wo.cn 的并发连接,导致下一个视频卡住不动(实测切集必现)。
    const ac = new AbortController()
    try {
      const res = await net.fetch(target, { headers, redirect: 'follow', signal: ac.signal })
      const out = new Headers()
      for (const h of ['content-type', 'content-range', 'accept-ranges', 'content-length']) {
        const v = res.headers.get(h)
        if (v) out.set(h, v)
      }
      // content-disposition 故意**不透传** —— 它正是触发 <video> 跨源拦截的元凶。
      // no-store:签名直链一次性,别让 Chromium 按响应里那个离谱的 1 年 max-age
      // 把它缓存进磁盘(实测能撑到上百 MB 死缓存)。
      out.set('cache-control', 'no-store')

      const reader = res.body?.getReader()
      if (!reader) return new Response(null, { status: 502 })
      const stream = new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          try {
            const { done, value } = await reader.read()
            if (done) { ctrl.close(); return }
            ctrl.enqueue(value)
          } catch (e) { ctrl.error(e as Error) }
        },
        cancel() {
          ac.abort()
          reader.cancel().catch(() => { /* 已断开 */ })
        },
      })
      return new Response(stream, { status: res.status, headers: out })
    } catch {
      return new Response(null, { status: 502 })
    }
  })
}
