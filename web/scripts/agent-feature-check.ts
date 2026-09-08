import ts from 'typescript'
import { readFileSync,readdirSync } from 'node:fs'
import { join,relative } from 'node:path'
import { AGENT_FEATURES,AGENT_FEATURE_REGISTRATIONS,knowledgeHash } from '../server/agent/knowledge'
import { SITE_API_FEATURES } from '../server/agent/site-features'
import { READ_DATA_TOOLS } from '../server/agent/data-tools'
import { AGENT_TOOLS } from '../shared/agent-contracts'
export const GUIDE_START='<!-- agent-feature-guide:start -->',GUIDE_END='<!-- agent-feature-guide:end -->'
export function featureGuideMarkdown():string {
 return AGENT_FEATURES.map(f=>`### ${f.id} · v${f.revision} · ${f.title}\n\n${f.purpose}\n\n- 入口：\`${f.entry}\`\n- 步骤：${f.steps.join('；')}\n- 限制：${f.limitations.join('；')}\n- Agent 工具：${f.tools.length?f.tools.map(t=>'`'+t+'`').join('、'):'无，仅讲解'}\n- 范围：${f.audience==='public'?'公开功能说明':'登录账号'}\n`).join('\n')
}
export function routeInventory(root:string):{file:string;method:string;path:string}[]{
 const result:{file:string;method:string;path:string}[]=[]
 const walk=(dir:string)=>{for(const item of readdirSync(dir,{withFileTypes:true})){const path=join(dir,item.name);if(item.isDirectory())walk(path);else if(item.name.endsWith('.ts')){
  const sf=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true),receivers=new Set<string>()
  const collect=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer&&ts.isNewExpression(node.initializer)&&node.initializer.expression.getText(sf)==='Hono')receivers.add(node.name.text);ts.forEachChild(node,collect)};collect(sf)
  const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&receivers.has(node.expression.expression.getText(sf))&&['get','post','put','patch','delete','route'].includes(node.expression.name.text)&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0]))result.push({file:relative(root,path).replaceAll('\\','/'),method:node.expression.name.text,path:node.arguments[0].text});ts.forEachChild(node,visit)};visit(sf)
 }}};walk(join(root,'server'));return result.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
}
export function checkFeatureRelease(root:string,documentation:string):void {
 if(new Set(AGENT_FEATURES.map(f=>f.id)).size!==AGENT_FEATURES.length||AGENT_FEATURE_REGISTRATIONS.length!==AGENT_FEATURES.length)throw new Error('FEATURE_REGISTRATION_COVERAGE')
 if(Object.entries(AGENT_TOOLS).some(([name,tool])=>tool.mode==='read'&&!READ_DATA_TOOLS.includes(name as typeof READ_DATA_TOOLS[number])))throw new Error('READ_TOOL_UNREGISTERED')
 const app=readFileSync(join(root,'src/App.tsx'),'utf8')
 for(const registration of AGENT_FEATURE_REGISTRATIONS){const f=AGENT_FEATURES.find(f=>f.id===registration.id);if(!f||f.revision!==registration.revision||knowledgeHash(f)!==registration.descriptionHash)throw new Error('FEATURE_DESCRIPTION_MISMATCH')
  if(f.tools.some(t=>!READ_DATA_TOOLS.includes(t as typeof READ_DATA_TOOLS[number])||AGENT_TOOLS[t].mode!=='read'))throw new Error('FEATURE_TOOL_MISSING')
  if(f.entry.startsWith('/#/')&&!app.includes(`'${f.entry}'`))throw new Error('FEATURE_PAGE_MISSING')
 }
 const inventory=routeInventory(root),roots=inventory.filter(r=>r.file==='server/index.ts')
 if(roots.some(r=>!SITE_API_FEATURES[r.path])||Object.keys(SITE_API_FEATURES).some(path=>!roots.some(r=>r.path===path)))throw new Error('FEATURE_ROUTE_COVERAGE')
 for(const id of Object.values(SITE_API_FEATURES))if(!id.startsWith('infrastructure.')&&!AGENT_FEATURES.some(f=>f.id===id))throw new Error('FEATURE_ROUTE_UNREGISTERED')
 for(const f of AGENT_FEATURES)if(f.entry.startsWith('/api/agent/')&&!inventory.some(r=>r.file.startsWith('server/agent/')&&r.method!=='route'&&r.path===f.entry.slice('/api/agent'.length)))throw new Error('FEATURE_API_ENTRY_MISSING')
 const recorded=JSON.parse(readFileSync(join(root,'server/agent/site-routes.json'),'utf8'))
 if(JSON.stringify(recorded)!==JSON.stringify(inventory))throw new Error('FEATURE_ROUTE_REVIEW_REQUIRED')
 const section=documentation.split(GUIDE_START)[1]?.split(GUIDE_END)[0]?.trim()
 if(section!==featureGuideMarkdown().trim())throw new Error('FEATURE_DOCUMENTATION_MISMATCH')
}
