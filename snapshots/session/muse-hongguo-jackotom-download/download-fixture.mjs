/** Default jackotom mode uses the real adapter, tools, transfer, MP4 checks and receipts with an invented engine. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'
import { calls, media, privateMarker, seriesId } from './engine-fixture.mjs'
import { installHongguoTaskIdentity } from '../muse-hongguo-task-controls/identity-fixture.mjs'

const owner = new URL('../../../apps/desktop-host/package.json', import.meta.url)
const { Service } = await importSnapshotPackage('@deepseek-ai/cordis', owner)
const { LlmAdapter, ToolCallId } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const clientURL = new URL('../../../third_party/plugins/muse-hongguo-download/src/client.js', import.meta.url)
const adapterURL = new URL('./jackotom.js', clientURL)
const pluginURL = new URL('./index.js', clientURL)
const engineURL = new URL('./engine-fixture.mjs', import.meta.url)
const networkURL = new URL('./network-fixture.mjs', import.meta.url)
const provider = 'hongguo-jackotom-download-fixture', outputDir = 'engine-media'
const stamp = Date.parse('2026-11-15T05:00:00Z')
const sha256 = createHash('sha256').update(media).digest('hex')
const codecCalls = []
const steps = [
  { id: 'engine-info', tool: 'hongguo_download_info', args: { seriesIds: [seriesId] } },
  { id: 'engine-full', tool: 'hongguo_download', args: { seriesIds: [seriesId], outputDir } },
  { id: 'engine-resume', tool: 'hongguo_download', args: { seriesIds: [seriesId], outputDir } },
]
const count = method => calls.filter(call => call.method === method).length

class CodecFixture extends Service {
  constructor(ctx) { super(ctx, 'subprocess') }
  async resolveExecutable(value, _cwd, signal) {
    signal.throwIfAborted()
    assert.equal(value, process.execPath, 'No external executable may run in this fixture')
    return value
  }
  spawn(spec) {
    spec.signal.throwIfAborted()
    assert.equal(spec.argv[0], process.execPath)
    const probe = spec.argv.includes('-show_entries')
    const path = spec.argv[spec.argv.indexOf('-i') + 1]
    assert.equal(dirname(dirname(path)), join(spec.cwd, `虚构开源引擎剧-${seriesId}`))
    assert.match(basename(dirname(path)), /^\.media-stage-[a-zA-Z0-9]+$/)
    assert.equal(basename(path), 'input.part')
    const text = probe ? JSON.stringify({ format: { duration: '10' }, streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920 }, { codec_type: 'audio', codec_name: 'aac' }] }) : ''
    const done = (async () => {
      assert.deepEqual(await readFile(path), media)
      codecCalls.push(probe ? 'probe' : 'decode')
      return { exitCode: 0, signal: null }
    })()
    return { done, waitForExit: async () => { await done; return true }, terminate() {},
      collected: { stdout: { readFrom: () => ({ text, lossy: false, truncated: false }) },
        stderr: { readFrom: () => ({ text: '', lossy: false, truncated: false }) } } }
  }
}

async function verifyResult(message, step, state) {
  assert.equal(message.toolCallId, step.id)
  assert.equal(message.isError, false)
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  assert.ok(!text.includes(privateMarker), 'Signed URLs and device values must not enter tool output')
  const value = JSON.parse(text)
  assert.equal(value.ok, true, text)
  assert.equal(value.sourceMode, 'legacy')
  if (step.id === 'engine-info') {
    assert.equal(state.engineReplaced, true, 'The fixture must intercept the exact pinned engine module')
    assert.equal(value.verifiedDownload, false)
    assert.deepEqual(value.items.map(item => ({ source: item.source, episodeCount: item.episodeCount,
      completeCatalog: item.completeCatalog, mediaUrlsVerified: item.mediaUrlsVerified, fullSeriesAvailable: item.fullSeriesAvailable })),
    [{ source: 'jackotom/hongguo-drama', episodeCount: 2, completeCatalog: true, mediaUrlsVerified: false, fullSeriesAvailable: null }])
    assert.deepEqual(calls, [{ method: 'fetchEpisodeList', id: seriesId }], 'Info must not resolve play info or transfer media')
    assert.deepEqual(codecCalls, [])
    return value
  }
  assert.match(value.sourceIdentity, /^jackotom:[a-f0-9]{40}:1080p$/)
  assert.equal(value.requestedQuality, '1080p')
  assert.equal(value.complete, true)
  assert.equal(value.fullDecodeChecked, true)
  assert.equal(value.state, 'completed')
  assert.equal(value.items[0].episodeCount, 2)
  assert.equal(value.items[0].downloadedEpisodeCount, 2)
  assert.deepEqual(value.items[0].episodes.map(episode => episode.index), [1, 2])
  for (const episode of value.items[0].episodes) {
    assert.equal(episode.bytes, media.length)
    assert.equal(episode.sha256, sha256)
    assert.equal(episode.quality, '1080p')
    assert.deepEqual(await readFile(episode.path), media, 'The actual tool must publish the transferred bytes')
  }
  const { taskId, runId, jobId, state: taskState, task, downloadTask, ...download } = value
  assert.equal(taskId, task.id)
  assert.equal(runId, task.runId)
  assert.equal(jobId, null)
  assert.equal(taskState, 'completed')
  assert.deepEqual(downloadTask, task)
  assert.deepEqual(JSON.parse(await readFile(join(value.path, 'download-manifest.json'), 'utf8')), download)
  if (step.id === 'engine-full') assert.equal(value.newlyDownloadedEpisodeCount, 2)
  else {
    assert.equal(value.reusedEpisodeCount, 2)
    assert.equal(value.newlyDownloadedEpisodeCount, 0)
  }
  assert.equal(count('fetchEpisodeList'), 2, 'Resume must reuse receipts without reloading the catalog')
  assert.equal(count('fetchPlayUrlSingle'), 2, 'Resume must not request play info again')
  assert.equal(count('media'), 2, 'Resume must not transfer media again')
  assert.deepEqual(codecCalls, ['probe', 'decode', 'probe', 'decode'])
  return value
}

function* response(step) {
  if (step === undefined) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text',
      text: '目录有2集；两集已按1080p完整下载并通过校验，完整收据已保存。再次调用复用了2集，没有重新请求片源或下载。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }
  const args = JSON.stringify(step.args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(step.id), name: step.tool, argumentsDelta: args }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(step.id), name: step.tool, arguments: args } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
class DownloadAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }
  async *stream() { yield* response(steps[this.state.results.length]) }
}

/** Loader identity for default open-engine download checks. */
export const name = 'snapshot-hongguo-jackotom-download'
/** Shipped Headless services own the model loop, registered tools and initiating workspace. */
export const inject = ['llm', 'tools', 'agents']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated Headless profile context.
 * @returns {Promise<void>} Readiness after controlled external services and the real plugin are mounted.
 */
