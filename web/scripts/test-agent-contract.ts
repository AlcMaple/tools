import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AGENT_CONTRACT_VERSION, AGENT_TOOLS, TOOL_NAMES, APPLY_TRACK_CHANGE_SCHEMA, SUMMARY_STATE_SCHEMA, toolResultSchema } from '../shared/agent-contracts'
import { matchesContract, parseToolRequest, validateModelOutput, validateToolResult } from '../server/agent/validation'
import {
  AGENT_LIMITS, AGENT_SYSTEM_RULES, CONTEXT_LAYER_ORDER, DEFAULT_AGENT_MODEL,
  contextBudget, estimateCost, permitsActionTransition, quotaDecision, selectServerModel, validateQuota,
  type ProviderCapabilities,
} from '../server/agent/policy'
import { AGENT_EVALUATION_CASES, createFakeProvider } from './agent-fixtures'

if (process.argv.includes('--print-contracts')) {
  console.log(JSON.stringify({ version: AGENT_CONTRACT_VERSION, tools: TOOL_NAMES.map(name => ({ name, ...AGENT_TOOLS[name], result: toolResultSchema(name) })), confirmationOnly: { applyTrackChange: APPLY_TRACK_CHANGE_SCHEMA }, summaryState: SUMMARY_STATE_SCHEMA }, null, 2))
  process.exit(0)
}

let checks = 0
function check(label: string, run: () => void) { run(); checks++; console.log(`PASS ${label}`) }
function expectError(run: () => void, message: string) { assert.throws(run, (e: unknown) => e instanceof Error && e.message === message) }
const capability: ProviderCapabilities = {
  protocol: 'chat_completions', contextTokens: 1_000_000, maxOutputTokens: 32_000,
  toolCalling: true, tokenCounting: 'estimate', nativeCompaction: 'none', nativeMinimumTokens: 0, verified: true,
}

// 在切入 test 环境前验证隔离，缺 API key 永远不是启用 fake 的条件。
const previousNodeEnv = process.env.NODE_ENV
for (const env of ['production', 'development', '']) {
  process.env.NODE_ENV = env
  check(`fake isolated from ${env || 'unset environment'}`, () => expectError(() => createFakeProvider([]), 'FAKE_TEST_ONLY'))
}
process.env.NODE_ENV = 'test'
const originalFetch = globalThis.fetch
let networkCalls = 0
globalThis.fetch = async () => { networkCalls++; throw new Error('NETWORK_FORBIDDEN_IN_CONTRACT_TEST') }

