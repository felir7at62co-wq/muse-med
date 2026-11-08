/** Exercise persisted unknown metrics and two real scoped research providers in shipped Headless. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

const stamp = Date.parse('2026-11-04T12:00:00.000Z')
const pageUrl = 'https://hongguoduanju.com/rank/hot-comic-drama'
const scenario = new URL('../../../../../snapshots/session/muse-source-research-admission/', import.meta.url)
const request = { action: 'collect', platform: 'hongguo', request: { operation: 'rankings', boards: ['hot-comic-drama'], refresh: true } }
const hash = value => createHash('sha256').update(value).digest('hex')
const valueOf = result => {
  assert.equal(result.isError, false, JSON.stringify(result))
  const block = result.content.find(item => item.type === 'text')
  assert.ok(block)
  return JSON.parse(block.text)
}

function verifySnapshot(snapshot) {
  assert.equal(snapshot.adapterVersion, '1.0.1')
  assert.equal(snapshot.canonicalItems.length, 1)
  const item = snapshot.canonicalItems[0]
  assert.equal(item.id, '7100000000000000021')
  const raws = { collection: '-12收藏', likes: '1e3点赞', heat: '约200万热度' }
  for (const [field, raw] of Object.entries(raws)) {
    const source = snapshot.sourceResult.items[0]
    assert.equal(source[field].raw, raw)
    assert.equal(source[field].value, null)
    assert.equal(item.metrics[field].raw, raw)
    assert.equal(item.metrics[field].value, null)
    assert.equal(item.metrics[field].missingReason, 'unparseable', `${field}: persisted canonical reason must match the source observation`)
    assert.ok(source.observations[0].missingMetrics.some(missing => missing.field === field && missing.reason === 'unparseable'))
  }
  assert.equal(snapshot.coverage.complete, true)
  assert.equal(snapshot.coverage.metrics.complete, false)
}

/** Loader identity for the owned source research publication scenario. */
export const name = 'snapshot-source-research-admission'
/** The registered tools, real filesystem, real Agent scopes and native replay remain production services. */
export const inject = ['llm', 'tools', 'agents', 'fs', 'userQuestions', 'sandboxPolicy']

/**
 * Mount private installed packages and an exact public-HTML transport; no business result or model adapter is replaced.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless services.
 * @returns {Promise<void>} Completion after all scenario effects are registered.
 */
