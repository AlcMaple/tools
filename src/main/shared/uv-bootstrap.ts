// libuv 的 fs/crypto/dns 线程池默认只有 4 条线程,且**首次用到时就按当时的
// UV_THREADPOOL_SIZE 创建,之后再改环境变量无效**。所以这必须在主进程最早一刻
// 执行 —— 作为 index.ts 的第一个 import,确保早于其余模块的 fs 副作用。
//
// 调大到 16:媒体库扫描会持续占用若干条 fs 线程,默认 4 条时一旦被占满,封面
// 本地化(cacheCover 读盘)/archivist 读图 / JsonStore 读写就全堵在后面,表现为
// 启动头十几秒"做什么都卡 2 秒"。多给线程 = 扫描和 UI 的 fs 操作各有车道,不互相饿死。
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '16'
}