export async function apply(ctx) {
  const state = { results: [], values: [], engineReplaced: false }
  installHongguoTaskIdentity(ctx, clientURL, { identity: 'muse-hongguo-jackotom-download', stamp })
  await ctx.plugin(CodecFixture)
  let networkReplaced = false
  ctx.effect(() => {
    const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === './network.js' && context.parentURL === clientURL.href) {
        networkReplaced = true
        return { url: networkURL.href, shortCircuit: true }
      }
      if (specifier === '../upstream/engine.cjs' && context.parentURL === adapterURL.href) {
        state.engineReplaced = true
        return { url: engineURL.href, format: 'module', shortCircuit: true }
      }
      return nextResolve(specifier, context)
    } })
    return () => hooks.deregister()
  }, 'hongguo-jackotom-fixture.external-engine-and-transport')
  const plugin = await import(pluginURL.href)
  assert.equal(networkReplaced, true, 'The fixture must intercept the exact client transport before plugin evaluation')
  await ctx.plugin(plugin, { concurrency: 1, retries: 0, retryDelayMs: 0, sourceRetries: 0,
    ffprobeExecutable: process.execPath, ffmpegExecutable: process.execPath })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== provider || options.purpose !== undefined) { yield* next(); return }
    assert.ok(options.tools.some(tool => tool.name === 'hongguo_download_info'))
    assert.ok(options.tools.some(tool => tool.name === 'hongguo_download'))
    const result = options.messages.findLast(message => message.role === 'tool')
    if (result && result.toolCallId !== state.results.at(-1)) {
      const step = steps[state.results.length]
      assert.ok(step, 'No extra tool result is expected')
      state.values.push(await verifyResult(result, step, state))
      state.results.push(result.toolCallId)
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    assert.deepEqual(state.results, steps.map(step => step.id))
    const events = agent.session.snapshotEvents()
    assert.deepEqual(events.filter(event => event.type === 'tool/call').map(event => event.data.name), steps.map(step => step.tool))
    assert.ok(!JSON.stringify(events).includes(privateMarker))
    const root = await realpath(process.cwd()), output = join(root, outputDir)
    const paths = await readdir(output, { recursive: true })
    assert.ok(!paths.some(path => path.endsWith('.part') || basename(path).startsWith('.media-')))
    for (const path of paths.filter(path => path.endsWith('.json'))) {
      assert.ok(!(await readFile(join(output, path), 'utf8')).includes(privateMarker), 'Recovery and success receipts stay source-free')
    }
    const proof = { infoResolvesPlayInfo: false, declaredEpisodes: 2, verifiedEpisodes: 2, reusedEpisodes: 2,
      catalogLookups: count('fetchEpisodeList'), playInfoLookups: count('fetchPlayUrlSingle'), mediaTransfers: count('media'),
      requestedQuality: '1080p', bytesPerEpisode: media.length, sha256, signedUrlsLogged: false,
      codecValidation: 'controlled-external-verdict', actualMp4ContainerAndHashChecked: true }
    // The fixture verifies published bytes and receipts before removing its private test transfer artifacts.
    await rm(output, { recursive: true, force: true })
    const tasks = join(root, '.muse-downloads/hongguo')
    const taskFiles = await readdir(tasks)
    assert.equal(taskFiles.length, 2)
    for (const file of taskFiles) {
      const task = JSON.parse(await readFile(join(tasks, file), 'utf8'))
      assert.equal(task.owner.id, agent.session.id)
      assert.equal(task.cwd, root)
      assert.equal(task.state, 'completed')
      assert.ok(!JSON.stringify(task).includes(privateMarker))
    }
    await rm(join(root, '.muse-downloads'), { recursive: true })
    await writeFile(join(root, 'jackotom-download-proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') {
    ctx.effect(() => ctx.llm.registerAdapter([provider], new DownloadAdapter(state)))
  }
}