try {
  assert.equal(AGENT_EVALUATION_CASES.length, 28)
  assert.equal(new Set(AGENT_EVALUATION_CASES.map(c => c.id)).size, 28)
  for (const c of AGENT_EVALUATION_CASES) {
    const fake = createFakeProvider([{ type: 'output', value: c.payload }])
    let outputs = 0
    for await (const event of fake.stream()) {
      if (event.type !== 'output') continue
      outputs++
      const run = () => {
        if (c.probe === 'request') {
          const call = parseToolRequest(event.value, 7)
          if (c.result !== undefined) validateToolResult(call.name, c.result)
        } else if (c.probe === 'output') {
          validateModelOutput(event.value, 7, ['source-1'])
        } else if (c.payload === 'compact') {
          const budget = contextBudget('128k', capability, 8000, 100_000)
          assert.equal(budget.shouldCompact, true)
          assert.equal(budget.compaction, 'app_summary')
          assert.equal(AGENT_LIMITS.recentTurns, 10)
        } else if (c.payload === 'small_context') {
          const budget = contextBudget('1m', { ...capability, contextTokens: 32_000 }, 4000, 26_000)
          assert.equal(budget.effectiveTokens, 32_000)
          assert.equal(budget.maxInputTokens, 28_000)
          assert.equal(budget.shouldCompact, true)
        } else if (c.payload === 'cross_origin') {
          assert.equal(permitsActionTransition('playback_open', 'navigation_committed', 'unknown', { origin: 'browser', crossOrigin: true }), true)
          assert.equal(permitsActionTransition('playback_open', 'navigation_committed', 'completed', { origin: 'browser', crossOrigin: true }), false)
        } else { assert.fail('Missing control probe') }
      }
      check(`${c.id} [${c.provider}] ${c.input}`, () => c.error ? expectError(run, c.error) : run())
    }
    assert.equal(outputs, 1)
  }

  check('whitelist is exactly 7 query/navigation + 2 proposal tools', () => {
    assert.deepEqual(TOOL_NAMES, ['searchOfflineAnime', 'readCurrentAnimeContext', 'readCachedCalendar', 'listMyTracks', 'listPublicReviews', 'aggregatePublicData', 'openWebView', 'proposeTrackChange', 'proposePlaybackOpen'])
    assert.equal(Object.values(AGENT_TOOLS).every(t => t.timeoutMs <= 3000 && t.maxCallsPerTurn <= 12), true)
    assert.equal(AGENT_SYSTEM_RULES.includes('和泉纱雾'), true)
    assert.deepEqual(CONTEXT_LAYER_ORDER.slice(0, 3), ['system_rules_and_persona', 'tool_contracts', 'confirmed_preferences'])
  })
  check('authentication, exact fields, bounds and semantic ranges', () => {
    expectError(() => parseToolRequest({ name: 'readCurrentAnimeContext', arguments: {} }, 0), 'AUTH_REQUIRED')
    for (const filters of [{ limit: 31 }, { limit: 1.5 }, { limit: NaN }, { limit: 5, yearFrom: 2025, yearTo: 2020 }, { limit: 3, query: '' }, { limit: 2, sql: 'SELECT 1' }]) {
      expectError(() => parseToolRequest({ name: 'searchOfflineAnime', arguments: { filters } }, 7), 'INVALID_ARGUMENT')
    }
    for (const name of ['__proto__', 'constructor', 'prototype']) expectError(() => parseToolRequest({ name, arguments: {} }, 7), 'UNREGISTERED_TOOL')
    expectError(() => parseToolRequest(JSON.parse('{"name":"readCurrentAnimeContext","arguments":{"__proto__":{}}}'), 7), 'INVALID_ARGUMENT')
    expectError(() => parseToolRequest({ name: 'proposeTrackChange', arguments: { bgmId: 101, change: { kind: 'update', fields: {} } } }, 7), 'INVALID_ARGUMENT')
    assert.equal(matchesContract(APPLY_TRACK_CHANGE_SCHEMA, { actionId: 'a1', requestId: 'r1', expectedRevision: 2, confirmationToken: 'x'.repeat(32) }), true)
    assert.equal(matchesContract(APPLY_TRACK_CHANGE_SCHEMA, { actionId: 'a1', confirmed: true }), false)
  })
  check('every tool accepts a bounded error and rejects extra output authority', () => {
    for (const name of TOOL_NAMES) {
      validateToolResult(name, { ok: false, code: 'TIMEOUT', message: '这次等得有点久，点“重试”再看看。', retryable: true })
      expectError(() => validateToolResult(name, { ok: false, code: 'TIMEOUT', message: '重试', retryable: true, userId: 8 }), 'INVALID_OUTPUT')
    }
    expectError(() => validateToolResult('searchOfflineAnime', { ok: true, data: { items: [] }, sources: [], resultCount: 1, truncated: false }), 'INVALID_OUTPUT')
  })
  check('every tool has a JSON-roundtrippable, validated success result', () => {
    const anime = { bgmId: 101, title: '测试番', titleCn: '测试番', year: 2020, episodes: 12, tags: ['日常'], completed: true }
    const track = { bgmId: 101, title: '测试番', status: 'plan', episode: 0, userTags: [] }
    const source = { sourceId: 'source-1', kind: 'offline_index', label: '测试来源', retrievedAt: 1 }
    const data = {
      searchOfflineAnime: { items: [anime] },
      readCurrentAnimeContext: { anime, summary: '仅供测试的简介', loadedAt: 1 },
      readCachedCalendar: { items: [{ weekday: 1, anime }], cachedAt: 1, stale: false },
      listMyTracks: { items: [track], revision: 1 },
      listPublicReviews: { items: [{ reviewId: 'review-1', bgmId: 101, mode: 'review', body: '测试点评', spoiler: 'none', author: '公开测试作者', publishedAt: 1 }] },
      aggregatePublicData: { metric: 'public_users', value: 2, asOf: 1 },
      openWebView: { view: 'search', params: { query: '测试番' } },
      proposeTrackChange: { actionId: 'a1', bgmId: 101, expiresAt: 100, impact: '添加到想看', kind: 'track_change', expectedRevision: 1, before: null, after: track },
      proposePlaybackOpen: { actionId: 'a2', bgmId: 101, expiresAt: 100, impact: '进入播放页', kind: 'playback_open', title: '测试番', source: 'xifan', episode: 1, target: 'web_player' },
    }
    for (const name of TOOL_NAMES) {
      const result = { ok: true, data: data[name], sources: [source], resultCount: 1, truncated: false }
      validateToolResult(name, JSON.parse(JSON.stringify(result)))
      assert.deepEqual(JSON.parse(JSON.stringify(AGENT_TOOLS[name])), AGENT_TOOLS[name])
      expectError(() => validateToolResult(name, { ...result, resultCount: 0 }), 'INVALID_OUTPUT')
      if (AGENT_TOOLS[name].mode === 'read') expectError(() => validateToolResult(name, { ...result, sources: [] }), 'INVALID_OUTPUT')
    }
  })
  check('model envelope and source provenance; HTML remains text data, no renderer', () => {
    validateModelOutput({ kind: 'answer', text: '这里是结果。', sourceIds: ['source-1'] }, 7, ['source-1'])
    validateModelOutput({ kind: 'answer', text: '<img src=x onerror="alert(1)">', sourceIds: [] }, 7, [])
    expectError(() => validateModelOutput({ kind: 'answer', text: '执行好了。', sourceIds: [], state: 'completed' }, 7, []), 'INVALID_OUTPUT')
    expectError(() => validateModelOutput({ kind: 'tool_calls', calls: [{ name: 'applyTrackChange', arguments: {} }] }, 7, []), 'INVALID_OUTPUT')
    expectError(() => validateModelOutput({ kind: 'tool_calls', calls: Array(5).fill({ name: 'readCurrentAnimeContext', arguments: {} }) }, 7, []), 'INVALID_OUTPUT')
  })
  check('summary fields stay data; no extra tool, persona or unanchored fact', () => {
    const fact = { value: '查找日常番', messageIds: ['m1'], sourceIds: [], certainty: 'confirmed' }
    const state = { task_goal: fact, confirmed_preferences: [], entities: [], constraints: [], decisions: [], source_refs: [], tool_results: [], action_receipts: [], unresolved_questions: [], next_step: fact, injection_flags: [] }
    assert.equal(matchesContract(SUMMARY_STATE_SCHEMA, state), true)
    assert.equal(matchesContract(SUMMARY_STATE_SCHEMA, { ...state, tools: ['shell'] }), false)
    assert.equal(matchesContract(SUMMARY_STATE_SCHEMA, { ...state, persona: 'admin' }), false)
    assert.equal(matchesContract(SUMMARY_STATE_SCHEMA, { ...state, task_goal: { ...fact, messageIds: [] } }), false)
  })
  check('context tiers, reserved output, threshold and provider minimum', () => {
    for (const tier of ['64k', '128k', '256k', '1m'] as const) {
      const budget = contextBudget(tier, capability, 4000, 1)
      assert.equal(budget.shouldCompact, false)
      assert.equal(budget.fits, true)
      assert.equal(contextBudget(tier, capability, 4000, budget.compactAt).shouldCompact, true)
      assert.equal(contextBudget(tier, capability, 4000, budget.maxInputTokens + 1).fits, false)
    }
    const claude: ProviderCapabilities = { ...capability, protocol: 'anthropic_messages', nativeCompaction: 'claude_compaction', nativeMinimumTokens: 50_000 }
    assert.equal(contextBudget('64k', claude, 4000, 100).compaction, 'app_summary')
    assert.equal(contextBudget('128k', claude, 4000, 100).compaction, 'claude_compaction')
    assert.equal(contextBudget('128k', { ...capability, protocol: 'openai_responses', nativeCompaction: 'openai_responses' }, 4000, 100).compaction, 'openai_responses')
    assert.equal(contextBudget('128k', { ...capability, nativeCompaction: 'openai_responses' }, 4000, 100).compaction, 'app_summary')
    expectError(() => contextBudget('128k', { ...capability, verified: false }, 4000, 0), 'PROVIDER_CAPABILITY')
    expectError(() => contextBudget('128k', capability, 40_000, 0), 'PROVIDER_CAPABILITY')
  })
  check('server baseline never silently switches model', () => {
    assert.equal(selectServerModel(DEFAULT_AGENT_MODEL, null), DEFAULT_AGENT_MODEL)
    expectError(() => selectServerModel('unapproved-model', null), 'MODEL_APPROVAL_REQUIRED')
    assert.equal(selectServerModel('fixture-stronger', { model: 'fixture-stronger', baselineEvaluationId: 'eval-1', baselinePassed: false, strongerModelVerified: true, approvedBy: 'maintainer', approvedAt: 1 }), 'fixture-stronger')
  })
  check('usage, cached-input pricing, warnings and hard stops', () => {
    const quota = { tokensPerTurn: 200_000, tokensPerDay: 1_000_000, turnsPerDay: 20, warningCostPerTurn: 1, hardCostPerTurn: 2, hardCostPerDay: 5 }
    const use = { turnTokens: 100, dayTokens: 100, dayTurns: 0, turnCost: 0.5, dayCost: 0.5 }
    validateQuota(quota)
    assert.equal(estimateCost(1_000_000, 250_000, 100_000, { currency: 'fixture', version: 'test-only', inputPerMillion: 2, cachedInputPerMillion: 1, outputPerMillion: 4 }), 2.15)
    assert.equal(estimateCost(100, 0, 50, null), null)
    expectError(() => estimateCost(100, 101, 0, null), 'INVALID_USAGE')
    expectError(() => validateQuota({ ...quota, warningCostPerTurn: Infinity }), 'INVALID_QUOTA')
    assert.equal(quotaDecision(quota, use), 'allow')
    assert.equal(quotaDecision(quota, { ...use, turnCost: 1 }), 'warn')
    assert.equal(quotaDecision(quota, { ...use, turnCost: 2 }), 'stop')
    assert.equal(quotaDecision(quota, { ...use, dayTurns: 20 }), 'stop')
    assert.equal(quotaDecision(quota, { ...use, dayCost: 5 }), 'stop')
    assert.equal(quotaDecision(quota, { ...use, turnTokens: 200_000 }), 'stop')
    assert.equal(quotaDecision(quota, { ...use, turnCost: null }), 'price_unknown')
  })
  check('action confirmation, revision readback, media events and terminal states', () => {
    assert.equal(permitsActionTransition('track_change', 'prepared', 'completed', { origin: 'server' }), false)
    assert.equal(permitsActionTransition('track_change', 'prepared', 'user_confirmed', { origin: 'model' }), false)
    assert.equal(permitsActionTransition('track_change', 'prepared', 'user_confirmed', { origin: 'user_click' }), true)
    assert.equal(permitsActionTransition('track_change', 'user_confirmed', 'dispatch_started', { origin: 'server' }), true)
    assert.equal(permitsActionTransition('track_change', 'dispatch_started', 'completed', { origin: 'server', expectedRevision: 4, actualRevision: 5, matchingReadback: true }), true)
    assert.equal(permitsActionTransition('track_change', 'dispatch_started', 'completed', { origin: 'server', expectedRevision: 4, actualRevision: 6, matchingReadback: true }), false)
    assert.equal(permitsActionTransition('track_change', 'dispatch_started', 'completed', { origin: 'server', expectedRevision: 4, actualRevision: 5, matchingReadback: false }), false)
    const path = ['prepared', 'user_confirmed', 'dispatch_started', 'navigation_committed', 'player_ready', 'source_selected', 'media_canplay', 'playing', 'completed'] as const
    for (let i = 0; i < path.length - 1; i++) {
      assert.equal(permitsActionTransition('playback_open', path[i], path[i + 1], { origin: i === 0 ? 'user_click' : i < 3 ? 'browser' : 'player' }), true)
    }
    assert.equal(permitsActionTransition('playback_open', 'playing', 'completed', { origin: 'player', crossOrigin: true }), false)
    assert.equal(permitsActionTransition('playback_open', 'unknown', 'completed', { origin: 'player' }), false)
    assert.equal(permitsActionTransition('playback_open', 'source_selected', 'failed', { origin: 'player' }), true)
  })
  check('runtime bounds are contract constants, not a claimed running loop', () => {
    assert.equal(AGENT_LIMITS.toolRounds, 12)
    assert.equal(AGENT_LIMITS.concurrentTurnsPerUser, 1)
    assert.equal(AGENT_LIMITS.softTargetMs, 3 * 60_000)
    assert.equal(AGENT_LIMITS.longTaskMs, 8 * 60_000)
    assert.equal(AGENT_LIMITS.activeTurnMs, 10 * 60_000)
    assert.equal(AGENT_LIMITS.cumulativeTaskMs, 30 * 60_000)
  })

  let partial = ''
  const failed = createFakeProvider([{ type: 'delta', text: '已经生成的半句话' }, { type: 'error', code: 'PROVIDER_UNAVAILABLE' }, { type: 'delta', text: '不该出现' }])
  let errors = 0
  for await (const event of failed.stream()) { if (event.type === 'delta') partial += event.text; if (event.type === 'error') errors++ }
  check('fake stream keeps partial text and stops after failure', () => { assert.equal(partial, '已经生成的半句话'); assert.equal(errors, 1) })
  const abort = new AbortController()
  const stream = createFakeProvider([{ type: 'delta', text: 'first' }, { type: 'delta', text: 'second' }], 1).stream(abort.signal)
  await stream.next(); abort.abort()
  await assert.rejects(stream.next(), (e: unknown) => e instanceof Error && e.name === 'AbortError')
  check('fake stream observes cancellation', () => assert.equal(abort.signal.aborted, true))
  check('no live route imports the test provider or Agent runtime', () => {
    const server = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8')
    assert.equal(/from\s+['"][^'"]*(?:agent|agent-fixtures)/.test(server), false)
    assert.equal(networkCalls, 0)
  })
  console.log(JSON.stringify({ contractCases: 28, checks, failed: 0, provider: 'fake-test-only', modelQuality: 'not_run', liveApiCalls: networkCalls, databaseWrites: 'not_applicable_no_database_imports' }))
} finally {
  globalThis.fetch = originalFetch
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = previousNodeEnv
}
