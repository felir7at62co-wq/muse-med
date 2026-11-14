/** Tool schemas, discovery, account refusals and durable submission keys. */
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, expect, it, vi } from 'vitest'
import { mountMuseMediaTools } from '../src/media-tools.ts'
import { MuseMediaError, MuseMediaClient } from '../src/media.ts'
import { writeMuseSession } from '../src/session.ts'
import { MuseMediaImportError, type MuseMediaImporter } from '../src/media-import.ts'
import type { MuseMediaJobId } from '../src/media-types.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
async function fixture(withAgent = false, providedClient?: MuseMediaClient) {
  const ctx = new Context(); contexts.push(ctx)
  if (withAgent) await mountAgentLoopTestDependencies(ctx)
  else { await ctx.plugin(SystemPrompt); await ctx.plugin(Tools) }
  const agent = withAgent ? await (await mountAgentLoopTestHarness(ctx)).create(SessionId('media-tools-import')) : undefined
  const client = { data: vi.fn<MuseMediaClient['data']>(), download: vi.fn<MuseMediaClient['download']>(),
    get: vi.fn<MuseMediaClient['get']>(), list: vi.fn<MuseMediaClient['list']>(), status: vi.fn<MuseMediaClient['status']>() }
  const importer = { import: vi.fn<MuseMediaImporter['import']>() }
  const fiber = ctx.plugin({ inject: ['tools'], apply: (scope: Context) => { mountMuseMediaTools(scope, providedClient ?? client, importer) } })
  await fiber.await()
  let next = 0
  return { ctx, client, importer, fiber, agent, call: async (name: string, args: object) => await executeToolFixture(ctx, {
    name, arguments: args, callId: ToolCallId(`media-${++next}`), signal: new AbortController().signal,
    ...agent === undefined ? {} : { agent },
  }) }
}

it('defers four media tools and removes every registration on unload', async () => {
  const f = await fixture(), schemas = f.ctx.tools.schemas()
  expect(schemas.map(row => row.name)).toEqual(['muse_media_data', 'muse_media_download', 'muse_media_task', 'muse_media_import'])
  expect(schemas.every(row => row.deferLoading === true)).toBe(true)
  await f.fiber.dispose()
  expect(f.ctx.tools.schemas()).toEqual([])
})

it('keeps cloud pending and partial results distinct from local files while reusing the submission key', async () => {
  const f = await fixture(), job = brandString<MuseMediaJobId>('80000000-0000-4000-8000-000000000001')
  f.client.download.mockResolvedValue({ state: 'pending', job_id: job, automatic_resubmit: false })
  for (let n = 0; n < 2; n++) {
    const result = await f.call('muse_media_download', { url: 'https://www.douyin.com/video/7126745726494821640', requestId: 'same-key' })
    expect(JSON.stringify(result)).toContain('pending')
    expect(JSON.stringify(result)).not.toContain('local_ready')
  }
  expect(f.client.download.mock.calls.map(args => args[0])).toEqual([
    { url: 'https://www.douyin.com/video/7126745726494821640', requestId: 'same-key', skip_existing: true },
    { url: 'https://www.douyin.com/video/7126745726494821640', requestId: 'same-key', skip_existing: true },
  ])
  f.client.get.mockResolvedValue({ state: 'partial', job_id: job, files: [] })
  expect(JSON.stringify(await f.call('muse_media_task', { action: 'status', jobId: job }))).toContain('partial')
})

it('returns fixed company-access and rate-limit guidance without private failure text', async () => {
  const f = await fixture()
  f.client.data.mockRejectedValueOnce(new MuseMediaError('company-access-required'))
    .mockRejectedValueOnce(new MuseMediaError('rate-limited', 9)).mockRejectedValueOnce(new Error('private-cookie-value'))
  for (const code of ['company-access-required', 'rate-limited', 'unavailable']) {
    const result = JSON.stringify(await f.call('muse_media_data', { action: 'parse_url', url: 'https://www.bilibili.com/video/BV1xx411c7mD' }))
    expect(result).toContain(code)
    expect(result).not.toContain('private-cookie-value')
    if (code === 'rate-limited') expect(result).toContain('retryAfter')
  }
})

it('requires an initiating workspace for import and rejects invalid read inputs before transport', async () => {
  const f = await fixture()
  expect(JSON.stringify(await f.call('muse_media_import', { jobId: '80000000-0000-4000-8000-000000000001', fileName: 'video.mp4' }))).toContain('workspace-required')
  expect(f.importer.import).not.toHaveBeenCalled()
  for (const args of [{ action: 'get_video' }, { action: 'list_comments', platform: 'douyin', contentId: '1', count: 0 }]) {
    expect(JSON.stringify(await f.call('muse_media_data', args))).toContain('invalid-input')
  }
  expect(f.client.data).not.toHaveBeenCalled()
})

