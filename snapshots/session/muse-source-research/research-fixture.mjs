/** Collect real public-client observations, compare stored evidence and publish a report through the shipped filesystem policy. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const { PiAiAdapter, resolveProfiles } = await importSnapshotModule(
  new URL('../../../packages/llm/llm-pi-ai/src/index.ts', import.meta.url),
  new URL('../../../packages/llm/llm-pi-ai/lib/index.js', import.meta.url),
)
const provider = 'deepseek-official'
const model = 'deepseek-v4-flash'
const firstStamp = Date.parse('2026-11-04T12:00:00.000Z')
const secondStamp = Date.parse('2026-11-05T12:00:00.000Z')
const qimaoUrl = 'https://www.qimao.com/paihang/boy/hot/date/'
const hongguoUrl = 'https://hongguoduanju.com/rank/hot-comic-drama'
const finalText = '已保存三份原始观测快照、比较七猫同口径热度并生成选材日报。七猫热度由 12.3 万变为 13.3 万；红果收藏与点赞未知，报告保留缺失及覆盖范围，不据此判断全市场增长、在读人数或金选。'
const rankingHtml = heat => `<html><title>七猫大热榜</title><body>
<div class="qm-switch-tab"><span class="item active">男生榜</span></div>
<div class="child-tabs-item active"><a href="/paihang/boy/hot/date/">大热榜</a></div>
<div class="date-type-tabs"><span class="tab active">日榜</span></div>
<div class="rank-list"><div class="rank-list-item"><span class="rank-number">1</span>
<a class="s-book-title" href="/shuku/71000011/">福星小厨娘</a>
<div class="s-book-info"><a href="/zuozhe/710001/">样例作者</a><a href="https://www.qimao.com/shuku/a-1/">美食</a>连载中 20万字</div>
<div class="s-book-intro">合成选材样本</div><div class="other-info">${heat}热度</div>
<div class="s-book-update">2026-11-04 12:00:00</div></div></div></body></html>`
const route = 'rank_hot-comic-drama/page'
const pending = JSON.stringify([route, [{ key: 'content', routerDataFnName: 's', routerDataFnArgs: ['"pending"', '"content"'] }]])
  .replaceAll('&', '&amp;').replaceAll('"', '&quot;')
const hongguoHtml = `<script>_ROUTER_DATA=${JSON.stringify({ loaderData: { [route]: { pageNum: 1, canonicalUrl: hongguoUrl, updatedText: '11月5日已更新' } } })};</script>
<script data-fn-name="mergeLoaderData" data-fn-args="${pending}"></script>
<article aria-labelledby="rank-title-7100000000000000011">
<span class="pc-badge-number-fixture">1</span><h2 id="rank-title-7100000000000000011">锦鲤小厨娘</h2>
<p class="pc-description-fixture">合成榜单样本</p><p class="pc-categories-fixture"><span>美食</span></p>
<p class="pc-metrics-fixture">200万热度</p></article>
<nav aria-label="榜单分页"><a href="/rank/hot-comic-drama">1</a></nav>`
const qimaoRequest = { action: 'collect', platform: 'qimao', request: {
  operation: 'rankings', channels: ['boy'], boards: ['hot'], periods: ['date'], refresh: true,
} }
const digest = value => createHash('sha256').update(value).digest('hex')
const toolValue = message => {
  const content = typeof message.content === 'string' ? message.content
    : message.content.find(block => block.type === 'text')?.text
  assert.equal(typeof content, 'string')
  return JSON.parse(content)
}

/** Loader identity for persisted source-research observations. */
export const name = 'snapshot-source-research'
/** The shipped loop, filesystem backend and model adapter remain real. */
export const inject = ['llm', 'tools', 'agents', 'fs', 'sandboxPolicy']

/**
 * Mount private installed-client copies before the real research provider and exact network responses.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated shipped-profile context.
 * @returns {Promise<void>} Completion after all owned resources and registrations are ready.
 */
