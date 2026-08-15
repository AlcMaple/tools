/**
 * BGM 桌面端离线动画索引。
 *
 * 边界刻意分明：
 * - 普通搜索只扫描已加载的本地快照，这个模块的搜索路径绝不发网络请求。
 * - 网络只用于启动后的一次静默索引更新，且只访问固定 GitHub Release tag 下的
 *   两个固定资产，不接受 manifest 下发的任意 URL。
 * - 新档先在内存中完整校验，再落成版本化 gzip，最后原子替换 pointer。整个过程
 *   中旧 snapshot 始终可搜，任一步失败都不切换。
 */

import { app } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzip } from 'node:zlib'
import { netRequest } from '../shared/net-request'
import { logError, logInfo } from '../shared/logger'
import type { BgmSearchCat, BgmSearchResult } from './search'

const SCHEMA_VERSION = 1 as const
const RELEASE_TAG = 'bgm-offline-index'
const INDEX_ASSET = 'bgm-offline-index-v1.json.gz'
const MANIFEST_ASSET = 'bgm-offline-index-manifest.json'
const REPO_RELEASE_BASE =
  `https://github.com/AlcMaple/tools/releases/download/${RELEASE_TAG}/`
const DOWNLOAD_CHANNELS = [
  { name: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
  { name: 'ghfast.top', prefix: 'https://ghfast.top/' },
  { name: 'github.com', prefix: '' },
] as const

const MANIFEST_MAX_BYTES = 256 * 1024
const INDEX_MAX_COMPRESSED_BYTES = 64 * 1024 * 1024
const INDEX_MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024
const SUCCESS_CHECK_TTL_MS = 24 * 60 * 60 * 1000
const STARTUP_UPDATE_DELAY_MS = 8_000

type OfflineTuple = [
  id: number,
  name: string,
  nameCn: string,
  aliases: string[],
  date: string,
  score: number,
]

interface IndexDocument {
  schemaVersion: typeof SCHEMA_VERSION
  builtAt: string
  items: OfflineTuple[]
}

interface SourceMetadata {
  name: string
  createdAt: string
  digest: string
}

interface IndexManifest {
  schemaVersion: typeof SCHEMA_VERSION
  builtAt: string
  count: number
  compressedSize: number
  sha256: string
  source: SourceMetadata
}

interface IndexPointer extends IndexManifest {
  file: string
  checkedAt: number
}

interface PreparedItem {
  id: number
  name: string
  nameCn: string
  aliases: string[]
  date: string
  score: number
  nameNorm: string
  nameCnNorm: string
  aliasNorms: string[]
}

interface ActiveSnapshot {
  archivePath: string
  builtAt: string
  count: number
  compressedSize: number
  sha256: string
  source: SourceMetadata
  items: PreparedItem[]
}

export interface BgmOfflineSearchResponse {
  items: BgmSearchResult[]
  ready: boolean
  supported: boolean
}

export type BgmOfflineIndexUpdateResult =
  | { status: 'skipped'; reason: 'checked-recently'; count: number }
  | { status: 'up-to-date'; count: number }
  | { status: 'updated'; count: number }
  | { status: 'unavailable'; reason: string }

let activeSnapshot: ActiveSnapshot | null = null
let currentPointer: IndexPointer | null = null
let loadPromise: Promise<boolean> | null = null
let updatePromise: Promise<BgmOfflineIndexUpdateResult> | null = null
let updateScheduleStarted = false

function indexDir(): string {
  return join(app.getPath('userData'), 'bgm-offline-index')
}

function pointerPath(): string {
  return join(indexDir(), 'current.json')
}

function versionedFileName(sha256: string): string {
  return `bgm-offline-index-v1-${sha256}.json.gz`
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

/** 拉丁/数字保留连续词，CJK 拆相邻二元组；和 Web 离线搜索保持同一语义。 */
function queryGrams(query: string): string[] {
  const normalized = normalizeText(query)
  const result = new Set<string>()
  for (const word of normalized.match(/[a-z0-9]+/g) ?? []) {
    if (word.length >= 2) result.add(word)
  }
  const cjk = normalized.replace(
    /[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu,
    ' ',
  )
  for (const segment of cjk.split(/\s+/)) {
    if (!segment) continue
    if (segment.length === 1) {
      result.add(segment)
      continue
    }
    for (let i = 0; i < segment.length - 1; i += 1) {
      result.add(segment.slice(i, i + 2))
    }
  }
  return [...result].slice(0, 16)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

function parseSource(value: unknown): SourceMetadata {
  if (!isRecord(value)) throw new Error('manifest.source 不是对象')
  const { name, createdAt, digest } = value
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('manifest.source.name 无效')
  }
  if (!isIsoDate(createdAt)) throw new Error('manifest.source.createdAt 无效')
  if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(digest)) {
    throw new Error('manifest.source.digest 无效')
  }
  return { name, createdAt, digest: digest.toLowerCase() }
}

function parseManifest(value: unknown): IndexManifest {
  if (!isRecord(value)) throw new Error('manifest 不是对象')
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`manifest schemaVersion 不支持：${String(value.schemaVersion)}`)
  }
  if (!isIsoDate(value.builtAt)) throw new Error('manifest.builtAt 无效')
  if (!Number.isSafeInteger(value.count) || (value.count as number) <= 0) {
    throw new Error('manifest.count 无效')
  }
  if (
    !Number.isSafeInteger(value.compressedSize)
    || (value.compressedSize as number) <= 0
    || (value.compressedSize as number) > INDEX_MAX_COMPRESSED_BYTES
  ) {
    throw new Error('manifest.compressedSize 超出限制')
  }
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256)) {
    throw new Error('manifest.sha256 无效')
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    builtAt: value.builtAt,
    count: value.count as number,
    compressedSize: value.compressedSize as number,
    sha256: value.sha256.toLowerCase(),
    source: parseSource(value.source),
  }
}

