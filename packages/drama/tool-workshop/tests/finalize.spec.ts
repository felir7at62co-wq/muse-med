/** Exercise draft validation and upload outcomes through the registered tool. */
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { WorkbenchHttpError, type WorkbenchRequest, type WorkbenchSession } from '@deepseek-ai/dsh-workbench-connection'
import { expect, it, onTestFinished, vi } from 'vitest'
import { checkEpisodes, finalizeTool, LIMITS } from '../src/finalize.ts'

const TITLE = '雨巷'
const SCRIPT = {
  id: 7, title: TITLE, owner: { id: 1, name: null }, rights: 'original',
  kind: 'drama', style: 'realistic', episodes: 1, words: 8, status: 'waiting', latest_version: 3,
}
const EMPTY_LIBRARY = {
  items: [], total: 0, page: 1, limit: 100, counts: { waiting: 0, picked: 0, in_production: 0, all: 0 }, can_pick: false,
}
const DRAFT = { title: TITLE, files: ['chapter.md'] }

async function bench(upload: () => unknown = () => ({ script: SCRIPT, created: true, version: 3 })) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const request = vi.fn(async (path: string, _options: WorkbenchRequest) => {
    if (path.startsWith('/script-library?')) return EMPTY_LIBRARY
    if (path === '/script-library') return upload()
    throw new Error('Unexpected Workshop path ' + path)
  })
  const session: WorkbenchSession = { identity: 'workshop-user', origin: 'https://muse.example/jubengongfang', request, fetch: vi.fn(), check: vi.fn() }
  const read = vi.fn(async () => '林晚回到雨巷。')
  const connect = vi.fn(async () => session)
  const tool = finalizeTool({ connect, read: () => read })
  ctx.tools.register(tool)
  const call = (args: object, { withoutAgent = false, signal = new AbortController().signal } = {}) =>
    executeModelToolFixture(ctx, {
      name: tool.name, arguments: args, callId: ToolCallId('workshop-finalize'), signal,
      ...(withoutAgent ? {} : { agent: { session: { id: 'finalize-fixture' } } as never }),
    })
  return { ctx, call, tool, read, connect, request }
}

it('rejects a missing conversation, invalid title, too many files and invalid origin before reading or connecting', async () => {
  const f = await bench()
  expect((await f.call(DRAFT, { withoutAgent: true })).error?.info?.code).toBe('WORKSHOP_SESSION_REQUIRED')
  const invalid = await f.call({
    title: 'x'.repeat(201), files: Array.from({ length: LIMITS.files + 1 }, () => 'episode.md'), origin: 'unknown:123',
  })
  expect(invalid.error?.message).toContain('title')
  expect(invalid.error?.message).toContain('files')
  expect(invalid.error?.message).toContain('origin')
  expect(f.read).not.toHaveBeenCalled()
  expect(f.connect).not.toHaveBeenCalled()
})

it('names an out-of-range or oversized episode and rejects excess script length before uploading', async () => {
  const f = await bench()
  const maxEpisode = 'x'.repeat(LIMITS.episodeChars)
  f.read.mockResolvedValueOnce('# 第301集\n' + maxEpisode + 'x')
  const malformed = await f.call(DRAFT)
  expect(malformed.error?.message).toContain('集数 301 超出范围')
  expect(malformed.error?.message).toContain('第 301 集超过 60000 字')

  f.read.mockResolvedValueOnce(Array.from({ length: LIMITS.episodes + 1 }, (_, index) => '# 第' + String(index + 1) + '集\n'
    + (index < 51 ? maxEpisode : '线索')).join('\n'))
  const overBudget = await f.call(DRAFT)
  expect(overBudget.error?.message).toContain('最多 300 集')
  expect(overBudget.error?.message).toContain('全剧超过 3000000 字')
  expect(f.connect).not.toHaveBeenCalled()
  expect(() => checkEpisodes([])).toThrow('没有读到任何一集')
})

it('numbers an unnumbered file by its input position and distinguishes unchanged text from a new version', async () => {
  const f = await bench(() => ({ script: SCRIPT, created: false, version: 3 }))
  const args = { ...DRAFT, origin: 'fanqie:123', origin_title: '  雨巷原作  ' }
  const result = await f.call(args)
  expect(result).toMatchObject({ isError: false, value: { id: 7, version: 3, created: false } })
  const posted = f.request.mock.calls[1]?.[1].body
  expect(posted).toMatchObject({
    origin_work_id: 'fanqie:123', origin_title: '雨巷原作',
    episodes: [{ order: 1, title: '第1集', content: '林晚回到雨巷。' }],
  })
  expect(f.tool.presentCall?.(args)?.title).toBe('定稿 ·《雨巷》')
  expect(f.tool.presentResult?.(args, result)?.title).toBe('定稿 · 正文没变 ·《雨巷》 v3')
})

it('retains the current version fallback for old upload results and handles redacted presentation metadata', async () => {
  const f = await bench(() => ({ script: SCRIPT }))
  const legacy = await f.call(DRAFT)
  expect(legacy).toMatchObject({ isError: false, value: { version: 0, created: false } })
  expect(f.tool.presentResult?.(DRAFT, legacy)?.title).toBe('定稿 · 正文没变 ·《雨巷》 v0')
  for (const result of [
    { isError: false, content: [] }, { isError: false, content: [], meta: null }, { isError: false, content: [], meta: [] },
  ]) expect(f.tool.presentResult?.(DRAFT, result)).toBeUndefined()
  expect(f.tool.presentResult?.(DRAFT, { isError: false, content: [], meta: {} })?.title).toBe('已上传剧本工坊 ·《雨巷》')

  f.ctx.on('tools/post-execute', async () => ({ kind: 'accept', value: { id: 7, version: 3 } }))
  const redacted = await f.call(DRAFT)
  expect(redacted).toMatchObject({ isError: false, meta: { title: null, created: null, version: 3 } })
  expect(f.tool.presentResult?.(DRAFT, redacted)?.title).toBe('已上传剧本工坊 ·《雨巷》 v3')
})

it('distinguishes definitive refusal, cancellation and an unconfirmed upload without resubmitting', async () => {
  const controller = new AbortController()
  const responses = [
    () => { throw new WorkbenchHttpError(409, 'SCRIPT_VERSION_CONFLICT', '定稿已变更。') },
    () => { throw new Error('Connection lost before response') },
    () => { const reason = new Error('Caller cancelled the request'); controller.abort(reason); throw reason },
  ]
  const f = await bench(() => {
    const response = responses.shift()
    if (response === undefined) throw new Error('Unexpected upload retry')
    return response()
  })
  const conflict = await f.call(DRAFT)
  expect(conflict.error?.info?.code).toBe('SCRIPT_VERSION_CONFLICT')
  const uncertain = await f.call(DRAFT)
  expect(uncertain.error?.info?.code).toBe('WORKSHOP_FINALIZE_OUTCOME_UNKNOWN')
  expect(uncertain.error?.message).toContain('先看定稿库里有没有这一版')
  expect(f.tool.presentResult?.(DRAFT, uncertain)).toBeUndefined()
  const cancelled = await f.call(DRAFT, { signal: controller.signal })
  expect(cancelled.error?.message).toContain('Caller cancelled the request')
  expect(f.request.mock.calls.filter(([path]) => path === '/script-library')).toHaveLength(3)
})
