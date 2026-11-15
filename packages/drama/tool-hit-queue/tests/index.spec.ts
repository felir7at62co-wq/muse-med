import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import CredentialProvider, { type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import * as plugin from '../src/index.ts'
import type { Fetch } from '../src/station.ts'

const BASE = 'http://station.test/api/service/hits'
const ORIGIN = 'https://muse.tos-cn-beijing.volces.com'
const MANIFEST_URL = `${ORIGIN}/download-video-date/hongguo/20261115/7470000000000000001/manifest-1.json`

function config(overrides: Partial<plugin.Config> = {}): plugin.Config {
  return {
    tokenRef: 'MUSE_DATA_SERVICE_TOKEN',
    baseUrl: BASE,
    manifestOrigin: ORIGIN,
    requestTimeoutMs: 5_000,
    maxResponseBytes: 64 * 1024,
    maxScriptBytes: 1_000,
    ...overrides,
  }
}

class MapCredentials extends CredentialProvider {
  constructor(ctx: Context, private readonly values: Readonly<Record<string, string>>) { super(ctx) }
  resolve(ref: string): Promise<ResolvedCredential | undefined> {
    const value = this.values[ref]
    return Promise.resolve(value === undefined ? undefined : { value, source: 'store' })
  }
  describe() { return Promise.resolve({ configured: false, writable: false }) }
  set() { return Promise.resolve() }
  unset() { return Promise.resolve() }
  readRecord() { return Promise.resolve(undefined) }
  describeRecord() { return Promise.resolve({ configured: false, writable: false }) }
  listRecords() { return Promise.resolve([]) }
  modifyRecord() { return Promise.resolve(undefined) }
  deleteRecord() { return Promise.resolve() }
}

/** Fake station and object store: records every request and answers by URL. */
function fakeNetwork() {
  const calls: { url: string; init: RequestInit }[] = []
  const manifest = {
    version: 1, platform: 'hongguo', work_id: '7470000000000000001', bucket: 'muse', date: '20261115',
    directory: 'download-video-date/hongguo/20261115/7470000000000000001/',
    objects: [{ kind: 'video', key: 'download-video-date/hongguo/20261115/7470000000000000001/video/001.mp4', bytes: 7, sha256: 's', status: 'uploaded' }],
  }
  const fetch: Fetch = (url, init) => {
    calls.push({ url, init })
    const body = url === MANIFEST_URL ? manifest : { echo: url.slice(BASE.length), method: init.method }
    return Promise.resolve(new Response(JSON.stringify(body)))
  }
  return { fetch, calls }
}

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'hit-queue-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function bench(options: { credentials?: Record<string, string> | undefined; fetch?: Fetch; config?: plugin.Config } = {}) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const values = options.credentials ?? { MUSE_DATA_SERVICE_TOKEN: 'secret-token' }
  if (options.credentials !== undefined || !('credentials' in options)) {
    await ctx.plugin(class extends MapCredentials { constructor(inner: Context) { super(inner, values) } })
  }
  const network = options.fetch ?? fakeNetwork().fetch
  const fiber = await ctx.plugin({ name: plugin.name, inject: plugin.inject,
    apply: (inner: Context) => { plugin.apply(inner, options.config ?? config(), { fetch: network }) } })
  const call = (args: unknown, session?: string) => executeToolFixture(ctx, {
    name: 'drama_hit_queue', arguments: args, callId: ToolCallId('hit-call'), signal: new AbortController().signal,
    ...(session === undefined ? {} : { agent: { session: { id: session } } as never }),
  })
  return { ctx, call, fiber }
}

function errorText(result: { isError: boolean; error?: unknown }): string {
  expect(result.isError).toBe(true)
  return JSON.stringify(result.error)
}

