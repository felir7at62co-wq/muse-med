/** Real owned jobs pause and resume a selected-video batch using local, fully decodable media fixtures. */
import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { importSnapshotModule, importSnapshotPackage } from '../muse-fixture-import.mjs'
import * as douyin from '../../../third_party/plugins/muse-douyin-download/src/index.js'
import { MP4, VIDEO_ONE, VIDEO_TWO, videoURL, mediaReceipt, digest } from '../../../third_party/plugins/muse-douyin-download/tests/task-fixtures.js'

const { Service } = await importSnapshotPackage('@deepseek-ai/cordis', new URL('../../../apps/cli/package.json', import.meta.url))
const { SessionId } = await importSnapshotPackage('@deepseek-ai/dsh-session', new URL('../../../apps/cli/package.json', import.meta.url))
const { PiAiAdapter, resolveProfiles } = await importSnapshotModule(
  new URL('../../../packages/llm/llm-pi-ai/src/index.ts', import.meta.url),
  new URL('../../../packages/llm/llm-pi-ai/lib/index.js', import.meta.url),
)
const ownerId = SessionId('snapshot-douyin-background')
const stamp = Date.parse('2026-11-04T15:00:00.000Z')
const provider = 'deepseek-official'
const model = 'deepseek-v4-flash'
const urls = [videoURL(VIDEO_ONE), videoURL(VIDEO_TWO)]
const jsonResult = message => {
  const text = typeof message.content === 'string' ? message.content : message.content.find(block => block.type === 'text')?.text
  assert.equal(typeof text, 'string')
  assert.ok(text.startsWith('{'), text)
  return JSON.parse(text)
}

/** Loader identity for task-owned download recovery. */
export const name = 'snapshot-douyin-background'
/** The shipped registry, controllers, Session persistence, and policy remain real. */
export const inject = ['llm', 'tools', 'agents', 'jobs', 'sessions', 'sessionPersistence', 'sandboxPolicy']

/**
 * Mount exact local transports around the real download tools and owned jobs.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated shipped-profile context.
 * @returns {Promise<void>} Completion after the persisted owner and transports are ready.
 */
