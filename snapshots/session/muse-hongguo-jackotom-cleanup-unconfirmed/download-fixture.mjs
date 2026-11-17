/** An unconfirmed media process exit blocks the jackotom task, retains its stage and refuses task recovery. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'
import { calls, media, privateMarker, seriesId } from '../muse-hongguo-jackotom-download/engine-fixture.mjs'
import { installHongguoTaskIdentity } from '../muse-hongguo-task-controls/identity-fixture.mjs'

const owner = new URL('../../../apps/desktop-host/package.json', import.meta.url)
const { Service } = await importSnapshotPackage('@deepseek-ai/cordis', owner)
const { LlmAdapter, ToolCallId } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const clientURL = new URL('../../../third_party/plugins/muse-hongguo-download/src/client.js', import.meta.url)
const adapterURL = new URL('./jackotom.js', clientURL)
const ownershipURL = new URL('./media-ownership.js', clientURL)
const pluginURL = new URL('./index.js', clientURL)
const engineURL = new URL('../muse-hongguo-jackotom-download/engine-fixture.mjs', import.meta.url)
const networkURL = new URL('../muse-hongguo-jackotom-download/network-fixture.mjs', import.meta.url)
const identity = 'muse-hongguo-jackotom-cleanup-unconfirmed'
const provider = 'hongguo-jackotom-cleanup-fixture', outputDir = 'engine-media'
const stamp = Date.parse('2026-11-15T05:00:00Z')
const taskId = `hgt-${createHash('sha256').update(`${identity}\0engine-blocked`).digest('hex').slice(0, 32)}`
const codecCalls = []
const steps = [
  { id: 'engine-blocked', tool: 'hongguo_download', args: { seriesIds: [seriesId], outputDir } },
  { id: 'task-retry', tool: 'hongguo_download_task', args: { action: 'retry', taskId } },
  { id: 'task-status', tool: 'hongguo_download_task', args: { action: 'status', taskId } },
]
const count = method => calls.filter(call => call.method === method).length
const leaseUUID = `
import { createHash } from 'node:crypto';
export * from 'node:crypto';
let sequence = 0;
export function randomUUID() {
  const hex = createHash('sha256').update(${JSON.stringify(identity)} + ':lease:' + (++sequence)).digest('hex');
  return hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-a'+hex.slice(17,20)+'-'+hex.slice(20,32);
}
`

/** The second decode exits non-zero and never confirms process exit after termination. */
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
    const unconfirmed = !probe && codecCalls.includes('decode')
    const text = probe ? JSON.stringify({ format: { duration: '10' }, streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920 }, { codec_type: 'audio', codec_name: 'aac' }] }) : ''
    const done = (async () => {
      assert.deepEqual(await readFile(path), media)
      codecCalls.push(probe ? 'probe' : unconfirmed ? 'decode-unconfirmed' : 'decode')
      return { exitCode: unconfirmed ? 1 : 0, signal: null }
    })()
    return { done, waitForExit: async () => { await done; return !unconfirmed },
      terminate() { assert.equal(unconfirmed, true); codecCalls.push('terminate') },
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
  if (step.id === 'engine-blocked') {
    assert.equal(state.engineReplaced, true, 'The fixture must intercept the exact pinned engine module')
    assert.equal(value.ok, false, text)
    assert.equal(value.complete, false)
    assert.equal(value.code, 'cleanup_unconfirmed')
    assert.equal(value.taskId, taskId)
    assert.equal(value.state, 'blocked')
    assert.equal(value.retainedEpisodeCount, 1)
    assert.equal(value.remainingEpisodeCount, 1)
    assert.deepEqual(value.task.summary, { ok: false, complete: false, code: 'cleanup_unconfirmed',
      path: value.path, cleanupPendingPath: value.cleanupPendingPath })
    assert.equal(dirname(value.cleanupPendingPath), value.path)
    assert.match(basename(value.cleanupPendingPath), /^\.media-process-[a-f0-9-]{36}$/)
    const lease = JSON.parse(await readFile(join(value.cleanupPendingPath, 'lease.json'), 'utf8'))
    assert.equal(lease.state, 'process-exit-unconfirmed')
    const series = join(value.path, `虚构开源引擎剧-${seriesId}`)
    assert.deepEqual(await readFile(join(series, '0001.mp4')), media, 'The verified first episode stays published')
    await assert.rejects(lstat(join(series, '0002.mp4')), { code: 'ENOENT' })
    const stages = (await readdir(series)).filter(name => name.startsWith('.media-stage-'))
    assert.equal(stages.length, 1)
    assert.deepEqual(lease.paths, [join(series, stages[0], 'input.part'), join(series, stages[0], 'output.part')])
    assert.deepEqual(await readFile(join(series, stages[0], 'input.part')), media, 'The unconfirmed stage is retained for inspection')
    await assert.rejects(lstat(join(value.path, 'download-manifest.json')), { code: 'ENOENT' })
    state.blocked = value
  } else if (step.id === 'task-retry') {
    assert.deepEqual(value, { ok: false, code: 'task_locked', message: '任务仍在运行或视频清理未确认' })
  } else {
    assert.equal(value.ok, true, text)
    assert.equal(value.state, 'blocked')
    assert.equal(value.runId, state.blocked.runId)
    assert.deepEqual(value.task.summary, state.blocked.task.summary)
    assert.equal((await lstat(state.blocked.cleanupPendingPath)).isDirectory(), true)
  }
  assert.equal(count('fetchEpisodeList'), 1)
  assert.equal(count('fetchPlayUrlSingle'), 2)
  assert.equal(count('media'), 2, 'A blocked task must not transfer media again')
  assert.deepEqual(codecCalls, ['probe', 'decode', 'probe', 'decode-unconfirmed', 'terminate', 'terminate'])
  return value
}