function parsePointer(value: unknown): IndexPointer {
  if (!isRecord(value)) throw new Error('pointer 不是对象')
  const manifest = parseManifest(value)
  const expectedFile = versionedFileName(manifest.sha256)
  if (value.file !== expectedFile) throw new Error('pointer.file 与 sha256 不匹配')
  if (!Number.isSafeInteger(value.checkedAt) || (value.checkedAt as number) < 0) {
    throw new Error('pointer.checkedAt 无效')
  }
  return { ...manifest, file: expectedFile, checkedAt: value.checkedAt as number }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function unzip(bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzip(bytes, { maxOutputLength: INDEX_MAX_UNCOMPRESSED_BYTES }, (error, result) => {
      if (error) reject(error)
      else resolve(result)
    })
  })
}

function validateTuple(value: unknown, seenIds: Set<number>): OfflineTuple {
  if (!Array.isArray(value) || value.length !== 6) {
    throw new Error('索引 item 不是 6 字段 tuple')
  }
  const [id, name, nameCn, aliases, date, score] = value
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('索引 item.id 无效')
  if (seenIds.has(id)) throw new Error(`索引包含重复 id：${id}`)
  if (typeof name !== 'string' || typeof nameCn !== 'string' || (!name.trim() && !nameCn.trim())) {
    throw new Error(`索引 item ${id} 的标题无效`)
  }
  if (!Array.isArray(aliases) || !aliases.every((alias) => typeof alias === 'string')) {
    throw new Error(`索引 item ${id} 的 aliases 无效`)
  }
  if (typeof date !== 'string') throw new Error(`索引 item ${id} 的 date 无效`)
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 10) {
    throw new Error(`索引 item ${id} 的 score 无效`)
  }
  seenIds.add(id)
  return [id, name, nameCn, aliases, date, score]
}

