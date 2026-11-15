/** Same-name source records remain unverified until the real user-question service returns a proposal-bound decision. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { importSnapshotModule, importSnapshotPackage } from '../muse-fixture-import.mjs'

const { PiAiAdapter, resolveProfiles } = await importSnapshotModule(
  new URL('../../../packages/llm/llm-pi-ai/src/index.ts', import.meta.url),
  new URL('../../../packages/llm/llm-pi-ai/lib/index.js', import.meta.url),
)
const { SessionId } = await importSnapshotPackage('@deepseek-ai/dsh-session', new URL('../../../apps/cli/package.json', import.meta.url))
const stableSessionId = SessionId('snapshot-work-mapping-review')
const provider = 'deepseek-official'
const model = 'deepseek-v4-flash'
const stamp = Date.parse('2026-11-04T14:00:00.000Z')
const qimaoUrl = 'https://www.qimao.com/paihang/boy/hot/date/'
const hongguoUrl = 'https://hongguoduanju.com/rank/hot-comic-drama'
const finalText = '已将两条同名来源记录保存为待核实提案，经独立的人工确认后记录 same_work 关系并生成报告。确认绑定具体快照、提案 SHA 和修订，不自动合并其他同名作品，也不证明版权、改编授权或来源完整性。'
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
const hongguoHtml = `<script>_ROUTER_DATA=${JSON.stringify({ loaderData: { [route]: { pageNum: 1, canonicalUrl: hongguoUrl, updatedText: '11月4日已更新' } } })};</script>
<script data-fn-name="mergeLoaderData" data-fn-args="${pending}"></script>
<article aria-labelledby="rank-title-7100000000000000011">
<span class="pc-badge-number-fixture">1</span><h2 id="rank-title-7100000000000000011">福星小厨娘</h2>
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

/** Loader identity for source-backed human relationship review. */
export const name = 'snapshot-work-mapping'
/** The shipped loop, filesystem backend and model adapter remain real. */
export const inject = ['llm', 'tools', 'agents', 'fs', 'sandboxPolicy', 'sessions', 'sessionPersistence', 'userQuestions']

/**
 * Mount real private client copies, a persisted root Session and one deterministic human answerer.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated shipped-profile context.
 * @returns {Promise<void>} Completion after all owned resources and registrations are ready.
 */