describe('drama_hit_queue', () => {
  it('registers the model-facing description and removes the tool when its fiber is disposed', async () => {
    const { ctx, fiber } = await bench()
    const definition = ctx.tools.get('drama_hit_queue')
    expect(definition?.description).toBe('数据站爆款转写任务队列。claim 领取一部待转写的红果剧（不填 work_id 取队首），返回任务和租约 lease；'
      + '之后每一步都带上 work_id 和 lease。progress 上报阶段和第几集，也作心跳，至少每 30 分钟一次；'
      + 'videos 用 drama_tos_upload 返回的 manifest.url 登记原片；publish 上传通过程序检查的剧本并发布；'
      + 'fail 报告失败，检查重写后仍不过时设 needs_attention。status 查询任务。')
    expect(definition?.presentCall?.({ action: 'status' })).toEqual({ card: 'generic', title: 'Hit queue: status', kind: 'read' })
    expect(definition?.presentCall?.({ action: 'claim' })).toEqual({ card: 'generic', title: 'Hit queue: claim', kind: 'other' })
    await fiber.dispose()
    expect(ctx.tools.get('drama_hit_queue')).toBeUndefined()
  })

  it('claims as the calling session, optionally a named work', async () => {
    const network = fakeNetwork()
    const { call } = await bench({ fetch: network.fetch })
    expect((await call({ action: 'claim' }, 'session-1')).value).toEqual({ action: 'claim', result: { echo: '/claim', method: 'POST' } })
    await call({ action: 'claim', work_id: 'hongguo:7470000000000000001' }, 'session-1')
    expect(network.calls.map(entry => entry.init.body)).toEqual([
      '{"workerId":"muse-worker-session-1"}',
      '{"workerId":"muse-worker-session-1","workId":"7470000000000000001"}',
    ])
    expect(network.calls[0]?.init.headers).toMatchObject({ 'X-Muse-Data-Service-Token': 'secret-token' })
    expect(errorText(await call({ action: 'claim' }))).toContain('claim 只能在会话中调用')
    expect(errorText(await call({ action: 'claim', work_id: 'abc' }, 'session-1'))).toContain('work_id 必须是红果 series_id')
  })

  it('reads status and reports progress or a heartbeat', async () => {
    const network = fakeNetwork()
    const { call } = await bench({ fetch: network.fetch })
    await call({ action: 'status', work_id: 'hongguo:7470000000000000001' })
    await call({ action: 'progress', work_id: '7470000000000000001', lease: 'L', state: 'transcribing', episode: 3, total_episodes: 65, message: '第3集' })
    await call({ action: 'progress', work_id: '7470000000000000001', lease: 'L' })
    expect(network.calls.map(entry => [entry.url.slice(BASE.length), entry.init.method, entry.init.body])).toEqual([
      ['/jobs/hongguo%3A7470000000000000001', 'GET', undefined],
      ['/jobs/7470000000000000001/progress', 'POST', '{"lease":"L","state":"transcribing","episode":3,"totalEpisodes":65,"message":"第3集"}'],
      ['/jobs/7470000000000000001/progress', 'POST', '{"lease":"L"}'],
    ])
    expect(errorText(await call({ action: 'status' }))).toContain('status 需要 work_id')
    expect(errorText(await call({ action: 'progress', work_id: '7470000000000000001' }))).toContain('progress 需要 lease')
  })

  it('registers stored videos from the upload manifest of the same work', async () => {
    const network = fakeNetwork()
    const { call } = await bench({ fetch: network.fetch })
    const result = await call({ action: 'videos', work_id: '7470000000000000001', lease: 'L', manifest_url: MANIFEST_URL })
    expect(result.isError).toBe(false)
    const put = network.calls[1]
    expect(put?.url).toBe(`${BASE}/jobs/7470000000000000001/videos`)
    expect(JSON.parse(put?.init.body as string)).toEqual({ lease: 'L', upload: {
      bucket: 'muse', date: '20261115', directory: 'download-video-date/hongguo/20261115/7470000000000000001/',
      objects: [{ kind: 'video', key: 'download-video-date/hongguo/20261115/7470000000000000001/video/001.mp4', bytes: 7, sha256: 's', status: 'uploaded' }],
      manifest: { key: 'download-video-date/hongguo/20261115/7470000000000000001/manifest-1.json' },
    } })
    expect(errorText(await call({ action: 'videos', work_id: '1', lease: 'L', manifest_url: MANIFEST_URL }))).toContain('与 work_id 不一致')
  })

  it('publishes a checked screenplay as multipart', async () => {
    const network = fakeNetwork()
    const { call } = await bench({ fetch: network.fetch })
    const script = join(root, '剧本.docx')
    await writeFile(script, 'docx-bytes')
    await call({ action: 'publish', work_id: '7470000000000000001', lease: 'L', script_path: script, checks_passed: true, checks_summary: '65/65 集通过' })
    await call({ action: 'publish', work_id: '7470000000000000001', lease: 'L', script_path: script, checks_passed: true })
    const form = network.calls[0]?.init.body
    expect(form).toBeInstanceOf(FormData)
    const file = (form as FormData).get('file')
    expect(file).toBeInstanceOf(File)
    expect([(file as File).name, (file as File).type, await (file as File).text()]).toEqual(['剧本.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx-bytes'])
    expect([(form as FormData).get('lease'), (form as FormData).get('checks')]).toEqual(['L', '{"passed":true,"summary":"65/65 集通过"}'])
    expect((network.calls[1]?.init.body as FormData).get('checks')).toBe('{"passed":true,"summary":""}')
  })

  it('rejects unusable screenplay files before contacting the station', async () => {
    const network = fakeNetwork()
    const { call } = await bench({ fetch: network.fetch })
    const big = join(root, 'big.md')
    await writeFile(big, 'x'.repeat(1_001))
    const folder = join(root, 'folder.md')
    await mkdir(folder)
    const base = { action: 'publish', work_id: '7470000000000000001', lease: 'L', checks_passed: true }
    expect(errorText(await call({ ...base, script_path: 'relative.md' }))).toContain('绝对路径')
    expect(errorText(await call({ ...base, script_path: join(root, 'a.zip') }))).toContain('绝对路径')
    expect(errorText(await call({ ...base, script_path: folder }))).toContain('普通文件')
    expect(errorText(await call({ ...base, script_path: big }))).toContain('HIT_QUEUE_LIMIT')
    const ok = join(root, 'ok.md')
    await writeFile(ok, 'x')
    expect(errorText(await call({ action: 'publish', work_id: '7470000000000000001', lease: 'L', script_path: ok }))).toContain('publish 需要 checks_passed')
    expect(network.calls).toEqual([])
  })

  it('reports failure with optional routing flags', async () => {
    const network = fakeNetwork()
    const { call } = await bench({ fetch: network.fetch })
    await call({ action: 'fail', work_id: '7470000000000000001', lease: 'L', reason: '检查两次未通过', stage: 'checking', retryable: false, needs_attention: true })
    await call({ action: 'fail', work_id: '7470000000000000001', lease: 'L', reason: '下载失败' })
    expect(network.calls.map(entry => entry.init.body)).toEqual([
      '{"lease":"L","reason":"检查两次未通过","stage":"checking","retryable":false,"needsAttention":true}',
      '{"lease":"L","reason":"下载失败"}',
    ])
  })

  it.each([
    ['no credential service', undefined],
    ['no token', {}],
  ])('reports an unconfigured deployment with %s', async (_label, credentials) => {
    const { call } = await bench(credentials === undefined ? { credentials: undefined } : { credentials })
    expect(errorText(await call({ action: 'status', work_id: '1' }))).toContain('数据站服务令牌未配置')
  })

  it('reaches a real HTTP station in the shipped plugin form', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ path: request.url, token: request.headers['x-muse-data-service-token'] }))
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    onTestFinished(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(class extends MapCredentials { constructor(inner: Context) { super(inner, { MUSE_DATA_SERVICE_TOKEN: 'real-token' }) } })
    const { port } = server.address() as AddressInfo
    await ctx.plugin(plugin, { tokenRef: 'MUSE_DATA_SERVICE_TOKEN', baseUrl: `http://127.0.0.1:${port}/api/service/hits` })
    const result = await executeToolFixture(ctx, { name: 'drama_hit_queue', arguments: { action: 'status', work_id: '42' },
      callId: ToolCallId('real-call'), signal: new AbortController().signal })
    expect(result.value).toEqual({ action: 'status', result: { path: '/api/service/hits/jobs/42', token: 'real-token' } })
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
  })
})

describe('configuration', () => {
  it.each([
    ['a trailing slash', { baseUrl: `${BASE}/` }, 'baseUrl'],
    ['a query', { baseUrl: `${BASE}?x=1` }, 'baseUrl'],
    ['another scheme', { baseUrl: 'ftp://station/api' }, 'baseUrl'],
    ['a manifest origin with a path', { manifestOrigin: `${ORIGIN}/x` }, 'manifestOrigin'],
  ])('fails at load for %s', (_label, overrides, field) => {
    expect(() => { plugin.apply(new Context(), config(overrides)) }).toThrow(new RegExp(`hit-queue: ${field}`))
  })
})
