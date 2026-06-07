// 主进程 JSON 持久化助手 —— 把散落各处的 `readFileSync/writeFileSync` 样板收成
// 一处,同时把同步盘 I/O 从事件循环上挪走(同步读写会阻塞**所有** IPC,renderer
// 切 tab / 进设置时正等着这些 IPC 返回,于是放大成可感卡顿)。
//
// 语义对标 renderer 的 utils/deferredStorage.ts:
//   - **内存为唯一权威值**:首次 load 后常驻内存,后续读直接返回内存(读永不碰盘)。
//   - 写合并:同一 tick 内多次 set 由一个 setImmediate 合并成**一次**原子落盘
//     (.tmp + rename),不引入人为延时。
//   - app 退出前(before-quit)若仍有未落盘的脏值,同步兜底写一次防丢。
//   - normalize 必填,一并承担"解析 + 容错 + 默认值"——坏数据 / 缺字段由它收敛,
//     默认值就是 normalize 对空输入(undefined)的返回。

import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { readFile, writeFile, rename } from 'fs/promises'
import { join } from 'path'
import { logError } from './logger'

// 所有实例登记在册,before-quit 时统一同步 flush。
const instances = new Set<JsonStore<unknown>>()
let quitHookInstalled = false

function installQuitHook(): void {
  if (quitHookInstalled) return
  quitHookInstalled = true
  app.on('before-quit', () => {
    for (const s of instances) s.flushSync()
  })
}

export class JsonStore<T> {
  private cache: T | null = null
  private loaded = false
  private dirty = false
  private flushScheduled = false
  private filePathCache: string | null = null

  /**
   * @param filename userData 下的文件名(如 'app_settings.json')。
   * @param normalize 把磁盘原始值收敛成 T;对 undefined / 坏数据返回默认值。
   */
  constructor(
    private readonly filename: string,
    private readonly normalize: (raw: unknown) => T,
  ) {
    instances.add(this as JsonStore<unknown>)
    installQuitHook()
  }

  // 延迟到首次使用再算路径 —— 避免在 app 路径就绪前于构造期求值。
  private filePath(): string {
    if (this.filePathCache === null) {
      this.filePathCache = join(app.getPath('userData'), this.filename)
    }
    return this.filePathCache
  }

  /** 异步读(返回内存权威值,首次会读盘)。启动时 await 一次即可,之后走内存。 */
  async read(): Promise<T> {
    if (this.loaded) return this.cache as T
    try {
      const raw = await readFile(this.filePath(), 'utf-8')
      this.cache = this.normalize(JSON.parse(raw))
    } catch {
      // 文件不存在 / 解析失败 → 交给 normalize 出默认值。
      this.cache = this.normalize(undefined)
    }
    this.loaded = true
    return this.cache as T
  }

  /**
   * 同步内存读 —— 给真正不能 await 的热路径(熔断器命中检查)和早于 app-ready
   * 的启动期 bootstrap 用。未加载过时做一次同步读盘,之后纯内存、瞬时。
   */
  current(): T {
    if (!this.loaded) {
      try {
        const raw = readFileSync(this.filePath(), 'utf-8')
        this.cache = this.normalize(JSON.parse(raw))
      } catch {
        this.cache = this.normalize(undefined)
      }
      this.loaded = true
    }
    return this.cache as T
  }

  /** 替换内存值并安排一次合并落盘。 */
  set(value: T): void {
    this.cache = value
    this.loaded = true
    this.dirty = true
    this.scheduleFlush()
  }

  /** 读-改-写便捷封装(设置项 / cache:set 这类局部更新用)。 */
  update(mutator: (draft: T) => void): void {
    const draft = this.current()
    mutator(draft)
    this.set(draft)
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    setImmediate(() => {
      this.flushScheduled = false
      void this.flushAsync()
    })
  }

  private async flushAsync(): Promise<void> {
    if (!this.dirty) return
    // 先取走脏标记和快照:落盘期间若又有 set,dirty 会被重新置位,落盘后补一轮。
    this.dirty = false
    const tmp = this.filePath() + '.tmp'
    try {
      const data = JSON.stringify(this.cache)
      await writeFile(tmp, data, 'utf-8')
      await rename(tmp, this.filePath())
    } catch (err) {
      this.dirty = true // 写失败保留脏标记,下次还有机会落盘
      logError(`json-store:${this.filename}`, err)
    }
    if (this.dirty) this.scheduleFlush()
  }

  /** before-quit 同步兜底:把未落盘的脏值同步写掉,防止退出丢数据。 */
  flushSync(): void {
    if (!this.dirty || this.cache === null) return
    this.dirty = false
    const tmp = this.filePath() + '.tmp'
    try {
      writeFileSync(tmp, JSON.stringify(this.cache), 'utf-8')
      renameSync(tmp, this.filePath())
    } catch (err) {
      logError(`json-store:${this.filename}`, err)
    }
  }
}