export async function apply(ctx) {
  const publicCalls = []
  const nativeCalls = []
  let resumed = false
  let requestCount = 0
  let rejected

  class PublicTransport extends Service {
    constructor(scope) { super(scope, 'subprocess') }
    spawn(spec) {
      spec.signal?.throwIfAborted()
      const index = spec.argv.indexOf('--url')
      const url = spec.argv[index + 1]
      assert.ok(spec.argv.some(value => basename(value) === 'download.py'))
      assert.ok(spec.argv.includes('--public-only'))
      assert.ok(urls.includes(url))
      assert.equal(spec.cwd, process.cwd())
      publicCalls.push(url)
      let text
      const done = (async () => {
        const result = url === urls[1] && !resumed
          ? { status: 'blocked', message: 'LOGIN_OR_VERIFICATION_REQUIRED' }
          : await mediaReceipt({ session: { header: { cwd: spec.cwd } } }, url)
        text = JSON.stringify(result)
        return { exitCode: result.status === 'downloaded' ? 0 : 1, signal: null }
      })()
      return { done, waitForExit: async () => { await done }, collected: {
        stdout: { readFrom: () => ({ text, lossy: false, truncated: false }) },
      } }
    }
  }
  class BrowserTransport extends Service {
    version = 4
    supportsBackgroundDownload = true
    constructor(scope) { super(scope, 'douyinBrowser') }
    async download(agent, url, signal, maxBytes, nativeTimeoutMs, options) {
      signal.throwIfAborted()
      assert.equal(agent, ctx.agents.get(ownerId))
      assert.equal(url, urls[1])
      assert.equal(maxBytes, 512 * 1024 ** 2)
      assert.equal(nativeTimeoutMs, 1800000)
      assert.equal(options?.background, true)
      nativeCalls.push(url)
      return { status: 'blocked', code: 'LOGIN_OR_VERIFICATION_REQUIRED' }
    }
  }
  await ctx.plugin(PublicTransport)
  await ctx.plugin(BrowserTransport)
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
        if (requestCount === 1) call = ['douyin_download', { urls, mode: 'background' }]
        if (requestCount === 2) {
          const accepted = jsonResult(results[0])
          assert.equal(accepted.status, 'queued')
          call = ['job_output', { job_id: accepted.downloadTask.jobId, wait: true, timeout_ms: 10000 }]
        }
        if (requestCount === 3) call = ['douyin_download_task', { action: 'status', taskId: jsonResult(results[0]).downloadTask.id }]
        if (requestCount === 4) {
          const paused = jsonResult(results[2])
          assert.equal(paused.downloadTask.state, 'waiting_user')
          assert.equal(paused.task.items.filter(item => item.state === 'completed').length, 1)
          resumed = true
          call = ['douyin_download_task', { action: 'resume', taskId: paused.downloadTask.id }]
        }
        if (requestCount === 5) {
          const accepted = jsonResult(results[3])
          assert.equal(accepted.status, 'queued')
          assert.notEqual(accepted.downloadTask.jobId, jsonResult(results[0]).downloadTask.jobId)
          call = ['job_output', { job_id: accepted.downloadTask.jobId, wait: true, timeout_ms: 10000 }]
        }
        if (requestCount === 6) call = ['douyin_download_task', { action: 'status', taskId: jsonResult(results[0]).downloadTask.id }]
        if (requestCount === 7) {
          const completed = jsonResult(results[5])
          assert.equal(completed.downloadTask.state, 'completed')
          assert.equal(completed.task.items.filter(item => item.state === 'completed').length, 2)
        }
        const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `douyin-task-${requestCount}`, type: 'function',
          function: { name: call[0], arguments: JSON.stringify(call[1]) } }] }
          : { role: 'assistant', content: '本地合成下载任务已完成：后台接收后遇到验证要求而暂停，显式恢复使用新 job，已验证的第一条未重新获取。此夹具不证明真实抖音媒体可用性。' }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end([
          { choices: [{ index: 0, delta, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n')
      } catch (error) {
        rejected = error
        console.error(error)
        response.writeHead(500)
        response.end('{"error":{"message":"Local download task fixture mismatch"}}')
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
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.origin === `http://127.0.0.1:${address.port}` && url.pathname === '/chat/completions') return originalFetch(input, options)
    throw new Error(`Download task fixture refuses network request ${url.origin}${url.pathname}`)
  }
  Date.now = () => stamp
  ctx.effect(() => () => { globalThis.fetch = originalFetch; Date.now = originalNow })
  const prepared = ctx.sessions.prepare(ownerId, { meta: { cwd: process.cwd(), createdAt: stamp, delegationDepth: 0 } })
  const handle = await ctx.sessionPersistence.create(prepared.header)
  try { await handle.flush() }
  finally { await handle.close() }
  await ctx.plugin(douyin, { pythonExecutable: process.execPath, ffprobeExecutable: process.execPath,
    ffmpegExecutable: process.execPath, settingsHome: process.env.DSH_HOME })
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
    assert.equal(agent.session.id, ownerId)
    assert.equal(requestCount, 7)
    assert.deepEqual(publicCalls, [urls[0], urls[1], urls[1]])
    assert.deepEqual(nativeCalls, [urls[1]])
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    assert.equal(results.length, 6)
    for (const result of results) assert.equal(result.data.message.isError, false)
    const completed = jsonResult(results[5].data.message)
    for (const item of completed.task.items) {
      assert.equal(item.state, 'completed')
      const bytes = await readFile(item.result.path)
      assert.deepEqual(bytes, MP4)
      assert.equal(digest(bytes), item.result.sha256)
      const receipt = JSON.parse(await readFile(item.result.receipt, 'utf8'))
      assert.equal(receipt.source, item.result.source)
      assert.equal(receipt.full_decode_verified, true)
    }
    assert.ok(ctx.jobs.list(ownerId).every(job => !['running', 'stopping'].includes(job.status)))
  })
  ctx.effect(() => ctx.provide('snapshotDouyinTasksReady', true))
}