export async function apply(ctx) {
  const anchor = await mkdtemp(fileURLToPath(new URL('../../../apps/desktop-host/.snapshot-work-mapping-', import.meta.url)))
  ctx.effect(() => () => rm(anchor, { recursive: true, force: true }))
  for (const plugin of ['muse-source-research', 'muse-qimao-data', 'muse-hongguo-search']) {
    await cp(new URL(`../../../third_party/plugins/${plugin}/`, import.meta.url), join(anchor, 'node_modules', plugin), {
      recursive: true,
      filter: source => !source.split(/[\\/]/).includes('node_modules'),
    })
  }
  const research = await import(pathToFileURL(join(anchor, 'node_modules/muse-source-research/src/index.js')).href)
  let modelRequests = 0
  let proposalState
  let proposalBeforeReview
  let questionRequests = 0
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
        assert.ok(modelRequests <= 10)
        const values = payload.messages.filter(message => message.role === 'tool').map(toolValue)
        assert.equal(values.length, modelRequests - 1)
        let call
        switch (modelRequests) {
          case 1: call = { name: 'source_snapshot', arguments: qimaoRequest }; break
          case 2: call = { name: 'source_snapshot', arguments: { action: 'collect', platform: 'hongguo', request: {
            operation: 'rankings', boards: ['hot-comic-drama'], refresh: true,
          } } }; break
          case 3: call = { name: 'work_mapping', arguments: { action: 'propose',
            left: { snapshotId: values[0].snapshotId, itemId: '71000011' },
            right: { snapshotId: values[1].snapshotId, itemId: '7100000000000000011' },
            relation: 'same_work', reason: '公开标题相同，仍需人工核验具体证据；同名本身不证明同一作品。',
          } }; break
          case 4:
            proposalState = values[2]
            assert.equal(proposalState.status, 'needs_human_review')
            assert.equal(proposalState.revision, 0)
            call = { name: 'work_mapping', arguments: { action: 'lookup', sourceRef: {
              snapshotId: values[0].snapshotId, itemId: '71000011',
            } } }
            break
          case 5:
            assert.equal(values[3].mappings[0].status, 'needs_human_review')
            assert.equal(questionRequests, 0)
            call = { name: 'work_mapping', arguments: { action: 'review', mappingId: proposalState.mappingId,
              expectedProposalSha256: proposalState.proposalSha256, expectedRevision: 0,
            } }
            break
          case 6:
            assert.equal(values[4].status, 'confirmed')
            assert.equal(values[4].revision, 1)
            call = { name: 'work_mapping', arguments: { action: 'lookup', mappingId: proposalState.mappingId } }
            break
          case 7: call = { name: 'work_mapping', arguments: { action: 'read', mappingId: proposalState.mappingId } }; break
          case 8: call = { name: 'source_report', arguments: { action: 'build',
            snapshotIds: [values[0].snapshotId, values[1].snapshotId], mappingIds: [proposalState.mappingId],
          } }; break
          case 9: call = { name: 'source_report', arguments: { action: 'read', reportId: values[7].reportId } }; break
          default: break
        }
        const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `work-mapping-${modelRequests}`, type: 'function',
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
        console.error(error instanceof Error ? error.message : 'Local work-mapping fixture assertion failed')
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end('{"error":{"message":"Local work-mapping fixture mismatch"}}')
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
      return new Response(url.href === qimaoUrl ? rankingHtml('12.3万') : hongguoHtml, {
        headers: { 'content-type': 'text/html' },
      })
    }
    if (url.origin === `http://127.0.0.1:${address.port}` && url.pathname === '/chat/completions') return originalFetch(input, options)
    throw new Error(`Work-mapping fixture refuses an unrelated request: ${url.origin}${url.pathname}`)
  }
  Date.now = () => stamp
  ctx.effect(() => () => { globalThis.fetch = originalFetch; Date.now = originalNow })
  const prepared = ctx.sessions.prepare(stableSessionId, { meta: { cwd: process.cwd(), createdAt: stamp, delegationDepth: 0 } })
  const handle = await ctx.sessionPersistence.create(prepared.header)
  try { await handle.flush() }
  finally { await handle.close() }
  ctx.on('user-questions/request', async request => {
    questionRequests++
    assert.equal(questionRequests, 1)
    assert.equal(request.agent, ctx.agents.get(stableSessionId))
    assert.equal(request.agent.session.id, stableSessionId)
    assert.equal(request.questions.length, 1)
    const question = request.questions[0]
    assert.equal(question.id, `work-mapping-${proposalState.proposalSha256}-r0`)
    assert.equal(question.multiSelect, false)
    assert.deepEqual(question.options.map(option => option.label), ['确认关系', '不同（拒绝该关系）', '待核实'])
    for (const endpoint of [proposalState.proposal.left, proposalState.proposal.right]) {
      assert.ok(question.detail.includes(endpoint.sourceRef.snapshotId))
      assert.ok(question.detail.includes(endpoint.snapshotSha256))
      assert.ok(question.detail.includes(endpoint.key))
    }
    assert.ok(question.detail.includes(proposalState.proposalSha256))
    assert.match(question.detail, /当前修订：0/)
    assert.match(question.detail, /模型理由（未独立核实）/)
    proposalBeforeReview = await readFile(proposalState.receipts.proposal.path, 'utf8')
    return { answers: [{ id: question.id, selected: ['确认关系'] }] }
  })
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
    assert.equal(agent.session.id, stableSessionId)
    assert.deepEqual(pageRequests, [qimaoUrl, hongguoUrl])
    assert.equal(modelRequests, 10)
    assert.equal(questionRequests, 1)
    assert.equal(ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'workspace-write')
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    assert.equal(results.length, 9)
    const values = results.map(event => {
      assert.equal(event.data.message.isError, false)
      return toolValue(event.data.message)
    })
    for (const receipt of values.slice(0, 2)) {
      const bytes = await readFile(receipt.path)
      assert.equal(digest(bytes), receipt.sha256)
      assert.equal(receipt.canonicalCount, 1)
      assert.equal(receipt.unidentifiedCount, 0)
    }
    const pending = values[2], reviewed = values[4], read = values[6]
    assert.equal(pending.status, 'needs_human_review')
    assert.equal(pending.revision, 0)
    assert.equal(pending.proposal.left.title, pending.proposal.right.title)
    assert.equal(pending.proposal.reasonVerified, false)
    assert.equal(values[3].mappings[0].status, 'needs_human_review')
    assert.equal(reviewed.status, 'confirmed')
    assert.equal(reviewed.revision, 1)
    assert.equal(reviewed.latestRevision.reviewerSessionId, stableSessionId)
    assert.deepEqual(values[5].mappings[0], reviewed)
    assert.deepEqual(read, reviewed)
    const proposalBytes = await readFile(reviewed.receipts.proposal.path, 'utf8')
    assert.equal(proposalBytes, proposalBeforeReview)
    assert.equal(digest(proposalBytes), pending.proposalSha256)
    const revisionBytes = await readFile(reviewed.receipts.revision.path)
    assert.equal(digest(revisionBytes), reviewed.revisionSha256)
    const revision = JSON.parse(revisionBytes.toString('utf8'))
    assert.equal(revision.questionId, `work-mapping-${pending.proposalSha256}-r0`)
    assert.deepEqual(revision.answer, { id: revision.questionId, selected: ['确认关系'] })
    assert.equal(revision.status, 'confirmed')
    const reportBytes = await readFile(values[7].path)
    assert.equal(digest(reportBytes), values[7].sha256)
    const report = JSON.parse(reportBytes.toString('utf8'))
    assert.deepEqual(report, values[8].report)
    assert.equal(report.mappingReceipts.length, 1)
    assert.equal(report.mappingReceipts[0].status, 'confirmed')
    assert.equal(report.mappingReceipts[0].proposalSha256, pending.proposalSha256)
    assert.deepEqual(report.mappingReceipts[0].latestRevision, revision)
    const markdown = await readFile(values[7].markdownPath, 'utf8')
    assert.equal(markdown, values[8].markdown)
    assert.equal(digest(markdown), report.markdownSha256)
    assert.match(markdown, /作品关系审核/)
    assert.match(markdown, /已核实（人工确认该提案）/)
    assert.match(markdown, /未审提案保持未核实/)
    assert.match(markdown, /不证明版权/)
  })
  ctx.effect(() => ctx.provide('snapshotWorkMappingReady', true))
}
