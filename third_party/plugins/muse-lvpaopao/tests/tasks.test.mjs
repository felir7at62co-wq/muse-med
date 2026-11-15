/** Owned series jobs use real services and verified local copies; native acquisition is offline. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { MP4 } from '../../muse-douyin-download/tests/task-fixtures.js'
import { BridgeError } from '../src/port.ts'
import { authorizeOutput } from '../src/output.ts'
import { SOURCE, TITLE, aborted, deferred, manifest, taskFixture } from './task-harness.mjs'

const testOptions = { timeout: 20000 }
const task = result => result.data.seriesTask
const actions = f => f.calls.map(call => call.action)

test('background acceptance survives caller completion and reports the real owned job without changing the v1 series identity', testOptions, async t => {
  const entered = deferred(), release = deferred(), caller = new AbortController()
  const f = await taskFixture(t, { beforeNative: async ({ action }) => {
    if (action === 'detail') { entered.resolve(); await release.promise }
  } })
  f.releases.add(() => release.resolve())
  const accepted = await f.download(SOURCE, { signal: caller.signal })
  assert.equal(accepted.status, 'series-queued'); assert.equal(accepted.ok, true)
  assert.match(task(accepted).id, /^lvs-[a-f0-9]{32}$/)
  assert.notEqual(task(accepted).id, task(accepted).jobId)
  await entered.promise
  caller.abort(Error('The accepting tool turn finished'))
  assert.equal(f.ctx.jobs.get(task(accepted).jobId, f.owner.agent.id).status, 'running')
  release.resolve(); await f.settle(accepted)
  const result = await f.status(accepted)
  assert.equal(task(result).state, 'completed'); assert.equal(result.status, 'series-complete')
  const saved = await manifest(result)
  const innerId = createHash('sha256').update(JSON.stringify([SOURCE.srcAppId, SOURCE.dramaId])).digest('hex').slice(0, 24)
  assert.equal(saved.schemaVersion, 1); assert.equal(saved.taskId, innerId)
  assert.equal(result.data.series.taskId, innerId)
  assert.deepEqual(saved.episodes.map(item => item.state), ['complete', 'complete'])
  for (const episode of saved.episodes) {
    assert.match(episode.requestKey, /^[a-f0-9]{64}$/)
    assert.deepEqual(await readFile(episode.media.localPath), MP4)
    const receipt = JSON.parse(await readFile(episode.media.receiptPath, 'utf8'))
    assert.equal(receipt.idempotencyKey, episode.requestKey)
  }
  const output = await f.jobTool('job_output', { job_id: task(accepted).jobId, wait: true })
  assert.equal(output.isError, false)
  assert.equal(f.copies, 0)
})

test('wait returns the established series result while a repeated download revalidates the same keys and skips verified media', testOptions, async t => {
  const f = await taskFixture(t)
  const first = await f.download(SOURCE, { mode: 'wait' })
  assert.equal(first.status, 'series-complete'); assert.equal(task(first).state, 'completed')
  const saved = await manifest(first), before = f.calls.length
  const second = await f.download(SOURCE, { mode: 'wait' })
  assert.equal(second.status, 'series-complete'); assert.equal(task(second).id, task(first).id)
  assert.notEqual(task(second).jobId, task(first).jobId)
  assert.deepEqual((await manifest(second)).episodes.map(item => item.requestKey), saved.episodes.map(item => item.requestKey))
  assert.equal(f.acquisitions.length, 2)
  assert.deepEqual(f.calls.slice(before).map(call => call.action), ['detail', 'episodes'])
})

test('ambiguous titles return selection candidates without creating an outer task or media directory', testOptions, async t => {
  const f = await taskFixture(t, { candidates: [
    { title: TITLE, srcAppId: SOURCE.srcAppId, originDramaId: SOURCE.dramaId },
    { title: TITLE, srcAppId: 'wx0000000000000002', originDramaId: 'other-series' },
  ] })
  const result = await f.download({ query: TITLE })
  assert.equal(result.status, 'selection-required'); assert.equal(result.ok, false)
  assert.equal(result.data.seriesTask, undefined)
  assert.deepEqual(actions(f), ['search']); assert.equal(f.configurations, 0)
  assert.deepEqual(await readdir(f.workspace), [])
  assert.deepEqual((await f.tasks.store.read()).tasks, [])
})

test('read-only and symlink outputs reject before source lookup or job creation, and another owner cannot inspect or resume a task', testOptions, async t => {
  const f = await taskFixture(t)
  setSandboxMode(f.owner.agent.session, 'read-only')
  await assert.rejects(f.download({ query: TITLE }), /download-access-denied/)
  assert.deepEqual(actions(f), [])
  setSandboxMode(f.owner.agent.session, 'workspace-write')
  const outside = join(f.directory, 'outside'); await mkdir(outside)
  await symlink(outside, join(f.workspace, 'linked'))
  await assert.rejects(f.download(SOURCE, { outputDir: 'linked' }), /unsafe|symlink|outside|forbidden/)
  assert.deepEqual(actions(f), [])
  const accepted = await f.download(SOURCE, { mode: 'wait' })
  const foreign = await f.makeAgent('foreign-owner')
  await assert.rejects(f.status(accepted, foreign.agent), /owner-mismatch/)
  await assert.rejects(f.resume(accepted, foreign.agent), /owner-mismatch/)
  await assert.rejects(f.cancel(accepted, foreign.agent), /owner-mismatch/)
  assert.equal(f.acquisitions.length, 2)
})

test('active requests from one owner and canonical destination coalesce into one durable job', testOptions, async t => {
  const entered = deferred(), release = deferred()
  const f = await taskFixture(t, { beforeNative: async ({ action }) => {
    if (action === 'detail') { entered.resolve(); await release.promise }
  } })
  f.releases.add(() => release.resolve())
  const first = await f.download(); await entered.promise
  const second = await f.download(SOURCE, { outputDir: './downloads/lvpaopao' })
  assert.deepEqual(task(second), task(first))
  release.resolve(); await f.settle(first)
  assert.equal(f.calls.filter(call => call.action === 'detail').length, 1)
  assert.equal(f.acquisitions.length, 2)
})

test('task status remains local and read-only when the native bridge and its configuration are unavailable', testOptions, async t => {
  const f = await taskFixture(t), complete = await f.download(SOURCE, { mode: 'wait' })
  const before = f.calls.length, configurations = f.configurations
  f.control.offline = true; setSandboxMode(f.owner.agent.session, 'read-only')
  const status = await f.status(complete)
  assert.equal(status.status, 'series-complete'); assert.equal(task(status).state, 'completed')
  assert.equal(f.calls.length, before); assert.equal(f.configurations, configurations)
})

test('job_kill waits for native cancellation cleanup and preserves the original unknown key for explicit resume', testOptions, async t => {
  const entered = deferred(), cancellation = deferred(), release = deferred()
  let first = true
  const f = await taskFixture(t, { episodeCount: 1, afterAcquisition: async ({ signal }) => {
    if (!first) return
    first = false; entered.resolve(); await aborted(signal); cancellation.resolve(); await release.promise; signal.throwIfAborted()
  } })
  f.releases.add(() => release.resolve())
  const accepted = await f.download(); await entered.promise
  const killed = await f.jobTool('job_kill', { job_id: task(accepted).jobId, reason: 'synthetic cancellation' })
  assert.equal(killed.isError, false); await cancellation.promise
  assert.equal(f.ctx.jobs.get(task(accepted).jobId, f.owner.agent.id).status, 'stopping')
  release.resolve(); await f.settle(accepted)
  assert.equal(f.copies, 0)
  const cancelled = await f.status(accepted)
  assert.equal(task(cancelled).state, 'cancelled')
  const saved = await manifest(cancelled), key = saved.episodes[0].requestKey, before = f.calls.length
  const resumed = await f.resume(accepted)
  assert.equal(resumed.status, 'series-queued'); assert.notEqual(task(resumed).jobId, task(accepted).jobId)
  await f.settle(resumed)
  const complete = await f.status(resumed)
  assert.equal(task(complete).state, 'completed'); assert.equal(f.acquisitions.length, 1)
  assert.deepEqual(f.calls.slice(before).map(call => call.action), ['status', 'detail', 'episodes', 'download_status'])
  assert.equal(f.calls.at(-1).params.idempotencyKey, key)
})

test('unresolved original-key status keeps the task waiting and never invents another acquisition key', testOptions, async t => {
  let fail = true
  const f = await taskFixture(t, { episodeCount: 1, afterAcquisition: async () => {
    if (fail) { fail = false; const error = Error('Synthetic unknown native outcome'); error.code = 'unknown-native-outcome'; throw error }
  } })
  const accepted = await f.download(SOURCE, { mode: 'wait' }), saved = await manifest(accepted)
  assert.equal(accepted.status, 'series-partial'); assert.equal(f.acquisitions.length, 1)
  f.control.reconciliation = 'unknown'
  const before = f.calls.length, resumed = await f.resume(accepted)
  await f.settle(resumed)
  const stillUnknown = await f.status(resumed), after = await manifest(stillUnknown)
  assert.equal(stillUnknown.status, 'series-partial')
  assert.ok(['waiting_source', 'interrupted'].includes(task(stillUnknown).state))
  assert.equal(after.episodes[0].requestKey, saved.episodes[0].requestKey)
  assert.deepEqual(f.calls.slice(before).map(call => call.action), ['status', 'detail', 'episodes', 'download_status'])
  assert.equal(f.acquisitions.length, 1)
})

test('cleanup-unconfirmed blocks explicit recovery before catalog or media requests', testOptions, async t => {
  const f = await taskFixture(t), accepted = await f.download(SOURCE, { mode: 'wait' }), before = f.calls.length
  f.control.cleanupUnconfirmed = true
  const resumed = await f.resume(accepted)
  await f.settle(resumed)
  const status = await f.status(resumed)
  assert.notEqual(task(status).state, 'completed')
  assert.deepEqual(f.calls.slice(before).map(call => call.action), ['status'])
  assert.equal(f.acquisitions.length, 2)
})

test('the Host-private registry has private permissions and canonical workspace ownership', testOptions, async t => {
  const f = await taskFixture(t), result = await f.download(SOURCE, { mode: 'wait' })
  assert.equal((await lstat(f.taskDirectory)).mode & 0o777, 0o700)
  const path = join(f.taskDirectory, 'registry.json')
  assert.equal((await lstat(path)).mode & 0o777, 0o600)
  const registry = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(registry.schemaVersion, 1)
  const serialized = JSON.stringify(registry)
  assert.ok(serialized.includes(f.owner.agent.id)); assert.ok(serialized.includes(f.workspace))
  assert.ok(serialized.includes(task(result).id))
})

test('cancelling a queued task settles it without releasing another task admission or letting a later task overtake', testOptions, async t => {
  const entered = deferred(), release = deferred()
  const f = await taskFixture(t, { episodeCount: 1, beforeNative: async ({ action, params }) => {
    if (action === 'detail' && params.dramaId === SOURCE.dramaId) { entered.resolve(); await release.promise }
  } })
  f.releases.add(() => release.resolve())
  const first = await f.download(); await entered.promise
  const secondOwner = await f.makeAgent('second-owner'), thirdOwner = await f.makeAgent('third-owner')
  const second = await f.download(SOURCE, { agent: secondOwner.agent })
  const third = await f.download(SOURCE, { agent: thirdOwner.agent })
  const cancelled = await f.cancel(second, secondOwner.agent)
  assert.equal(task(cancelled).state, 'cancelled')
  assert.deepEqual(f.calls.filter(call => call.action === 'detail').map(call => call.params.dramaId), [SOURCE.dramaId])
  assert.equal(f.ctx.jobs.get(task(third).jobId, thirdOwner.agent.id).status, 'running')
  release.resolve(); await f.settle(first); await f.ctx.jobs.wait(task(third).jobId, 30000, thirdOwner.agent.id)
  assert.deepEqual(f.calls.filter(call => call.action === 'detail').map(call => call.params.dramaId), [SOURCE.dramaId, SOURCE.dramaId])
  assert.equal(f.acquisitions.length, 1)
  assert.equal(task(await f.status(second, secondOwner.agent)).state, 'cancelled')
})

test('a live owner disposal cancels its task and waits for native and copy cleanup', testOptions, async t => {
  const entered = deferred(), cancellation = deferred(), release = deferred()
  const f = await taskFixture(t, { beforeNative: async ({ action, signal }) => {
    if (action === 'download_episode') {
      entered.resolve(); await aborted(signal); cancellation.resolve(); await release.promise; signal.throwIfAborted()
    }
  } })
  f.releases.add(() => release.resolve())
  const accepted = await f.download(); await entered.promise
  let finished = false
  const disposal = f.owner.dispose().then(() => { finished = true })
  await cancellation.promise; assert.equal(finished, false); assert.equal(f.copies, 1)
  release.resolve(); await disposal
  assert.equal(f.copies, 0)
  const saved = (await f.tasks.store.read()).tasks.find(item => item.id === task(accepted).id)
  assert.equal(saved.state, 'interrupted')
})

test('plugin task disposal closes admission and joins native cleanup before returning', testOptions, async t => {
  const entered = deferred(), cancellation = deferred(), release = deferred()
  const f = await taskFixture(t, { beforeNative: async ({ action, signal }) => {
    if (action === 'download_episode') {
      entered.resolve(); await aborted(signal); cancellation.resolve(); await release.promise; signal.throwIfAborted()
    }
  } })
  f.releases.add(() => release.resolve())
  const accepted = await f.download(); await entered.promise
  let finished = false
  const disposal = f.tasks.dispose().then(() => { finished = true })
  await cancellation.promise; assert.equal(finished, false)
  await assert.rejects(f.download({ ...SOURCE, dramaId: 'after-unload' }), /closed|disposed/)
  release.resolve(); await disposal; await f.settle(accepted)
  assert.equal(f.copies, 0); assert.equal(finished, true)
})

test('explicit resume rechecks write permission before native recovery and leaves the saved manifest untouched when denied', testOptions, async t => {
  const f = await taskFixture(t), complete = await f.download(SOURCE, { mode: 'wait' })
  const path = complete.data.series.manifestPath, saved = await readFile(path, 'utf8'), before = f.calls.length
  setSandboxMode(f.owner.agent.session, 'read-only')
  await assert.rejects(f.resume(complete), /download-access-denied/)
  assert.equal(f.calls.length, before); assert.equal(await readFile(path, 'utf8'), saved)
})

test('resume refuses a replaced output directory before issuing native recovery', testOptions, async t => {
  const f = await taskFixture(t), complete = await f.download(SOURCE, { mode: 'wait' })
  const output = join(f.workspace, 'downloads', 'lvpaopao'), before = f.calls.length
  await rename(output, output + '-moved')
  await symlink(output + '-moved', output)
  await assert.rejects(f.resume(complete), /unsafe|symlink|replaced|forbidden/)
  assert.equal(f.calls.length, before)
})

test('a real process restart marks active work interrupted without native replay, then resumes only the original unknown key', testOptions, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'lvpaopao-task-crash-'))), ownerId = 'series-crash-owner'
  const child = fork(fileURLToPath(new URL('./task-crash-child.mjs', import.meta.url)), [directory, ownerId], {
    execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env },
  })
  let stderr = '', accepted
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk })
  const reached = deferred(), exited = once(child, 'exit')
  child.on('message', message => {
    if (message.phase === 'accepted') accepted = message.accepted
    if (message.phase === 'native-result-before-local-copy') reached.resolve(message)
  })
  child.once('error', reached.reject)
  child.once('exit', code => reached.reject(Error(`Crash fixture exited before its barrier: ${code}; ${stderr}`)))
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    await rm(directory, { recursive: true, force: true })
  })
  const ready = await reached.promise
  assert.ok(accepted, 'The task is accepted before the native episode barrier')
  child.send('crash'); assert.deepEqual(await exited, [0, null])
  const f = await taskFixture(t, { directory, ownerId, keepDirectory: true })
  const restarted = await f.status(accepted)
  assert.equal(task(restarted).state, 'interrupted'); assert.equal(task(restarted).jobId, null)
  assert.deepEqual(actions(f), []); assert.equal(f.acquisitions.length, 0)
  assert.throws(() => f.ctx.jobs.get(task(accepted).jobId, f.owner.agent.id), /unknown job/)
  const before = await manifest(restarted)
  assert.equal(before.episodes[0].state, 'complete'); assert.equal(before.episodes[1].requestKey, ready.key)
  const resumed = await f.resume(accepted)
  assert.equal(resumed.status, 'series-queued'); assert.equal(task(resumed).id, task(accepted).id)
  assert.equal(f.ctx.jobs.get(task(resumed).jobId, f.owner.agent.id).status, 'running')
  await f.settle(resumed)
  const complete = await f.status(resumed)
  assert.equal(task(complete).state, 'completed')
  assert.deepEqual(actions(f), ['status', 'detail', 'episodes', 'download_status'])
  assert.equal(f.calls.at(-1).params.episodeNo, 2); assert.equal(f.calls.at(-1).params.idempotencyKey, ready.key)
  assert.equal(f.acquisitions.length, 0, 'Both native receipts were saved before the crash; status only copies the second')
  assert.deepEqual((await manifest(complete)).episodes.map(item => item.requestKey), before.episodes.map(item => item.requestKey))
})

test('the registered tool defaults to wait and exposes outer controls without forwarding them as native actions', testOptions, async t => {
  const f = await taskFixture(t); await f.mountTool()
  const complete = await f.invoke({ action: 'download_series', ...SOURCE })
  assert.equal(complete.status, 'series-complete'); assert.equal(task(complete).state, 'completed')
  const saved = await manifest(complete)
  assert.equal(saved.schemaVersion, 1); assert.equal(complete.data.series.taskId, saved.taskId)
  const before = f.calls.length
  f.control.offline = true
  const status = await f.invoke({ action: 'series_status', seriesTaskId: task(complete).id })
  assert.equal(status.status, 'series-complete'); assert.equal(task(status).state, 'completed')
  assert.equal(f.calls.length, before)
  for (const args of [
    { action: 'series_status', seriesTaskId: task(complete).id, ...SOURCE },
    { action: 'detail', mode: 'background', ...SOURCE },
    { action: 'series_resume', seriesTaskId: task(complete).id, outputDir: 'other' },
  ]) {
    const rejected = await f.invoke(args)
    assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'invalid-arguments')
  }
  assert.equal(f.calls.length, before)
})

test('a registered background tool returns before native work and its finished execution signal does not cancel the job', testOptions, async t => {
  const entered = deferred(), release = deferred(), controller = new AbortController()
  const f = await taskFixture(t, { beforeNative: async ({ action }) => {
    if (action === 'detail') { entered.resolve(); await release.promise }
  } })
  f.releases.add(() => release.resolve()); await f.mountTool()
  const accepted = await f.invoke({ action: 'download_series', mode: 'background', ...SOURCE }, { signal: controller.signal })
  assert.equal(accepted.status, 'series-queued'); await entered.promise
  controller.abort(Error('Synthetic tool completion'))
  release.resolve(); await f.settle(accepted)
  const status = await f.invoke({ action: 'series_status', seriesTaskId: task(accepted).id })
  assert.equal(task(status).state, 'completed'); assert.equal(f.acquisitions.length, 2)
})

for (const corruption of ['missing', 'malformed']) test(`resume refuses a previously used ${corruption} inner manifest without replacing its original request keys`, testOptions, async t => {
  let fail = true
  const f = await taskFixture(t, { episodeCount: 1, afterAcquisition: async () => {
    if (fail) { fail = false; throw new BridgeError('native-outcome-unconfirmed') }
  } })
  const partial = await f.download(SOURCE, { mode: 'wait' }), saved = await manifest(partial)
  const path = partial.data.series.manifestPath, original = await readFile(path, 'utf8'), before = f.calls.length
  assert.equal(saved.episodes[0].state, 'unknown')
  if (corruption === 'missing') await rename(path, path + '.retained')
  else await writeFile(path, '{ not valid JSON')
  await assert.rejects(f.resume(partial), /manifest|task-not-found|state/)
  assert.equal(f.calls.length, before); assert.equal(f.acquisitions.length, 1)
  assert.equal((await readFile(corruption === 'missing' ? path + '.retained' : path, 'utf8')),
    corruption === 'missing' ? original : '{ not valid JSON')
  assert.equal(f.acquisitions[0].key, saved.episodes[0].requestKey)
})

for (const mode of ['wait', 'background']) test(`${mode} preserves locally verified receipts when the outer completion registration fails`, testOptions, async t => {
  const f = await taskFixture(t), transaction = f.tasks.store.transaction.bind(f.tasks.store)
  let rejectedCompletion = false
  f.releases.add(() => { f.tasks.store.transaction = transaction })
  f.tasks.store.transaction = change => transaction(async registry => {
    const result = await change(registry)
    if (!rejectedCompletion && registry.tasks.some(item => item.state === 'completed')) {
      rejectedCompletion = true; throw new BridgeError('series-task-publication-failed')
    }
    return result
  })
  let result = await f.download(SOURCE, { mode }), accepted = result
  if (mode === 'background') {
    await f.settle(accepted)
    const output = await f.jobTool('job_output', { job_id: task(accepted).jobId, wait: true, timeout_ms: 30000 })
    assert.equal(output.isError, false); result = JSON.parse(output.value.text)
  }
  assert.equal(rejectedCompletion, true); assert.equal(result.ok, false); assert.equal(result.status, 'series-interrupted')
  assert.equal(task(result).state, 'interrupted')
  assert.equal(result.error.code, 'series-task-state-failed')
  const saved = await manifest(result)
  assert.deepEqual(saved.episodes.map(item => item.state), ['complete', 'complete'])
  for (const episode of saved.episodes) {
    assert.deepEqual(await readFile(episode.media.localPath), MP4)
    assert.equal(JSON.parse(await readFile(episode.media.receiptPath, 'utf8')).idempotencyKey, episode.requestKey)
  }
  assert.equal(f.acquisitions.length, 2)
  assert.equal(task(await f.status(accepted)).state, 'interrupted')
})

test('a saved owner identity cannot control the task from a different canonical cwd', testOptions, async t => {
  const f = await taskFixture(t), complete = await f.download(SOURCE, { mode: 'wait' })
  const ownerId = f.owner.agent.id, before = f.calls.length, elsewhere = join(f.directory, 'another-workspace')
  await f.owner.dispose(); await mkdir(elsewhere)
  const replacement = await f.makeAgent(ownerId, elsewhere)
  await assert.rejects(f.status(complete, replacement.agent), /owner-mismatch/)
  await assert.rejects(f.resume(complete, replacement.agent), /owner-mismatch/)
  assert.equal(f.calls.length, before)
})

test('queued work rechecks the owner write policy when it actually gains admission', testOptions, async t => {
  const entered = deferred(), release = deferred()
  let first = true
  const f = await taskFixture(t, { beforeNative: async ({ action }) => {
    if (action === 'detail' && first) { first = false; entered.resolve(); await release.promise }
  } })
  f.releases.add(() => release.resolve())
  const running = await f.download(); await entered.promise
  const secondOwner = await f.makeAgent('policy-revoked-while-queued')
  const queued = await f.download(SOURCE, { agent: secondOwner.agent })
  setSandboxMode(secondOwner.agent.session, 'read-only')
  release.resolve(); await f.settle(running)
  await f.ctx.jobs.wait(task(queued).jobId, 30000, secondOwner.agent.id)
  const result = await f.status(queued, secondOwner.agent)
  assert.notEqual(task(result).state, 'completed')
  assert.equal(f.calls.filter(call => call.action === 'detail').length, 1)
  assert.equal(f.acquisitions.length, 2)
})

test('local verification detects altered completed media without writing the v1 manifest or contacting native', testOptions, async t => {
  const f = await taskFixture(t), complete = await f.download(SOURCE, { mode: 'wait' }), saved = await manifest(complete)
  const originalManifest = await readFile(complete.data.series.manifestPath, 'utf8'), before = f.calls.length
  const altered = Buffer.from(MP4); altered[altered.length - 1] ^= 1
  await writeFile(saved.episodes[0].media.localPath, altered)
  const status = await f.status(complete)
  assert.equal(status.status, 'series-partial'); assert.equal(task(status).state, 'interrupted')
  assert.deepEqual(status.data.series.completedEpisodeNumbers, [2])
  assert.deepEqual(status.data.series.failedEpisodeNumbers, [1])
  assert.equal(await readFile(complete.data.series.manifestPath, 'utf8'), originalManifest)
  assert.equal(f.calls.length, before)
})

test('unload rejects later title acceptance before search or any new durable task is written', testOptions, async t => {
  const f = await taskFixture(t), complete = await f.download(SOURCE, { mode: 'wait' })
  await f.tasks.dispose()
  const before = f.calls.length, state = JSON.stringify(await f.tasks.store.read())
  await assert.rejects(f.download({ query: TITLE }), /closed|disposed/)
  await assert.rejects(f.download({ ...SOURCE, dramaId: 'unloaded-series' }), /closed|disposed/)
  assert.equal(f.calls.length, before); assert.equal(JSON.stringify(await f.tasks.store.read()), state)
  assert.equal(task(complete).state, 'completed')
})

test('replacing the private registry directory with a symlink rejects control before native work', testOptions, async t => {
  const f = await taskFixture(t), complete = await f.download(SOURCE, { mode: 'wait' }), before = f.calls.length
  await rename(f.taskDirectory, f.taskDirectory + '-retained')
  await symlink(f.taskDirectory + '-retained', f.taskDirectory)
  await assert.rejects(f.resume(complete), /directory-unsafe|directory-changed|state-invalid/)
  assert.equal(f.calls.length, before)
})

test('unloading the registered plugin cancels and joins its background native copy before the tool fiber closes', testOptions, async t => {
  const entered = deferred(), cancellation = deferred(), release = deferred()
  const f = await taskFixture(t, { beforeNative: async ({ action, signal }) => {
    if (action === 'download_episode') {
      entered.resolve(); await aborted(signal); cancellation.resolve(); await release.promise; signal.throwIfAborted()
    }
  } })
  f.releases.add(() => release.resolve())
  const mounted = await f.mountTool(), accepted = await f.invoke({ action: 'download_series', mode: 'background', ...SOURCE })
  assert.equal(accepted.status, 'series-queued'); await entered.promise
  let finished = false
  const disposal = mounted.dispose().then(() => { finished = true })
  await cancellation.promise; assert.equal(finished, false)
  release.resolve(); await disposal; await f.settle(accepted)
  const record = (await f.tasks.store.read()).tasks.find(item => item.id === task(accepted).id)
  assert.equal(record.state, 'interrupted'); assert.equal(finished, true)
})

test('an unplayable episode preserves earlier verified progress and reports waiting_user rather than completion', testOptions, async t => {
  const f = await taskFixture(t, { beforeNative: ({ action, params }) => {
    if (action === 'download_episode' && params.episodeNo === 2) throw new BridgeError('straight-playback-unconfirmed')
  } })
  const result = await f.download(SOURCE, { mode: 'wait' })
  assert.equal(result.ok, false); assert.equal(result.status, 'series-partial'); assert.equal(task(result).state, 'waiting_user')
  assert.deepEqual(result.data.series.completedEpisodeNumbers, [1]); assert.deepEqual(result.data.series.deniedEpisodeNumbers, [2])
  assert.equal(f.acquisitions.length, 1)
  const saved = await manifest(result)
  assert.equal(saved.episodes[1].media, undefined)
  assert.deepEqual(await readFile(saved.episodes[0].media.localPath), MP4)
})

test('cancelling a coalesced wait releases only that caller and keeps the existing background job running', testOptions, async t => {
  const entered = deferred(), release = deferred(), waiting = deferred(), caller = new AbortController()
  const f = await taskFixture(t, { beforeNative: async ({ action }) => {
    if (action === 'detail') { entered.resolve(); await release.promise }
  } })
  f.releases.add(() => release.resolve())
  const accepted = await f.download(); await entered.promise
  const original = f.ctx.jobs.wait.bind(f.ctx.jobs)
  f.ctx.jobs.wait = (id, timeout, owner, signal) => {
    if (signal === caller.signal) waiting.resolve()
    return original(id, timeout, owner, signal)
  }
  f.releases.add(() => { f.ctx.jobs.wait = original })
  const waiter = f.download(SOURCE, { mode: 'wait', signal: caller.signal })
  const cancelled = assert.rejects(waiter, /wait aborted/)
  await waiting.promise; caller.abort(Error('Synthetic caller stopped waiting')); await cancelled
  assert.equal(f.ctx.jobs.get(task(accepted).jobId, f.owner.agent.id).status, 'running')
  release.resolve(); await f.settle(accepted)
  assert.equal(task(await f.status(accepted)).state, 'completed'); assert.equal(f.acquisitions.length, 2)
})

test('cancellation during resume local verification prevents acceptance of a new background job', testOptions, async t => {
  const f = await taskFixture(t), complete = await f.download(SOURCE, { mode: 'wait' })
  const verified = deferred(), release = deferred(), caller = new AbortController(), before = f.calls.length
  f.releases.add(() => release.resolve())
  const resumer = await f.makeTasks({ localStatus: async (params, output, signal) => {
    const result = await f.dependencies.localStatus(params, output, signal)
    verified.resolve(); await release.promise; return result
  } })
  const savedBefore = await f.tasks.store.read()
  assert.equal(savedBefore.tasks[0].jobId, task(complete).jobId)
  const pending = resumer.resume(task(complete).id, f.owner.agent, caller.signal)
  const rejected = assert.rejects(pending, error => error === caller.signal.reason || error.name === 'AbortError')
  await verified.promise; caller.abort(Error('Synthetic cancellation during preflight')); release.resolve(); await rejected
  assert.equal(f.calls.length, before)
  assert.deepEqual(await f.tasks.store.read(), savedBefore)
})

test('adopting an existing completed v1 manifest also preserves its original keys if that manifest later disappears', testOptions, async t => {
  const f = await taskFixture(t), signal = new AbortController().signal
  const output = await authorizeOutput(f.owner.agent.session, undefined, f.ctx.sandboxPolicy.resolve({ session: f.owner.agent.session }))
  const legacy = await f.dependencies.run({ ...SOURCE, title: TITLE, episodeCount: 2,
    actualEpisodeNumbers: [1, 2], catalogComplete: true }, output, signal, async () => {})
  const saved = JSON.parse(await readFile(legacy.manifestPath, 'utf8'))
  const complete = await f.download(SOURCE, { mode: 'wait' })
  assert.equal(complete.status, 'series-complete'); assert.equal(f.acquisitions.length, 2)
  const adopted = await readFile(legacy.manifestPath, 'utf8')
  await rename(legacy.manifestPath, legacy.manifestPath + '.retained')
  const before = f.calls.length
  await assert.rejects(f.resume(complete), /original-manifest-required/)
  assert.equal(f.calls.length, before); assert.equal(f.acquisitions.length, 2)
  assert.equal(await readFile(legacy.manifestPath + '.retained', 'utf8'), adopted)
  assert.deepEqual(f.acquisitions.map(item => item.key), saved.episodes.map(item => item.requestKey))
})
