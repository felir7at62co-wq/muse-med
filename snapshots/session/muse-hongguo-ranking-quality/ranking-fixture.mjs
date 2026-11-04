/** Preserve a public ranking entry whose page omits collection and like fields. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { importSnapshotModule } from '../muse-fixture-import.mjs'
import * as hongguo from '../../../third_party/plugins/muse-hongguo-search/src/index.js'

const { PiAiAdapter, resolveProfiles } = await importSnapshotModule(
  new URL('../../../packages/llm/llm-pi-ai/src/index.ts', import.meta.url),
  new URL('../../../packages/llm/llm-pi-ai/lib/index.js', import.meta.url),
)
const provider = 'deepseek-official'
const model = 'deepseek-v4-flash'
const stamp = Date.parse('2026-11-04T12:00:00.000Z')
const sourceUrl = 'https://hongguoduanju.com/rank/hot-comic-drama'
const finalText = '已保留 1 部短剧。榜单分页完整；收藏和点赞未知，热度为 200 万，需补齐指标后再判断是否达到收藏门槛。'
const route = 'rank_hot-comic-drama/page'
const pending = JSON.stringify([route, [{ key: 'content', routerDataFnName: 's', routerDataFnArgs: ['"pending"', '"content"'] }]])
  .replaceAll('&', '&amp;').replaceAll('"', '&quot;')
const html = `<script>_ROUTER_DATA=${JSON.stringify({ loaderData: { [route]: { pageNum: 1, canonicalUrl: sourceUrl, updatedText: '11月4日已更新' } } })};</script>
<script data-fn-name="mergeLoaderData" data-fn-args="${pending}"></script>
<article aria-labelledby="rank-title-7100000000000000011">
<span class="pc-badge-number-fixture">1</span><h2 id="rank-title-7100000000000000011">锦鲤小厨娘</h2>
<p class="pc-description-fixture">合成榜单样本</p><p class="pc-categories-fixture"><span>美食</span></p>
<p class="pc-metrics-fixture">200万热度</p></article>
<nav aria-label="榜单分页"><a href="/rank/hot-comic-drama">1</a></nav>`

/** Loader name for the isolated public ranking transport. */
export const name = 'snapshot-hongguo-ranking-quality'
/** The shipped adapter and loop own model streaming and registered tool execution. */
export const inject = ['llm', 'tools']

/**
 * Mount one deterministic page response and a local two-step model stream.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated shipped-profile context.
 * @returns {Promise<void>} Completion after the fixture transports are ready.
 */
export async function apply(ctx) {
  let pageRequests = 0
  let modelRequests = 0
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
        modelRequests++
        assert.ok(modelRequests <= 2)
        if (modelRequests === 2) {
          const result = payload.messages.find(message => message.role === 'tool')
          assert.ok(result, 'The real registered ranking tool must produce a model-visible result')
          assert.match(JSON.stringify(result), /7100000000000000011/)
          assert.match(JSON.stringify(result), /missingMetrics/)
        }
        const first = modelRequests === 1
        const delta = first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'ranking-missing-metrics', type: 'function',
          function: { name: 'hongguo_rankings', arguments: '{"boards":["hot-comic-drama"],"refresh":true}' } }] }
          : { role: 'assistant', content: finalText }
        const events = [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
        ]
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n')
      } catch (error) {
        rejected = error
        console.error(error instanceof Error ? error.message : 'Local ranking fixture assertion failed')
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end('{"error":{"message":"Local ranking fixture mismatch"}}')
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
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  globalThis.fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.href === sourceUrl) {
      options?.signal?.throwIfAborted()
      pageRequests++
      return new Response(html, { headers: { 'content-type': 'text/html' } })
    }
    if (url.origin === `http://127.0.0.1:${address.port}` && url.pathname === '/chat/completions') {
      return originalFetch(input, options)
    }
    throw new Error(`Ranking fixture refuses an unrelated request: ${url.origin}${url.pathname}`)
  }
  Date.now = () => stamp
  ctx.effect(() => () => { globalThis.fetch = originalFetch; Date.now = originalNow })
  await ctx.plugin(hongguo, { requestIntervalMs: 0 })
  const profiles = resolveProfiles({ [provider]: {
    api: 'openai-completions', baseURL: `http://127.0.0.1:${address.port}`,
    compat: { maxTokensField: 'max_tokens' },
    models: [{ id: model, contextWindow: 1000000, maxTokens: 256000, reasoningEfforts: false }],
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
    if (rejected) throw rejected
    assert.equal(pageRequests, 1)
    assert.equal(modelRequests, 2)
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    assert.equal(results.length, 1)
    assert.equal(results[0].data.message.isError, false)
    const block = results[0].data.message.content.find(item => item.type === 'text')
    assert.ok(block)
    const value = JSON.parse(block.text)
    assert.equal(value.items.length, 1)
    assert.equal(value.items[0].seriesId, '7100000000000000011')
    assert.equal(value.items[0].collection.value, null)
    assert.equal(value.items[0].likes.value, null)
    assert.equal(value.items[0].heat.value, 2000000)
    assert.equal(value.coverage.complete, true)
    assert.equal(value.coverage.metrics.complete, false)
    assert.equal(value.coverage.metrics.fields.collection.missing, 1)
    assert.equal(value.coverage.metrics.fields.likes.missing, 1)
    assert.equal(value.coverage.metrics.fields.heat.known, 1)
    assert.deepEqual(value.items[0].observations[0].missingMetrics, [
      { field: 'collection', reason: 'not_displayed' }, { field: 'likes', reason: 'not_displayed' },
    ])
  })
}
