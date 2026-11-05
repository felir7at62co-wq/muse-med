/** Account-backed DeepSeek reasoning and tool replay through the shipped headless profile. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const account = await importSnapshotModule(new URL('../../../packages/host/muse-account/src/index.ts', import.meta.url),
  new URL('../../../packages/host/muse-account/lib/types/index.js', import.meta.url))
const { defineContentToolFixture } = await importSnapshotModule(
  new URL('../../../packages/test-support/tool-testkit/src/index.ts', import.meta.url),
  new URL('../../../packages/test-support/tool-testkit/lib/index.js', import.meta.url))

/** Loader name for account supplier reasoning replay. */
export const name = 'snapshot-deepseek-supplier-thinking'
/** Account and real tool execution services supplied by the headless profile. */
export const inject = ['tools', 'llm', 'agentDefaultModel']

function completion(message) {
  const chunks = message.content.map((block, index) => ({ choices: [{ index: 0, finish_reason: null,
    delta: block.type === 'text' ? { content: block.text } : block.type === 'reasoning' ? { reasoning_content: block.text }
      : { tool_calls: [{ index, id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } }] },
  }] }))
  chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: message.content.some(block => block.type === 'tool-call') ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 30, completion_tokens: 4 } })
  return [...chunks.map(chunk => JSON.stringify(chunk)), '[DONE]'].map(chunk => `data: ${chunk}\n\n`).join('')
}

/** Mount the normal account plugin against an isolated HTTP supplier and verify both wire requests.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Shipped-profile snapshot context.
 * @returns {Promise<void>} Completion after account and tool registration.
 */
export async function apply(ctx) {
  const recorded = (await readFile(process.env.DSH_SNAPSHOT_FILE, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const config = recorded.find(event => event.type === 'request/header')?.data.header.config
  const provider = config.provider.slice('muse-cloud-'.length), model = config.model
  assert.ok(provider === 'volcengine-ark' || provider === 'alibaba-bailian')
  assert.equal(model, provider === 'volcengine-ark' ? 'deepseek-v4-1-flash-261017' : 'deepseek-v4.1-flash-1017')
  const scripts = recorded.filter(event => event.type === 'assistant/message').map(event => event.data.message)
  assert.equal(scripts.length, 2)
  const home = await mkdtemp(join(tmpdir(), 'muse-deepseek-supplier-snapshot-'))
  ctx.effect(() => () => rm(home, { recursive: true, force: true }))
  const catalog = { providers: [{ id: provider, name: provider, models: [{ id: model, name: model,
    contextWindow: 128000, maxTokens: 2048, input: ['text'],
    reasoningEfforts: { off: null, low: 'low', high: 'high' }, defaultReasoningEffort: 'low',
  }] }] }
  const requests = []
  let rejected
  let baseUrl
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk.toString('utf8') })
    request.once('end', () => {
      try {
        if (request.url === '/api/desktop-login/start') {
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({
            id: 'a'.repeat(43), secret: 's'.repeat(43), code: 'A1B2C3D4', expiresAt: Date.now() + 600000,
            pollIntervalMs: 2000, authorizeUrl: baseUrl + '/desktop-login?attempt=' + 'a'.repeat(43),
          })); return
        }
        if (request.url === '/api/desktop-login/check') {
          assert.equal(new URLSearchParams(body).get('secret'), 's'.repeat(43))
          response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': '__Host-muse=supplier-snapshot-session; Path=/; HttpOnly' })
          response.end('{"state":"signed-in"}'); return
        }
        if (request.url === '/api/muse.account') {
          response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"username":"snapshot"}'); return
        }
        if (request.url === '/api/desktop-models/providers') {
          assert.equal(request.headers.cookie, '__Host-muse=supplier-snapshot-session')
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(catalog)); return
        }
        if (request.url === `/api/desktop-models/${provider}/chat/completions`) {
          assert.equal(request.headers.authorization, 'Bearer supplier-snapshot-session')
          assert.equal(request.headers.origin, baseUrl)
          const payload = JSON.parse(body)
          assert.equal(payload.model, model)
          assert.equal(payload.max_tokens, 2048)
          assert.equal(payload.reasoning_effort, 'low')
          if (provider === 'alibaba-bailian') {
            assert.equal(payload.enable_thinking, true)
            assert.equal(payload.thinking, undefined)
          } else {
            assert.deepEqual(payload.thinking, { type: 'enabled' })
            assert.equal(payload.enable_thinking, undefined)
          }
          if (requests.length === 1) {
            const assistant = payload.messages.find(message => message.role === 'assistant')
            assert.equal(assistant.reasoning_content, 'Read the supplier probe before answering.')
            assert.equal(assistant.tool_calls[0].id, 'call_supplier_probe')
            assert.deepEqual(payload.messages.find(message => message.role === 'tool'), {
              role: 'tool', tool_call_id: 'call_supplier_probe', content: 'SUPPLIER_PROBE_OK',
            })
          }
          const message = scripts[requests.length]
          assert.ok(message)
          requests.push(payload)
          response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(completion(message)); return
        }
        response.writeHead(404); response.end()
      } catch (error) {
        rejected = error
        response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"error":{"message":"Supplier snapshot request mismatch"}}')
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
  baseUrl = `http://127.0.0.1:${address.port}`
  const mounted = ctx.plugin(account, { baseUrl, accountHome: home, remoteAccess: false })
  await mounted.await()
  const service = ctx.get('museAccount')
  assert.ok(service instanceof account.MuseAccountService)
  ctx.on('agent/created', async () => {
    const attempt = await service.startBrowserLogin()
    assert.equal((await service.checkBrowserLogin(attempt.id)).state, 'signed-in')
  })
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({ name: 'supplier_probe',
    description: 'Read the supplier acceptance result.', parameters: {},
    execute: async () => [{ type: 'text', text: 'SUPPLIER_PROBE_OK' }],
  })))
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (rejected) throw rejected
    assert.equal(requests.length, 2)
    assert.equal(agent.session.requestHeader()?.config.reasoningEffort, 'low')
    assert.deepEqual(agent.session.deriveMessages().filter(message => message.role === 'assistant').at(-1).content,
      [{ type: 'text', text: 'SUPPLIER_TOOL_CONTINUATION_READY' }])
    const logged = JSON.stringify(agent.session.snapshotEvents())
    assert.ok(!logged.includes('supplier-snapshot-session'))
    assert.ok(!logged.includes('s'.repeat(43)))
  })
}
