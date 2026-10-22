const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { createRequire } = require('node:module')
const path = require('node:path')
const repo = path.resolve(__dirname, '../..')
const local = createRequire(path.join(repo, 'package.json'))
const ts = local('typescript')

function load(file, dependencies, mutate = text => text) {
  const source = mutate(readFileSync(path.join(repo, file), 'utf8'))
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(name => {
    assert(Object.hasOwn(dependencies, name), name)
    return dependencies[name]
  }, module, module.exports)
  return module.exports
}

const coreFile = 'src/main/order-judge/sync-core.ts'
const deps = {
  'fs/promises': require('node:fs/promises'), path: require('node:path'), crypto: require('node:crypto'),
  '../../../web/shared/order-judge-api': { DOC_MAX_BYTES: 1_000_000 },
  '../../../web/shared/order-judge-text': load('web/shared/order-judge-text.ts', {}),
}
const mutant = (from, to) => load(coreFile, deps, source => { assert(source.includes(from), from); return source.replace(from, to) })
const root = mkdtempSync(path.join(tmpdir(), 'mt-judge-mutation-'))

;(async () => {
  try {
    const real = load(coreFile, deps)
    const present = path.join(root, 'log.md'), empty = path.join(root, 'empty.md')
    writeFileSync(present, 'LOG'); writeFileSync(empty, '  \n')
    const missing = path.join(root, 'other-computer', 'log.md')

    const priority = async core => assert.equal((await core.firstSourceDoc('log', [missing, present]))?.content, 'LOG')
    await priority(real)
    await assert.rejects(priority(mutant("code === 'ENOTDIR') continue", "code === 'ENOTDIR') return null")), assert.AssertionError)
    console.log('PASS mutation 1: stopping at a missing higher-priority path makes the priority assertion fail')

    const emptyBlocked = async core => assert.rejects(core.firstSourceDoc('log', [empty]), /空的/)
    await emptyBlocked(real)
    await assert.rejects(emptyBlocked(mutant('if (!content.trim()) throw', 'if (false) throw')), assert.AssertionError)
    console.log('PASS mutation 2: removing the empty-file guard makes the no-overwrite assertion fail')
    console.log('RESULT: 2/2 guard mutations detected; source files were never edited')
  } finally { rmSync(root, { recursive: true, force: true }) }
})().catch(error => { console.error(error); process.exitCode = 1 })
