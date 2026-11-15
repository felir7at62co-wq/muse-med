/** Preserve a completed provider reply when the local model capacity is stale. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const { PiAiAdapter, resolveProfiles } = await importSnapshotModule(
  new URL('../../../packages/llm/llm-pi-ai/src/index.ts', import.meta.url),
  new URL('../../../packages/llm/llm-pi-ai/lib/index.js', import.meta.url),
)
const provider = 'muse-cloud-deepseek-official'
const model = 'deepseek-v4.1-flash-261017'
const text = 'COMPLETED_ABOVE_STALE_CONTEXT'

/** Loader name for the local provider-response fixture. */
export const name = 'snapshot-completed-over-stale-context'
/** The shipped loop owns request assembly, streaming and durable settlement. */
export const inject = ['llm']

/** Mount the real adapter over one local, deterministic SSE response.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Shipped headless profile context.
 * @returns {Promise<void>} Completion after the listener and adapter are mounted.
 */
export async function apply(ctx) {
  let requests = 0
  let rejected
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk.toString('utf8') })
    request.once('end', () => {
      try {
        assert.equal(request.url, '/chat/completions')
        assert.equal(request.headers.authorization, 'Bearer snapshot-fake-key')
        const payload = JSON.parse(body)
        assert.equal(payload.model, model)
        assert.equal(payload.max_tokens, 393216)
        assert.equal(++requests, 1)
        const events = [
          { choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: {
            prompt_tokens: 490470, completion_tokens: 537, total_tokens: 491007,
            prompt_cache_hit_tokens: 490240, prompt_cache_miss_tokens: 230,
          } },
        ]
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n')
      } catch (error) {
        rejected = error
        console.error(error instanceof Error ? error.message : 'Local fixture assertion failed')
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end('{"error":{"message":"Local completion fixture mismatch"}}')
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  ctx.effect(() => async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => { if (error) reject(error); else resolve() }))
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const profiles = resolveProfiles({ [provider]: {
    api: 'openai-completions', baseURL: `http://127.0.0.1:${address.port}`,
    compat: { maxTokensField: 'max_tokens' },
    models: [{ id: model, contextWindow: 475000, maxTokens: 393216, reasoningEfforts: false }],
  } })
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => Promise.resolve('snapshot-fake-key'),
    auth: {
      credentials: {
        read: () => Promise.resolve(undefined),
        list: () => Promise.resolve([]),
        modify: () => { throw new Error('Fixture must not modify credentials') },
        delete: () => { throw new Error('Fixture must not delete credentials') },
      },
      authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) },
    },
  })
  ctx.effect(() => ctx.llm.registerAdapter([provider], adapter))
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (rejected) throw rejected
    assert.equal(requests, 1)
    const events = agent.session.snapshotEvents()
    assert.equal(events.filter(event => event.type === 'assistant/attempt').length, 0)
    assert.equal(events.filter(event => event.type.startsWith('compaction/')).length, 0)
    const replies = events.filter(event => event.type === 'assistant/message')
    assert.equal(replies.length, 1)
    assert.deepEqual(replies[0].data.message.content, [{ type: 'text', text }])
    assert.deepEqual(replies[0].data.usage, {
      inputTokens: 230, outputTokens: 537, totalTokens: 491007, cacheReadTokens: 490240,
    })
    assert.equal(replies[0].data.message.source.replayState.response.stopReason, 'stop')
  })
}
