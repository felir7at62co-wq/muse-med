/** Selected Muse model pressure through the shipped short-drama policy and logged HTTP responses. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { importSnapshotModule, importSnapshotPackage } from '../muse-fixture-import.mjs'
import { selectedModelProviders } from '../../../services/muse-accounts/selected-models.mjs'
import { desktopModelCatalog } from '../../../services/muse-accounts/desktop-models.mjs'

const owner = new URL('../../../apps/desktop-host/package.json', import.meta.url)
const account = await importSnapshotModule(new URL('../../../packages/host/muse-account/src/index.ts', import.meta.url),
  new URL('../../../packages/host/muse-account/lib/types/index.js', import.meta.url))
const compaction = await importSnapshotModule(new URL('../../../packages/compaction/compaction-basic/src/index.ts', import.meta.url),
  new URL('../../../packages/compaction/compaction-basic/lib/index.js', import.meta.url))
const [{ defineContentToolFixture }, { parse }] = await Promise.all([
  importSnapshotPackage('@deepseek-ai/dsh-tools', owner), import(pathToFileURL(createRequire(owner).resolve('yaml')).href),
])

/** Loader name for the small-window model recording. */
export const name = 'snapshot-small-window-compaction'
/** Normal profile services used by the fixture account, request meter and tools. */
export const inject = ['tools', 'llm', 'sessionProjections', 'agentDefaultModel', 'tokenMeter', 'sessions']

const resources = Array.from({ length: 7400 }, (_value, index) => `resource-${index.toString().padStart(5, '0')}`)

/** Stable sub-threshold tool values; the shipped pruner retains each complete result.
 * @param {string} resource - Resource selected from the real JSON Schema enumeration.
 * @returns {string} Complete logged fixture document or post-compaction verification marker.
 */
export function documentText(resource) {
  const index = Number(resource.slice('resource-'.length))
  if (index > 25) return 'TOOL_CONTINUED_AFTER_COMPACTION'
  const lead = `DOCUMENT ${resource}\n`
  const tail = `\nEND DOCUMENT ${resource}`
  return lead + 'A logged reference detail. '.repeat(400).slice(0, 7600 - lead.length - tail.length) + tail
}

function leaf(rows) {
  for (const row of rows) {
    if (row.id === 'compaction-basic') return row
    if (Array.isArray(row.config)) { const child = leaf(row.config); if (child) return child }
  }
}

function completion(content) {
  let call = 0
  const chunks = content.map(block => ({ choices: [{ index: 0, finish_reason: null,
    delta: block.type === 'text' ? { content: block.text } : block.type === 'reasoning' ? { reasoning_content: block.text }
      : { tool_calls: [{ index: call++, id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } }] },
  }] }))
  chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: call > 0 ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 30, completion_tokens: 4 } })
  return [...chunks.map(chunk => JSON.stringify(chunk)), '[DONE]'].map(chunk => `data: ${chunk}\n\n`).join('')
}

/** Register actual account authentication and compaction over the recorded model response script.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated shipped-profile context.
 * @returns {Promise<void>} Completion after account, backend and tool registration.
 */
