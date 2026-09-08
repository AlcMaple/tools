import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const webRoot = fileURLToPath(new URL('../../', import.meta.url))
export function agentCodeHash(root: string): string {
  const files: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|css)$/.test(entry.name)) files.push(path)
    }
  }
  for (const directory of ['server', 'shared', 'src']) walk(join(root, directory))
  const hash = createHash('sha256')
  for (const file of files.sort()) hash.update(relative(root, file)).update('\0').update(readFileSync(file)).update('\0')
  return hash.digest('hex')
}
export function readLoadedRelease(): { release: string; matches: boolean } {
  // 只在模块加载时读取发布清单与代码指纹；后续磁盘提交不改变运行中的快照。
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(webRoot, 'server/agent-release.json'), 'utf8'))
    if (!manifest || typeof manifest !== 'object' || !('format' in manifest) || manifest.format!==1 || !('codeHash' in manifest) || typeof manifest.codeHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(manifest.codeHash)) return { release: 'unbuilt', matches: false }
    return { release: manifest.codeHash, matches: manifest.codeHash === agentCodeHash(webRoot) }
  } catch { return { release: 'unbuilt', matches: false } }
}
export const releaseDirectory = dirname(join(webRoot, 'server/agent-release.json'))
