/** Durable series orchestration with real files; native media acquisition is the injected test edge. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { authorizeOutput } from '../src/output.ts'
import { BridgeError } from '../src/port.ts'
import { readSeriesStatus, readStoredSeriesStatus, runSeries } from '../src/series.ts'

const signal = () => new AbortController().signal
const selection = { srcAppId: 'wx0123456789abcdef', dramaId: 'sample_1', title: 'Test drama',
  episodeCount: 3, actualEpisodeNumbers: [1, 2, 3], catalogComplete: true }
async function fixture(t, selected = selection) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lvpaopao-series-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const output = await authorizeOutput({ header: { cwd: root } }, 'downloads', { mode: 'workspace-write' })
  const options = { selection: selected, output, lockDirectory: join(root, '.private-locks'), maxAttempts: 2, retryDelayMs: 0, lockWaitMs: 10, maxEpisodes: 100, maxMediaBytes: 10000 }
  const downloads = [], reconciliations = []
  const dependencies = {
    async download(request) { downloads.push(request); return await media(request) },
    async reconcile(request) { reconciliations.push(request); return { kind: 'unknown' } },
    classify(error) { return { code: error instanceof BridgeError ? error.code : 'test-failure', retry: 'unknown' } },
  }
  return { root, options, dependencies, downloads, reconciliations }
}
async function media(request, suffix = '') {
  const bytes = Buffer.from(`synthetic episode ${request.episodeNo}${suffix}`)
  const file = join(request.episodeDirectory, `episode-${request.attempt}${suffix}.mp4`), receiptPath = join(request.episodeDirectory, `receipt-${request.attempt}${suffix}.json`)
  await writeFile(file, bytes, { flag: 'wx' }); await writeFile(receiptPath, '{}\n', { flag: 'wx' })
  return { localPath: file, receiptPath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    durationSeconds: 1.5, width: 720, height: 1280, hasAudio: true, fullDecodePassed: true }
}
const one = { ...selection, episodeCount: 1, actualEpisodeNumbers: [1] }

test('complete actual catalog is downloaded into stable directories and a second call verifies without native replay', async t => {
  const f = await fixture(t)
  const first = await runSeries(f.options, f.dependencies, signal())
  assert.equal(first.status, 'complete'); assert.deepEqual(first.completedEpisodeNumbers, [1, 2, 3])
  assert.equal(f.downloads.length, 3)
  assert.match(f.downloads[0].episodeDirectory, /episodes[/\\]0001$/)
  const persisted = JSON.parse(await readFile(first.manifestPath, 'utf8'))
  assert.equal(persisted.schemaVersion, 1); assert.equal(persisted.episodes[0].attempts, 1)
  const second = await runSeries({ ...f.options, selection: { ...selection, title: 'Renamed title', actualEpisodeNumbers: [3, 1, 2] } }, f.dependencies, signal())
  assert.equal(second.taskId, first.taskId); assert.equal(second.status, 'complete'); assert.equal(f.downloads.length, 3)
  assert.equal((await readSeriesStatus(f.options)).status, 'complete')
})

test('missing catalog numbers and denied episodes keep progress partial and do not invent native requests', async t => {
  const f = await fixture(t, { ...selection, actualEpisodeNumbers: [1, 3], catalogComplete: false })
  f.dependencies.download = async request => {
    f.downloads.push(request)
    if (request.episodeNo === 3) throw new BridgeError('episode-not-playable')
    return await media(request)
  }
  f.dependencies.classify = error => ({ code: error.code, retry: 'denied' })
  const result = await runSeries(f.options, f.dependencies, signal())
  assert.equal(result.status, 'partial'); assert.deepEqual(result.completedEpisodeNumbers, [1]); assert.deepEqual(result.deniedEpisodeNumbers, [3])
  assert.deepEqual(result.missingEpisodeNumbers, [2]); assert.deepEqual(f.downloads.map(request => request.episodeNo), [1, 3])
  await runSeries(f.options, f.dependencies, signal()); assert.equal(f.downloads.length, 2)
})

test('safe failures retry within the invocation budget and preserve the durable key before every native call', async t => {
  const f = await fixture(t, one)
  let manifestPath
  f.dependencies.download = async request => {
    f.downloads.push(request)
    const files = await readdir(f.options.output.path); manifestPath = join(f.options.output.path, files[0], 'manifest.json')
    const entry = JSON.parse(await readFile(manifestPath, 'utf8')).episodes[0]
    assert.equal(entry.state, 'downloading'); assert.equal(entry.requestKey, request.requestKey); assert.equal(entry.attempts, request.attempt)
    if (request.attempt === 1) throw new BridgeError('transfer-interrupted')
    return await media(request)
  }
  f.dependencies.classify = error => ({ code: error.code, retry: 'safe' })
  const result = await runSeries(f.options, f.dependencies, signal())
  assert.equal(result.status, 'complete'); assert.equal(result.episodes[0].attempts, 2)
  assert.equal(f.downloads[0].requestKey, f.downloads[1].requestKey); assert.equal(f.downloads[0].episodeDirectory, f.downloads[1].episodeDirectory)
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).episodes[0].state, 'complete')
})

test('an explicit continue gets a fresh bounded retry budget while total attempts remain durable', async t => {
  const f = await fixture(t, one)
  f.dependencies.classify = error => ({ code: error.code, retry: 'safe' })
  f.dependencies.download = async request => { f.downloads.push(request); throw new BridgeError('transfer-interrupted') }
  assert.equal((await runSeries(f.options, f.dependencies, signal())).episodes[0].attempts, 2)
  f.dependencies.download = async request => { f.downloads.push(request); return await media(request) }
  const result = await runSeries(f.options, f.dependencies, signal())
  assert.equal(result.status, 'complete'); assert.equal(result.episodes[0].attempts, 3)
  assert.equal(new Set(f.downloads.map(request => request.requestKey)).size, 1)
})

test('unknown acquisition is reconciled by original key without a second download', async t => {
  const f = await fixture(t, one); let completed
  f.dependencies.download = async request => { f.downloads.push(request); completed = await media(request); throw new BridgeError('native-result-unknown') }
  const first = await runSeries(f.options, f.dependencies, signal())
  assert.equal(first.status, 'partial'); assert.deepEqual(first.unknownEpisodeNumbers, [1]); assert.equal(f.downloads.length, 1)
  f.dependencies.reconcile = async request => { f.reconciliations.push(request); return { kind: 'verified', media: completed } }
  const second = await runSeries(f.options, f.dependencies, signal())
  assert.equal(second.status, 'complete'); assert.equal(f.downloads.length, 1)
  assert.equal(f.downloads[0].requestKey, f.reconciliations[0].requestKey)
})

test('a temporarily omitted unknown episode retains its original key until the catalog returns it', async t => {
  const selected = { ...selection, episodeCount: 2, actualEpisodeNumbers: [1, 2] }
  const f = await fixture(t, selected); let secondMedia
  f.dependencies.download = async request => {
    f.downloads.push(request)
    const completed = await media(request)
    if (request.episodeNo === 2) { secondMedia = completed; throw new BridgeError('native-result-unknown') }
    return completed
  }
  const first = await runSeries(f.options, f.dependencies, signal())
  assert.deepEqual(first.unknownEpisodeNumbers, [2]); assert.equal(f.downloads.length, 2)
  const original = f.downloads[1].requestKey
  const omitted = { ...f.options, selection: { ...selected, actualEpisodeNumbers: [1], catalogComplete: false } }
  const partial = await runSeries(omitted, f.dependencies, signal())
  assert.equal(partial.status, 'partial'); assert.deepEqual(partial.completedEpisodeNumbers, [1])
  assert.deepEqual(partial.missingEpisodeNumbers, [2]); assert.deepEqual(partial.unknownEpisodeNumbers, [])
  assert.deepEqual(partial.episodes.map(entry => entry.episodeNo), [1]); assert.deepEqual(f.reconciliations, [])
  const saved = JSON.parse(await readFile(partial.manifestPath, 'utf8'))
  assert.equal(saved.episodes.length, 2); assert.equal(saved.episodes[1].requestKey, original)
  assert.equal(saved.episodes[1].state, 'unknown'); assert.equal(saved.episodes[1].attempts, 1)
  const { selection: current, ...bounds } = omitted
  const stored = await readStoredSeriesStatus({ ...bounds, srcAppId: current.srcAppId, dramaId: current.dramaId })
  assert.equal(stored.status, 'partial'); assert.deepEqual(stored.missingEpisodeNumbers, [2])
  assert.deepEqual(stored.unknownEpisodeNumbers, []); assert.equal(f.downloads.length, 2)
  f.dependencies.reconcile = async request => { f.reconciliations.push(request); return { kind: 'verified', media: secondMedia } }
  const returned = await runSeries(f.options, f.dependencies, signal())
  assert.equal(returned.status, 'complete'); assert.deepEqual(returned.completedEpisodeNumbers, [1, 2])
  assert.equal(f.downloads.length, 2); assert.equal(f.reconciliations.length, 1)
  assert.equal(f.reconciliations[0].requestKey, original); assert.equal(f.reconciliations[0].attempt, 1)
})

test('a completed episode omitted from the latest catalog is preserved and reverified when it returns', async t => {
  const selected = { ...selection, episodeCount: 2, actualEpisodeNumbers: [1, 2] }
  const f = await fixture(t, selected), first = await runSeries(f.options, f.dependencies, signal())
  const completed = first.episodes[1].media, originalBytes = await readFile(completed.localPath), original = f.downloads[1].requestKey
  const omitted = { ...f.options, selection: { ...selected, actualEpisodeNumbers: [1], catalogComplete: false } }
  const partial = await runSeries(omitted, f.dependencies, signal())
  assert.equal(partial.status, 'partial'); assert.deepEqual(partial.completedEpisodeNumbers, [1])
  assert.deepEqual(partial.missingEpisodeNumbers, [2]); assert.deepEqual(partial.episodes.map(entry => entry.episodeNo), [1])
  const saved = JSON.parse(await readFile(partial.manifestPath, 'utf8'))
  assert.equal(saved.episodes[1].state, 'complete'); assert.equal(saved.episodes[1].requestKey, original)
  await writeFile(completed.localPath, Buffer.alloc(originalBytes.length, 120))
  const { selection: current, ...bounds } = omitted
  const stored = await readStoredSeriesStatus({ ...bounds, srcAppId: current.srcAppId, dramaId: current.dramaId })
  assert.equal(stored.status, 'partial'); assert.deepEqual(stored.completedEpisodeNumbers, [1])
  assert.deepEqual(stored.failedEpisodeNumbers, []); assert.deepEqual(stored.missingEpisodeNumbers, [2])
  const invalid = await readSeriesStatus(f.options)
  assert.equal(invalid.status, 'partial'); assert.deepEqual(invalid.failedEpisodeNumbers, [2])
  await writeFile(completed.localPath, originalBytes)
  const returned = await runSeries(f.options, f.dependencies, signal())
  assert.equal(returned.status, 'complete'); assert.deepEqual(returned.completedEpisodeNumbers, [1, 2])
  assert.equal(f.downloads.length, 2); assert.deepEqual(f.reconciliations, [])
  const restored = JSON.parse(await readFile(returned.manifestPath, 'utf8'))
  assert.equal(restored.episodes[1].requestKey, original); assert.equal(restored.episodes[1].attempts, 1)
})

test('unresolved original result blocks replay and later episodes until reconciliation is established', async t => {
  const f = await fixture(t)
  f.dependencies.download = async request => { f.downloads.push(request); throw new BridgeError('native-result-unknown') }
  await runSeries(f.options, f.dependencies, signal())
  const second = await runSeries(f.options, f.dependencies, signal())
  assert.deepEqual(second.unknownEpisodeNumbers, [1]); assert.equal(f.downloads.length, 1); assert.equal(f.reconciliations.length, 1)
})

test('cancellation awaits active cleanup, persists the unknown key and resumes only after original-key reconciliation', async t => {
  const f = await fixture(t, one), entered = Promise.withResolvers(), released = Promise.withResolvers(), controller = new AbortController()
  let settled = false
  f.dependencies.download = async request => {
    f.downloads.push(request); entered.resolve()
    await released.promise; settled = true; throw new BridgeError('cancelled')
  }
  const work = runSeries(f.options, f.dependencies, controller.signal)
  await entered.promise; controller.abort()
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(settled, false)
  released.resolve(); const first = await work
  assert.equal(first.status, 'cancelled'); assert.deepEqual(first.unknownEpisodeNumbers, [1])
  f.dependencies.reconcile = async request => { f.reconciliations.push(request); return { kind: 'retry' } }
  f.dependencies.download = async request => { f.downloads.push(request); return await media(request) }
  const second = await runSeries(f.options, f.dependencies, signal())
  assert.equal(second.status, 'complete'); assert.equal(f.downloads[0].requestKey, f.downloads[1].requestKey)
})

test('cleanup-unconfirmed remains an error even after cancellation and its original key remains unresolved', async t => {
  const f = await fixture(t, one), controller = new AbortController()
  f.dependencies.download = async () => { controller.abort(); throw new BridgeError('download-copy-cleanup-unconfirmed') }
  await assert.rejects(runSeries(f.options, f.dependencies, controller.signal), /download-copy-cleanup-unconfirmed/)
  const status = await readSeriesStatus(f.options)
  assert.deepEqual(status.unknownEpisodeNumbers, [1]); assert.equal(status.episodes[0].lastError, 'download-copy-cleanup-unconfirmed')
})

test('a process-interrupted downloading entry is reconciled before any retry', async t => {
  const f = await fixture(t, one)
  const first = await runSeries(f.options, f.dependencies, signal())
  const manifest = JSON.parse(await readFile(first.manifestPath, 'utf8')); manifest.episodes[0].state = 'downloading'; delete manifest.episodes[0].media
  await writeFile(first.manifestPath, JSON.stringify(manifest))
  const result = await runSeries(f.options, f.dependencies, signal())
  assert.equal(result.status, 'partial'); assert.equal(f.downloads.length, 1); assert.equal(f.reconciliations.length, 1)
})

test('modified or missing completed bytes are never counted complete and can resume from the same durable key', async t => {
  const f = await fixture(t, one)
  const first = await runSeries(f.options, f.dependencies, signal())
  await writeFile(first.episodes[0].media.localPath, 'changed local bytes')
  const status = await readSeriesStatus(f.options)
  assert.equal(status.status, 'partial'); assert.deepEqual(status.failedEpisodeNumbers, [1]); assert.deepEqual(status.completedEpisodeNumbers, [])
  const second = await runSeries(f.options, f.dependencies, signal())
  assert.equal(second.status, 'complete'); assert.equal(second.episodes[0].attempts, 2)
  assert.equal(f.downloads[0].requestKey, f.downloads[1].requestKey)
})

test('a second writer cannot enter a task while its native call is active', async t => {
  const f = await fixture(t, one), entered = Promise.withResolvers(), release = Promise.withResolvers()
  const original = f.dependencies.download
  f.dependencies.download = async request => { entered.resolve(); await release.promise; return await original(request) }
  const work = runSeries(f.options, f.dependencies, signal()); await entered.promise
  const active = await readSeriesStatus(f.options)
  assert.deepEqual(active.inProgressEpisodeNumbers, [1]); assert.deepEqual(active.unknownEpisodeNumbers, [])
  assert.equal(active.episodes[0].state, 'downloading')
  await assert.rejects(runSeries(f.options, f.dependencies, signal()), /timed out waiting for the writer lock/)
  release.resolve(); assert.equal((await work).status, 'complete'); assert.equal(f.downloads.length, 1)
})

test('status on an absent task does not create output and aborted admission does no file work', async t => {
  const f = await fixture(t, one)
  const status = await readSeriesStatus(f.options)
  assert.equal(status.status, 'partial'); assert.equal(status.episodes[0].state, 'pending'); assert.deepEqual(await readdir(f.root), [])
  const controller = new AbortController(); controller.abort()
  assert.equal((await runSeries(f.options, f.dependencies, controller.signal)).status, 'cancelled')
  assert.deepEqual(await readdir(f.root), []); assert.deepEqual(f.downloads, [])
})

test('symlinked task and episode parents cannot redirect status or native file publication', async t => {
  const f = await fixture(t, one), outside = join(f.root, 'outside'); await mkdir(outside)
  const status = await readSeriesStatus(f.options); await f.options.output.create()
  await symlink(outside, status.taskDirectory, 'dir')
  await assert.rejects(readSeriesStatus(f.options), /series-output-replaced/)
  await assert.rejects(runSeries(f.options, f.dependencies, signal()), /series-output-replaced/)
  await rm(status.taskDirectory); await mkdir(status.taskDirectory)
  await symlink(outside, join(status.taskDirectory, 'episodes'), 'dir')
  await assert.rejects(runSeries(f.options, f.dependencies, signal()), /series-output-replaced/)
  assert.deepEqual(await readdir(outside), []); assert.equal(f.downloads.length, 0)
})

test('directory replacement after native settlement never publishes completion or removes replacement files', async t => {
  const f = await fixture(t, one)
  f.dependencies.download = async request => {
    const completed = await media(request), task = await readSeriesStatus(f.options)
    await rename(task.taskDirectory, task.taskDirectory + '-saved'); await mkdir(task.taskDirectory)
    await writeFile(join(task.taskDirectory, 'unrelated.txt'), 'keep')
    await writeFile(join(task.taskDirectory, 'manifest.json.lock'), 'new task owns this')
    return completed
  }
  await assert.rejects(runSeries(f.options, f.dependencies, signal()), /series-output-replaced/)
  const status = await readSeriesStatus(f.options)
  assert.equal(await readFile(join(status.taskDirectory, 'unrelated.txt'), 'utf8'), 'keep')
  assert.equal(await readFile(join(status.taskDirectory, 'manifest.json.lock'), 'utf8'), 'new task owns this')
})

test('invalid persisted paths, duplicate entries and future schema cannot be replayed', async t => {
  const f = await fixture(t, one), first = await runSeries(f.options, f.dependencies, signal())
  const original = JSON.parse(await readFile(first.manifestPath, 'utf8'))
  for (const mutate of [value => { value.schemaVersion = 2 }, value => { value.episodes.push(value.episodes[0]) },
    value => { value.episodes[0].media.localPath = join(f.root, 'outside.mp4') }]) {
    const value = structuredClone(original); mutate(value); await writeFile(first.manifestPath, JSON.stringify(value))
    await assert.rejects(runSeries(f.options, f.dependencies, signal()), /series-manifest-invalid/)
  }
  assert.equal(f.downloads.length, 1)
})


test('coordination locks stay outside task output, and an exited owner can be recovered without replaying completed work', async t => {
  const f = await fixture(t, one), first = await runSeries(f.options, f.dependencies, signal())
  assert.deepEqual((await readdir(first.taskDirectory)).sort(), ['episodes', 'manifest.json'])
  const lockNames = await readdir(f.options.lockDirectory); assert.deepEqual(lockNames, [])
  const destination = createHash('sha256').update(f.options.output.path).digest('hex').slice(0, 24)
  await writeFile(join(f.options.lockDirectory, `${first.taskId}-${destination}.json.lock`), '2147483647\n')
  const recovered = await runSeries(f.options, f.dependencies, signal())
  assert.equal(recovered.status, 'complete'); assert.equal(f.downloads.length, 1); assert.deepEqual(await readdir(f.options.lockDirectory), [])
})

test('coordination rejects output-tree locks and symlinked private coordination parents before native work', async t => {
  const f = await fixture(t, one)
  await assert.rejects(runSeries({ ...f.options, lockDirectory: join(f.options.output.path, 'locks') }, f.dependencies, signal()), /series-options-invalid/)
  const outside = join(f.root, 'lock-outside'); await mkdir(outside)
  await symlink(outside, f.options.lockDirectory, 'dir')
  await assert.rejects(runSeries(f.options, f.dependencies, signal()), /series-lock-directory-unsafe/)
  assert.deepEqual(await readdir(outside), []); assert.equal(f.downloads.length, 0)
})


test('stored status uses its saved catalog without native calls or directory creation', async t => {
  const f = await fixture(t), completed = await runSeries(f.options, f.dependencies, signal())
  const { selection: selected, ...bounds } = f.options
  let creations = 0
  const output = { ...bounds.output, async create() { creations++; throw new Error('status must never create') } }
  const calls = f.downloads.length
  const status = await readStoredSeriesStatus({ ...bounds, output, srcAppId: selected.srcAppId, dramaId: selected.dramaId })
  assert.equal(status.status, 'complete'); assert.equal(status.episodeCount, 3); assert.equal(status.taskId, completed.taskId)
  assert.equal(f.downloads.length, calls); assert.deepEqual(f.reconciliations, []); assert.equal(creations, 0)
})

test('stored status for an absent task neither creates a directory nor guesses an episode count', async t => {
  const f = await fixture(t), { selection: selected, ...bounds } = f.options
  await assert.rejects(readStoredSeriesStatus({ ...bounds, srcAppId: selected.srcAppId, dramaId: selected.dramaId }), { code: 'series-task-not-found' })
  assert.deepEqual(await readdir(f.root), []); assert.deepEqual(f.downloads, [])
})

test('stored status rejects a forged saved selection and source identity before presenting progress', async t => {
  const f = await fixture(t), completed = await runSeries(f.options, f.dependencies, signal()), original = JSON.parse(await readFile(completed.manifestPath, 'utf8'))
  const { selection: selected, ...bounds } = f.options
  for (const mutate of [value => { value.selection.dramaId = 'another_source' }, value => { value.selection.episodeCount = -1 },
    value => { value.selection.actualEpisodeNumbers = [1, 1] }, value => { value.selection.actualEpisodeNumbers = ['1'] },
    value => { value.selection.catalogComplete = 'true' }, value => { value.selection.privateUrl = 'private-url-never-presented' }]) {
    const value = structuredClone(original); mutate(value); await writeFile(completed.manifestPath, JSON.stringify(value))
    await assert.rejects(readStoredSeriesStatus({ ...bounds, srcAppId: selected.srcAppId, dramaId: selected.dramaId }), { code: 'series-manifest-invalid' })
  }
  assert.equal(f.downloads.length, 3); assert.deepEqual(f.reconciliations, [])
})


test('a trusted home whose earlier OS ancestry has an alias still uses canonical private coordination', async t => {
  const f = await fixture(t, one), actual = join(f.root, 'physical'), home = join(actual, 'home'), alias = join(f.root, 'home-alias')
  await mkdir(home, { recursive: true }); await symlink(actual, alias, 'dir')
  const lockDirectory = join(alias, 'home', 'locks')
  const result = await runSeries({ ...f.options, lockDirectory }, f.dependencies, signal())
  assert.equal(result.status, 'complete'); assert.deepEqual(await readdir(join(home, 'locks')), [])
})
