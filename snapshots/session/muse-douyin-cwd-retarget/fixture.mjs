/** A real queued download retains its accepted directory while the Session's owned link is retargeted. */
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'
import { mediaReceipt, VIDEO_ONE, VIDEO_TWO, videoURL } from '../../../third_party/plugins/muse-douyin-download/tests/task-fixtures.js'

const cliOwner = new URL('../../../apps/cli/package.json', import.meta.url)
const { Service } = await importSnapshotPackage('@deepseek-ai/cordis', cliOwner)
const { ToolCallId, createUserMessage } = await importSnapshotPackage('@deepseek-ai/dsh-llm', cliOwner)
const { SessionId } = await importSnapshotPackage('@deepseek-ai/dsh-session', cliOwner)
const override = process.env.MUSE_DOUYIN_PACKAGE_ROOT
if (override !== undefined) {
  assert.equal(process.env.DSH_EXAMPLE_MODE, 'lib')
  assert.ok(isAbsolute(override), 'The negative control requires an owned absolute package directory')
}
const douyin = await import(override === undefined
  ? new URL('../../../third_party/plugins/muse-douyin-download/src/index.js', import.meta.url).href
  : pathToFileURL(join(override, 'src/index.js')).href)
const stamp = Date.parse('2026-11-08T12:00:00.000Z')
const ownerId = SessionId('snapshot-douyin-cwd-retarget')
const childId = SessionId('snapshot-cwd-retarget-worker')
const waitFor = (promise, signal) => {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
const valueOf = result => {
  assert.equal(result.isError, false, JSON.stringify(result))
  const block = result.content.find(item => item.type === 'text')
  assert.ok(block)
  return JSON.parse(block.text)
}

/** Loader identity for the canonical queued-directory replay. */
export const name = 'snapshot-douyin-cwd-retarget'
/** Jobs, exact live Agent identity, policy, native tool execution and persistence remain real. */
export const inject = ['llm', 'tools', 'agents', 'jobs', 'sandboxPolicy', 'sessions', 'sessionPersistence']

/**
 * Replace only public transport IO and the clock; all acquisition decisions belong to the production task controller.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated shipped Headless context.
 * @returns {Promise<void>} Completion after effects and the production tools are mounted.
 */
export async function apply(ctx) {
  const prepared = ctx.sessions.prepare(ownerId, { meta: { cwd: process.cwd(), createdAt: stamp, delegationDepth: 0 } })
  const owner = await ctx.sessionPersistence.create(prepared.header)
  try { await owner.flush() }
  finally { await owner.close() }
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const calls = [], admitted = []
  let child, root, observed = false
  class OfflinePublic extends Service {
    constructor(scope) { super(scope, 'subprocess') }
    spawn(spec) {
      assert.ok(spec.argv.some(value => basename(value) === 'download.py'))
      assert.ok(spec.argv.includes('--public-only'))
      const url = spec.argv[spec.argv.indexOf('--url') + 1]
      assert.ok([videoURL(VIDEO_ONE), videoURL(VIDEO_TWO)].includes(url))
      assert.equal(spec.argv[spec.argv.indexOf('--project') + 1], spec.cwd)
      calls.push({ url, cwd: spec.cwd })
      let text
      const done = (async () => {
        spec.signal?.throwIfAborted()
        let result
        if (url === videoURL(VIDEO_ONE)) {
          entered.resolve()
          await release.promise
          spec.signal?.throwIfAborted()
          result = { status: 'blocked', message: 'SOURCE_UNAVAILABLE' }
        } else {
          // A target acquisition copies real local fixture bytes into the supplied public destination.
          result = await mediaReceipt({ session: { header: { cwd: spec.cwd } } }, url)
        }
        text = JSON.stringify(result)
        return { exitCode: result.status === 'downloaded' ? 0 : 1, signal: null }
      })()
      return { done, waitForExit: async () => { await done; return true }, collected: {
        stdout: { readFrom: () => ({ text, lossy: false, truncated: false }) },
      } }
    }
  }
  await ctx.plugin(OfflinePublic)
  ctx.effect(() => {
    const originalFetch = globalThis.fetch, originalNow = Date.now
    globalThis.fetch = async () => { throw new Error('The queued-directory fixture refuses every network request') }
    Date.now = () => stamp
    return () => { globalThis.fetch = originalFetch; Date.now = originalNow }
  })
  await ctx.plugin(douyin, { pythonExecutable: process.execPath, ffprobeExecutable: process.execPath,
    ffmpegExecutable: process.execPath, settingsHome: process.env.DSH_HOME })
  ctx.effect(() => async () => {
    release.resolve()
    for (const item of admitted) await ctx.jobs.wait(item.jobId, 30000, item.owner)
    await child?.dispose()
  })
  const invoke = (agent, name, args, id, signal) => ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    agent, signal, calls: [{ type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) }],
  }))
  ctx.effect(() => ctx.tools.register({
    name: 'douyin_cwd_retarget',
    description: 'Fixture-only observation of a real queued task after its Session directory link changes; it never contacts a website.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    timeoutMs: 60000,
    execute: async (_args, exec) => {
      try {
      root = ctx.agents.requireInitiator()
      assert.equal(root.id, ownerId)
      const cwd = root.session.header.cwd, original = join(cwd, 'project-a'), replacement = join(cwd, 'project-b'), selected = join(cwd, 'selected-project')
      await mkdir(original); await mkdir(replacement); await symlink(process.platform === 'win32' ? original : 'project-a', selected, process.platform === 'win32' ? 'junction' : 'dir')
      child = await ctx.agents.create({ sessionId: childId, parentAgent: root,
        meta: { cwd: selected, parentSession: root.id, delegationDepth: 1 },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
      child.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '仅确认目录绑定测试会话已就绪，不调用工具。' }] }))
      await child.agent.whenIdle()
      const first = valueOf((await invoke(root, 'douyin_download', {
        url: videoURL(VIDEO_ONE), publicOnly: true, mode: 'background',
      }, 'cwd-blocker', exec.signal)).results[0].result)
      admitted.push({ jobId: first.downloadTask.jobId, owner: root.id })
      await waitFor(entered.promise, exec.signal)
      const queued = valueOf((await invoke(child.agent, 'douyin_download', {
        url: videoURL(VIDEO_TWO), publicOnly: true, mode: 'background',
      }, 'cwd-target', exec.signal)).results[0].result)
      admitted.push({ jobId: queued.downloadTask.jobId, owner: childId })
      assert.equal(queued.status, 'queued')
      const before = valueOf((await invoke(child.agent, 'douyin_download_task', {
        action: 'status', taskId: queued.downloadTask.id,
      }, 'cwd-before-status', exec.signal)).results[0].result)
      assert.equal(before.task.cwd, await realpath(original))
      assert.equal(calls.length, 1, 'The target remains queued behind the real admitted first task')
      await unlink(selected); await symlink(process.platform === 'win32' ? replacement : 'project-b', selected, process.platform === 'win32' ? 'junction' : 'dir')
      assert.equal(await realpath(selected), await realpath(replacement))
      release.resolve()
      for (const item of admitted) await ctx.jobs.wait(item.jobId, 30000, item.owner)
      const output = (await invoke(child.agent, 'job_output', { job_id: queued.downloadTask.jobId }, 'cwd-job-output', exec.signal)).results[0].result
      assert.equal(output.isError, false)
      assert.ok(output.content.some(block => block.type === 'text' && block.text.includes('interrupted')))
      const registry = JSON.parse(await readFile(join(process.env.DSH_HOME, 'plugin-data/muse-douyin-download/tasks/v1/registry.json'), 'utf8'))
      const saved = registry.tasks.find(task => task.id === queued.downloadTask.id)
      assert.equal(saved.ownerSessionId, childId)
      assert.equal(saved.cwd, await realpath(original))
      assert.equal(saved.state, 'interrupted')
      const targetAcquisitions = calls.filter(call => call.url === videoURL(VIDEO_TWO)).length
      const replacementEntries = await readdir(replacement)
      assert.equal(saved.error.code, 'DOUYIN_TASK_FORBIDDEN', `Changed queued cwd must be denied before acquisition, not after a misplaced receipt; targetAcquisitions=${targetAcquisitions}, replacementEntries=${JSON.stringify(replacementEntries)}`)
      assert.deepEqual(calls.map(call => call.url), [videoURL(VIDEO_ONE)], 'No acquisition starts for the retargeted task')
      assert.deepEqual(await readdir(original), [])
      assert.deepEqual(replacementEntries, [], 'Replacement project must contain no downloaded media or sidecar')
      const after = (await invoke(child.agent, 'douyin_download_task', {
        action: 'status', taskId: queued.downloadTask.id,
      }, 'cwd-after-status', exec.signal)).results[0].result
      assert.equal(after.isError, true)
      assert.ok(after.content.some(block => block.type === 'text' && block.text.includes('workspace differs')))
      await child.dispose(); child = undefined
      await unlink(selected)
      const proof = { acceptedProject: 'project-a', changedProject: 'project-b', targetWasQueued: true,
        state: saved.state, errorCode: saved.error.code, targetAcquisitions,
        originalProjectFiles: 0, replacementProjectFiles: 0, changedOwnerStatusDenied: true, jobsSettled: true }
      await writeFile(join(cwd, 'cwd-retarget-proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
      observed = true
      return proof
      } finally { release.resolve() }
    },
  }))
  ctx.on('llm/stream', async function* (options, next) {
    const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'cwd-retarget-observation')
    if (result !== undefined) {
      const proof = valueOf(result)
      assert.equal(proof.errorCode, 'DOUYIN_TASK_FORBIDDEN')
      assert.equal(proof.targetAcquisitions, 0)
      assert.equal(proof.replacementProjectFiles, 0)
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (agent !== root) return
    assert.equal(observed, true)
    assert.ok(ctx.jobs.list(root.id).every(job => !['running', 'stopping'].includes(job.status)))
    const final = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').at(-1)
    assert.ok(final?.data.message.content.some(block => block.type === 'text' && block.text.includes('拒绝') && block.text.includes('未写入')))
  })
  ctx.effect(() => ctx.provide('snapshotDouyinCwdReady', true))
}
