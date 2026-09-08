import { readFileSync,writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { webRoot } from '../server/agent/release'
import { featureGuideMarkdown,GUIDE_START,GUIDE_END,routeInventory } from './agent-feature-check'
// 维护者核对行为后显式运行；构建只验证，不自动掩盖遗漏。
const path=join(webRoot,'../docs/web/Agent功能说明.md'),source=readFileSync(path,'utf8')
const block=GUIDE_START+'\n'+featureGuideMarkdown()+'\n'+GUIDE_END
const before=source.includes(GUIDE_START)?source.slice(0,source.indexOf(GUIDE_START)):source+'\n## 当前功能与入口登记\n\n'
const after=source.includes(GUIDE_END)?source.slice(source.indexOf(GUIDE_END)+GUIDE_END.length):'\n'
writeFileSync(path,before+block+after)
writeFileSync(join(webRoot,'server/agent/site-routes.json'),JSON.stringify(routeInventory(webRoot),null,2)+'\n')
console.log('Updated reviewed feature guide and route inventory')
