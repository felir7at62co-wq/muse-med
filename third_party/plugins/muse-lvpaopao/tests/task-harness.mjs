/** Source-plane fixture: real Agents, Jobs and local native-file copies; no WeChat or network. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context, Service } from '@deepseek-ai/cordis'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MP4, digest } from '../../muse-douyin-download/tests/task-fixtures.js'
import * as Consumer from '../src/index.ts'
import { Config as ConnectionConfig } from '../src/config.ts'
import { resolveSeriesIdentity, resolveSeriesCatalog } from '../src/catalog.ts'
import { runSeries, readStoredSeriesStatus } from '../src/series.ts'
import { EpisodeDownloadRequestPort } from '../src/episode-download.ts'
import { localDownload } from '../src/download.ts'
import { BridgeError } from '../src/port.ts'
import { SeriesTasks } from '../src/tasks.ts'

export const SOURCE = { srcAppId: 'wx0000000000000001', dramaId: 'synthetic-series-001' }
export const TITLE = 'Synthetic background series'
export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export function aborted(signal) {
  if (signal.aborted) return Promise.resolve(signal.reason)
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(signal.reason), { once: true }))
}
export async function manifest(result) {
  const series = result.data?.series ?? result.series ?? result
  return JSON.parse(await readFile(series.manifestPath, 'utf8'))
}

export async function taskFixture(t, options = {}) {
  const directory = options.directory ?? await realpath(await mkdtemp(join(tmpdir(), 'lvpaopao-owned-tasks-')))
  const workspace = join(directory, 'workspace'), privateHome = join(directory, 'home')
  const taskDirectory = join(privateHome, 'lvpaopao', 'tasks', 'v1')
  const ctx = new Context(), handles = [], executors = [], releases = new Set(), calls = [], acquisitions = [], records = new Map()
  let configurations = 0, sequence = 0, agentSequence = 0, copies = 0
  const control = { offline: false, reconciliation: 'saved', cleanupUnconfirmed: false }
  const close = async () => {
    const failures = []
    const finish = async operation => { try { await operation() } catch (error) { failures.push(error) } }
    await Promise.all([...releases].map(release => finish(release)))
    await Promise.all(executors.map(executor => finish(() => executor.dispose())))
    await Promise.all(handles.map(handle => finish(() => handle.dispose())))
    await finish(() => ctx.fiber.dispose())
    if (options.keepDirectory !== true) await finish(() => rm(directory, { recursive: true, force: true }))
    if (failures.length) throw new AggregateError(failures, 'Series task fixture teardown failed')
  }
  t?.after(close)
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  await mkdir(privateHome, { recursive: true, mode: 0o700 })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(LocalJobs)
  await ctx.plugin(ToolJobs, { completionDelivery: 'quiet' })
  await mountAgentLoopTestHarness(ctx)
  const makeAgent = async (id = 'series-owner-' + ++agentSequence, cwd = workspace) => {
    const handle = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd } })
    handles.push(handle)
    return { agent: handle.agent, dispose: () => handle.dispose() }
  }
  const owner = await makeAgent(options.ownerId)
  const limits = { ...Consumer.Config({ maxEpisodeCount: 2, maxSeriesEpisodes: 20, maxAttempts: 2,
    retryDelayMs: 0, seriesLockWaitMs: 100, copyChunkBytes: 127 }), maxSeriesTasks: 100,
    maxTaskStateBytes: 1024 * 1024, taskLockWaitMs: 5000, maxSeriesJobOutputBytes: 65536,
    seriesTaskWaitMs: 30000, ...options.limits }
  const nativeDirectory = join(directory, 'native'), helperPath = join(nativeDirectory, 'helper.py')
  await mkdir(nativeDirectory, { recursive: true })
  const helperBytes = Buffer.from('# Offline native receipt fixture; never executed.\n')
  await writeFile(helperPath, helperBytes)
  const transport = ConnectionConfig({ transport: 'local', localPython: process.execPath,
    localHelper: helperPath, helperSha256: digest(helperBytes), cwd: directory, downloadEnabled: true,
    maxMediaBytes: 100000, copyTimeoutMs: 1000 })
  const episodeCount = options.episodeCount ?? 2
  const candidates = options.candidates ?? [{ title: TITLE, srcAppId: SOURCE.srcAppId, originDramaId: SOURCE.dramaId }]
  const bound = (params, status) => ({ operation: 'download_episode', status, identityMatched: true,
    srcAppId: params.srcAppId, dramaId: params.dramaId, episodeNo: params.episodeNo, idempotencyKey: params.idempotencyKey })
  const native = async (action, params, signal) => {
    signal.throwIfAborted()
    calls.push({ action, params: structuredClone(params) })
    if (options.beforeNative) await options.beforeNative({ action, params, signal, control })
    if (control.offline) throw new BridgeError('synthetic-native-offline')
    if (action === 'status') {
      if (control.cleanupUnconfirmed) throw new BridgeError('remote-cleanup-unconfirmed')
      return { operation: action, status: 'status-returned', identityMatched: true, ready: true, businessCalls: 0 }
    }
    if (action === 'search') return { operation: action, status: 'search-returned', identityMatched: true, resultCount: candidates.length, partial: false, candidates }
    if (action === 'detail') return { operation: action, status: 'detail-returned', identityMatched: true,
      srcAppId: params.srcAppId, dramaId: params.dramaId, title: TITLE, episodeCount }
    if (action === 'episodes') return { operation: action, status: 'episodes-returned', identityMatched: true,
      srcAppId: params.srcAppId, dramaId: params.dramaId, episodeCount, requestedStart: params.start,
      requestedEndExclusive: params.start + params.count, partial: false,
      episodeNumbers: Array.from({ length: params.count }, (_, index) => params.start + index) }
    assert.ok(action === 'download_episode' || action === 'download_status')
    const key = params.idempotencyKey
    if (action === 'download_status' && control.reconciliation === 'unknown') return bound(params, 'request-in-progress')
    const nativeReceipt = join(nativeDirectory, 'downloads', key, 'native-receipt.json')
    if (!records.has(key)) {
      try { records.set(key, JSON.parse(await readFile(nativeReceipt, 'utf8'))) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (action === 'download_status' && !records.has(key)) return bound(params, 'request-not-found')
    const fresh = !records.has(key)
    if (fresh) {
      assert.equal(action, 'download_episode', 'Metadata reconciliation cannot acquire media')
      const relativePath = `downloads/${key}/media/episode-${String(params.episodeNo).padStart(4, '0')}.mp4`
      const path = join(nativeDirectory, relativePath)
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, MP4)
      records.set(key, { relativePath, bytes: MP4.length, sha256: digest(MP4), durationSeconds: 1,
        width: 16, height: 16, hasAudio: false, fullDecodePassed: true })
      await writeFile(nativeReceipt, JSON.stringify(records.get(key)), { mode: 0o600 })
      acquisitions.push({ episodeNo: params.episodeNo, key, srcAppId: params.srcAppId, dramaId: params.dramaId })
    }
    if (options.afterAcquisition) await options.afterAcquisition({ action, params, signal, fresh, control })
    return { ...bound(params, 'download-returned'), serialNo: params.episodeNo, isStraight: true,
      playAuthorization: 'native-straight-playback', receiptReused: !fresh, businessCalls: fresh ? 2 : 0,
      title: TITLE, media: records.get(key) }
  }
  const bridge = { request: native, async dispose() { throw Error('A task must not dispose the shared native bridge') } }
  const subprocess = { spawn() { throw Error('Local fixture copy cannot spawn a process') } }
  const bounds = output => ({ output, lockDirectory: join(privateHome, 'lvpaopao', 'locks'), maxAttempts: limits.maxAttempts,
    retryDelayMs: limits.retryDelayMs, lockWaitMs: limits.seriesLockWaitMs, maxEpisodes: limits.maxSeriesEpisodes, maxMediaBytes: transport.maxMediaBytes })
  const copy = async (action, source, request, output, signal) => {
    const port = new EpisodeDownloadRequestPort(bridge, subprocess, transport, { output, directory: request.episodeDirectory,
      chunkBytes: limits.copyChunkBytes, maxMediaBytes: transport.maxMediaBytes, copyTimeoutMs: transport.copyTimeoutMs })
    copies++
    try { return await port.request(action, { ...source, episodeNo: request.episodeNo, idempotencyKey: request.requestKey }, signal) }
    finally { await port.dispose(); copies-- }
  }
  const dependencies = {
    directory: taskDirectory,
    resolveSource: (params, signal) => resolveSeriesIdentity(bridge, params, limits, signal),
    catalog: (params, signal) => resolveSeriesCatalog(bridge, params, limits, signal),
    async recover(signal) { await bridge.request('status', {}, signal) },
    async localStatus(params, output, signal) { return readStoredSeriesStatus({ ...bounds(output), ...params }, signal) },
    async run(selection, output, signal, beforeNative) {
      configurations++
      const source = { srcAppId: selection.srcAppId, dramaId: selection.dramaId }
      return runSeries({ ...bounds(output), selection }, {
        async download(request, active) {
          await beforeNative()
          const result = localDownload(await copy('download_episode', source, request, output, active))
          if (!result) throw new BridgeError('download-local-verification-failed')
          return result.media
        },
        async reconcile(request, active) {
          await beforeNative()
          const result = await copy('download_status', source, request, output, active), local = localDownload(result)
          if (local) return { kind: 'verified', media: local.media }
          return ['request-not-found', 'resume-available'].includes(result.status)
            ? { kind: 'retry' } : { kind: 'unknown', code: 'series-reconciliation-required' }
        },
        classify(error) {
          const code = error instanceof BridgeError ? error.code : 'fixture-failure'
          return { code, retry: ['transfer-failed', 'download-copy-timeout', 'download-copy-failed', 'download-local-hash-mismatch', 'download-source-changed'].includes(code)
            ? 'safe' : ['straight-playback-unconfirmed', 'playable-episode-unconfirmed'].includes(code) ? 'denied' : 'unknown' }
        },
      }, signal)
    },
  }
  const makeTasks = async extra => {
    const tasks = new SeriesTasks(ctx, limits, { ...dependencies, ...extra })
    executors.push(tasks); await tasks.ready(); return tasks
  }
  const tasks = await makeTasks()
  const download = (params = SOURCE, { mode = 'background', agent = owner.agent, signal = new AbortController().signal, outputDir } = {}) => tasks.download(params, mode, agent, signal, outputDir)
  const status = (accepted, agent = owner.agent) => tasks.status(typeof accepted === 'string' ? accepted : accepted.data.seriesTask.id, agent, new AbortController().signal)
  const resume = (accepted, agent = owner.agent, signal = new AbortController().signal) => tasks.resume(typeof accepted === 'string' ? accepted : accepted.data.seriesTask.id, agent, signal)
  const cancel = (accepted, agent = owner.agent) => tasks.cancel(typeof accepted === 'string' ? accepted : accepted.data.seriesTask.id, agent, new AbortController().signal)
  const settle = accepted => ctx.jobs.wait(accepted.data.seriesTask.jobId, 30000, owner.agent.id)
  const jobTool = (name, args, agent = owner.agent) => ctx.tools.execute({ name, arguments: args, callId: 'series-job-tool-' + ++sequence, signal: new AbortController().signal, agent })
  let mounted
  const mountTool = async () => {
    const previousHome = process.env.MUSE_HOME
    process.env.MUSE_HOME = privateHome
    t.after(() => { if (previousHome === undefined) delete process.env.MUSE_HOME; else process.env.MUSE_HOME = previousHome })
    class Bridge extends Service {
      constructor(scope) { super(scope, 'lvpaopaoBridge'); this.configuration = transport }
      async resolveConfiguration(signal) { signal.throwIfAborted(); configurations++; if (control.offline) throw new BridgeError('synthetic-native-offline'); return transport }
      request(action, params, signal) { return native(action, params, signal) }
    }
    class Subprocess extends Service {
      constructor(scope) { super(scope, 'subprocess') }
      spawn() { throw Error('Local fixture copy must not spawn a subprocess') }
    }
    await ctx.plugin(Bridge); await ctx.plugin(Subprocess)
    mounted = ctx.plugin(Consumer, limits); await mounted.await()
    return mounted
  }
  const invoke = (args, { agent = owner.agent, signal = new AbortController().signal } = {}) => ctx.agents.withInitiator(agent, async () => {
    const result = await ctx.tools.execute({ name: 'lvpaopao', arguments: args, callId: 'series-tool-' + ++sequence, agent, signal })
    if (result.isError) return { toolError: result }
    return JSON.parse(result.content[0].text)
  })
  return { directory, workspace, privateHome, taskDirectory, ctx, limits, owner, tasks, calls, acquisitions, records, control,
    dependencies, releases, makeTasks, makeAgent, download, status, resume, cancel, settle, jobTool, mountTool, invoke, close,
    get configurations() { return configurations }, get copies() { return copies } }
}
