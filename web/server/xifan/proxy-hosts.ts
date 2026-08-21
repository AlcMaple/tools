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

export function needsProxy(rawUrl: string): boolean {
  try {
    return PROXY_HOSTS.includes(new URL(rawUrl).hostname)
  } catch {
    return false
  }
}
