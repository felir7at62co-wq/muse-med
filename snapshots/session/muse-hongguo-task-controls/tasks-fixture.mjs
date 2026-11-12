/** Real chat task controls, Jobs, transfer, checkpoints and media publication with controlled codec verdicts. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'
import { installHongguoTaskIdentity } from './identity-fixture.mjs'
import { interruptedStreamClosed, media, mediaUrl, privateMarker, requests, secondClosed, secondStarted, seriesId } from './network-fixture.mjs'

const owner = new URL('../../../apps/desktop-host/package.json', import.meta.url)
const { Service } = await importSnapshotPackage('@deepseek-ai/cordis', owner)
const { LlmAdapter, ToolCallId } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const pluginRoot = process.env.HONGGUO_DOWNLOAD_PLUGIN_ROOT
if (pluginRoot !== undefined) { assert.equal(process.env.DSH_EXAMPLE_MODE, 'lib'); assert.ok(isAbsolute(pluginRoot)) }
const clientURL = pluginRoot === undefined
  ? new URL('../../../third_party/plugins/muse-hongguo-download/src/client.js', import.meta.url)
  : pathToFileURL(join(pluginRoot, 'src/client.js'))
const pluginURL = new URL('./index.js', clientURL), networkURL = new URL('./network-fixture.mjs', import.meta.url)
const provider = 'hongguo-task-controls-fixture', outputDir = 'task-media', catalogName = 'fixture-catalog.json'
const stamp = Date.parse('2026-11-12T07:00:00Z'), sha256 = createHash('sha256').update(media).digest('hex')
const codecCalls = []
const ids = ['task-start', 'task-pause', 'task-resume', 'task-status', 'task-remove']
const tools = ['hongguo_download', ...Array.from({ length: 4 }, () => 'hongguo_download_task')]

class CodecFixture extends Service {
  constructor(ctx) { super(ctx, 'subprocess') }
  async resolveExecutable(value, _cwd, signal) {
    signal.throwIfAborted(); assert.equal(value, process.execPath, 'No native executable runs in this fixture'); return value
  }
  spawn(spec) {
    spec.signal.throwIfAborted(); assert.equal(spec.argv[0], process.execPath)
    const probe = spec.argv.includes('-show_entries'), path = spec.argv[spec.argv.indexOf('-i') + 1]
    assert.equal(basename(path), 'input.part'); assert.match(basename(dirname(path)), /^\.media-stage-[a-zA-Z0-9]+$/)
    assert.equal(basename(dirname(dirname(path))), `任务管理测试虚构剧-${seriesId}`)
    assert.deepEqual(spec.argv, probe
      ? [process.execPath, '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height',
        '-of', 'json', '-protocol_whitelist', 'file,pipe', '-i', path]
      : [process.execPath, '-v', 'error', '-xerror', '-err_detect', 'explode', '-protocol_whitelist', 'file,pipe',
        '-i', path, '-map', '0:v?', '-map', '0:a?', '-f', 'null', '-'])
    const text = probe ? JSON.stringify({ format: { duration: '10' },
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }] }) : ''
    const done = (async () => { assert.deepEqual(await readFile(path), media); codecCalls.push(probe ? 'probe' : 'decode'); return { exitCode: 0, signal: null } })()
    return { done, waitForExit: async () => { await done; return true }, terminate() {},
      collected: { stdout: { readFrom: () => ({ text, lossy: false, truncated: false }) },
        stderr: { readFrom: () => ({ text: '', lossy: false, truncated: false }) } } }
  }
}

function argsFor(state) {
  const first = state.values[0]
  switch (state.values.length) {
    case 0: return { seriesIds: [seriesId], episodes: [1, 2], quality: '720p', mode: 'background', outputDir }
    case 1: return { action: 'pause', taskId: first.taskId, expectedRunId: first.runId, requestId: 'pause-request' }
    case 2: return { action: 'resume', taskId: first.taskId, mode: 'wait' }
    case 3: return { action: 'status', taskId: first.taskId }
    case 4: return { action: 'remove', taskId: first.taskId }
    default: return undefined
  }
}
function* response(state) {
  const index = state.values.length, args = argsFor(state)
  if (args === undefined) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '已确认暂停后台下载，再按原720p请求恢复。第1、2集已经逐集校验并保存；任务完成了所选两集，但目录共有3集，不能称为全集。状态查询没有新增下载，移除任务记录后视频和下载进度仍保留。此测试使用合成媒体及受控解码结果，不证明真实红果来源可用性。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }; return
  }
  const argumentText = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(ids[index]), name: tools[index], argumentsDelta: argumentText }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(ids[index]), name: tools[index], arguments: argumentText } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
class TaskAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }
  async *stream() { yield* response(this.state) }
}

async function verifyResult(message, state) {
  const index = state.values.length
  assert.equal(message.toolCallId, ids[index]); assert.equal(message.isError, false)
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  assert.ok(!text.includes(privateMarker)); assert.ok(!text.includes('fixture.jspcdn.cn'))
  const value = JSON.parse(text)
  assert.equal(value.ok, true, text)
  if (index === 0) {
    assert.equal(value.state, 'running'); assert.match(value.taskId, /^hgt-[a-f0-9]{32}$/); assert.match(value.runId, /^hgr-[a-f0-9]{32}$/)
    assert.ok(value.jobId.startsWith('hongguo-download-'))
    await secondStarted.promise
    assert.equal(interruptedStreamClosed, false); assert.deepEqual(requests, [1, 2])
  } else if (index === 1) {
    assert.equal(state.pauseCloseObservedAtReturn, true)
    await secondClosed.promise; await state.waiters[0]
    assert.equal(interruptedStreamClosed, true, 'Pause acknowledgement follows transfer close')
    assert.equal(value.state, 'paused'); assert.equal(value.control.state, 'acknowledged')
    assert.equal(value.control.runId, state.values[0].runId)
    assert.deepEqual(value.task.progress, { recordedCompletedEpisodeCount: 1, remainingEpisodeCount: 1, requestedQuality: '720p' })
    assert.equal(value.task.summary.code, 'cancelled')
    const root = await realpath(process.cwd()), files = await readdir(join(root, outputDir), { recursive: true })
    assert.ok(!files.some(path => path.endsWith('.part') || path.includes('.media-stage-')), 'Paused transfer staging has been cleaned')
    assert.equal(files.filter(path => path.endsWith('.mp4')).length, 1)
  } else if (index === 2) {
    assert.equal(value.taskId, state.values[0].taskId); assert.notEqual(value.runId, state.values[0].runId)
    assert.equal(value.jobId, null, 'Foreground resume has no background completion notice')
    assert.equal(value.state, 'completed'); assert.equal(value.complete, false)
    assert.equal(value.requestedQuality, '720p'); assert.equal(value.reusedEpisodeCount, 1); assert.equal(value.newlyDownloadedEpisodeCount, 1)
    assert.equal(value.items[0].episodeCount, 3); assert.equal(value.items[0].downloadedEpisodeCount, 2)
    assert.equal(value.items[0].complete, false)
    assert.deepEqual(value.items[0].episodes.map(episode => episode.index), [1, 2])
    for (const episode of value.items[0].episodes) {
      assert.equal(episode.sha256, sha256); assert.equal(episode.bytes, media.length)
      assert.deepEqual(await readFile(episode.path), media)
      assert.deepEqual([episode.width, episode.height, episode.quality, episode.videoCodec], [1280, 720, '720p', 'h264'])
    }
    assert.deepEqual(requests, [1, 2, 2])
  } else if (index === 3) {
    assert.equal(value.state, 'completed'); assert.equal(value.task.summary.complete, false)
    assert.equal(value.task.request.quality, '720p'); assert.deepEqual(value.task.request.episodes, [1, 2])
    assert.deepEqual(requests, [1, 2, 2], 'Status performs no new media request')
  } else {
    assert.equal(value.removed, true); assert.equal(value.mediaPreserved, true)
    const root = await realpath(process.cwd())
    const records = await readdir(join(root, '.muse-downloads/hongguo'))
    assert.ok(!records.some(path => path.endsWith('.json')))
    for (const episode of state.values[2].items[0].episodes) assert.deepEqual(await readFile(episode.path), media)
    assert.deepEqual(JSON.parse(await readFile(join(state.values[2].path, 'download-manifest.json'), 'utf8')).items, state.values[2].items)
  }
  state.values.push(value); state.results.push(message.toolCallId)
}

/** Loader identity for a real chat download-task lifecycle. */
export const name = 'snapshot-hongguo-task-controls'
/** The shipped profile owns permission, Session, Jobs and tool execution services. */
export const inject = ['llm', 'tools', 'agents', 'jobs']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated shipped Headless profile.
 * @returns {Promise<void>} Readiness after controlled external services and the real downloader are mounted.
 */