export async function apply(ctx) {
  const home = await mkdtemp(join(tmpdir(), 'muse-pressure-snapshot-'))
  ctx.effect(() => () => rm(home, { recursive: true, force: true }))
  const source = await readFile(new URL('../../../apps/desktop-host/presets/short-drama/agent.cordis.yml', import.meta.url), 'utf8')
  const rows = parse(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ __jsExpr: value }) }] })
  const policy = leaf(rows)?.config
  assert.ok(policy)
  const selectedPolicy = policy.modelPolicies.find(row => row.provider === 'muse-cloud-yunying' && row.model === 'gpt-6-sol')
  assert.deepEqual(selectedPolicy, { provider: 'muse-cloud-yunying', model: 'gpt-6-sol', headroomTokens: 16384, maxTokens: 8192 })
  await ctx.plugin(compaction.default, policy).await()
  const recorded = (await readFile(process.env.DSH_SNAPSHOT_FILE, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const selection = recorded.find(event => event.type === 'request/header')?.data.header.config
  assert.deepEqual({ provider: selection?.provider, model: selection?.model }, { provider: 'muse-cloud-yunying', model: 'gpt-6-sol' })
  const script = recorded.flatMap(event => event.type === 'assistant/message' ? [{ summary: false, content: event.data.message.content }]
    : event.type === 'compaction/summary' && event.data.llmStreamCall ? [{ summary: true, content: event.data.rawOutput }] : [])
  assert.equal(script.length, 8)
  const catalog = desktopModelCatalog({ metadata: () => ({ providers: selectedModelProviders('https://wy6688.token6688.com/v1') }) })
  const requests = []
  const results = []
  let active
  let rejected
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk.toString('utf8') })
    request.once('end', () => {
      try {
        if (request.url === '/login') {
          response.writeHead(303, { 'set-cookie': '__Host-muse=pressure-session; Path=/; HttpOnly', location: '/' }); response.end(); return
        }
        if (request.url === '/api/muse.account') {
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ username: 'pressure' })); return
        }
        if (request.url === '/api/desktop-models/providers') {
          assert.equal(request.headers.cookie, '__Host-muse=pressure-session')
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(catalog)); return
        }
        if (request.url === '/api/desktop-models/yunying/chat/completions') {
          const payload = JSON.parse(body)
          assert.equal(request.headers.authorization, 'Bearer pressure-session')
          assert.equal(payload.model, 'gpt-6-sol')
          assert.equal(payload.reasoning_effort, 'low')
          const step = script[requests.length]
          assert.ok(step)
          assert.equal(payload.max_tokens, step.summary ? 8192 : 32768)
          const measurement = ctx.tokenMeter.measure(active.session)
          const summaries = active.session.snapshotEvents().filter(event => event.type === 'compaction/summary')
          if (requests.length === 0) assert.ok(measurement.totalTokens > 35000 && measurement.totalTokens < 41000)
          if (!step.summary && summaries.length === 0) assert.ok(measurement.totalTokens > 29696 && measurement.totalTokens < 78848)
          if (step.summary) assert.ok(measurement.totalTokens >= 78848)
          requests.push({ summary: step.summary, tokens: measurement.totalTokens })
          response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(completion(step.content)); return
        }
        response.writeHead(404); response.end()
      } catch (error) {
        rejected = error
        response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"error":{"message":"Pressure snapshot mismatch"}}')
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
  const profile = ctx.get('profileContext')
  assert.ok(profile)
  await writeFile(profile.patchPath, JSON.stringify([{ id: 'agent-default-model', config: {
    provider: selection.provider, model: selection.model,
  } }]) + '\n')
  await ctx.plugin(account, { baseUrl: `http://127.0.0.1:${address.port}`, accountHome: home, remoteAccess: false }).await()
  const service = ctx.get('museAccount')
  assert.ok(service instanceof account.MuseAccountService)
  ctx.on('agent/created', async ({ agent }) => {
    active = agent
    assert.equal((await service.login({ username: 'pressure', password: 'fixture-password', registerIfMissing: false })).outcome, 'signed-in')
  })
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({ name: 'fixture_document',
    description: 'Read a reference document from the available resource catalog.',
    parameters: { resource: { type: 'string', enum: resources } },
    async execute({ resource }) { results.push(resource); return [{ type: 'text', text: documentText(resource) }] },
  })))
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (rejected) throw rejected
    assert.equal(requests.length, 8)
    assert.equal(requests.filter(request => request.summary).length, 1)
    assert.equal(results.length, 26)
    const events = agent.session.snapshotEvents()
    for (const type of ['compaction/start', 'compaction/summary', 'compaction/end']) assert.equal(events.filter(event => event.type === type).length, 1)
    const summary = events.find(event => event.type === 'compaction/summary')
    assert.equal(summary.data.maxTokens, 8192)
    assert.ok(summary.data.shadowedSeqs.length > 1)
    assert.ok(ctx.tokenMeter.measure(agent.session).totalTokens < 78848)
    assert.ok(events.some(event => event.type === 'tool/result' && event.data.message.content.some(block => block.text === 'TOOL_CONTINUED_AFTER_COMPACTION')))
    assert.ok(!JSON.stringify(events).includes('pressure-session'))
  })
}
