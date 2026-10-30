/** Reject an infeasible fresh request before either an ordinary or summary upstream call. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const { PiAiAdapter, resolveProfiles } = await importSnapshotModule(
  new URL('../../../packages/llm/llm-pi-ai/src/index.ts', import.meta.url),
  new URL('../../../packages/llm/llm-pi-ai/lib/index.js', import.meta.url),
)
const provider = 'muse-cloud-deepseek-official'
const model = 'deepseek-v4.1-flash-261017'

/** Loader name for the local working-budget recording. */
export const name = 'snapshot-working-budget-stop'
/** The shipped loop and compaction backend own admission and error settlement. */
export const inject = ['llm']

/** Mount a local upstream whose request count must remain zero.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated headless-profile context.
 * @returns {Promise<void>} Completion after local adapter registration.
 */
export async function apply(ctx) {
  let requests = 0
  const server = createServer((_request, response) => {
    requests++
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end('{"error":{"message":"Infeasible request reached the local upstream"}}')
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
    models: [{ id: model, contextWindow: 1000000, maxTokens: 393216, reasoningEfforts: false }],
  } })
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => Promise.resolve('snapshot-fake-key'),
    auth: {
      credentials: {
        read: () => Promise.resolve(undefined), list: () => Promise.resolve([]),
        modify: () => { throw new Error('Fixture must not modify credentials') },
        delete: () => { throw new Error('Fixture must not delete credentials') },
      },
      authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) },
    },
  })
  ctx.effect(() => ctx.llm.registerAdapter([provider], adapter))
  ctx.on('agent/turn-stopping', ({ agent }) => {
    assert.equal(requests, 0, 'Neither a normal request nor a summary may reach the local upstream')
    const events = agent.session.snapshotEvents()
    assert.equal(events.filter(event => event.type === 'assistant/message').length, 0)
    assert.ok(events.filter(event => event.type === 'assistant/attempt').length <= 1,
      'One local admission failure must not enter a repeated model retry loop')
    assert.equal(events.filter(event => event.type === 'compaction/summary').length, 0)
    assert.equal(agent.session.requestContext()?.contextWindow, 1000000)
    assert.equal(agent.session.requestHeader()?.config.maxTokens, 393216)
    assert.ok(JSON.stringify(events).includes('WORKING_CONTEXT_LIMIT'))
    assert.ok(!JSON.stringify(events).includes('snapshot-fake-key'))
  })
}