async function parseArchive(
  compressed: Buffer,
  expected?: IndexManifest,
): Promise<{ document: IndexDocument; items: PreparedItem[]; digest: string }> {
  if (compressed.byteLength <= 0 || compressed.byteLength > INDEX_MAX_COMPRESSED_BYTES) {
    throw new Error('索引压缩文件大小非法')
  }
  const digest = sha256(compressed)
  if (expected) {
    if (compressed.byteLength !== expected.compressedSize) {
      throw new Error(
        `索引压缩大小不符：${compressed.byteLength}/${expected.compressedSize}`,
      )
    }
    if (digest !== expected.sha256) throw new Error('索引 SHA-256 校验失败')
  }

  const raw = await unzip(compressed)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('索引 gzip 内不是合法 JSON')
  }
  if (!isRecord(parsed)) throw new Error('索引 JSON 根节点不是对象')
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`索引 schemaVersion 不支持：${String(parsed.schemaVersion)}`)
  }
  if (!isIsoDate(parsed.builtAt)) throw new Error('索引 builtAt 无效')
  if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
    throw new Error('索引 items 为空')
  }
  if (expected && parsed.builtAt !== expected.builtAt) {
    throw new Error('索引 builtAt 与 manifest 不一致')
  }
  if (expected && parsed.items.length !== expected.count) {
    throw new Error(`索引条数不符：${parsed.items.length}/${expected.count}`)
  }

  const seenIds = new Set<number>()
  const tuples = parsed.items.map((item) => validateTuple(item, seenIds))
  const items = tuples.map(([id, name, nameCn, aliases, date, score]) => ({
    id,
    name,
    nameCn,
    aliases,
    date,
    score,
    nameNorm: normalizeText(name),
    nameCnNorm: normalizeText(nameCn),
    aliasNorms: aliases.map(normalizeText),
  }))
  return {
    document: { schemaVersion: SCHEMA_VERSION, builtAt: parsed.builtAt, items: tuples },
    items,
    digest,
  }
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

async function loadCurrentSnapshot(): Promise<boolean> {
  let pointerBytes: Buffer
  try {
    pointerBytes = await readFile(pointerPath())
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
  const pointer = parsePointer(JSON.parse(pointerBytes.toString('utf8')) as unknown)
  const archivePath = join(indexDir(), pointer.file)
  const compressed = await readFile(archivePath)
  const parsed = await parseArchive(compressed, pointer)
  activeSnapshot = {
    archivePath,
    builtAt: pointer.builtAt,
    count: pointer.count,
    compressedSize: pointer.compressedSize,
    sha256: pointer.sha256,
    source: pointer.source,
    items: parsed.items,
  }
  currentPointer = pointer
  logInfo('bgm:offline-index', `已加载用户索引：${pointer.count} 条`)
  return true
}

function seedDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bgm-offline-index')
    : join(__dirname, '../../resources/bgm-offline-index')
}

async function loadSeedSnapshot(): Promise<boolean> {
  const archivePath = join(seedDir(), INDEX_ASSET)
  let compressed: Buffer
  try {
    compressed = await readFile(archivePath)
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }

  // 发版包会同时带 manifest；为了便于 dev 中只投放一个 fixture gzip，manifest
  // 缺失时仍做完整的 gzip/schema/tuple/唯一 ID 校验，但不跳过任何档内校验。
  let manifest: IndexManifest | null = null
  try {
    const manifestBytes = await readFile(join(seedDir(), MANIFEST_ASSET))
    if (manifestBytes.byteLength > MANIFEST_MAX_BYTES) throw new Error('种子 manifest 过大')
    manifest = parseManifest(JSON.parse(manifestBytes.toString('utf8')) as unknown)
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }

  const parsed = await parseArchive(compressed, manifest ?? undefined)
  const fallbackSource: SourceMetadata = {
    name: 'packaged-seed',
    createdAt: parsed.document.builtAt,
    digest: `sha256:${parsed.digest}`,
  }
  activeSnapshot = {
    archivePath,
    builtAt: parsed.document.builtAt,
    count: parsed.items.length,
    compressedSize: compressed.byteLength,
    sha256: parsed.digest,
    source: manifest?.source ?? fallbackSource,
    items: parsed.items,
  }
  currentPointer = null
  logInfo('bgm:offline-index', `已加载内置索引：${parsed.items.length} 条`)
  return true
}