export async function apply(ctx) {
  const anchor = await mkdtemp(fileURLToPath(new URL('../../../.snapshot-research-admission-', import.meta.url)))
  ctx.effect(() => () => rm(anchor, { recursive: true, force: true }))
  const override = process.env.MUSE_RESEARCH_PLUGIN_ROOT
  if (override !== undefined) {
    assert.equal(process.env.DSH_EXAMPLE_MODE, 'lib')
    assert.ok(isAbsolute(override), 'The negative control accepts only an owned absolute package directory')
  }
  for (const plugin of ['muse-source-research', 'muse-hongguo-search', 'muse-qimao-data']) {
    const source = plugin === 'muse-source-research' && override !== undefined
      ? override : new URL(`../../../../../third_party/plugins/${plugin}/`, import.meta.url)
    await cp(source, join(anchor, 'node_modules', plugin), {
      recursive: true, filter: sourcePath => !sourcePath.split(/[\\/]/).includes('node_modules'),
    })
  }
  const research = await import(pathToFileURL(join(anchor, 'node_modules/muse-source-research/src/index.js')).href)
  const html = await readFile(new URL('page.html', scenario), 'utf8')
  let pageRequests = 0
  let quotaActive = false
  let quotaArrivals = 0
  const bothPagesEntered = Promise.withResolvers()
  ctx.effect(() => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    globalThis.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      assert.equal(url.href, pageUrl, 'The fixture refuses every unrelated network request')
      options?.signal?.throwIfAborted()
      pageRequests++
      if (quotaActive) {
        quotaArrivals++
        assert.ok(quotaArrivals <= 2)
        if (quotaArrivals === 2) bothPagesEntered.resolve()
        await bothPagesEntered.promise
        options?.signal?.throwIfAborted()
      }
      return new Response(html, { headers: { 'content-type': 'text/html' } })
    }
    Date.now = () => stamp
    return () => { globalThis.fetch = originalFetch; Date.now = originalNow }
  })
  const config = { maxSnapshots: 1, hongguo: { requestIntervalMs: 0 }, qimao: { requestIntervalMs: 0 } }
  await ctx.plugin(research, config)
  let root
  let rootRequests = 0
  let admissionObserved = false
  let readObserved = false
  const scopes = []
  ctx.effect(() => async () => {
    bothPagesEntered.resolve()
    for (const handle of [...scopes].reverse()) await handle.dispose()
  })
  async function invoke(agent, args, signal, suffix) {
    const batch = await ctx.agents.withInitiator(agent, () => {
      assert.equal(ctx.agents.requireInitiator(), agent)
      return ctx.tools.execute({ agent, signal, calls: [{
        type: 'tool-call', id: ToolCallId(`admission-${suffix}`), name: 'source_snapshot', arguments: JSON.stringify({ ...args, project: 'quota' }),
      }] })
    })
    assert.equal(batch.results.length, 1)
    return batch.results[0].result
  }
  ctx.effect(() => ctx.tools.register({
    name: 'source_research_admission',
    description: 'Fixture-only observation of two real scoped research providers sharing one project and maxSnapshots=1.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
    execute: async (_args, exec) => {
      assert.equal(scopes.length, 0)
      assert.equal(exec.agent, root)
      const quota = join(root.session.header.cwd, 'quota')
      await mkdir(quota)
      for (let index = 1; index <= 2; index++) {
        const handle = await ctx.agents.create({
          sessionId: SessionId(`source-research-admission-scope-${index}`),
          parentAgent: root, meta: { cwd: root.session.header.cwd, parentSession: root.id, delegationDepth: 1 },
          agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
          setup: async scoped => { await scoped.plugin(research, config) },
        })
        scopes.push(handle)
        handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '仅确认此独立配额会话已建立，不调用任何工具。' }] }))
        await handle.agent.whenIdle()
      }
      assert.notEqual(scopes[0].agent.ctx, scopes[1].agent.ctx)
      assert.equal(scopes[0].agent.session.header.cwd, scopes[1].agent.session.header.cwd)
      quotaActive = true
      const outcomes = await Promise.all(scopes.map((handle, index) => invoke(handle.agent, request, exec.signal, `collect-${index}`)))
      quotaActive = false
      assert.equal(quotaArrivals, 2, `Both real clients entered collection before publication: ${JSON.stringify(outcomes)}`)
      const successful = outcomes.filter(result => !result.isError)
      const rejected = outcomes.filter(result => result.isError)
      assert.equal(successful.length, 1, 'A shared project permits only one successful scoped publication at maxSnapshots=1')
      assert.equal(rejected.length, 1)
      assert.equal(rejected[0].error.message, 'Research snapshots exceed maxSnapshots; archive to another project before collecting')
      const receipt = valueOf(successful[0])
      assert.equal(receipt.path, join(quota, '.muse/source-research/snapshots/v1', `${receipt.snapshotId}.json`))
      const files = await readdir(join(quota, '.muse/source-research/snapshots/v1'))
      assert.deepEqual(files, [`${receipt.snapshotId}.json`])
      const bytes = await readFile(receipt.path)
      assert.equal(hash(bytes), receipt.sha256)
      verifySnapshot(JSON.parse(bytes.toString('utf8')))
      for (const [index, handle] of scopes.entries()) {
        const listing = valueOf(await invoke(handle.agent, { action: 'list' }, exec.signal, `list-${index}`))
        assert.equal(listing.complete, true)
        assert.equal(listing.count, 1)
        assert.equal(listing.snapshots[0].sha256, receipt.sha256)
        const read = valueOf(await invoke(handle.agent, { action: 'read', snapshotId: receipt.snapshotId }, exec.signal, `read-${index}`))
        assert.equal(read.receipt.sha256, receipt.sha256)
        verifySnapshot(read.snapshot)
      }
      admissionObserved = true
      return { scopes: 2, clientsEntered: quotaArrivals, successfulPublications: successful.length,
        rejectedPublications: rejected.length, rejection: rejected[0].error.message,
        persistedFiles: files.length, listsComplete: true, readableFromBothScopes: true,
        snapshotId: receipt.snapshotId, sha256: receipt.sha256,
        unsupportedMetrics: { raw: ['-12收藏', '1e3点赞', '约200万热度'], value: null, missingReason: 'unparseable' } }
    },
  }))
  ctx.on('llm/stream', async function* (options, next) {
    if (options.sessionId === root?.id || root === undefined) {
      root = ctx.agents.requireInitiator()
      rootRequests++
      const collected = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'research-collect-unknown')
      if (collected !== undefined) {
        const receipt = valueOf(collected)
        const bytes = await readFile(receipt.path)
        assert.equal(hash(bytes), receipt.sha256)
        verifySnapshot(JSON.parse(bytes.toString('utf8')))
      }
      const read = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'research-read-unknown')
      if (read !== undefined) {
        const value = valueOf(read)
        const bytes = await readFile(value.receipt.path)
        assert.equal(hash(bytes), value.receipt.sha256)
        assert.deepEqual(JSON.parse(bytes.toString('utf8')), value.snapshot)
        verifySnapshot(value.snapshot)
        readObserved = true
      }
      const admission = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'research-admission')
      if (admission !== undefined) {
        const observed = valueOf(admission)
        assert.equal(observed.successfulPublications, 1)
        assert.equal(observed.readableFromBothScopes, true)
      }
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (agent !== root) return
    assert.equal(pageRequests, 3)
    assert.equal(rootRequests, 4)
    assert.equal(readObserved, true)
    assert.equal(admissionObserved, true)
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    assert.equal(results.length, 3)
    assert.ok(results.every(event => event.data.message.isError === false))
    const last = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').at(-1)
    assert.ok(last?.data.message.content.some(block => block.type === 'text' && block.text.includes('未知') && block.text.includes('配额')))
  })
}
