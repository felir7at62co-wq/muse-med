/** Deterministic chat and account-search responses; no supplier endpoint is contacted. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const { PiAiAdapter, resolveProfiles } = await importSnapshotModule(
  new URL('../../../packages/llm/llm-pi-ai/src/index.ts', import.meta.url),
  new URL('../../../packages/llm/llm-pi-ai/lib/index.js', import.meta.url),
)
const { mountMuseWebSearch } = await importSnapshotModule(
  new URL('../../../packages/host/muse-account/src/web-search.ts', import.meta.url),
  new URL('../../../packages/host/muse-account/lib/types/web-search.js', import.meta.url),
)
const { writeMuseSession } = await importSnapshotModule(
  new URL('../../../packages/host/muse-account/src/session.ts', import.meta.url),
  new URL('../../../packages/host/muse-account/lib/types/session.js', import.meta.url),
)
const provider = 'muse-cloud-deepseek-official'
const model = 'deepseek-v4.1-flash-261017'

export const name = 'snapshot-muse-search-account-proxy'
export const inject = ['llm', 'web']

/** Mount the real account search provider and replay model over one local gateway.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Shipped headless profile context.
 * @returns {Promise<void>} Completion after session and provider setup.
 */
export async function apply(ctx) {
  assert.ok(['replay', 'refresh'].includes(process.env.DSH_SNAPSHOT), 'This authored fixture never records a paid model')
  const home = await mkdtemp(join(tmpdir(), 'muse-search-snapshot-'))
  ctx.effect(() => () => rm(home, { recursive: true, force: true }))
  let modelCalls = 0, searches = 0, rejected
  let origin
  const cookie = '__Host-muse=snapshot-private-session'
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk.toString('utf8') })
    request.once('end', () => {
      try {
        const payload = JSON.parse(body)
        if (request.url === '/api/web/search') {
          searches++
          assert.equal(request.headers.cookie, cookie)
          assert.equal(request.headers.origin, origin)
          assert.equal(request.headers.authorization, undefined)
          assert.equal(request.headers['x-api-key'], undefined)
          if (payload.query === 'expired session') {
            response.writeHead(401, { 'content-type': 'application/json' })
            response.end('{"error":"private-provider-detail-must-not-escape"}')
          } else {
            assert.equal(payload.query, 'Muse official search')
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ results: [{ title: 'Muse search source',
              url: 'https://example.com/muse-search-evidence', summary: 'A gateway source summary.', date: '2026-10-30' }] }))
          }
          return
        }
        assert.equal(request.url, '/chat/completions')
        assert.equal(request.headers.authorization, 'Bearer snapshot-model-key')
        assert.equal(payload.model, model)
        const index = ++modelCalls
        assert.ok(index <= 3)
        const tool = index < 3
        const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0,
          id: index === 1 ? 'call_muse_search_ok' : 'call_muse_search_expired', type: 'function',
          function: { name: 'web_search', arguments: JSON.stringify({ queries: [index === 1 ? 'Muse official search' : 'expired session'] }) } }] }
          : { role: 'assistant', content: 'MUSE_WEB_SEARCH_ACCOUNT_PROXY_OK' }
        const events = [{ choices: [{ index: 0, delta, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }]
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n')
      } catch (error) {
        rejected = error
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end('{"error":"Local search fixture mismatch"}')
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
  origin = `http://127.0.0.1:${address.port}`
  const sessionFile = join(home, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl: origin, username: 'snapshot-editor', cookie })
  mountMuseWebSearch(ctx, { baseUrl: origin, sessionFile, requestTimeoutMs: 60000 })
  const profiles = resolveProfiles({ [provider]: { api: 'openai-completions', baseURL: origin,
    compat: { maxTokensField: 'max_tokens' },
    models: [{ id: model, contextWindow: 1000000, maxTokens: 8192, reasoningEfforts: false }],
  } })
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: () => Promise.resolve('snapshot-model-key'),
    auth: { credentials: { read: () => Promise.resolve(undefined), list: () => Promise.resolve([]),
      modify: () => { throw new Error('No credential writes') }, delete: () => { throw new Error('No credential deletes') } },
    authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) } },
  })
  ctx.effect(() => ctx.llm.registerAdapter([provider], adapter))
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (rejected) throw rejected
    assert.equal(modelCalls, 3)
    assert.equal(searches, 2)
    const events = agent.session.snapshotEvents()
    const results = events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, 2)
    assert.ok(JSON.stringify(results[0]).includes('https://example.com/muse-search-evidence'))
    assert.ok(JSON.stringify(results[0]).includes('A gateway source summary.'))
    assert.ok(JSON.stringify(results[1]).includes('WEB_PROVIDER_CREDENTIAL_MISSING'))
    const recorded = JSON.stringify(events)
    assert.ok(!recorded.includes('snapshot-private-session'))
    assert.ok(!recorded.includes('snapshot-model-key'))
    assert.ok(!recorded.includes('private-provider-detail-must-not-escape'))
  })
}
