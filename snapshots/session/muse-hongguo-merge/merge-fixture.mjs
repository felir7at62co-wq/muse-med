/** Registered merge tools verify original task receipts, reject missing or changed media and publish ordered output. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'
import { installHongguoTaskIdentity } from '../muse-hongguo-task-controls/identity-fixture.mjs'
import { media, mediaUrl, mergedMedia, privateMarker, requests, seriesId } from './network-fixture.mjs'

const owner = new URL('../../../apps/desktop-host/package.json', import.meta.url)
const { Service } = await importSnapshotPackage('@deepseek-ai/cordis', owner)
const { LlmAdapter, ToolCallId } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const pluginRoot = process.env.HONGGUO_DOWNLOAD_PLUGIN_ROOT
if (pluginRoot !== undefined) { assert.equal(process.env.DSH_EXAMPLE_MODE, 'lib'); assert.ok(isAbsolute(pluginRoot)) }
const clientURL = pluginRoot === undefined
  ? new URL('../../../third_party/plugins/muse-hongguo-download/src/client.js', import.meta.url)
  : pathToFileURL(join(pluginRoot, 'src/client.js'))
const pluginURL = new URL('./index.js', clientURL), networkURL = new URL('./network-fixture.mjs', import.meta.url)
const provider = 'hongguo-merge-fixture', outputDir = 'merge-media', catalogName = 'fixture-catalog.json'
const stamp = Date.parse('2026-11-12T08:00:00Z'), digest = bytes => createHash('sha256').update(bytes).digest('hex')
const ids = ['merge-download', 'merge-missing', 'merge-changed', 'merge-ordered', 'merge-existing']
const tools = ['hongguo_download', 'hongguo_merge', 'hongguo_merge', 'hongguo_merge', 'hongguo_merge']
const external = { probes: [], decodes: [], merges: [] }

class CodecFixture extends Service {
  constructor(ctx) { super(ctx, 'subprocess') }
  async resolveExecutable(value, _cwd, signal) {
    signal.throwIfAborted(); assert.equal(value, process.execPath, 'No native executable runs in this fixture'); return value
  }
  spawn(spec) {
    spec.signal.throwIfAborted(); assert.equal(spec.argv[0], process.execPath)
    const inputIndex = spec.argv.indexOf('-i')
    const path = resolve(spec.cwd, inputIndex === -1 ? spec.argv.at(-1) : spec.argv[inputIndex + 1])
    const probe = spec.argv.includes('-show_entries') || spec.argv.includes('-show_streams')
    const concatenate = spec.argv.includes('concat')
    const output = { text: '' }
    const done = (async () => {
      if (concatenate) {
        const text = await readFile(path, 'utf8')
        const files = text.split('\n').filter(line => line.startsWith('file ')).map(line => {
          const match = /^file '([^']+)'$/.exec(line)
          assert.ok(match, 'Controlled concat entries use fixture-owned filenames')
          return resolve(dirname(path), match[1])
        })
        assert.equal(files.length, 2)
        assert.deepEqual(await readFile(files[0]), media[0]); assert.deepEqual(await readFile(files[1]), media[1])
        external.merges.push({ episodeOrder: [1, 2], requestedCopy: spec.argv.includes('copy') })
        await writeFile(resolve(spec.cwd, spec.argv.at(-1)), mergedMedia)
      } else {
        const bytes = await readFile(path), merged = bytes.equals(mergedMedia)
        assert.ok(merged || media.some(episode => bytes.equals(episode)), 'Only actual episode or merge bytes may be inspected')
        if (probe) {
          external.probes.push(merged ? 'merged' : 'episode')
          output.text = JSON.stringify({ format: { duration: merged ? '20' : '10' }, streams: [
            { index: 0, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720,
              pix_fmt: 'yuv420p', r_frame_rate: '25/1', avg_frame_rate: '25/1', time_base: '1/12800',
              extradata_hash: `SHA256:${digest(Buffer.from('fixture h264 extradata'))}`, codec_tag_string: 'avc1' },
            { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2,
              channel_layout: 'stereo', time_base: '1/48000', extradata_hash: `SHA256:${digest(Buffer.from('fixture aac extradata'))}`, codec_tag_string: 'mp4a' },
          ] })
        } else {
          assert.ok(spec.argv.includes('null'), 'Only complete decode checks and concat may invoke FFmpeg')
          external.decodes.push(merged ? 'merged' : 'episode')
        }
      }
      return { exitCode: 0, signal: null }
    })()
    return { done, waitForExit: async () => { await done; return true }, terminate() {},
      collected: { stdout: { readFrom: () => ({ text: output.text, lossy: false, truncated: false }) },
        stderr: { readFrom: () => ({ text: '', lossy: false, truncated: false }) } } }
  }
}

function argsFor(state) {
  const taskId = state.values[0]?.taskId
  switch (state.values.length) {
    case 0: return { seriesIds: [seriesId], episodes: [1, 2], quality: '720p', mode: 'wait', outputDir }
    case 1: return { taskId, episodes: [1, 3], mode: 'auto', outputFile: 'missing.mp4' }
    case 2: return { taskId, episodes: [1, 2], mode: 'auto', outputFile: 'changed.mp4' }
    case 3: return { taskId, episodes: [2, 1], mode: 'auto', outputFile: 'selected.mp4' }
    case 4: return { taskId, episodes: [1, 2], mode: 'auto', outputFile: 'selected.mp4' }
    default: return undefined
  }
}
function* response(state) {
  const index = state.values.length, args = argsFor(state)
  if (args === undefined) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '缺少第3集及第2集哈希变化时均已拒绝合并，没有生成输出。恢复已验证的分集后，按第1、2集数字顺序完成合并，原分集保留。重复输出名称时已拒绝且保留原文件；合并文件已经检查容器、完整解码、时长和SHA256。目录共有3集，本次只合并了选定两集，不能称为全集。此夹具使用合成媒体和受控FFmpeg结果，不证明真实来源或编码器可用性。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }; return
  }
  const text = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(ids[index]), name: tools[index], argumentsDelta: text }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(ids[index]), name: tools[index], arguments: text } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
class MergeAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }
  async *stream() { yield* response(this.state) }
}

async function noMergeOutput(download) {
  const files = await readdir(download.path, { recursive: true })
  for (const name of ['missing.mp4', 'changed.mp4', 'selected.mp4']) assert.ok(!files.includes(name))
  assert.equal(external.merges.length, 0, 'Rejected input must not reach the merge process')
}
async function verifyResult(message, state) {
  const index = state.values.length
  assert.equal(message.toolCallId, ids[index]); assert.equal(message.isError, false)
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  assert.ok(!text.includes(privateMarker)); assert.ok(!text.includes('fixture.jspcdn.cn'))
  const value = JSON.parse(text)
  if (index === 0) {
    assert.equal(value.ok, true, text); assert.equal(value.state, 'completed'); assert.equal(value.complete, false)
    assert.equal(value.items[0].episodeCount, 3); assert.deepEqual(value.items[0].episodes.map(episode => episode.index), [1, 2])
    for (const episode of value.items[0].episodes) {
      assert.equal(episode.sha256, digest(media[episode.index - 1])); assert.deepEqual(await readFile(episode.path), media[episode.index - 1])
    }
    assert.deepEqual(requests, [1, 2])
  } else if (index === 1) {
    assert.equal(value.ok, false); assert.equal(value.code, 'missing_episodes')
    await noMergeOutput(state.values[0])
    const secondPath = state.values[0].items[0].episodes[1].path, changed = Buffer.from(media[1])
    changed[changed.length - 1] ^= 1
    await writeFile(secondPath, changed)
  } else if (index === 2) {
    assert.equal(value.ok, false); assert.equal(value.code, 'merge_input_changed')
    await noMergeOutput(state.values[0])
    await writeFile(state.values[0].items[0].episodes[1].path, media[1])
  } else if (index === 3) {
    assert.equal(value.ok, true, text)
    assert.deepEqual(await readFile(value.path), mergedMedia)
    assert.equal(value.sha256, digest(mergedMedia)); assert.equal(value.bytes, mergedMedia.length)
    assert.equal(value.complete, false); assert.deepEqual(value.episodes, [1, 2])
    assert.equal(value.seriesEpisodeCount, 3); assert.equal(value.sourceTaskId, state.values[0].taskId)
    assert.equal(value.requestedMode, 'auto'); assert.equal(value.actualMode, 'copy')
    assert.equal(value.durationSeconds, 20); assert.equal(value.fullDecodeChecked, true)
    assert.deepEqual(JSON.parse(await readFile(value.receipt, 'utf8')), value)
    assert.deepEqual(external.merges, [{ episodeOrder: [1, 2], requestedCopy: true }])
    assert.ok(external.probes.includes('merged')); assert.ok(external.decodes.includes('merged'))
    assert.deepEqual(requests, [1, 2], 'Merge only reads verified local inputs')
  } else {
    assert.equal(value.ok, false); assert.equal(value.code, 'output_exists')
    assert.deepEqual(await readFile(state.values[3].path), mergedMedia)
    assert.deepEqual(JSON.parse(await readFile(state.values[3].receipt, 'utf8')), state.values[3])
    assert.equal(external.merges.length, 1, 'Existing output must be rejected before native merge work')
  }
  state.values.push(value); state.results.push(message.toolCallId)
}

/** Loader identity for original-task media merge checks. */
export const name = 'snapshot-hongguo-merge'
/** The shipped profile owns Session authority and registered tool execution. */
export const inject = ['llm', 'tools', 'agents']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated shipped Headless profile.
 * @returns {Promise<void>} Readiness after controlled external services and the actual downloader are mounted.
 */
