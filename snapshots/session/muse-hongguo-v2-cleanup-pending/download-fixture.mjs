/** Session replay covers a cleanup failure, retained output and a bounded retry. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { basename, join } from 'node:path'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'
import { media, calls, privateMarker } from './engine-fixture.mjs'
const owner = new URL('../../../apps/desktop-host/package.json', import.meta.url)
const { Service } = await importSnapshotPackage('@deepseek-ai/cordis', owner)
const { LlmAdapter, ToolCallId } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const clientURL = new URL('../../../third_party/plugins/muse-hongguo-download/src/v2-download.js', import.meta.url)
const engineURL = new URL('./engine-fixture.mjs', import.meta.url)
const fsURL = new URL('./fs-fixture.mjs', import.meta.url)
const provider = 'hongguo-v2-cleanup-fixture', id = '1000000000000000001', outputDir = 'v2-media'
const steps = [
  { id: 'v2-info', tool: 'hongguo_download_info', args: { seriesIds: [id] } },
  { id: 'v2-full', tool: 'hongguo_download', args: { seriesIds: [id], outputDir } },
  { id: 'v2-resume', tool: 'hongguo_download', args: { seriesIds: [id], outputDir } },
]
class Codec extends Service {
  constructor(ctx) { super(ctx, 'subprocess') }
  async resolveExecutable(value) { assert.equal(value, process.execPath); return value }
  spawn(spec) {
    assert.equal(spec.argv[0], process.execPath)
    const probe = spec.argv.includes('-show_entries')
    const text = probe ? JSON.stringify({ format: { duration: '10' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 720, height: 1280 }, { codec_type: 'audio', codec_name: 'aac' }] }) : ''
    const done = Promise.resolve({ exitCode: 0, signal: null })
    return { done, waitForExit: async () => true, terminate() {}, collected: { stdout: { readFrom: () => ({ text, lossy: false, truncated: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false, truncated: false }) } } }
  }
}
function* response(step) {
  if (!step) { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: '首次清理失败，已验证的第1集及临时目录保留。重试复用第1集并完成第2集；临时目录需人工检查。' } }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
  const args = JSON.stringify(step.args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(step.id), name: step.tool, argumentsDelta: args }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(step.id), name: step.tool, arguments: args } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
class Adapter extends LlmAdapter { constructor(state) { super(); this.state = state } async *stream() { yield* response(steps[this.state.values.length]) } }
export const name = 'snapshot-hongguo-v2-cleanup-pending'
export const inject = ['llm', 'tools', 'agents']
/** Mount controlled engine/codec seams while preserving the shipped downloader and agent loop. */
export async function apply(ctx) {
  const state = { ids: [], values: [] }
  await ctx.plugin(Codec)
  ctx.effect(() => { const hooks = registerHooks({ resolve(specifier, context, next) { if (context.parentURL === clientURL.href && specifier === './v2-session.js') return { url: engineURL.href, shortCircuit: true }; if (context.parentURL === clientURL.href && specifier === 'node:fs/promises') return { url: fsURL.href, shortCircuit: true }; return next(specifier, context) } }); return () => hooks.deregister() })
  const plugin = await import('../../../third_party/plugins/muse-hongguo-download/src/index.js')
  await ctx.plugin(plugin, { legacyBackend: 'v2', v2RuntimeDir: '/fixture/runtime', v2StateDir: '/fixture/state', ffprobeExecutable: process.execPath, ffmpegExecutable: process.execPath })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== provider || options.purpose !== undefined) { yield* next(); return }
    const result = options.messages.findLast(m => m.role === 'tool')
    if (result && result.toolCallId !== state.ids.at(-1)) {
      const step = steps[state.values.length]; assert.equal(result.toolCallId, step.id); assert.equal(result.isError, false)
      const text = result.content.filter(b => b.type === 'text').map(b => b.text).join('\n'); assert.ok(!text.includes(privateMarker))
      const value = JSON.parse(text)
      if (step.id === 'v2-info') { assert.equal(value.ok, true); assert.equal(value.verifiedDownload, false); assert.equal(calls.filter(c => c.method === 'download').length, 0) }
      else if (step.id === 'v2-full') {
        assert.equal(value.ok, false); assert.equal(value.code, 'v2_cleanup_pending'); assert.equal(value.retainedEpisodeCount, 1)
        assert.equal(basename(value.cleanupPendingPath), '.muse-v2-snapshot-1')
        assert.deepEqual(await readFile(join(value.cleanupPendingPath, 'episode.part')), media)
      } else {
        assert.equal(value.ok, true); assert.equal(value.complete, true); assert.equal(value.reusedEpisodeCount, 1)
        assert.equal(value.newlyDownloadedEpisodeCount, 1); assert.equal(value.items[0].episodes.length, 2)
        for (const episode of value.items[0].episodes) { assert.equal(episode.sha256, createHash('sha256').update(media).digest('hex')); assert.deepEqual(await readFile(episode.path), media) }
      }
      state.ids.push(step.id); state.values.push(value)
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    assert.deepEqual(state.ids, steps.map(s => s.id)); assert.equal(calls.filter(c => c.method === 'download').length, 2)
    assert.ok(!JSON.stringify(agent.session.snapshotEvents()).includes(privateMarker))
    const output = join(process.cwd(), outputDir); assert.equal((await readdir(output, { recursive: true })).filter(p => p.endsWith('.part')).length, 1)
    await rm(output, { recursive: true, force: true })
    await writeFile(join(process.cwd(), 'v2-proof.json'), JSON.stringify({ cleanupReported: true, retainedEpisodes: 1, reusedEpisodes: 1, completedEpisodes: 2, engineDownloads: 2, leftoverPreserved: true, codec: 'controlled-external-verdict' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') ctx.effect(() => ctx.llm.registerAdapter([provider], new Adapter(state)))
}
