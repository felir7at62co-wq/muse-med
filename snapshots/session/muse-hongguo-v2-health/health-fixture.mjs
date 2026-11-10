/** Replay preserves health scope through the real registered tool, client and session log. */
import assert from 'node:assert/strict'
import { lstat, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'
import { calls, sessions, privateMarker } from './engine-fixture.mjs'

const owner = new URL('../../../apps/desktop-host/package.json', import.meta.url)
const { Service } = await importSnapshotPackage('@deepseek-ai/cordis', owner)
const { LlmAdapter, ToolCallId } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const clientURL = new URL('../../../third_party/plugins/muse-hongguo-download/src/v2-download.js', import.meta.url)
const engineURL = new URL('./engine-fixture.mjs', import.meta.url)
const provider = 'hongguo-v2-health-fixture', seriesId = '1000000000000000001'
const processCalls = []
const steps = [
  { id: 'v2-health-local', args: {} },
  { id: 'v2-health-catalog', args: { seriesIds: [seriesId] } },
]
const count = method => calls.filter(call => call.method === method).length
class NoProcesses extends Service {
  constructor(ctx) { super(ctx, 'subprocess') }
  async resolveExecutable() { processCalls.push('resolve'); throw new Error('Health fixture must not resolve an executable') }
  spawn() { processCalls.push('spawn'); throw new Error('Health fixture must not spawn') }
}
function* response(step) {
  if (!step) {
    const text = '本地运行资源和引擎检查通过，目录摘要有2集。授权尚未检查，媒体可用性尚未测试，没有下载视频，不能据此判断全集可下载。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }
  const args = JSON.stringify(step.args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(step.id), name: 'hongguo_download_health', argumentsDelta: args }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(step.id), name: 'hongguo_download_health', arguments: args } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
class Adapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }
  async *stream() { yield* response(steps[this.state.values.length]) }
}
export const name = 'snapshot-hongguo-v2-health'
export const inject = ['llm', 'tools', 'agents']

/** Mount a fake session while retaining the shipped health registration and scope checks. */
export async function apply(ctx) {
  const state = { ids: [], values: [], network: 0 }
  await ctx.plugin(NoProcesses)
  ctx.effect(() => {
    const native = globalThis.fetch
    globalThis.fetch = () => { state.network++; throw new Error('Health replay must not use the network') }
    return () => { globalThis.fetch = native }
  })
  ctx.effect(() => {
    const hooks = registerHooks({ resolve(specifier, context, next) {
      return specifier === './v2-session.js' && context.parentURL === clientURL.href
        ? { url: engineURL.href, shortCircuit: true } : next(specifier, context)
    } })
    return () => hooks.deregister()
  })
  const plugin = await import('../../../third_party/plugins/muse-hongguo-download/src/index.js')
  await ctx.plugin(plugin, { legacyBackend: 'v2', v2RuntimeDir: '/fixture/runtime', v2StateDir: '/fixture/state' })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== provider || options.purpose !== undefined) { yield* next(); return }
    assert.ok(options.tools.some(tool => tool.name === 'hongguo_download_health'))
    const result = options.messages.findLast(message => message.role === 'tool')
    if (result && result.toolCallId !== state.ids.at(-1)) {
      const step = steps[state.values.length]
      assert.equal(result.toolCallId, step.id); assert.equal(result.isError, false)
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      assert.ok(!text.includes(privateMarker))
      const value = JSON.parse(text)
      assert.equal(value.ok, true); assert.equal(value.sourceBackend, 'v2')
      assert.equal(value.authorization, 'not_checked'); assert.equal(value.mediaAvailability, 'not_tested')
      assert.equal(value.verifiedDownload, false); assert.equal(Object.hasOwn(value, 'complete'), false)
      assert.deepEqual(value.engine, { engineVersion: 'fixture-hongguo-v2', protocol: 2, build: 15 })
      assert.deepEqual(value.localLicenseStatus, { mode: 'Checking', reason: 'checking', refreshed: false })
      assert.equal(value.checks.shutdown, 'confirmed')
      if (step.id === 'v2-health-local') {
        assert.equal(value.scope, 'local'); assert.deepEqual(value.items, []); assert.equal(count('catalog'), 0)
        assert.equal(value.checks.catalog, 'not_requested')
      } else {
        assert.equal(value.scope, 'catalog'); assert.equal(value.items.length, 1)
        assert.equal(value.items[0].seriesId, seriesId); assert.equal(value.items[0].episodeCount, 2)
        assert.equal(value.items[0].completeCatalog, true); assert.equal(value.items[0].mediaUrlsVerified, false)
        assert.equal(value.items[0].fullSeriesAvailable, null); assert.equal(value.checks.catalog, 'passed')
      }
      assert.equal(count('download'), 0); assert.equal(count('refresh'), 0); assert.equal(count('authorize'), 0)
      for (const session of sessions) await assert.rejects(lstat(session.paths.runDir), { code: 'ENOENT' })
      state.ids.push(step.id); state.values.push(value)
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    assert.deepEqual(state.ids, steps.map(step => step.id))
    const events = agent.session.snapshotEvents(), toolCalls = events.filter(event => event.type === 'tool/call')
    assert.deepEqual(toolCalls.map(event => event.data.name), ['hongguo_download_health', 'hongguo_download_health'])
    assert.deepEqual(toolCalls.map(event => JSON.parse(event.data.arguments)), steps.map(step => step.args))
    assert.ok(!JSON.stringify(events).includes(privateMarker))
    assert.equal(count('health'), 2); assert.equal(count('catalog'), 1); assert.equal(count('dispose'), 2)
    assert.equal(state.network, 0); assert.equal(processCalls.length, 0)
    assert.equal(count('download'), 0); assert.equal(count('refresh'), 0); assert.equal(count('authorize'), 0)
    await writeFile(join(process.cwd(), 'v2-health-proof.json'), JSON.stringify({ healthCalls: 2, catalogCalls: 1,
      engineDownloads: 0, licenseRefreshes: 0, seriesAuthorizations: 0, spawnedProcesses: 0, networkCalls: 0,
      declaredEpisodes: 2, authorization: 'not_checked', mediaAvailability: 'not_tested', verifiedDownload: false,
      topLevelComplete: false, confirmedSessionShutdowns: 2 }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') ctx.effect(() => ctx.llm.registerAdapter([provider], new Adapter(state)))
}
