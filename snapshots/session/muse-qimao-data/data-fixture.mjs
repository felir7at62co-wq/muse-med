/** Read public book facts without treating read occurrences as current readers. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { importSnapshotModule } from '../muse-fixture-import.mjs'
import * as qimao from '../../../third_party/plugins/muse-qimao-data/src/index.js'

const { PiAiAdapter, resolveProfiles } = await importSnapshotModule(
  new URL('../../../packages/llm/llm-pi-ai/src/index.ts', import.meta.url),
  new URL('../../../packages/llm/llm-pi-ai/lib/index.js', import.meta.url),
)
const provider = 'deepseek-official'
const model = 'deepseek-v4-flash'
const stamp = Date.parse('2026-11-04T12:30:00.000Z')
const rankingUrl = 'https://www.qimao.com/paihang/boy/hot/date/'
const bookUrl = 'https://www.qimao.com/shuku/71000011/'
const finalText = '已读取七猫公开榜单及《福星小厨娘》详情：累计人气值 8.1 万、次阅读 5.2 万；当前在读人数和金选标记未知，不能据此判定达到在读或金选门槛。'
const rankingHtml = `<html><title>七猫大热榜</title><body>
<div class="qm-switch-tab"><span class="item active">男生榜</span></div>
<div class="child-tabs-item active"><a href="/paihang/boy/hot/date/">大热榜</a></div>
<div class="date-type-tabs"><span class="tab active">日榜</span></div>
<div class="rank-list"><div class="rank-list-item"><span class="rank-number">1</span>
<a class="s-book-title" href="/shuku/71000011/">福星小厨娘</a>
<div class="s-book-info"><a href="/zuozhe/710001/">样例作者</a><a href="https://www.qimao.com/shuku/a-1/">美食</a>连载中 20万字</div>
<div class="s-book-intro">合成选材样本</div><div class="other-info">12.3万热度</div>
<div class="s-book-update">2026-11-04 12:00:00</div></div></div></body></html>`
const detailHtml = `<html><title>福星小厨娘</title><body>
<div class="book-information"><div class="title"><span class="txt">福星小厨娘</span></div>
<div class="tags-wrap"><a href="https://www.qimao.com/shuku/a-1/">美食</a>连载中</div>
<p>20万字 8.1万累计人气值 5.2万次阅读</p>
<div class="update-chapter-title"><a href="/shuku/71000011-1000001/">最新章节</a></div>
<div class="update-time">2026-11-04 12:00:00</div></div>
<div class="author-information"><div class="author-name"><a href="/zuozhe/710001/">样例作者</a></div></div>
<div class="book-introduction"><div class="intro">合成选材样本</div></div>
<div class="chapter-content">CHAPTER_BODY_MUST_NOT_REACH_THE_MODEL</div></body></html>`

/** Loader name for deterministic public book observations. */
export const name = 'snapshot-qimao-data'
/** The real registry and adapter own tool execution and durable model streaming. */
export const inject = ['llm', 'tools']

/**
 * Mount exact public-page responses before constructing the real Qimao provider.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated shipped-profile context.
 * @returns {Promise<void>} Completion after transport and model fixtures are ready.
 */
export async function apply(ctx) {
  const pageRequests = []
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
        assert.ok(modelRequests <= 4)
        if (modelRequests > 1) {
          const results = payload.messages.filter(message => message.role === 'tool')
          assert.equal(results.length, modelRequests - 1)
          assert.match(JSON.stringify(results), /71000011/)
          assert.doesNotMatch(JSON.stringify(results), /CHAPTER_BODY_MUST_NOT_REACH_THE_MODEL/)
        }
        const calls = [
          { name: 'qimao_rankings', arguments: '{"channels":["boy"],"boards":["hot"],"periods":["date"],"refresh":true}' },
          { name: 'qimao_search', arguments: '{"query":"福星","channels":["boy"],"boards":["hot"],"periods":["date"]}' },
          { name: 'qimao_detail', arguments: '{"bookId":"71000011","refresh":true}' },
        ]
        const call = calls[modelRequests - 1]
        const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `qimao-public-${modelRequests}`, type: 'function', function: call }] }
          : { role: 'assistant', content: finalText }
        const events = [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
        ]
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n')
      } catch (error) {
        rejected = error
        console.error(error instanceof Error ? error.message : 'Local Qimao fixture assertion failed')
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end('{"error":{"message":"Local Qimao fixture mismatch"}}')
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
    if (url.href === rankingUrl || url.href === bookUrl) {
      options?.signal?.throwIfAborted()
      pageRequests.push(url.href)
      return new Response(url.href === rankingUrl ? rankingHtml : detailHtml, { headers: { 'content-type': 'text/html' } })
    }
    if (url.origin === `http://127.0.0.1:${address.port}` && url.pathname === '/chat/completions') return originalFetch(input, options)
    throw new Error(`Qimao fixture refuses an unrelated request: ${url.origin}${url.pathname}`)
  }
  Date.now = () => stamp
  ctx.effect(() => () => { globalThis.fetch = originalFetch; Date.now = originalNow })
  await ctx.plugin(qimao, { requestIntervalMs: 0, allowLegacyResponseHeaders: false })
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
    assert.deepEqual(pageRequests, [rankingUrl, bookUrl])
    assert.equal(modelRequests, 4)
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    assert.equal(results.length, 3)
    const values = results.map(event => {
      assert.equal(event.data.message.isError, false)
      const block = event.data.message.content.find(item => item.type === 'text')
      assert.ok(block)
      return JSON.parse(block.text)
    })
    const ranked = values[0].items[0]
    assert.equal(ranked.bookId, '71000011')
    assert.equal(ranked.metrics.heat.value, 123000)
    assert.equal(ranked.currentReaders, null)
    assert.equal(ranked.goldenPick, null)
    assert.equal(values[0].coverage.completeFor, 'requested_public_pages')
    assert.equal(values[0].coverage.siteWide, false)
    assert.equal(values[0].coverage.pages[0].paginationVerified, false)
    assert.equal(values[1].scope, 'collected_public_window_search')
    assert.equal(values[1].complete, false)
    assert.equal(values[1].matchedInWindow, 1)
    assert.equal(values[1].fromCache, true)
    const detailed = values[2]
    assert.equal(detailed.bookId, '71000011')
    assert.equal(detailed.metrics.cumulativePopularity.value, 81000)
    assert.equal(detailed.metrics.readOccurrences.value, 52000)
    assert.equal(detailed.metrics.readOccurrences.label, '次阅读')
    assert.equal(detailed.currentReaders, null)
    assert.equal(detailed.goldenPick, null)
  })
}
