#!/usr/bin/env node

/**
 * Build the compact, read-only Bangumi animation search index shipped with the
 * desktop app. The production path downloads the official bangumi/Archive
 * snapshot; --file is intentionally available for small local fixtures.
 *
 * Usage:
 *   node scripts/build-bgm-offline-index.mjs
 *   node scripts/build-bgm-offline-index.mjs --file subject.jsonlines --out-dir ./tmp
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const LATEST_URL = 'https://raw.githubusercontent.com/bangumi/Archive/master/aux/latest.json'
const INDEX_FILE = 'bgm-offline-index-v1.json.gz'
const MANIFEST_FILE = 'bgm-offline-index-manifest.json'
const SCHEMA_VERSION = 1
const MIN_PRODUCTION_ITEMS = 10_000

function usage() {
  return [
    '用法：',
    '  node scripts/build-bgm-offline-index.mjs [--out-dir <目录>]',
    '  node scripts/build-bgm-offline-index.mjs --file <subject.jsonlines> [--out-dir <目录>]',
    '',
    '--file 模式用于本地 fixture，不执行生产库 10000 条下限。',
  ].join('\n')
}

function parseArgs(argv) {
  const options = {
    file: '',
    outDir: resolve('resources/bgm-offline-index'),
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    }
    if (arg === '--file' || arg === '--out-dir') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} 缺少值\n${usage()}`)
      }
      if (arg === '--file') options.file = resolve(value)
      else options.outDir = resolve(value)
      i += 1
      continue
    }
    throw new Error(`未知参数：${arg}\n${usage()}`)
  }

  return options
}

function parseAliasesFromWiki(infobox) {
  if (typeof infobox !== 'string') return []
  const match = infobox.match(/\|\s*别名\s*=\s*(\{[\s\S]*?\}|[^\n|]*)/)
  if (!match) return []

  const raw = match[1].trim()
  const aliases = raw.startsWith('{')
    ? (raw.match(/\[([^\]]+)\]/g) ?? []).map((item) => item.slice(1, -1).split('|')[0].trim())
    : [raw]

  return [...new Set(aliases.filter(Boolean))]
}

function normalizeItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'bad' }
  }
  const type = Number(value.type)
  if (!Number.isInteger(type) || type <= 0) return { kind: 'bad' }
  if (type !== 2) return { kind: 'other-type' }

  const id = Number(value.id)
  if (!Number.isSafeInteger(id) || id <= 0) return { kind: 'bad' }

  // schema v1 tuple: [id, name, name_cn, aliases, date, score]
  return {
    kind: 'item',
    item: [
      id,
      typeof value.name === 'string' ? value.name : '',
      typeof value.name_cn === 'string' ? value.name_cn : '',
      parseAliasesFromWiki(value.infobox),
      typeof value.date === 'string' ? value.date : '',
      Number.isFinite(Number(value.score)) ? Number(value.score) : 0,
    ],
  }
}

async function collectItems(lines) {
  const byId = new Map()
  let nonEmptyLines = 0
  let invalidLines = 0
  let ignoredTypes = 0

  for await (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    nonEmptyLines += 1

    let value
    try {
      value = JSON.parse(line)
    } catch {
      invalidLines += 1
      continue
    }

    const normalized = normalizeItem(value)
    if (normalized.kind === 'other-type') {
      ignoredTypes += 1
      continue
    }
    if (normalized.kind === 'bad') {
      invalidLines += 1
      continue
    }
    byId.set(normalized.item[0], normalized.item)
  }

  const allowedInvalidLines = Math.max(5, Math.ceil(nonEmptyLines * 0.001))
  if (invalidLines > allowedInvalidLines) {
    throw new Error(
      `坏行过多：${invalidLines}/${nonEmptyLines}（允许最多 ${allowedInvalidLines} 行），拒绝生成索引`,
    )
  }

  const items = [...byId.values()].sort((a, b) => a[0] - b[0])
  if (items.length === 0) {
    throw new Error('动画索引为空，拒绝生成')
  }

  return { items, nonEmptyLines, invalidLines, ignoredTypes }
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function atomicWrite(path, bytes) {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.writeFile(temporaryPath, bytes)
    await fs.rename(temporaryPath, path)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true })
    throw error
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'MapleTools-BGM-Offline-Index-Builder' },
  })
  if (!response.ok) throw new Error(`请求 ${url} 失败：HTTP ${response.status}`)
  return response.json()
}

function validateLatest(value) {
  const url = typeof value?.browser_download_url === 'string' ? value.browser_download_url : ''
  const name = typeof value?.name === 'string' ? value.name : ''
  const createdAt = typeof value?.created_at === 'string' ? value.created_at : ''
  const digest = typeof value?.digest === 'string' ? value.digest.toLowerCase() : ''

  if (!url || !name || !createdAt || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error('官方 latest.json 缺少有效的下载地址、名称、创建时间或 SHA-256')
  }
  return { url, name, createdAt, digest }
}

async function downloadArchive(url, expectedDigest, destination) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'MapleTools-BGM-Offline-Index-Builder' },
  })
  if (!response.ok || !response.body) {
    throw new Error(`下载官方档案失败：HTTP ${response.status}`)
  }

  const hash = createHash('sha256')
  const checksum = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), checksum, createWriteStream(destination))

  const actualDigest = `sha256:${hash.digest('hex')}`
  if (actualDigest !== expectedDigest) {
    throw new Error(`官方档案校验失败：期望 ${expectedDigest}，实际 ${actualDigest}`)
  }
}

function subjectFileInArchive(archivePath) {
  const entries = execFileSync('unzip', ['-Z1', archivePath], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)

  const subjectFile = entries.find((entry) => /(^|\/)subject[^/]*\.jsonlines$/i.test(entry))
  if (!subjectFile) {
    throw new Error(`官方档案中找不到 subject*.jsonlines（共 ${entries.length} 个文件）`)
  }
  return subjectFile
}

async function* readArchiveLines(archivePath, subjectFile) {
  const child = spawn('unzip', ['-p', archivePath, subjectFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 16_384) stderr += chunk
  })

  const closed = once(child, 'close')
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
  for await (const line of reader) yield line

  const [code, signal] = await closed
  if (code !== 0) {
    throw new Error(
      `unzip 解压失败（code=${String(code)}, signal=${String(signal)}）：${stderr.trim()}`,
    )
  }
}

async function localSource(filePath) {
  const stat = await fs.stat(filePath)
  if (!stat.isFile()) throw new Error(`--file 不是文件：${filePath}`)
  const digest = await hashFile(filePath)
  return {
    lines: createInterface({ input: createReadStream(filePath), crlfDelay: Infinity }),
    source: {
      name: basename(filePath),
      createdAt: stat.mtime.toISOString(),
      digest: `sha256:${digest}`,
    },
    production: false,
    cleanup: async () => {},
  }
}

async function officialSource() {
  const latest = validateLatest(await fetchJson(LATEST_URL))
  const temporaryDirectory = await fs.mkdtemp(join(tmpdir(), 'mapletools-bgm-index-'))
  const archivePath = join(temporaryDirectory, latest.name)

  console.log(`下载官方档案 ${latest.name} …`)
  try {
    await downloadArchive(latest.url, latest.digest, archivePath)
    const subjectFile = subjectFileInArchive(archivePath)
    console.log(`流式读取 ${subjectFile}`)
    return {
      lines: readArchiveLines(archivePath, subjectFile),
      source: {
        name: latest.name,
        createdAt: latest.createdAt,
        digest: latest.digest,
      },
      production: true,
      cleanup: () => fs.rm(temporaryDirectory, { recursive: true, force: true }),
    }
  } catch (error) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
    throw error
  }
}

async function writeOutputs(outDir, source, items) {
  await fs.mkdir(outDir, { recursive: true })
  // 构建时间取源快照时间，而不是当前时间：同一份 Archive 在周更与应用发版
  // workflow 中重复构建时必须得到相同 gzip，避免客户端误判为新索引并重复下载。
  const builtAt = source.createdAt
  const index = {
    schemaVersion: SCHEMA_VERSION,
    builtAt,
    items,
  }
  const compressed = gzipSync(Buffer.from(JSON.stringify(index)), { level: 9 })
  const sha256 = createHash('sha256').update(compressed).digest('hex')
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    builtAt,
    count: items.length,
    compressedSize: compressed.byteLength,
    sha256,
    source,
  }

  const indexPath = join(outDir, INDEX_FILE)
  const manifestPath = join(outDir, MANIFEST_FILE)
  await atomicWrite(indexPath, compressed)
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { indexPath, manifestPath, manifest }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const input = options.file ? await localSource(options.file) : await officialSource()

  try {
    const result = await collectItems(input.lines)
    if (input.production && result.items.length < MIN_PRODUCTION_ITEMS) {
      throw new Error(
        `生产动画索引仅 ${result.items.length} 条，低于安全下限 ${MIN_PRODUCTION_ITEMS}，拒绝生成`,
      )
    }

    const output = await writeOutputs(options.outDir, input.source, result.items)
    console.log(
      `扫描 ${result.nonEmptyLines} 行，忽略其他类型 ${result.ignoredTypes} 行，` +
        `坏行 ${result.invalidLines} 行，输出动画 ${result.items.length} 条`,
    )
    console.log(`索引：${output.indexPath}`)
    console.log(`清单：${output.manifestPath}`)
    console.log(`SHA-256：${output.manifest.sha256}`)
  } finally {
    await input.cleanup()
  }
}

main().catch((error) => {
  console.error('构建 BGM 离线索引失败：', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
