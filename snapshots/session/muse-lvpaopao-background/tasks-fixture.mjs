/** A shipped Headless Session drives real Jobs, Bridge requests, original-key reconciliation, and byte copies. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { importSnapshotModule, importSnapshotPackage } from '../muse-fixture-import.mjs'
import { importLvpaopaoSnapshot } from '../muse-lvpaopao/plugin-import.mjs'
import { selected, title, seriesId, originalKeys, digest } from './subprocess-fixture.mjs'
import { MP4 } from '../../../third_party/plugins/muse-douyin-download/tests/task-fixtures.js'

const { SessionId } = await importSnapshotPackage('@deepseek-ai/dsh-session', new URL('../../../apps/cli/package.json', import.meta.url))
const { PiAiAdapter, resolveProfiles } = await importSnapshotModule(
  new URL('../../../packages/llm/llm-pi-ai/src/index.ts', import.meta.url),
  new URL('../../../packages/llm/llm-pi-ai/lib/index.js', import.meta.url),
)
const ownerId = SessionId('snapshot-lvpaopao-background')
const stamp = Date.parse('2026-11-04T15:00:00.000Z')
const provider = 'deepseek-official', model = 'deepseek-v4-flash'
const jsonResult = message => {
  const text = typeof message.content === 'string' ? message.content : message.content.find(block => block.type === 'text')?.text
  assert.equal(typeof text, 'string'); assert.ok(text.startsWith('{'), text)
  return JSON.parse(text)
}

/** Loader identity for the original-key background download scenario. */
export const name = 'snapshot-lvpaopao-background'
/** Native IO alone is synthetic; all authority and task ownership services are the shipped providers. */
export const inject = ['llm', 'tools', 'agents', 'jobs', 'sessions', 'sessionPersistence', 'sandboxPolicy', 'subprocess', 'lvpaopaoBridge']

/**
 * Mount only a local model endpoint and native IO around the real consumer.
 * @param {import('@deepseek-ai/cordis').Context} ctx - The isolated shipped-profile context.
 * @returns {Promise<void>} Completion after the persisted owner and real consumer are ready.
 */
