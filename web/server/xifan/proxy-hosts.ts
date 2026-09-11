// 哪些源站必须走服务端并发代理 —— 单独成文件，因为解析层(resolve.ts)和传输层(stream.ts)
// 都要用它，而 resolve.ts 不该为了一个常量把 undici Agent 那一坨拖进自己的 import 图。
//
// **判据是 hostname，不是线路编号**：线路号和源站没有固定对应关系——实测 animeId=3498
// 的「线路一」就是 play.xfvod.pro(快源直连)，而 3535 的线路一才是 apn.moedot.net。
// 按线路号选默认线路是错的，必须按域名。
//
// 两个理由决定一个域名要不要进这份名单：
//   1. 它是不是**真的需要加速**（apn.moedot.net → 联通网盘，单路 1.4Mbps，非并发不可）；
//   2. 服务器出口只有 6Mbps(约 2.2 人份)，是最稀缺的资源。能直连的一律别占它
//      （play.xfvod.pro 直连实测 30Mbps、给全套 CORS、不按连接限速）。
export const PROXY_HOSTS = ['apn.moedot.net']

// 「快源」只是从 VPS / 电脑看是快的。Sentry 里 iPhone 直连 play.xfvod.pro:8088 的胶片：
// 播放中 buffered 一秒不涨、耗光后 30 秒零字节、64KB 探测要 4.8s——非标端口在部分
// 手机运营商网络上就是这么慢。这些域名**默认仍直连**，只在播放页实测直连喂不饱时
// 才允许临时改走服务端（/prepared?rescue=1、/stream），不算进「必须代理」名单。
export const RESCUE_HOSTS = ['play.xfvod.pro']

function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname
  } catch {
    return ''
  }
}

export function needsProxy(rawUrl: string): boolean {
  return PROXY_HOSTS.includes(hostOf(rawUrl))
}

// 服务端代理 / 预转愿意接的全部域名 = 必须代理 + 可救援。
export function canProxy(rawUrl: string): boolean {
  const host = hostOf(rawUrl)
  return PROXY_HOSTS.includes(host) || RESCUE_HOSTS.includes(host)
}