async function loadInitialSnapshot(): Promise<boolean> {
  try {
    if (await loadCurrentSnapshot()) return true
  } catch (error) {
    // current 坏了不应拖死内置种子；保留原文件，只记日志并降级。
    logError('bgm:offline-index:load-current', error)
  }
  try {
    return await loadSeedSnapshot()
  } catch (error) {
    logError('bgm:offline-index:load-seed', error)
    return false
  }
}

/** 显式可测的加载入口；同一会话共享一次加载，避免重复解压 3 万条数据。 */
export function loadBgmOfflineIndex(): Promise<boolean> {
  if (!loadPromise) loadPromise = loadInitialSnapshot()
  return loadPromise
}

/**
 * 只搜主进程内存，不触发加载等待，更不会发网络请求。
 * 书籍(cat=1)没有离线库；supported=false，ready 仍如实表示动画库状态。
 */
export function searchBgmOffline(
  keyword: string,
  cat: BgmSearchCat = 2,
): BgmOfflineSearchResponse {
  const snapshot = activeSnapshot
  const ready = snapshot !== null
  if (cat !== 2) return { items: [], ready, supported: false }
  if (!snapshot) return { items: [], ready: false, supported: true }

  const query = normalizeText(keyword)
  if (!query) return { items: [], ready: true, supported: true }
  const grams = queryGrams(query)
  // 与 Web 搜索一致：纯标点/单个拉丁字符没有可用 gram，直接返空。
  if (grams.length === 0) return { items: [], ready: true, supported: true }

  const matches: Array<{ item: PreparedItem; rank: number; gramHits: number }> = []
  for (const item of snapshot.items) {
    const fields = [item.nameNorm, item.nameCnNorm, ...item.aliasNorms]
    let gramHits = 0
    for (const gram of grams) {
      if (fields.some((field) => field.includes(gram))) gramHits += 1
    }
    if (gramHits === 0) continue

    let rank = 0
    if (item.nameNorm === query || item.nameCnNorm === query) rank = 3
    else if (item.nameNorm.startsWith(query) || item.nameCnNorm.startsWith(query)) rank = 2
    else if (fields.some((field) => field.includes(query))) rank = 1
    matches.push({ item, rank, gramHits })
  }

  matches.sort((a, b) =>
    b.rank - a.rank
    || b.gramHits - a.gramHits
    || b.item.score - a.item.score
    || b.item.id - a.item.id,
  )

  return {
    ready: true,
    supported: true,
    // 离线库无在线风控过滤，也不做 30 条截断：所有本地命中原样返回。
    items: matches.map(({ item }) => ({
      title: item.nameCn.trim() || item.name.trim(),
      date: item.date || '未知日期',
      rate: item.score > 0 ? String(item.score) : 'N/A',
      link: `https://bgm.tv/subject/${item.id}`,
    })),
  }
}

function fixedReleaseUrl(
  asset: typeof INDEX_ASSET | typeof MANIFEST_ASSET,
  prefix: string,
  cacheKey: string,
): string {
  // 固定 tag 的资产会被原地覆盖，URL path 不变。query 只作为缓存版本键，仍然只访问
  // 写死的代理 / GitHub host 与写死的资产路径，不给远端 manifest 下发 URL 的能力。
  return `${prefix}${REPO_RELEASE_BASE}${asset}?mapletools_bgm_index=${encodeURIComponent(cacheKey)}`
}