it('maps read arguments without accepting caller-supplied account identity', async () => {
  const f = await fixture()
  f.client.data.mockResolvedValue({ state: 'ok', data: [] })
  await f.call('muse_media_data', { action: 'list_comments', platform: 'douyin', contentId: '123', cursor: 'cursor', count: 5, sort: 'new', accountId: 'other' })
  expect(f.client.data.mock.calls[0]?.slice(0, 2)).toEqual(['list_comments', { platform: 'douyin', content_id: '123', cursor: 'cursor', count: 5, sort: 'new' }])
})

it.each([
  ['get_video', { platform: 'douyin', contentId: 'video-1' }, { platform: 'douyin', content_id: 'video-1' }],
  ['get_user', { platform: 'tiktok', userId: 'author-1' }, { platform: 'tiktok', uid: 'author-1' }],
  ['list_user_posts', { platform: 'bilibili', userId: 'author-1' }, { platform: 'bilibili', uid: 'author-1' }],
  ['list_user_posts', { platform: 'douyin', userId: 'author-1', count: 50, cursor: 'opaque' },
    { platform: 'douyin', uid: 'author-1', count: 50, cursor: 'opaque' }],
  ['list_comments', { platform: 'douyin', contentId: 'video-1' }, { platform: 'douyin', content_id: 'video-1' }],
  ['get_content_history', { platform: 'tiktok', contentId: 'video-1' }, { platform: 'tiktok', content_id: 'video-1' }],
  ['get_content_history', { platform: 'tiktok', contentId: 'video-1', since: '2026-11-01' },
    { platform: 'tiktok', content_id: 'video-1', since: '2026-11-01' }],
] as const)('keeps the exact account-owned %s query arguments', async (action, input, expected) => {
  const f = await fixture()
  f.client.data.mockResolvedValue({ state: 'ok', data: { play_count: null } })
  const result = await f.call('muse_media_data', { action, ...input })
  expect(result).toMatchObject({ isError: false, value: { state: 'ok', data: { play_count: null } } })
  expect(f.client.data).toHaveBeenCalledExactlyOnceWith(action, expected, expect.any(AbortSignal))
})

it('returns service limits and receipt pagination without submitting new work', async () => {
  const f = await fixture(), limits = { requests_per_minute: 10, concurrent_requests: 2, downloads_per_day: 20, concurrent_downloads: 1 }
  f.client.status.mockResolvedValue({ ready: false, limits })
  expect(await f.call('muse_media_data', { action: 'status' })).toMatchObject({ value: { state: 'ok', ready: false, limits } })
  f.client.list.mockResolvedValue({ jobs: [{ state: 'pending' }], next_offset: 9 })
  expect(await f.call('muse_media_task', { action: 'list', offset: 8 })).toMatchObject({
    value: { state: 'ok', jobs: [{ state: 'pending' }], next_offset: 9 },
  })
  expect(f.client.list).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), 8)
  expect(f.client.download).not.toHaveBeenCalled()
  expect(f.importer.import).not.toHaveBeenCalled()
})

it('reports a missing receipt identity and an unavailable account list without returning an invented job', async () => {
  const f = await fixture()
  expect(await f.call('muse_media_task', { action: 'status' }))
    .toMatchObject({ value: { state: 'failed', code: 'invalid-input' } })
  expect(f.client.get).not.toHaveBeenCalled()
  f.client.list.mockRejectedValue(new MuseMediaError('sign-in-required'))
  expect(await f.call('muse_media_task', { action: 'list' }))
    .toMatchObject({ value: { state: 'failed', code: 'sign-in-required' } })
})

