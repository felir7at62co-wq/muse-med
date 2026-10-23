/** Offline real-Cordis integration with synthetic native receipts and actual local copies; no video service or decode runs. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { Context, Service } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import Tools, { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as consumer from '../src/index.ts'
import { Config as ConnectionConfig } from '../src/config.ts'
import { BridgeError } from '../src/port.ts'

const SOURCE = 'wx0000000000000001'
const DRAMA = 'synthetic-series-001'
const TITLE = 'Synthetic Series'
const source = { srcAppId: SOURCE, dramaId: DRAMA }
const bytesFor = episodeNo => Buffer.from(`SYNTHETIC EPISODE ${episodeNo}; not a playable video or real native decode.\n`.repeat(17))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lvpaopao-series-tool-')))
  const previousHome = process.env.MUSE_HOME
  process.env.MUSE_HOME = join(root, 'private-home')
  const ctx = new Context(), calls = [], acquisitions = [], records = new Map()
  const control = { offline: false, reconciliation: 'saved' }
  let resolutions = 0, bridgeDisposed = 0, subprocessCalls = 0
  const nativeDirectory = join(root, 'synthetic-native'), helperPath = join(nativeDirectory, 'helper.py')
  await mkdir(nativeDirectory)
  const helperBytes = Buffer.from('# Synthetic fixture source root; this helper is never executed.\n')
  await writeFile(helperPath, helperBytes)
  const transport = Object.freeze(ConnectionConfig({ transport: 'local', localPython: process.execPath,
    localHelper: helperPath, helperSha256: hash(helperBytes), cwd: root, downloadEnabled: true,
    outputDir: '/ignored-native-output', maxMediaBytes: 100000, copyTimeoutMs: 1000 }))
  t.after(async () => {
    try { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
    finally { if (previousHome === undefined) delete process.env.MUSE_HOME; else process.env.MUSE_HOME = previousHome }
  })
  await ctx.plugin(Agents); await ctx.plugin(Sessions); await ctx.plugin(Projections)
  await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: root })
  const episodeCount = options.episodeCount ?? 3
  const candidates = options.candidates ?? [{ title: TITLE, srcAppId: SOURCE, originDramaId: DRAMA }]
  function bound(params, status) {
    return { operation: 'download_episode', status, identityMatched: true, ...source,
      episodeNo: params.episodeNo, idempotencyKey: params.idempotencyKey }
  }
  async function native(action, params, signal) {
    signal.throwIfAborted()
    if (control.offline) throw new BridgeError('synthetic-native-offline')
    calls.push({ action, params: structuredClone(params) })
    if (action === 'search') return { operation: action, status: 'search-returned', identityMatched: true,
      resultCount: candidates.length, partial: false, candidates }
    if (action === 'detail') return { operation: action, status: 'detail-returned', identityMatched: true,
      ...source, title: TITLE, episodeCount }
    if (action === 'episodes') return { operation: action, status: 'episodes-returned', identityMatched: true,
      ...source, episodeCount, requestedStart: params.start, requestedEndExclusive: params.start + params.count,
      episodeNumbers: Array.from({ length: params.count }, (_, index) => params.start + index), partial: false }
    assert.ok(action === 'download_episode' || action === 'download_status')
    const key = params.idempotencyKey
    if (action === 'download_status' && control.reconciliation === 'unknown') return bound(params, 'request-in-progress')
    if (action === 'download_status' && !records.has(key)) return bound(params, 'request-not-found')
    const fresh = !records.has(key)
    if (fresh) {
      assert.equal(action, 'download_episode', 'Status reconciliation must not acquire media')
      const bytes = bytesFor(params.episodeNo)
      const relativePath = `downloads/${key}/media/episode-${String(params.episodeNo).padStart(4, '0')}.mp4`
      const path = join(nativeDirectory, relativePath)
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes)
      records.set(key, { bytes: bytes.length, sha256: hash(bytes), relativePath, durationSeconds: 1.25,
        width: 720, height: 1280, hasAudio: true, fullDecodePassed: true })
      acquisitions.push({ episodeNo: params.episodeNo, key })
    }
    if (options.afterAcquisition) await options.afterAcquisition({ action, params, fresh, control })
    return { ...bound(params, 'download-returned'), serialNo: params.episodeNo, isStraight: true,
      playAuthorization: 'native-straight-playback', title: TITLE, receiptReused: !fresh,
      businessCalls: fresh ? 2 : 0, media: records.get(key) }
  }
  class Bridge extends Service {
    constructor(scope) { super(scope, 'lvpaopaoBridge'); this.configuration = transport }
    async resolveConfiguration(signal) {
      signal.throwIfAborted(); resolutions++
      if (control.offline) throw new BridgeError('synthetic-native-offline')
      return transport
    }
    request(action, params, signal) { return native(action, params, signal) }
    async dispose() { bridgeDisposed++ }
  }
  class Subprocess extends Service {
    constructor(scope) { super(scope, 'subprocess') }
    spawn() { subprocessCalls++; throw Error('Local native-file copy must not spawn an external process') }
  }
  await ctx.plugin(Bridge); await ctx.plugin(Subprocess)
  async function mount() {
    const scope = ctx.isolate('tools').isolate('systemPrompt')
    await scope.plugin(SystemPrompt); await scope.plugin(Tools)
    const fiber = scope.plugin(consumer, consumer.Config({ maxEpisodeCount: 2, maxSeriesEpisodes: 20,
      maxAttempts: 2, retryDelayMs: 0, seriesLockWaitMs: 100, copyChunkBytes: 11 }))
    await fiber.await()
    return { scope, fiber }
  }
  let mounted = await mount(), sequence = 0
  async function session(name = 'workspace') {
    const cwd = join(root, name); await mkdir(cwd, { recursive: true })
    return ctx.sessions.create(undefined, { meta: { cwd } })
  }
  async function invoke(session, args = { action: 'download_series', query: TITLE }, signal = new AbortController().signal) {
    return ctx.agents.withInitiator({ session, ctx: mounted.scope }, async () => {
      const result = await mounted.scope.tools.execute({ callId: `synthetic-series-${++sequence}`, name: 'lvpaopao', arguments: args, signal })
      if (signal.aborted) {
        assert.equal(result.isError, true)
        assert.equal(result.error.info.code, TOOL_ABORTED)
        return { abortedToolResult: result }
      }
      assert.equal(result.isError, false)
      return JSON.parse(result.content[0].text)
    })
  }
  return { root, ctx, calls, acquisitions, records, control, session, invoke,
    get resolutions() { return resolutions }, get bridgeDisposed() { return bridgeDisposed }, get subprocessCalls() { return subprocessCalls },
    async remount() { await mounted.fiber.dispose(); mounted = await mount() } }
}

async function manifest(result) { return JSON.parse(await readFile(result.data.series.manifestPath, 'utf8')) }
async function assertFiles(result) {
  const saved = await manifest(result)
  assert.deepEqual(saved.episodes.map(item => item.state), saved.episodes.map(() => 'complete'))
  for (const item of saved.episodes) {
    const bytes = bytesFor(item.episodeNo)
    assert.deepEqual(await readFile(item.media.localPath), bytes)
    assert.equal(item.media.sha256, hash(bytes))
    const receipt = JSON.parse(await readFile(item.media.receiptPath, 'utf8'))
    assert.equal(receipt.idempotencyKey, item.requestKey)
    assert.equal(receipt.episodeNo, item.episodeNo)
    assert.equal(receipt.media.localPath, item.media.localPath)
  }
  return saved
}

test('real Agent tool resolves a title, copies all actual episodes and resumes after scope replacement without acquisition', async t => {
  const f = await fixture(t), session = await f.session()
  const first = await f.invoke(session)
  assert.equal(first.ok, true); assert.equal(first.status, 'series-complete')
  assert.deepEqual(first.data.series.completedEpisodeNumbers, [1, 2, 3])
  assert.deepEqual(first.data.series.missingEpisodeNumbers, [])
  assert.ok(first.data.series.taskDirectory.startsWith(join(session.header.cwd, 'downloads', 'lvpaopao') + sep))
  const saved = await assertFiles(first)
  assert.equal(f.acquisitions.length, 3); assert.equal(f.subprocessCalls, 0)
  await f.remount()
  const restartedSession = await f.session()
  const before = f.calls.length, second = await f.invoke(restartedSession)
  assert.equal(second.status, 'series-complete'); assert.equal(second.data.series.taskId, first.data.series.taskId)
  assert.equal(f.acquisitions.length, 3)
  assert.deepEqual(f.calls.slice(before).map(call => call.action), ['search', 'detail', 'episodes', 'episodes'])
  assert.deepEqual((await manifest(second)).episodes.map(item => item.requestKey), saved.episodes.map(item => item.requestKey))
  assert.equal(f.bridgeDisposed, 0)
})

test('series_status uses the saved catalog and local verification without native or configuration access', async t => {
  const f = await fixture(t, { episodeCount: 2 }), session = await f.session()
  const complete = await f.invoke(session)
  assert.equal(complete.ok, true)
  const before = f.calls.length, resolutions = f.resolutions
  f.control.offline = true; setSandboxMode(session, 'read-only')
  const status = await f.invoke(session, { action: 'series_status', ...source })
  assert.equal(status.ok, true); assert.equal(status.status, 'series-complete')
  assert.deepEqual(status.data.series.completedEpisodeNumbers, [1, 2])
  assert.equal(f.calls.length, before); assert.equal(f.resolutions, resolutions)
})

test('ambiguous exact title returns candidates without acquisition, configuration or output creation', async t => {
  const candidates = [{ title: TITLE, srcAppId: SOURCE, originDramaId: DRAMA },
    { title: TITLE, srcAppId: 'wx0000000000000002', originDramaId: 'synthetic-other-series' }]
  const f = await fixture(t, { candidates }), session = await f.session()
  const result = await f.invoke(session)
  assert.equal(result.status, 'selection-required'); assert.equal(result.ok, false)
  assert.deepEqual(result.data.candidates, candidates)
  assert.deepEqual(f.calls.map(call => call.action), ['search']); assert.equal(f.acquisitions.length, 0)
  assert.equal(f.resolutions, 0); assert.deepEqual(await readdir(session.header.cwd), [])
})

test('current Session permission denial prevents even the first native catalog call', async t => {
  const f = await fixture(t), session = await f.session()
  setSandboxMode(session, 'read-only')
  assert.equal((await f.invoke(session)).status, 'download-access-denied')
  setSandboxMode(session, 'workspace-write')
  assert.equal((await f.invoke(session, { action: 'download_series', query: TITLE, outputDir: join(f.root, 'external') })).status, 'download-access-denied')
  assert.equal((await f.invoke(session, { action: 'download_series', query: TITLE, outputDir: '../escape' })).status, 'download-output-outside-workspace')
  assert.deepEqual(f.calls, []); assert.deepEqual(f.acquisitions, []); assert.equal(f.resolutions, 0)
  assert.deepEqual(await readdir(session.header.cwd), [])
})

test('cancellation settles an acquired episode and resume reconciles its original durable key', async t => {
  const controller = new AbortController()
  const f = await fixture(t, { async afterAcquisition({ action, params, fresh }) {
    if (action === 'download_episode' && params.episodeNo === 2 && fresh) controller.abort(Error('Synthetic caller cancelled after acquisition'))
  } }), session = await f.session()
  const cancelled = await f.invoke(session, undefined, controller.signal)
  assert.equal(cancelled.abortedToolResult.error.info.code, TOOL_ABORTED)
  const beforeStatus = f.calls.length
  const durable = await f.invoke(session, { action: 'series_status', ...source })
  assert.equal(durable.status, 'series-partial')
  assert.deepEqual(durable.data.series.completedEpisodeNumbers, [1])
  assert.deepEqual(durable.data.series.unknownEpisodeNumbers, [2])
  assert.deepEqual(durable.data.series.pendingEpisodeNumbers, [3])
  assert.equal(f.calls.length, beforeStatus)
  const previous = await manifest(durable), oldKey = previous.episodes.find(item => item.episodeNo === 2).requestKey
  const resumed = await f.invoke(session)
  assert.equal(resumed.status, 'series-complete'); await assertFiles(resumed)
  assert.equal(f.acquisitions.length, 3)
  const secondEpisodeCalls = f.calls.filter(call => call.params.episodeNo === 2)
  assert.deepEqual(secondEpisodeCalls.map(call => call.action), ['download_episode', 'download_status'])
  assert.deepEqual(secondEpisodeCalls.map(call => call.params.idempotencyKey), [oldKey, oldKey])
})

test('unknown native outcome is reconciled by original key and cannot silently start another acquisition', async t => {
  const f = await fixture(t, { episodeCount: 2, async afterAcquisition({ action, params, fresh }) {
    if (action === 'download_episode' && params.episodeNo === 1 && fresh) throw new BridgeError('transport-error')
  } }), session = await f.session()
  const first = await f.invoke(session)
  assert.equal(first.status, 'series-partial'); assert.deepEqual(first.data.series.unknownEpisodeNumbers, [1])
  const initial = await manifest(first), oldKey = initial.episodes[0].requestKey
  f.control.reconciliation = 'unknown'
  const stillUnknown = await f.invoke(session)
  assert.equal(stillUnknown.status, 'series-partial'); assert.deepEqual(stillUnknown.data.series.unknownEpisodeNumbers, [1])
  assert.equal(f.acquisitions.length, 1)
  assert.deepEqual(f.calls.filter(call => call.action.startsWith('download')).map(call => [call.action, call.params.idempotencyKey]),
    [['download_episode', oldKey], ['download_status', oldKey]])
  f.control.reconciliation = 'saved'
  const recovered = await f.invoke(session)
  assert.equal(recovered.status, 'series-complete'); await assertFiles(recovered)
  assert.equal(f.acquisitions.length, 2)
  assert.equal((await manifest(recovered)).episodes[0].requestKey, oldKey)
})

test('a classified transfer failure retries the same native key and reuses its saved receipt', async t => {
  const f = await fixture(t, { episodeCount: 2, async afterAcquisition({ action, params, fresh }) {
    if (action === 'download_episode' && params.episodeNo === 1 && fresh) throw new BridgeError('transfer-failed')
  } }), session = await f.session()
  const result = await f.invoke(session)
  assert.equal(result.status, 'series-complete'); const saved = await assertFiles(result)
  assert.equal(f.acquisitions.length, 2)
  const firstEpisodeCalls = f.calls.filter(call => call.params.episodeNo === 1)
  assert.equal(firstEpisodeCalls.length, 2)
  assert.equal(firstEpisodeCalls[0].params.idempotencyKey, firstEpisodeCalls[1].params.idempotencyKey)
  assert.equal(saved.episodes[0].attempts, 2)
})

test('local first-episode compatibility uses the episode lane and reuses its durable key without SCP or another acquisition', async t => {
  const f = await fixture(t), session = await f.session()
  const args = { action: 'download_first_episode', ...source }
  const first = await f.invoke(session, args)
  assert.equal(first.action, 'download_first_episode'); assert.equal(first.ok, true)
  assert.equal(first.status, 'download-returned'); assert.equal(first.data.serialNo, 1)
  assert.equal(Object.hasOwn(first.data, 'isFirstMediaFree'), false)
  assert.deepEqual(await readFile(first.data.media.localPath), bytesFor(1))
  assert.equal(first.data.media.sha256, hash(bytesFor(1)))
  assert.deepEqual(f.calls.map(call => call.action), ['download_status', 'download_episode'])
  assert.equal(f.acquisitions.length, 1); assert.equal(f.subprocessCalls, 0)
  const originalKey = f.calls[0].params.idempotencyKey
  assert.match(originalKey, /^[a-f0-9]{64}$/)
  assert.equal(f.calls[1].params.idempotencyKey, originalKey)
  const receipt = JSON.parse(await readFile(first.data.media.receiptPath, 'utf8'))
  assert.equal(receipt.idempotencyKey, originalKey); assert.equal(receipt.episodeNo, 1)
  await f.remount()
  const second = await f.invoke(await f.session(), args)
  assert.equal(second.ok, true); assert.equal(second.data.receiptReused, true)
  assert.equal(second.data.media.localPath, first.data.media.localPath)
  assert.deepEqual(f.calls.map(call => call.action), ['download_status', 'download_episode', 'download_status'])
  assert.equal(f.calls[2].params.idempotencyKey, originalKey)
  assert.equal(f.acquisitions.length, 1); assert.equal(f.subprocessCalls, 0)
})