export async function apply(ctx) {
  const state = { results: [], values: [], waiters: [], pauseCloseObservedAtReturn: false }, observer = new AbortController()
  const root = await realpath(process.cwd()), catalogPath = join(root, catalogName)
  await writeFile(catalogPath, JSON.stringify({ series: [{ series_id: seriesId, title: '任务管理测试虚构剧', episode_cnt: 3,
    episodes: Array.from({ length: 3 }, (_, index) => ({ index: index + 1, url: mediaUrl(index + 1), sha256 })) }] }), { flag: 'wx', mode: 0o600 })
  await ctx.plugin(CodecFixture)
  installHongguoTaskIdentity(ctx, clientURL, { identity: 'muse-hongguo-task-controls', stamp })
  let replaced = false
  ctx.effect(() => {
    const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier !== './network.js' || context.parentURL !== clientURL.href) return nextResolve(specifier, context)
      replaced = true; return { url: networkURL.href, shortCircuit: true }
    } })
    return () => hooks.deregister()
  }, 'hongguo-task-fixture.external-transport')
  ctx.effect(() => ctx.jobs.events.subscribe({ owners: 'all' }, event => {
    if (event.type === 'registered' && event.job.kind === 'hongguo-download') {
      const waiting = ctx.jobs.wait(event.job.id, 30000, event.job.owner, observer.signal)
      state.waiters.push(waiting); void waiting.catch(() => {})
    }
  }))
  ctx.effect(() => async () => { observer.abort(); await Promise.allSettled(state.waiters) })
  const plugin = await import(pluginURL.href)
  assert.equal(replaced, true)
  await ctx.plugin(plugin, { sourceMode: 'manifest', catalogPath, retries: 0, retryDelayMs: 0,
    mediaRequestIntervalMs: 0, mediaBatchSize: 1, concurrency: 1,
    taskPollIntervalMs: 20, taskControlWaitMs: 1000,
    ffprobeExecutable: process.execPath, ffmpegExecutable: process.execPath })
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    if (exec.name === 'hongguo_download_task' && exec.arguments.action === 'pause') {
      state.pauseCloseObservedAtReturn = interruptedStreamClosed
      assert.equal(state.pauseCloseObservedAtReturn, true, 'The pause tool cannot return before transfer close')
    }
    return await next()
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== provider || options.purpose !== undefined) { yield* next(); return }
    assert.ok(options.tools.some(tool => tool.name === 'hongguo_download_task'))
    const result = options.messages.findLast(message => message.role === 'tool')
    if (result && result.toolCallId !== state.results.at(-1)) await verifyResult(result, state)
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    assert.deepEqual(state.results, ids)
    const events = agent.session.snapshotEvents()
    assert.deepEqual(events.filter(event => event.type === 'tool/call').map(event => event.data.name), tools)
    assert.ok(!JSON.stringify(events).includes(privateMarker))
    for (const value of state.values.slice(0, 4)) {
      assert.deepEqual(value.task.owner, { kind: 'session', id: agent.id })
      assert.equal(value.task.cwd, root)
    }
    assert.deepEqual(codecCalls, ['probe', 'decode', 'probe', 'decode'])
    assert.equal(state.waiters.length, 1); await Promise.all(state.waiters)
    assert.ok(ctx.jobs.list(agent.id).every(job => !['running', 'stopping'].includes(job.status)))
    const proof = { taskOwner: 'original-session', frozenQuality: '720p', declaredEpisodes: 3,
      selectedEpisodes: [1, 2], downloadedEpisodes: [1, 2], complete: false,
      pauseAcknowledgedAfterTransferClosed: state.pauseCloseObservedAtReturn, pausedCompletedEpisodes: 1,
      resumedWithNewRun: state.values[2].runId !== state.values[0].runId, reusedEpisodes: 1,
      mediaTransfers: requests, statusMediaRequests: 0, removedTaskRecords: true,
      mediaPreservedAfterRemove: true, checkpointPreservedAfterRemove: true,
      bytesPerEpisode: media.length, sha256, width: 1280, height: 720,
      codecValidation: 'controlled-external-verdict', actualMp4ContainerAndHashChecked: true, realExternalRequests: 0 }
    await rm(join(root, outputDir), { recursive: true, force: true })
    await rm(join(root, '.muse-downloads'), { recursive: true, force: true })
    await rm(catalogPath)
    await writeFile(join(root, 'task-controls-proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') ctx.effect(() => ctx.llm.registerAdapter([provider], new TaskAdapter(state)))
}