it('refuses a gateway number that cannot survive lossless model-visible JSON materialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-tool-json-'))
  let client: MuseMediaClient | undefined
  try {
    const baseUrl = 'https://muse.test', sessionFile = join(root, 'session.json')
    await writeMuseSession(sessionFile, { baseUrl, username: 'alice', cookie: '__Host-muse=' + 'A'.repeat(43) })
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (typeof init?.body !== 'string') throw Error('Expected a media RPC request')
      const request = JSON.parse(init.body) as { id: string }
      const receipt = '{"state":"ok","job_id":"80000000-0000-4000-8000-000000000001","files":[],"data":-0}'
      return new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(request.id)},"result":{"isError":false,"structuredContent":${receipt}}}`,
        { headers: { 'content-type': 'application/json' } })
    })
    client = new MuseMediaClient({ baseUrl, sessionFile, requestTimeoutMs: 5000, fileTimeoutMs: 5000,
      maxReplyBytes: 65_536, maxFileBytes: 65_536, fetcher })
    const read = vi.spyOn(client, 'data')
    const f = await fixture(false, client)
    expect(await f.call('muse_media_data', { action: 'parse_url', url: 'https://www.douyin.com/video/123' }))
      .toMatchObject({ value: { state: 'failed', code: 'invalid-response' } })
    expect(fetcher).toHaveBeenCalledOnce()
    const invocation = read.mock.results[0]
    if (invocation?.type !== 'return') throw Error('Media transport did not return its receipt')
    expect(Object.is((await invocation.value).data, -0)).toBe(true)
  } finally { await client?.dispose(); await rm(root, { recursive: true, force: true }) }
})

it.each([
  { action: 'parse_url' }, { action: 'parse_url', url: '   ' },
  { action: 'get_user', platform: 'douyin' }, { action: 'list_user_posts', platform: 'douyin', userId: ' ' },
  { action: 'get_content_history', platform: 'douyin' },
])('refuses an absent required media identity before a transport call: %j', async (args) => {
  const f = await fixture()
  expect(await f.call('muse_media_data', args)).toMatchObject({ value: { state: 'failed', code: 'invalid-input' } })
  expect(f.client.data).not.toHaveBeenCalled()
})

it('preserves the original submission key on uncertainty and passes explicit download options unchanged', async () => {
  const f = await fixture(), input = { url: 'https://www.bilibili.com/video/BV1xx411c7mD', requestId: 'original-key',
    skipExisting: false, part: 2 }
  f.client.download.mockRejectedValue(new MuseMediaError('unconfirmed'))
  const result = await f.call('muse_media_download', input)
  const guidance: unknown = expect.stringContaining('never submit with a new key')
  expect(result).toMatchObject({ value: { state: 'failed', code: 'unconfirmed', requestId: input.requestId,
    guidance } })
  expect(f.client.download).toHaveBeenCalledExactlyOnceWith({ url: input.url, requestId: input.requestId,
    skip_existing: false, part: 2 }, expect.any(AbortSignal))
})

it('keeps imported images and partial source receipts distinct from complete video delivery', async () => {
  const f = await fixture(true), jobId = brandString<MuseMediaJobId>('80000000-0000-4000-8000-000000000001')
  const receipt = { state: 'local_ready' as const, jobId, fileName: 'cover.jpg', path: '/source/cover.jpg',
    receipt: '/source/cover.jpg.source.json', bytes: 4, sha256: 'a'.repeat(64), kind: 'image' as const,
    width: 64, height: 48, fullDecodeVerified: true as const, sourceJobState: 'partial' as const,
    fileCoverage: { reported: 2, accepted: 1, rejected: 1, complete: false, truncated: false } }
  f.importer.import.mockResolvedValue(receipt)
  const result = await f.call('muse_media_import', { jobId, fileName: receipt.fileName })
  const guidance: unknown = expect.stringContaining('an image is not a complete video')
  expect(result).toMatchObject({ isError: false, value: { ...receipt, guidance } })
  expect(f.importer.import).toHaveBeenCalledExactlyOnceWith(f.agent, jobId, receipt.fileName, expect.any(AbortSignal))
  for (const code of ['local-conflict', 'account-changed'] as const) {
    f.importer.import.mockRejectedValueOnce(code === 'local-conflict' ? new MuseMediaImportError(code) : new MuseMediaError(code))
    const failureGuidance: unknown = expect.stringMatching(/not replaced|account changed/u)
    expect(await f.call('muse_media_import', { jobId, fileName: receipt.fileName }))
      .toMatchObject({ value: { state: 'failed', code, guidance: failureGuidance } })
  }
})

it.each([
  ['muse_media_data', { action: 'status' }, 'status', 'read'],
  ['muse_media_download', { url: 'selected URL', requestId: 'stable-key' }, 'selected URL', 'execute'],
  ['muse_media_task', { action: 'list' }, 'list', 'read'],
  ['muse_media_task', { action: 'status', jobId: 'original-job' }, 'original-job', 'read'],
  ['muse_media_import', { jobId: 'original-job', fileName: 'cover.jpg' }, 'cover.jpg', 'edit'],
] as const)('presents %s with its original identity and operation category', async (name, args, title, kind) => {
  const f = await fixture(), tool = f.ctx.tools.get(name)
  if (!tool) throw Error('Expected media tool was not registered')
  expect(tool.presentCall?.(args)).toEqual({ card: 'generic', title, kind })
  expect(tool.output.render(args, { state: 'pending' })).toEqual([{ type: 'text', text: '{"state":"pending"}' }])
})
