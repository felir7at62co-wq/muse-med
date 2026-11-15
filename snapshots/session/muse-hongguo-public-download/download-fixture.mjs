/** Public fallback lookup uses real tools, transfer, MP4 checks and receipts with controlled external codec verdicts. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'
import { media, privateMarker, requests, series } from './network-fixture.mjs'

const owner = new URL('../../../apps/desktop-host/package.json', import.meta.url)
const { Service } = await importSnapshotPackage('@deepseek-ai/cordis', owner)
const { LlmAdapter, ToolCallId } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const pluginRoot = process.env.HONGGUO_DOWNLOAD_PLUGIN_ROOT
if (pluginRoot !== undefined) {
  assert.equal(process.env.DSH_EXAMPLE_MODE, 'lib')
  assert.ok(isAbsolute(pluginRoot))
}
const clientURL = pluginRoot === undefined
  ? new URL('../../../third_party/plugins/muse-hongguo-download/src/client.js', import.meta.url)
  : pathToFileURL(join(pluginRoot, 'src/client.js'))
const pluginURL = new URL('./index.js', clientURL)
const networkURL = new URL('./network-fixture.mjs', import.meta.url)
const provider = 'hongguo-public-download-fixture'
const stamp = Date.parse('2026-11-10T05:00:00Z')
const sha256 = createHash('sha256').update(media).digest('hex')
const codecCalls = []
const outputDir = 'public-media'
const steps = [
  { id: 'public-info', tool: 'hongguo_download_info', args: { seriesIds: [series[0]], sourceMode: 'public' } },
  { id: 'public-download-open', tool: 'hongguo_download',
    args: { seriesIds: [series[0]], sourceMode: 'public', episodes: [1], outputDir } },
  { id: 'public-download-closed', tool: 'hongguo_download',
    args: { seriesIds: [series[0]], sourceMode: 'public', episodes: [2], outputDir } },
  { id: 'public-download-business-failure', tool: 'hongguo_download',
    args: { seriesIds: [series[1]], sourceMode: 'public', episodes: [1], outputDir } },
]

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
    assert.equal(path, join(spec.cwd, `公开下载测试虚构剧-${series[0]}`, '0001.mp4.part'))
    assert.deepEqual(spec.argv, probe
      ? [process.execPath, '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height',
        '-of', 'json', '-protocol_whitelist', 'file,pipe', '-i', path]
      : [process.execPath, '-v', 'error', '-xerror', '-err_detect', 'explode', '-protocol_whitelist', 'file,pipe',
        '-i', path, '-map', '0:v?', '-map', '0:a?', '-f', 'null', '-'])
    const text = probe ? JSON.stringify({ format: { duration: '10' },
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 128, height: 72 }] }) : ''
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

async function verifyResult(message, step) {
  assert.equal(message.toolCallId, step.id)
  assert.equal(message.isError, false)
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  assert.ok(!text.includes(privateMarker), 'Private upstream diagnostics and signed URLs must not enter tool output')
  assert.ok(!text.includes('https://v1-hgweb.qznovelvod.com/'))
  const value = JSON.parse(text)
  if (step.id === 'public-info') {
    assert.equal(value.ok, true, 'A protected SSR catalog must remain inspectable without embedded media')
    assert.equal(value.sourceMode, 'public')
    assert.equal(value.verifiedDownload, false)
    assert.deepEqual(value.items.map(item => ({ episodeCount: item.episodeCount,
      accessibleEpisodeCount: item.accessibleEpisodeCount, completeCatalog: item.completeCatalog,
      mediaUrlsVerified: item.mediaUrlsVerified, fullSeriesAvailable: item.fullSeriesAvailable })),
    [{ episodeCount: 3, accessibleEpisodeCount: 1, completeCatalog: true,
      mediaUrlsVerified: false, fullSeriesAvailable: false }])
    assert.deepEqual(requests, [{ kind: 'catalog', seriesId: series[0] }], 'Info must not resolve a media model')
    assert.deepEqual(codecCalls, [])
    return value
  }
  assert.equal(value.complete, false, 'An opened sample must not claim the whole declared series')
  if (step.id === 'public-download-open') {
    assert.equal(value.ok, true, JSON.stringify(value))
    assert.equal(value.sourceMode, 'public')
    assert.equal(value.newlyDownloadedEpisodeCount, 1)
    assert.equal(value.items[0].episodeCount, 3)
    assert.equal(value.items[0].downloadedEpisodeCount, 1)
    assert.equal(value.items[0].complete, false)
    const episode = value.items[0].episodes[0]
    assert.equal(episode.index, 1)
    assert.equal(episode.bytes, media.length)
    assert.equal(episode.sha256, sha256)
    assert.deepEqual(await readFile(episode.path), media, 'The actual tool must publish the transferred bytes')
    assert.deepEqual(JSON.parse(await readFile(join(value.path, 'download-manifest.json'), 'utf8')), value)
    assert.deepEqual(codecCalls, ['probe', 'decode'])
  } else {
    assert.equal(value.ok, false)
    if (step.id === 'public-download-closed') assert.equal(value.code, 'public_preview_only')
    else {
      assert.equal(value.code, 'platform_error')
      assert.equal(value.upstreamCode, 1001)
      assert.equal(value.sourceStage, 'video_model')
      assert.equal(value.retryable, false)
      assert.equal(value.retainedEpisodeCount, 0)
      assert.equal(value.remainingEpisodeCount, 1)
      await assert.rejects(readFile(join(value.path, 'download-manifest.json')), { code: 'ENOENT' })
    }
  }
  const expectedFallbacks = step.id === 'public-download-business-failure' ? 2 : 1
  assert.equal(requests.filter(request => request.kind === 'fallback').length, expectedFallbacks)
  assert.equal(requests.filter(request => request.kind === 'media').length, 1)
  return value
}

function* response(step) {
  if (step === undefined) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text',
      text: '公开目录声明3集，仅开放第1集；已保存第1集，不能称为全剧。第2集已拒绝；另一剧的接口业务失败，没有成功交付。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }
  const args = JSON.stringify(step.args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(step.id), name: step.tool, argumentsDelta: args }
  yield { type: 'block-end', index: 0,
    block: { type: 'tool-call', id: ToolCallId(step.id), name: step.tool, arguments: args } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
class DownloadAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }
  async *stream() { yield* response(steps[this.state.results.length]) }
}

/** Loader identity for explicit public-mode download checks. */
export const name = 'snapshot-hongguo-public-download'
/** Shipped Headless services own the model loop, registered tools and initiating workspace. */
export const inject = ['llm', 'tools', 'agents']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated Headless profile context.
 * @returns {Promise<void>} Readiness after controlled external services and the real plugin are mounted.
 */