function* response(step) {
  if (step === undefined) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text',
      text: '第1集已验证并保留；第2集的视频进程无法确认已退出，暂存文件和进程租约已保留，任务保持阻塞，重试被拒绝。请先人工检查该进程，再恢复下载。' } }
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
class CleanupAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }
  async *stream() { yield* response(steps[this.state.results.length]) }
}

/** Loader identity for the unconfirmed media cleanup checks. */
export const name = 'snapshot-hongguo-jackotom-cleanup-unconfirmed'
/** Shipped Headless services own the model loop, registered tools and initiating workspace. */
export const inject = ['llm', 'tools', 'agents']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated Headless profile context.
 * @returns {Promise<void>} Readiness after controlled external services and the real plugin are mounted.
 */
export async function apply(ctx) {
  const state = { results: [], engineReplaced: false, blocked: null }
  installHongguoTaskIdentity(ctx, clientURL, { identity, stamp })
  await ctx.plugin(CodecFixture)
  let networkReplaced = false, leaseReplaced = false
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
      if (specifier === 'node:crypto' && context.parentURL === ownershipURL.href) {
        leaseReplaced = true
        return { url: `data:text/javascript,${encodeURIComponent(leaseUUID)}`, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    } })
    return () => hooks.deregister()
  }, 'hongguo-jackotom-cleanup-fixture.external-engine-transport-and-lease-ids')
  const plugin = await import(pluginURL.href)
  assert.equal(networkReplaced, true, 'The fixture must intercept the exact client transport before plugin evaluation')
  assert.equal(leaseReplaced, true, 'The fixture must make process lease names deterministic before plugin evaluation')
  await ctx.plugin(plugin, { concurrency: 1, retries: 0, retryDelayMs: 0, sourceRetries: 0,
    ffprobeExecutable: process.execPath, ffmpegExecutable: process.execPath })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== provider || options.purpose !== undefined) { yield* next(); return }
    assert.ok(options.tools.some(tool => tool.name === 'hongguo_download'))
    assert.ok(options.tools.some(tool => tool.name === 'hongguo_download_task'))
    const result = options.messages.findLast(message => message.role === 'tool')
    if (result && result.toolCallId !== state.results.at(-1)) {
      const step = steps[state.results.length]
      assert.ok(step, 'No extra tool result is expected')
      await verifyResult(result, step, state)
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
    for (const path of (await readdir(output, { recursive: true })).filter(path => path.endsWith('.json'))) {
      assert.ok(!(await readFile(join(output, path), 'utf8')).includes(privateMarker), 'Recovery state and leases stay source-free')
    }
    const tasks = join(root, '.muse-downloads/hongguo')
    const taskFiles = await readdir(tasks)
    assert.deepEqual(taskFiles, [`${taskId}.json`])
    const task = JSON.parse(await readFile(join(tasks, taskFiles[0]), 'utf8'))
    assert.equal(task.owner.id, agent.session.id)
    assert.equal(task.state, 'blocked')
    assert.ok(!JSON.stringify(task).includes(privateMarker))
    const proof = { verifiedEpisodesRetained: 1, unconfirmedProcessExits: 1, stageRetained: true, leaseRetained: true,
      taskState: task.state, retryCode: 'task_locked', catalogLookups: count('fetchEpisodeList'),
      playInfoLookups: count('fetchPlayUrlSingle'), mediaTransfers: count('media'), signedUrlsLogged: false,
      codecValidation: 'controlled-external-verdict' }
    // The fixture inspects the retained stage and lease before removing its private test artifacts.
    await rm(output, { recursive: true, force: true })
    await rm(join(root, '.muse-downloads'), { recursive: true })
    await writeFile(join(root, 'jackotom-cleanup-proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') {
    ctx.effect(() => ctx.llm.registerAdapter([provider], new CleanupAdapter(state)))
  }
}
