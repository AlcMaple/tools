import { checkFeatureRelease } from './agent-feature-check'
import { readFileSync,writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { agentCodeHash, webRoot, releaseDirectory } from '../server/agent/release'
import { AGENT_FEATURES, AGENT_FEATURE_REGISTRATIONS, knowledgeHash } from '../server/agent/knowledge'

if (new Set(AGENT_FEATURES.map(f => f.id)).size !== AGENT_FEATURES.length) throw new Error('DUPLICATE_FEATURE')
for (const registration of AGENT_FEATURE_REGISTRATIONS) {
  const description = AGENT_FEATURES.find(f => f.id === registration.id)
  if (!description || description.revision !== registration.revision || knowledgeHash(description) !== registration.descriptionHash) throw new Error('FEATURE_DESCRIPTION_MISMATCH')
}
checkFeatureRelease(webRoot,readFileSync(join(webRoot,'../docs/web/Agent功能说明.md'),'utf8'))
const guide=JSON.stringify(AGENT_FEATURES),guideHash=knowledgeHash(AGENT_FEATURES)
writeFileSync(join(releaseDirectory,'agent-guide.json'),guide+'\n')
const codeHash = agentCodeHash(webRoot), temp = join(releaseDirectory, `.agent-release-${randomUUID()}.tmp`)
try {
  writeFileSync(temp, JSON.stringify({ format: 1, codeHash,guideHash }) + '\n')
  renameSync(temp, join(releaseDirectory, 'agent-release.json'))
} finally { rmSync(temp, { force: true }) }
console.log('[agent-release] code and registered descriptions fingerprinted')
