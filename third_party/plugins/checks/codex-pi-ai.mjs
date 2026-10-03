/** Exercise the staged subscription provider with the Host's actual pi-ai exports. */
import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { createModels, openaiCodexSubscriptionProvider, PI_AI_RUNTIME_VERSIONS } from './src/pi-ai-runtime.js'

const token = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.signature`

function fixtureFetch(observed) {
  return async (url, init) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses')
    assert.equal(init.method, 'POST')
    const headers = new Headers(init.headers)
    assert.equal(headers.get('authorization'), `Bearer ${token}`)
    assert.equal(headers.get('chatgpt-account-id'), 'fixture-account')
    const body = headers.get('content-encoding') === 'zstd'
      ? zstdDecompressSync(init.body).toString('utf8')
      : init.body
    const payload = JSON.parse(body)
    assert.equal(payload.model, 'gpt-6-astra')
    assert.equal(payload.store, false)
    assert.equal(payload.stream, true)
    assert.equal(payload.service_tier, 'priority')
    assert.equal(payload.text.verbosity, 'high')
    assert.match(JSON.stringify(payload.input), /fixture user/)
    observed.push(payload)
    const item = { id: 'fixture-message', type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'fixture answer', annotations: [] }] }
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'fixture answer' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'fixture-response', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
    ]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }
}

function provider(connection) {
  return openaiCodexSubscriptionProvider({
    resolveSpeedMode: () => 'fast', resolveOutputVerbosity: () => 'high', connection,
    catalog: { getModels: models => models, metadata: () => ({ supportsFast: true, supportVerbosity: true }) },
  })
}

function auth() {
  return {
    credentials: { read: async () => assert.fail('the request token must avoid stored credentials') },
    authContext: { env: async () => assert.fail('must not read host environment'), fileExists: async () => assert.fail('must not read host files') },
  }
}

test('streams authenticated Codex SSE and preferences through the exact Host pi-ai release', async () => {
  const entry = import.meta.resolve('@earendil-works/pi-ai')
  const hostRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai'))))
  assert.equal(realpathSync(dirname(dirname(fileURLToPath(entry)))), realpathSync(join(hostRoot, 'node_modules/@earendil-works/pi-ai')))
  assert.equal(JSON.parse(readFileSync(new URL('../package.json', entry), 'utf8')).version, '0.87.1')
  assert.deepEqual(PI_AI_RUNTIME_VERSIONS, ['0.87.1'])
  const native = provider()
  const models = createModels(auth())
  models.setProvider(native)
  const model = models.getModel('openai-codex', 'gpt-6-astra')
  assert.ok(model)
  const observed = []
  let payloadCalls = 0
  const events = []
  for await (const event of models.streamSimple(model, { messages: [{ role: 'user', content: 'fixture user', timestamp: 0 }] }, {
    apiKey: token, transport: 'sse', maxRetries: 0, signal: AbortSignal.timeout(10_000), fetch: fixtureFetch(observed),
    onPayload: payload => { payloadCalls++; return { ...payload, fixture_marker: 'retained' } },
  })) events.push(event)
  assert.equal(observed.length, 1)
  assert.equal(payloadCalls, 1)
  assert.equal(observed[0].fixture_marker, 'retained')
  assert.equal(events.find(event => event.type === 'text_delta')?.delta, 'fixture answer')
  assert.equal(events.at(-1).type, 'done')
  assert.equal(events.at(-1).reason, 'stop')
  assert.equal(events.at(-1).message.usage.totalTokens, 5)
})

test('projects actual subscription streaming through the current Host PiAiAdapter', async () => {
  const { PiAiAdapter } = await import('@deepseek-ai/dsh-llm-pi-ai')
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const observed = []
  const native = provider({ prepare: async options => ({ options: { ...options, maxRetries: 0, fetch: fixtureFetch(observed) } }) })
  const profile = {
    provider: 'openai-codex', displayName: 'Fixture subscription', piProvider: native,
    configuredMaxTokens: new Map(), modelErrors: new Map(), streamIdleTimeoutMs: 10_000,
    maxRequestImageBytes: 20 * 1024 * 1024, requestImagePixelBudget: 2048 * 2048, requestImageMaxBytes: 1024 * 1024,
    cacheRetention: 'short', transport: 'sse',
  }
  const adapter = new PiAiAdapter({ profiles: () => new Map([['openai-codex', profile]]), resolveApiKey: async () => token, auth: auth() })
  const prepared = await adapter.prepareCall('openai-codex', 'gpt-6-astra')
  const chunks = []
  for await (const chunk of prepared.stream({
    provider: 'openai-codex', model: 'gpt-6-astra', signal: AbortSignal.timeout(10_000),
    messages: [createUserMessage({ content: [{ type: 'text', text: 'fixture user' }], source: { kind: 'user' } })],
  })) chunks.push(chunk)
  assert.equal(observed.length, 1)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'fixture answer')
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage')?.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 })
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})
