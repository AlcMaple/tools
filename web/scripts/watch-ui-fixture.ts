import { createAgentUiFixture } from './agent-ui-fixture'

process.env.NODE_ENV = 'test'
process.env.AGENT_UI_FIXTURE = '1'
process.env.AGENT_UI_WATCH = '1'
const fixture = await createAgentUiFixture()
console.log(JSON.stringify({ origin: fixture.origin, browserUrl: fixture.browserOrigin + '/', mode: 'isolated-watch-journey-fixture', realAiCalls: 0, media: 'generated-local-test-pattern-not-anime' }))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void fixture.close().finally(() => process.exit(0)) })