export async function apply(ctx) {
  const native = ctx.subprocess
  let requestCount = 0, rejected, statusActive = false, statusNativeBefore = 0, statusConfigurationBefore = 0, configurations = 0
  const timeline = []
  const bridge = ctx.lvpaopaoBridge, originalResolve = bridge.resolveConfiguration
  bridge.resolveConfiguration = function (...args) {
    assert.equal(statusActive, false, 'Saved status cannot resolve native configuration')
    configurations++
    return originalResolve.apply(this, args)
  }
  ctx.effect(() => () => { bridge.resolveConfiguration = originalResolve })
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'lvpaopao' && exec.arguments.action === 'series_status') {
      assert.equal(statusActive, false); statusActive = true
      statusNativeBefore = native.methods.length; statusConfigurationBefore = configurations
    }
    return await next()
  })
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const decision = await next()
    if (exec.name === 'lvpaopao' && exec.arguments.action === 'series_status') {
      assert.equal(native.methods.length, statusNativeBefore); assert.equal(configurations, statusConfigurationBefore)
      statusActive = false
      timeline.push({ action: 'series_status', nativeRequests: 0, configurationResolutions: 0 })
    }
    return decision
  })
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk.toString('utf8') })
    request.once('end', () => {
      try {
        assert.equal(request.url, '/chat/completions')
        assert.equal(request.headers.authorization, 'Bearer snapshot-fake-key')
        const payload = JSON.parse(body)
        assert.equal(payload.model, model)
        requestCount++
        assert.ok(requestCount <= 7)
        const results = payload.messages.filter(message => message.role === 'tool')
        assert.equal(results.length, requestCount - 1)
        let call
        if (requestCount === 1) call = ['lvpaopao', { action: 'download_series', query: title, mode: 'background' }]
        if (requestCount === 2) {
          const accepted = jsonResult(results[0])
          assert.equal(accepted.status, 'series-queued'); assert.equal(accepted.ok, true)
          call = ['job_output', { job_id: accepted.data.seriesTask.jobId, wait: true, timeout_ms: 10000 }]
        }
        if (requestCount === 3) call = ['lvpaopao', { action: 'series_status', seriesTaskId: jsonResult(results[0]).data.seriesTask.id }]
        if (requestCount === 4) {
          const paused = jsonResult(results[2])
          assert.equal(paused.data.seriesTask.state, 'interrupted')
          assert.deepEqual(paused.data.series.unknownEpisodeNumbers, [1])
          assert.equal(native.acquisitions.size, 0)
          call = ['lvpaopao', { action: 'series_resume', seriesTaskId: paused.data.seriesTask.id }]
        }
        if (requestCount === 5) {
          const resumed = jsonResult(results[3])
          assert.equal(resumed.status, 'series-queued')
          assert.notEqual(resumed.data.seriesTask.jobId, jsonResult(results[0]).data.seriesTask.jobId)
          call = ['job_output', { job_id: resumed.data.seriesTask.jobId, wait: true, timeout_ms: 10000 }]
        }
        if (requestCount === 6) call = ['lvpaopao', { action: 'series_status', seriesTaskId: jsonResult(results[0]).data.seriesTask.id }]
        if (requestCount === 7) {
          const complete = jsonResult(results[5])
          assert.equal(complete.ok, true); assert.equal(complete.status, 'series-complete')
          assert.equal(complete.data.seriesTask.state, 'completed')
          assert.equal(complete.data.series.taskId, seriesId)
          assert.deepEqual(complete.data.series.completedEpisodeNumbers, [1, 2])
        }
        const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `lvpaopao-task-${requestCount}`, type: 'function',
          function: { name: call[0], arguments: JSON.stringify(call[1]) } }] }
          : { role: 'assistant', content: '合成本地全集后台任务已完成。首次原请求结果不明后暂停；显式恢复先检查连接并使用原键查询，确认未获取后才继续。两集文件与回执已逐一核验；状态查询没有原生请求或连接配置解析。此夹具不证明真实微信或绿泡泡媒体可用性。' }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end([
          { choices: [{ index: 0, delta, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n')
      } catch (error) {
        rejected = error; console.error(error)
        response.writeHead(500); response.end('{"error":{"message":"Local series task fixture mismatch"}}')
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  ctx.effect(() => async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const originalFetch = globalThis.fetch, originalNow = Date.now
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.origin === `http://127.0.0.1:${address.port}` && url.pathname === '/chat/completions') return originalFetch(input, options)
    throw new Error(`Series fixture refuses network request ${url.origin}${url.pathname}`)
  }
  Date.now = () => stamp
  ctx.effect(() => () => { globalThis.fetch = originalFetch; Date.now = originalNow })
  const prepared = ctx.sessions.prepare(ownerId, { meta: { cwd: process.cwd(), createdAt: stamp, delegationDepth: 0 } })
  const handle = await ctx.sessionPersistence.create(prepared.header)
  try { await handle.flush() }
  finally { await handle.close() }
  await ctx.plugin(await importLvpaopaoSnapshot('index'), { maxEpisodeCount: 2, retryDelayMs: 0, copyChunkBytes: 127 })
  const profiles = resolveProfiles({ [provider]: { api: 'openai-completions', baseURL: `http://127.0.0.1:${address.port}`,
    compat: { maxTokensField: 'max_tokens' }, models: [{ id: model, contextWindow: 1000000, maxTokens: 256000, reasoningEfforts: false }] } })
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: () => Promise.resolve('snapshot-fake-key'), auth: {
    credentials: { read: () => Promise.resolve(undefined), list: () => Promise.resolve([]),
      modify: () => { throw new Error('No credential writes') }, delete: () => { throw new Error('No credential deletion') } },
    authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) },
  } })
  ctx.effect(() => ctx.llm.registerAdapter([provider], adapter))
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (rejected) throw rejected
    assert.equal(agent.session.id, ownerId); assert.equal(requestCount, 7)
    assert.deepEqual(timeline, Array.from({ length: 2 }, () => ({ action: 'series_status', nativeRequests: 0, configurationResolutions: 0 })))
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    assert.equal(results.length, 6)
    for (const result of results) assert.equal(result.data.message.isError, false)
    const completed = jsonResult(results[5].data.message)
    assert.notEqual(completed.data.seriesTask.id, completed.data.series.taskId)
    const manifest = JSON.parse(await readFile(completed.data.series.manifestPath, 'utf8'))
    assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.taskId, seriesId)
    assert.deepEqual(manifest.selection, { ...selected, title, episodeCount: 2, actualEpisodeNumbers: [1, 2], catalogComplete: true })
    const files = []
    for (const entry of manifest.episodes) {
      assert.equal(entry.state, 'complete'); assert.equal(entry.requestKey, originalKeys[entry.episodeNo - 1])
      assert.equal(entry.attempts, entry.episodeNo === 1 ? 2 : 1)
      const bytes = await readFile(entry.media.localPath), receipt = JSON.parse(await readFile(entry.media.receiptPath, 'utf8'))
      assert.deepEqual(bytes, MP4); assert.equal(digest(bytes), entry.media.sha256)
      assert.equal(receipt.idempotencyKey, entry.requestKey); assert.equal(receipt.episodeNo, entry.episodeNo)
      assert.equal(native.acquisitions.get(entry.requestKey), entry.episodeNo)
      files.push({ episodeNo: entry.episodeNo, bytes: bytes.length, sha256: digest(bytes), attempts: entry.attempts, originalRequestKey: entry.requestKey })
    }
    assert.equal(native.launches, 2); assert.equal(native.acquisitions.size, 2)
    assert.deepEqual(native.methods, ['search', 'detail', 'episodes', 'download_episode', 'status', 'detail', 'episodes', 'download_status', 'download_episode', 'download_episode'])
    assert.deepEqual(native.requests.filter(request => request.method.startsWith('download')).map(request => [request.method, request.params.episodeNo, request.params.idempotencyKey]), [
      ['download_episode', 1, originalKeys[0]], ['download_status', 1, originalKeys[0]], ['download_episode', 1, originalKeys[0]], ['download_episode', 2, originalKeys[1]],
    ])
    assert.ok(ctx.jobs.list(ownerId).every(job => !['running', 'stopping'].includes(job.status)))
    native.proofPath = join(agent.session.header.cwd, 'bridge-proof.json')
    native.proof = { title, localHelperLaunches: native.launches, nativeMethods: native.methods, completedEpisodes: [1, 2],
      localFiles: files, savedStatus: timeline, unknownAcquisitions: 0, completedAcquisitions: 2,
      originalRequestKeysRetained: true, sharedBridgeDisposedByTask: false, realExternalCalls: 0 }
  })
  ctx.effect(() => ctx.provide('snapshotLvpaopaoTasksReady', true))
}
