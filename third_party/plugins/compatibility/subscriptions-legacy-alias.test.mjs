/** Saved subscription routes retain native LLM capabilities and immutable history. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createAssistantMessage, createToolResultMessage, createUserMessage,
  LlmAdapter, resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import { legacyCodexAlias } from './subscriptions-legacy-alias.mjs'

const LEGACY = 'openai-codex'
const MODEL = 'fixture-vision'
const policy = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'fixture subscription')
const pricing = { priceImages: images => images.map(() => ({ visualTokens: 17, text: '' })) }
const target = { width: 128, height: 64, maxBytes: 512 }
const image = { type: 'image', attachment: {
  attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 1024, width: 256, height: 128,
} }

class RecordingAdapter extends LlmAdapter {
  supportsRequiredImageInput = true
  generation = 1
  calls = []
  lookups = []
  providerInfo(provider) { return { id: provider, name: 'Fixture Codex' } }
  providerRetryPolicy(provider) { assert.equal(provider, 'codex'); return policy }
  imageRequestPricing(provider, model) {
    assert.deepEqual([provider, model], ['codex', MODEL]); return pricing
  }
  imageRequestTarget(provider, model, ref) {
    assert.deepEqual([provider, model, ref], ['codex', MODEL, image.attachment]); return target
  }
  async listModels(provider) { return [{ provider, id: MODEL, name: 'Fixture vision' }] }
  async resolveModel(provider, model, signal) {
    signal?.throwIfAborted()
    this.lookups.push({ provider, model, signal })
    return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
  }
  async prepareCall(provider, model, signal) {
    const resolved = await this.resolveModel(provider, model, signal)
    const generation = this.generation
    return { model: resolved, stream: options => this.record(options, generation) }
  }
  async * record(options, generation) {
    this.calls.push({ options, generation })
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  stream(options) { return this.record(options, this.generation) }
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('hides only the saved-route picker entry while forwarding image and retry capabilities', async () => {
  const adapter = new RecordingAdapter()
  const alias = legacyCodexAlias(adapter)
  assert.deepEqual(alias.providerInfo(LEGACY), { id: LEGACY, name: 'Fixture Codex', selectable: false })
  assert.deepEqual(await alias.listModels(LEGACY), [])
  assert.equal(alias.supportsRequiredImageInput, true)
  assert.equal(alias.providerRetryPolicy(LEGACY), policy)
  assert.equal(alias.imageRequestPricing(LEGACY, MODEL), pricing)
  assert.equal(alias.imageRequestTarget(LEGACY, MODEL, image.attachment), target)
  const controller = new AbortController()
  const model = await alias.resolveModel(LEGACY, MODEL, controller.signal)
  assert.equal(model.provider, LEGACY)
  assert.deepEqual(adapter.lookups, [{ provider: 'codex', model: MODEL, signal: controller.signal }])
  controller.abort(new Error('fixture cancellation'))
  await assert.rejects(alias.prepareCall(LEGACY, MODEL, controller.signal), /fixture cancellation/)
  assert.deepEqual(adapter.calls, [])
})

test('dispatches a saved route through real LlmRuntime with images, tool history and one prepared generation', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['codex'], adapter)
  const disposeAlias = ctx.llm.registerAdapter([LEGACY], legacyCodexAlias(adapter))
  try {
    assert.deepEqual(ctx.llm.listProviders().filter(provider => provider.selectable !== false).map(provider => provider.id), ['codex'])
    assert.deepEqual(await ctx.llm.listModels(LEGACY), [])
    assert.equal((await ctx.llm.listModels('codex'))[0].id, MODEL)
    assert.equal((await ctx.llm.resolveModelInfo(LEGACY, MODEL)).provider, LEGACY)
    const callId = 'fixture-tool-call'
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: 'Read this image first.' }, image], source: { kind: 'user' } }),
      createAssistantMessage({ content: [{ type: 'tool-call', id: callId, name: 'inspect_fixture', arguments: '{"frame":1}' }],
        source: { provider: LEGACY, model: MODEL, replayState: { fixture: 'saved-state' } } }),
      createToolResultMessage({ callId, content: [{ type: 'text', text: 'Frame one is intact.' }], isError: false }),
      createUserMessage({ content: [{ type: 'text', text: 'Continue using that result.' }], source: { kind: 'user' } }),
    ]
    const tools = [{ name: 'inspect_fixture', description: 'Inspect the fixture.', parameters: { type: 'object', properties: { frame: { type: 'number' } } } }]
    const signal = new AbortController().signal
    const prepared = await ctx.llm.prepareCall({ provider: LEGACY, model: MODEL }, signal)
    assert.equal(prepared.config.provider, LEGACY)
    assert.deepEqual(prepared.inputModalities, ['text', 'image'])
    adapter.generation = 2
    const options = { ...prepared.config, messages, tools, signal, requireImageInput: true }
    assert.deepEqual(await collect(prepared.stream(options)), [{ type: 'finish', reason: { kind: 'stop' } }])
    assert.equal(adapter.calls.length, 1)
    assert.equal(adapter.calls[0].generation, 1)
    assert.equal(adapter.calls[0].options.provider, 'codex')
    assert.equal(adapter.calls[0].options.signal, signal)
    assert.equal(adapter.calls[0].options.requireImageInput, true)
    assert.deepEqual(adapter.calls[0].options.messages, messages)
    assert.deepEqual(adapter.calls[0].options.tools, tools)
    assert.equal(options.provider, LEGACY)
    assert.equal(messages[1].source.provider, LEGACY)
    assert.deepEqual(messages[1].source.replayState, { fixture: 'saved-state' })
    disposeAlias()
    assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id), ['codex'])
    await assert.rejects(ctx.llm.prepareCall({ provider: LEGACY, model: MODEL }), error => error.code === 'NO_ADAPTER')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('direct alias streams retain controls and payload hooks while changing only the dispatch route', async () => {
  const adapter = new RecordingAdapter()
  const alias = legacyCodexAlias(adapter)
  const options = Object.freeze({ provider: LEGACY, model: MODEL, messages: [], tools: [],
    signal: new AbortController().signal, sessionId: 'fixture-session',
    responseFormat: { type: 'json_object' }, onPayload: () => {}, maxTokens: 31 })
  await collect(alias.stream(options))
  assert.deepEqual(adapter.calls[0].options, { ...options, provider: 'codex' })
  assert.equal(adapter.calls[0].options.onPayload, options.onPayload)
  assert.equal(options.provider, LEGACY)
})