async function downloadBounded(url: string, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  const response = await netRequest(url, {
    timeoutMs,
    maxBytes,
    headers: { 'User-Agent': `MapleTools-BgmOfflineIndex/${app.getVersion()}` },
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`)
  }
  if (response.body.byteLength <= 0 || response.body.byteLength > maxBytes) {
    throw new Error(`响应体 ${response.body.byteLength} 超出限制 ${maxBytes}`)
  }
  return response.body
}

interface ManifestCandidate {
  channelName: string
  authoritative: boolean
  manifest: IndexManifest
}

function manifestIdentity(manifest: IndexManifest): string {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    builtAt: manifest.builtAt,
    count: manifest.count,
    compressedSize: manifest.compressedSize,
    sha256: manifest.sha256,
    source: manifest.source,
  })
}

async function discoverManifest(): Promise<IndexManifest> {
  // 三个小 manifest 并行收集，不能让第一个「语法合法但被代理缓存的旧版本」截断
  // 后续通道。每轮 query 都不同，避免固定 mutable release URL 被长期命中旧缓存。
  const cacheKey = `manifest-${Date.now()}`
  const attempts = await Promise.all(DOWNLOAD_CHANNELS.map(async (channel) => {
    try {
      const bytes = await downloadBounded(
        fixedReleaseUrl(MANIFEST_ASSET, channel.prefix, cacheKey),
        MANIFEST_MAX_BYTES,
        12_000,
      )
      const candidate: ManifestCandidate = {
        channelName: channel.name,
        authoritative: channel.prefix === '',
        manifest: parseManifest(JSON.parse(bytes.toString('utf8')) as unknown),
      }
      return { ok: true, candidate } as const
    } catch (error) {
      return {
        ok: false,
        failure: `${channel.name}: ${error instanceof Error ? error.message : String(error)}`,
      } as const
    }
  }))

  const candidates: ManifestCandidate[] = []
  const failures: string[] = []
  for (const attempt of attempts) {
    if (attempt.ok) candidates.push(attempt.candidate)
    else failures.push(attempt.failure)
  }
  if (candidates.length === 0) {
    throw new Error(`全部 manifest 通道失败（${failures.join(' | ')}）`)
  }

  // github.com 直连只要可用就是权威：代理不能因缓存更新或更新的时间戳而覆盖直连观测。
  // query 已避开固定 tag 的 CDN 缓存，若直连不可用才在代理间挑选最新快照。
  const authoritative = candidates.find((candidate) => candidate.authoritative)
  if (authoritative) {
    const disagreement = candidates.some(
      (candidate) => manifestIdentity(candidate.manifest) !== manifestIdentity(authoritative.manifest),
    )
    if (disagreement) {
      logError(
        'bgm:offline-index:manifest-conflict',
        `代理副本与 github.com 直连不一致，采用 github.com：${authoritative.manifest.builtAt}`,
      )
    }
    logInfo(
      'bgm:offline-index:manifest',
      `采用 github.com：${authoritative.manifest.builtAt}（可用通道 ${candidates.length}）`,
    )
    return authoritative.manifest
  }

  const latestBuiltAtMs = Math.max(
    ...candidates.map(({ manifest }) => Date.parse(manifest.builtAt)),
  )
  const latest = candidates.filter(
    ({ manifest }) => Date.parse(manifest.builtAt) === latestBuiltAtMs,
  )
  const firstLatest = latest[0]
  if (!firstLatest) throw new Error('manifest builtAt 排序失败')
  const identities = new Set(latest.map(({ manifest }) => manifestIdentity(manifest)))
  if (identities.size > 1) {
    // 没有权威直连时，互相冲突的代理不应随机选择一份。
    throw new Error(
      `最新 manifest 元数据冲突且 GitHub 直连不可用（${latest.map((item) => item.channelName).join(', ')}）`,
    )
  }

  const selected = firstLatest
  logInfo(
    'bgm:offline-index:manifest',
    `采用 ${selected.channelName}：${selected.manifest.builtAt}（可用通道 ${candidates.length}）`,
  )
  return selected.manifest
}

async function downloadAndValidateIndexAsset(
  manifest: IndexManifest,
): Promise<{ compressed: Buffer; items: PreparedItem[] }> {
  const failures: string[] = []
  for (const channel of DOWNLOAD_CHANNELS) {
    try {
      const compressed = await downloadBounded(
        // hash 既是缓存版本键，也是下载后必须通过的内容校验。发布新资产后 URL query
        // 随内容变化，旧代理缓存不会继续冒充新文件。
        fixedReleaseUrl(INDEX_ASSET, channel.prefix, `index-${manifest.sha256}`),
        INDEX_MAX_COMPRESSED_BYTES,
        60_000,
      )
      // 代理可能缓存了旧的固定 tag 资产：HTTP 200 不等于这一份就是当前
      // manifest 指向的新快照。大小/hash/gzip/schema/tuple 都在通道内校验，失败
      // 继续下一源，不让第一个过期 200 截断回退链。
      const parsed = await parseArchive(compressed, manifest)
      return { compressed, items: parsed.items }
    } catch (error) {
      failures.push(`${channel.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`全部索引通道失败（${failures.join(' | ')}）`)
}

function temporaryPath(finalPath: string): string {
  return `${finalPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
}

async function atomicWrite(finalPath: string, data: string | Buffer): Promise<void> {
  const tmp = temporaryPath(finalPath)
  try {
    await writeFile(tmp, data)
    await rename(tmp, finalPath)
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
}

async function cleanupOldArchives(currentFile: string): Promise<void> {
  try {
    const names = await readdir(indexDir())
    const stale = names.filter((name) =>
      name !== currentFile
      && /^bgm-offline-index-v1-[a-f0-9]{64}\.json\.gz$/.test(name),
    )
    const outcomes = await Promise.allSettled(
      stale.map((name) => unlink(join(indexDir(), name))),
    )
    for (let i = 0; i < outcomes.length; i += 1) {
      const outcome = outcomes[i]
      if (outcome.status === 'rejected') {
        logError('bgm:offline-index:cleanup', `${stale[i]}: ${String(outcome.reason)}`)
      }
    }
  } catch (error) {
    // 清理只是防周更累积，pointer 已经成功切换后不能因此回滚。
    logError('bgm:offline-index:cleanup', error)
  }
}

async function persistSnapshot(
  compressed: Buffer,
  manifest: IndexManifest,
  preparedItems: PreparedItem[],
  checkedAt: number,
): Promise<void> {
  await mkdir(indexDir(), { recursive: true })
  const file = versionedFileName(manifest.sha256)
  const archivePath = join(indexDir(), file)
  await atomicWrite(archivePath, compressed)
  const pointer: IndexPointer = { ...manifest, file, checkedAt }
  await atomicWrite(pointerPath(), `${JSON.stringify(pointer, null, 2)}\n`)

  // pointer 成功落盘才切内存 snapshot；此前任何失败都继续服务旧数据。
  activeSnapshot = {
    archivePath,
    builtAt: manifest.builtAt,
    count: manifest.count,
    compressedSize: manifest.compressedSize,
    sha256: manifest.sha256,
    source: manifest.source,
    items: preparedItems,
  }
  currentPointer = pointer
  await cleanupOldArchives(file)
}

async function markSuccessfulCheck(manifest: IndexManifest, checkedAt: number): Promise<void> {
  const snapshot = activeSnapshot
  if (!snapshot) return

  if (currentPointer?.sha256 === manifest.sha256) {
    // userData 里已是这一版：只原子更新小 pointer。不重写同名 gzip，
    // 避免 Windows 上杀软/索引程序短暂占用文件时把「已是最新」误报成更新失败。
    const pointer: IndexPointer = {
      ...manifest,
      file: currentPointer.file,
      checkedAt,
    }
    await atomicWrite(pointerPath(), `${JSON.stringify(pointer, null, 2)}\n`)
    activeSnapshot = { ...snapshot, source: manifest.source }
    currentPointer = pointer
    await cleanupOldArchives(pointer.file)
    return
  }

  const compressed = await readFile(snapshot.archivePath)
  if (compressed.byteLength !== manifest.compressedSize || sha256(compressed) !== manifest.sha256) {
    throw new Error('已加载索引与远程 manifest 不一致')
  }
  // 内置 seed 与远程版本相同时，也把它提升为 userData 版本化文件，
  // 才能持久化 checkedAt 并在下次启动跳过 24h 内的重复检查。
  await persistSnapshot(compressed, manifest, snapshot.items, checkedAt)
}

async function runUpdateCheck(): Promise<BgmOfflineIndexUpdateResult> {
  await loadBgmOfflineIndex()
  const now = Date.now()
  if (
    currentPointer
    && now >= currentPointer.checkedAt
    && now - currentPointer.checkedAt < SUCCESS_CHECK_TTL_MS
  ) {
    return { status: 'skipped', reason: 'checked-recently', count: currentPointer.count }
  }

  try {
    const manifest = await discoverManifest()
    const old = activeSnapshot
    if (old && manifest.count < old.count * 0.9) {
      throw new Error(`新索引条数 ${manifest.count} 低于旧库 ${old.count} 的 90%`)
    }

    if (old && manifest.sha256 === old.sha256) {
      if (
        manifest.count !== old.count
        || manifest.compressedSize !== old.compressedSize
        || manifest.builtAt !== old.builtAt
      ) {
        throw new Error('相同 SHA-256 的 manifest 元数据与当前库不一致')
      }
      await markSuccessfulCheck(manifest, now)
      logInfo('bgm:offline-index:update', `索引已是最新：${old.count} 条`)
      return { status: 'up-to-date', count: old.count }
    }

    if (old && Date.parse(manifest.builtAt) < Date.parse(old.builtAt)) {
      throw new Error(`拒绝回退索引：${manifest.builtAt} < ${old.builtAt}`)
    }

    const downloaded = await downloadAndValidateIndexAsset(manifest)
    // 下载完后再做一次 90% 检查，使判断直接绑定到实际解压条数。
    if (old && downloaded.items.length < old.count * 0.9) {
      throw new Error(`实际索引条数 ${downloaded.items.length} 低于旧库 ${old.count} 的 90%`)
    }
    await persistSnapshot(downloaded.compressed, manifest, downloaded.items, now)
    logInfo('bgm:offline-index:update', `已更新离线索引：${downloaded.items.length} 条`)
    return { status: 'updated', count: downloaded.items.length }
  } catch (error) {
    logError('bgm:offline-index:update', error)
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 单轮更新入口：并发调用共享同一轮；本轮结束即释放，供下一次 24h 调度重新检查。 */
export function checkForBgmOfflineIndexUpdate(): Promise<BgmOfflineIndexUpdateResult> {
  if (updatePromise) return updatePromise
  const round = runUpdateCheck()
  updatePromise = round
  const clearRound = (): void => {
    if (updatePromise === round) updatePromise = null
  }
  void round.then(clearRound, clearRound)
  return round
}

function nextScheduledDelay(result: BgmOfflineIndexUpdateResult): number {
  if (result.status !== 'skipped' || !currentPointer) return SUCCESS_CHECK_TTL_MS
  // 启动时若刚成功检查过，不应从「这次 skip」重新算完整 24h；只等 pointer
  // 剩余 TTL，避免在 23h59m 重启一次后把下一次检查推迟到近 48h。
  const elapsed = Math.max(0, Date.now() - currentPointer.checkedAt)
  return Math.max(1_000, SUCCESS_CHECK_TTL_MS - elapsed)
}

function scheduleUpdateCheck(delayMs: number): void {
  setTimeout(() => {
    const round = checkForBgmOfflineIndexUpdate()
    void round.then(
      (result) => scheduleUpdateCheck(nextScheduledDelay(result)),
      (error) => {
        // runUpdateCheck 正常会把失败收敛成 unavailable；这里仅兜住意外 reject。
        // 失败后不立即重试，下一轮仍严格等 24 小时。
        logError('bgm:offline-index:schedule', error)
        scheduleUpdateCheck(SUCCESS_CHECK_TTL_MS)
      },
    )
  }, delayMs)
}

/** app ready 后调用：本地加载立即开始；8s 后首查，之后每 24h 最多一轮。 */
export function setupBgmOfflineIndex(): void {
  void loadBgmOfflineIndex()
  if (updateScheduleStarted) return
  updateScheduleStarted = true
  scheduleUpdateCheck(STARTUP_UPDATE_DELAY_MS)
}
