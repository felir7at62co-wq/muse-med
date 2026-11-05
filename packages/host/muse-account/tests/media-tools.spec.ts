/** Tool schemas, discovery, account refusals and durable submission keys. */
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, expect, it, vi } from 'vitest'
import { mountMuseMediaTools } from '../src/media-tools.ts'
import { MuseMediaError, type MuseMediaClient } from '../src/media.ts'
import type { MuseMediaImporter } from '../src/media-import.ts'
import type { MuseMediaJobId } from '../src/media-types.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
async function fixture() {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const client = { data: vi.fn<MuseMediaClient['data']>(), download: vi.fn<MuseMediaClient['download']>(),
    get: vi.fn<MuseMediaClient['get']>(), list: vi.fn<MuseMediaClient['list']>(), status: vi.fn<MuseMediaClient['status']>() }
  const importer = { import: vi.fn<MuseMediaImporter['import']>() }
  const fiber = ctx.plugin({ inject: ['tools'], apply: (scope: Context) => { mountMuseMediaTools(scope, client, importer) } })
  await fiber.await()
  let next = 0
  return { ctx, client, importer, fiber, call: async (name: string, args: object) => await executeToolFixture(ctx, {
    name, arguments: args, callId: ToolCallId(`media-${++next}`), signal: new AbortController().signal,
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