export async function apply(ctx) {
  const state = { results: [], values: [] }, root = await realpath(process.cwd()), catalogPath = join(root, catalogName)
  await writeFile(catalogPath, JSON.stringify({ series: [{ series_id: seriesId, title: '分集合并测试虚构剧', episode_cnt: 3,
    episodes: Array.from({ length: 3 }, (_, index) => ({ index: index + 1, url: mediaUrl(index + 1),
      ...(index < 2 ? { sha256: digest(media[index]) } : {}) })) }] }), { flag: 'wx', mode: 0o600 })
  await ctx.plugin(CodecFixture)
  installHongguoTaskIdentity(ctx, clientURL, { identity: 'muse-hongguo-merge', stamp })
  let replaced = false
  ctx.effect(() => {
    const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier !== './network.js' || context.parentURL !== clientURL.href) return nextResolve(specifier, context)
      replaced = true; return { url: networkURL.href, shortCircuit: true }
    } })
    return () => hooks.deregister()
  }, 'hongguo-merge-fixture.external-transport')
  const plugin = await import(pluginURL.href); assert.equal(replaced, true)
  await ctx.plugin(plugin, { sourceMode: 'manifest', catalogPath, retries: 0, retryDelayMs: 0,
    mediaRequestIntervalMs: 0, mediaBatchSize: 1, concurrency: 1,
    ffprobeExecutable: process.execPath, ffmpegExecutable: process.execPath })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== provider || options.purpose !== undefined) { yield* next(); return }
    assert.ok(options.tools.some(tool => tool.name === 'hongguo_merge'))
    const result = options.messages.findLast(message => message.role === 'tool')
    if (result && result.toolCallId !== state.results.at(-1)) await verifyResult(result, state)
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    assert.deepEqual(state.results, ids)
    const events = agent.session.snapshotEvents()
    assert.deepEqual(events.filter(event => event.type === 'tool/call').map(event => event.data.name), tools)
    assert.ok(!JSON.stringify(events).includes(privateMarker))
    assert.deepEqual(state.values[0].task.owner, { kind: 'session', id: agent.id }); assert.equal(state.values[0].task.cwd, root)
    for (const episode of state.values[0].items[0].episodes) assert.deepEqual(await readFile(episode.path), media[episode.index - 1])
    const proof = { taskOwner: 'original-session', declaredEpisodes: 3, selectedEpisodes: [1, 2], complete: false,
      missingEpisodeRejected: true, changedHashRejected: true, rejectedMergeProcesses: 0,
      numericEpisodeOrder: [1, 2], mergeProcesses: 1, existingOutputPreserved: true, sourceFilesUnchanged: true, mediaTransfers: requests,
      mergedBytes: mergedMedia.length, mergedSha256: digest(mergedMedia), sourceSha256: media.map(digest),
      durationSeconds: 20, codecValidation: 'controlled-external-verdict', actualMp4ContainerAndHashChecked: true,
      realExternalRequests: 0 }
    await rm(join(root, outputDir), { recursive: true, force: true })
    await rm(join(root, '.muse-downloads'), { recursive: true, force: true }); await rm(catalogPath)
    await writeFile(join(root, 'merge-proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') ctx.effect(() => ctx.llm.registerAdapter([provider], new MergeAdapter(state)))
}