export async function apply(ctx) {
  const anchor = await mkdtemp(fileURLToPath(new URL('../../../apps/desktop-host/.snapshot-research-', import.meta.url)))
  ctx.effect(() => () => rm(anchor, { recursive: true, force: true }))
  for (const plugin of ['muse-source-research', 'muse-qimao-data', 'muse-hongguo-search']) {
    await cp(new URL(`../../../third_party/plugins/${plugin}/`, import.meta.url), join(anchor, 'node_modules', plugin), {
      recursive: true,
      filter: source => !source.split(/[\\/]/).includes('node_modules'),
    })
  }
  const research = await import(pathToFileURL(join(anchor, 'node_modules/muse-source-research/src/index.js')).href)
  let stamp = firstStamp
  let modelRequests = 0
  let qimaoRequests = 0
  const pageRequests = []
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
        assert.ok(modelRequests <= 7)
        const values = payload.messages.filter(message => message.role === 'tool').map(toolValue)
        assert.equal(values.length, modelRequests - 1)
        let call
        switch (modelRequests) {
          case 1: call = { name: 'source_snapshot', arguments: qimaoRequest }; break
          case 2:
            assert.equal(values[0].canonicalCount, 1)
            stamp = secondStamp
            call = { name: 'source_snapshot', arguments: qimaoRequest }
            break
          case 3:
            assert.notEqual(values[0].snapshotId, values[1].snapshotId)
            call = { name: 'source_snapshot', arguments: { action: 'collect', platform: 'hongguo', request: {
              operation: 'rankings', boards: ['hot-comic-drama'], refresh: true,
            } } }
            break
          case 4: call = { name: 'source_snapshot', arguments: {
            action: 'compare', beforeId: values[0].snapshotId, afterId: values[1].snapshotId,
          } }; break
          case 5: call = { name: 'source_report', arguments: {
            action: 'build', snapshotIds: [values[1].snapshotId, values[2].snapshotId], baselineIds: [values[0].snapshotId],
          } }; break
          case 6: call = { name: 'source_report', arguments: { action: 'read', reportId: values[4].reportId } }; break
          default: break
        }
        const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `source-research-${modelRequests}`, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
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
        console.error(error instanceof Error ? error.message : 'Local source-research fixture assertion failed')
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end('{"error":{"message":"Local source-research fixture mismatch"}}')
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
    if (url.href === qimaoUrl || url.href === hongguoUrl) {
      options?.signal?.throwIfAborted()
      pageRequests.push(url.href)
      if (url.href === qimaoUrl) qimaoRequests++
      return new Response(url.href === qimaoUrl ? rankingHtml(qimaoRequests === 1 ? '12.3万' : '13.3万') : hongguoHtml, {
        headers: { 'content-type': 'text/html' },
      })
    }
    if (url.origin === `http://127.0.0.1:${address.port}` && url.pathname === '/chat/completions') return originalFetch(input, options)
    throw new Error(`Source-research fixture refuses an unrelated request: ${url.origin}${url.pathname}`)
  }
  Date.now = () => stamp
  ctx.effect(() => () => { globalThis.fetch = originalFetch; Date.now = originalNow })
  await ctx.plugin(research, { hongguo: { requestIntervalMs: 0 }, qimao: { requestIntervalMs: 0, allowLegacyResponseHeaders: false } })
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
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (rejected) throw rejected
    assert.deepEqual(pageRequests, [qimaoUrl, qimaoUrl, hongguoUrl])
    assert.equal(modelRequests, 7)
    assert.equal(ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'workspace-write')
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    assert.equal(results.length, 6)
    const values = results.map(event => {
      assert.equal(event.data.message.isError, false)
      return toolValue(event.data.message)
    })
    const snapshots = await Promise.all(values.slice(0, 3).map(async receipt => {
      const bytes = await readFile(receipt.path)
      assert.equal(digest(bytes), receipt.sha256)
      assert.equal(receipt.canonicalCount, 1)
      assert.equal(receipt.unidentifiedCount, 0)
      return JSON.parse(bytes.toString('utf8'))
    }))
    assert.equal(snapshots[0].sourceResult.items[0].metrics.heat.raw, '12.3万热度')
    assert.equal(snapshots[1].sourceResult.items[0].metrics.heat.raw, '13.3万热度')
    assert.equal(snapshots[0].canonicalItems[0].metrics.heat.value, 123000)
    assert.equal(snapshots[1].canonicalItems[0].metrics.heat.value, 133000)
    assert.equal(snapshots[0].coverage.siteWide, false)
    assert.equal(snapshots[0].coverage.pages[0].paginationVerified, false)
    assert.equal(snapshots[2].sourceResult.items[0].collection.value, null)
    assert.equal(snapshots[2].sourceResult.items[0].likes.value, null)
    assert.equal(snapshots[2].canonicalItems[0].metrics.collection.value, null)
    assert.equal(snapshots[2].canonicalItems[0].metrics.likes.value, null)
    assert.equal(snapshots[2].coverage.metrics.complete, false)
    const comparison = values[3]
    assert.equal(comparison.sameScope, true)
    const heat = comparison.comparisons[0].metrics.find(metric => metric.field === 'heat')
    assert.equal(heat.delta, 10000)
    assert.equal(heat.measurementAdvanced, true)
    const reportBytes = await readFile(values[4].path)
    assert.equal(digest(reportBytes), values[4].sha256)
    const report = JSON.parse(reportBytes.toString('utf8'))
    assert.deepEqual(report.inputReceipts.map(receipt => receipt.snapshotId), [values[1].snapshotId, values[2].snapshotId, values[0].snapshotId])
    assert.deepEqual(values[5].report, report)
    const markdown = await readFile(values[4].markdownPath, 'utf8')
    assert.equal(values[5].markdown, markdown)
    assert.equal(digest(markdown), report.markdownSha256)
    assert.match(markdown, /source|平台范围|原始观察时间/)
    assert.match(markdown, /collection|likes/)
    assert.match(markdown, /10000/)
    assert.match(markdown, /在读人数、金选/)
    assert.match(JSON.stringify(values[5]), /报告|report|inputReceipts/)
  })
}