export async function apply(ctx) {
  const state = { results: [], values: [] }
  await ctx.plugin(CodecFixture)
  let replaced = false
  ctx.effect(() => {
    const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier !== './network.js' || context.parentURL !== clientURL.href) return nextResolve(specifier, context)
      replaced = true
      return { url: networkURL.href, shortCircuit: true }
    } })
    return () => hooks.deregister()
  }, 'hongguo-public-fixture.external-transport')
  ctx.effect(() => {
    const priorNow = Date.now
    Date.now = () => stamp
    return () => { Date.now = priorNow }
  })
  const plugin = await import(pluginURL.href)
  assert.equal(replaced, true, 'The fixture must intercept the exact client transport before plugin evaluation')
  await ctx.plugin(plugin, { retries: 0, retryDelayMs: 0, mediaRequestIntervalMs: 0,
    ffprobeExecutable: process.execPath, ffmpegExecutable: process.execPath })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== provider || options.purpose !== undefined) { yield* next(); return }
    assert.ok(options.tools.some(tool => tool.name === 'hongguo_download_info'))
    assert.ok(options.tools.some(tool => tool.name === 'hongguo_download'))
    const result = options.messages.findLast(message => message.role === 'tool')
    if (result && result.toolCallId !== state.results.at(-1)) {
      const step = steps[state.results.length]
      assert.ok(step, 'No extra tool result is expected')
      state.values.push(await verifyResult(result, step))
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
    assert.ok(!paths.some(path => path.endsWith('.part')))
    for (const path of paths.filter(path => path.endsWith('.json'))) {
      assert.ok(!(await readFile(join(output, path), 'utf8')).includes(privateMarker), 'Recovery and success receipts stay source-free')
    }
    assert.deepEqual(codecCalls, ['probe', 'decode'])
    const proof = { infoResolvesMedia: false, declaredEpisodes: 3, accessibleEpisodes: 1,
      downloadedEpisodes: [1], complete: false, bytes: media.length, sha256,
      sourceLookupPosts: 2, mediaTransfers: 1, unopenedEpisodeLookup: false,
      unopenedCode: state.values[2].code, businessFailureCode: state.values[3].code,
      businessFailureDelivered: false, temporaryUrlsLogged: false,
      codecValidation: 'controlled-external-verdict', actualMp4ContainerAndHashChecked: true }
    // The fixture verifies published bytes and receipts before removing its private test transfer artifacts.
    await rm(output, { recursive: true, force: true })
    await writeFile(join(root, 'public-download-proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') {
    ctx.effect(() => ctx.llm.registerAdapter([provider], new DownloadAdapter(state)))
  }
}
