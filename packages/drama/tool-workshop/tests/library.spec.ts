import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { WorkbenchHttpError, type WorkbenchRequest, type WorkbenchSession } from '@deepseek-ai/dsh-workbench-connection'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { checkEpisodes, finalizeTool, splitEpisodes } from '../src/finalize.ts'
import { episodeFiles, libraryTool } from '../src/library.ts'

type Route = (path: string, options: WorkbenchRequest) => unknown

const SCRIPT = {
  id: 7, title: '好一个乖乖女', owner: { id: 1, name: '小林' }, rights: 'licensed', origin_work_id: 'hongguo:7481108346636864536',
  origin_title: '好一个乖乖女', kind: 'drama', style: 'realistic', episodes: 2, words: 40, status: 'picked', latest_version: 3,
  picked: { by: { id: 2, name: '组长' }, version: 2, at: '2026-11-20T08:00:00' }, project: null,
  created_at: '2026-11-19T08:00:00', updated_at: '2026-11-20T08:00:00',
}
const EPISODES = [{ order: 2, title: '第2集 摊牌', content: '△ 客厅。\n林晚：我不嫁。' }, { order: 1, title: '', content: '1-1 日 内 林家\n林母：吃饭了。' }]

function sessionOf(route: Route) {
  const request = vi.fn(async (path: string, init: WorkbenchRequest = {}) => route(path, init))
  const session: WorkbenchSession = { identity: 'workshop-user', origin: 'https://muse.example/jubengongfang', request, fetch: vi.fn(), check: vi.fn() }
  return { session, request }
}

async function bench(tool: ToolDefinition, configure?: (ctx: Context) => void) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const fiber = ctx.plugin({ name: 'library-fixture', inject: ['tools'], apply: (scope: Context) => { scope.effect(() => scope.tools.register(tool)) } })
  await fiber.await()
  configure?.(ctx)
  return (args: unknown, agent = true) => executeToolFixture(ctx, {
    name: tool.name, arguments: args, callId: ToolCallId('library-call'), signal: new AbortController().signal,
    ...(agent ? { agent: { session: { id: 'session-1' } } as never } : {}),
  })
}

describe('splitEpisodes', () => {
  it('splits a file at its 第N集 headings and numbers a file without them by its name', () => {
    const episodes = splitEpisodes([
      { path: 'drafts/all.md', text: '﻿# 第1集 开场\n林晚回家。\n\n## 第 2 集\n林母开门。' },
      { path: 'drafts/0003.md', text: '林父出场。' },
    ])
    expect(episodes).toEqual([
      { order: 1, title: '第1集 开场', content: '林晚回家。' },
      { order: 2, title: '第2集', content: '林母开门。' },
      { order: 3, title: '第3集', content: '林父出场。' },
    ])
  })

  it('names repeated and empty episodes', () => {
    expect(() => checkEpisodes([{ order: 1, title: '', content: 'a' }, { order: 1, title: '', content: '' }]))
      .toThrow(/第 1 集出现了不止一次/u)
  })
})

describe('script_finalize', () => {
  it('appends a version to the member’s own script with the same title, with rights and form mapped', async () => {
    const posted: unknown[] = []
    const { session } = sessionOf((path, init) => {
      if (path.startsWith('/script-library?')) return { items: [{ ...SCRIPT, status: 'waiting', picked: null }], total: 1, page: 1, limit: 100, counts: { waiting: 1, picked: 0, in_production: 0, all: 1 }, can_pick: false }
      posted.push(init.body)
      return { created: true, version: 4, script: { ...SCRIPT, latest_version: 4 } }
    })
    const files: Record<string, string> = { 'ep/0001.md': '林晚回家。', 'ep/0002.md': '林母开门。' }
    const call = await bench(finalizeTool({ connect: async () => session, read: () => async path => files[path] ?? '' }))
    const result = await call({ title: '好一个乖乖女', files: ['ep/0001.md', 'ep/0002.md'], rights: '授权改编', kind: '解说剧', style: '3D', origin: 'hongguo:7481108346636864536' })
    expect(result.isError).toBe(false)
    expect(posted).toEqual([expect.objectContaining({
      entry_id: 7, rights: 'licensed', kind: 'narration', style: '3d', origin_work_id: 'hongguo:7481108346636864536',
      episodes: [{ order: 1, title: '第1集', content: '林晚回家。' }, { order: 2, title: '第2集', content: '林母开门。' }],
    })])
  })

  it('refuses a licensed adaptation without its source work', async () => {
    const { session, request } = sessionOf(() => ({}))
    const call = await bench(finalizeTool({ connect: async () => session, read: () => async () => 'x' }))
    const result = await call({ title: '好一个乖乖女', files: ['a.md'], rights: '授权改编' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.error)).toContain('授权改编需要 origin')
    expect(request).not.toHaveBeenCalled()
  })
})

describe('script_library', () => {
  it('writes one file per episode under 剧本库, headed so script_finalize reads them back', async () => {
    expect(episodeFiles('a/b:c', 2, EPISODES)).toEqual({
      folder: '剧本库/a_b_c-v2',
      files: [
        { path: '剧本库/a_b_c-v2/第001集.md', text: '# 第1集\n\n1-1 日 内 林家\n林母：吃饭了。\n' },
        { path: '剧本库/a_b_c-v2/第002集.md', text: '# 第2集 摊牌\n\n△ 客厅。\n林晚：我不嫁。\n' },
      ],
    })
    expect(episodeFiles('  ', 2, []).folder).toBe('剧本库/剧本-v2')
    const { files } = episodeFiles('好一个乖乖女', 2, EPISODES)
    expect(splitEpisodes(files).map(episode => episode.content)).toEqual(['1-1 日 内 林家\n林母：吃饭了。', '△ 客厅。\n林晚：我不嫁。'])
  })

  it('reads the requested version into the workspace', async () => {
    const written: Record<string, string> = {}
    const { session, request } = sessionOf(() => ({
      script: SCRIPT, can_pick: true, versions: [{ number: 2, words: 40, created_at: null, by: { id: 1, name: null } }],
      content: { version: 2, episodes: EPISODES },
    }))
    const call = await bench(libraryTool({ connect: async () => session, write: () => async (path, text) => { written[path] = text } }))
    const result = await call({ action: 'read', id: 7, version: 2 })
    expect(result.isError).toBe(false)
    expect(request).toHaveBeenCalledWith('/script-library/7?version=2', expect.anything())
    expect(Object.keys(written)).toEqual(['剧本库/好一个乖乖女-v2/第001集.md', '剧本库/好一个乖乖女-v2/第002集.md'])
  })

  it('reads the latest version and presents its recorded production project without including manuscript text', async () => {
    const script = { ...SCRIPT, status: 'in_production', project: { id: 'p-9', title: '乖乖女' } }
    const { session, request } = sessionOf(() => ({
      script, can_pick: true, versions: [], content: { version: 3, episodes: EPISODES },
    }))
    const write = vi.fn(async (_path: string, _text: string) => {})
    const tool = libraryTool({ connect: async () => session, write: () => write })
    const call = await bench(tool)
    const args = { action: 'read', id: 7 }
    const result = await call(args)
    expect(result).toMatchObject({ isError: false, value: { version: 3, project: '乖乖女' } })
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]?.[0]).toBe('/script-library/7')
    expect(request.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(write).toHaveBeenCalledTimes(2)
    expect(tool.presentCall?.(args)?.title).toBe('取出定稿剧本 · 剧本 7')
    expect(tool.presentResult?.(args, result)?.title).toBe('已取出 《好一个乖乖女》 第 3 版 · 2 集')
    expect(JSON.stringify(result.content)).not.toContain(EPISODES[0]!.content)
  })

  it('requires a valid script ID and a conversation before reading workspace files', async () => {
    const { session, request } = sessionOf(() => ({}))
    const connect = vi.fn(async () => session)
    const write = vi.fn()
    const call = await bench(libraryTool({ connect, write }))
    expect((await call({ action: 'read', id: 0 })).error?.message).toContain('id 是剧本库编号')
    expect((await call({ action: 'read', id: 7 }, false)).error?.info).toMatchObject({ code: 'WORKSHOP_SESSION_REQUIRED' })
    expect(connect).not.toHaveBeenCalled()

    expect((await call({ action: 'read', id: 7, version: 0 })).error?.message).toContain('version')
    expect(request).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('records the Jingliu project a picked script became', async () => {
    const { session, request } = sessionOf(() => ({ script: { ...SCRIPT, status: 'in_production', project: { id: 'p-9', title: '乖乖女' } } }))
    const tool = libraryTool({ connect: async () => session, write: () => async () => undefined })
    const call = await bench(tool)
    const args = { action: 'link', id: 7, project_id: '  p-9 ', project_title: ' 乖乖女 ' }
    const result = await call(args, false)
    expect(result.isError).toBe(false)
    expect(tool.presentCall?.(args)?.title).toBe('登记投产 · 剧本 7')
    expect(tool.presentResult?.(args, result)?.title).toBe('已登记投产 · 《好一个乖乖女》 → 乖乖女')
    expect(request).toHaveBeenCalledWith('/script-library/7/production', expect.objectContaining({ method: 'POST', body: { project_id: 'p-9', project_title: '乖乖女' } }))
  })

  it('does not report a project when the server returned no link and preserves permission errors', async () => {
    const { session, request } = sessionOf(() => ({ script: SCRIPT }))
    const tool = libraryTool({ connect: async () => session, write: () => async () => undefined })
    const call = await bench(tool)
    const args = { action: 'link', id: 7, project_id: 'p-9', project_title: '乖乖女' }
    const missing = await call(args)
    expect(missing).toMatchObject({ isError: false, value: { project_id: null, project: null } })
    expect(tool.presentResult?.(args, missing)?.title).toBe('已登记投产 · 《好一个乖乖女》')
    request.mockRejectedValueOnce(new WorkbenchHttpError(403, 'SCRIPT_PICK_FORBIDDEN', '没有剧本选用权限。'))
    const denied = await call(args)
    expect(denied.error?.info).toMatchObject({ code: 'SCRIPT_PICK_FORBIDDEN' })
    expect(tool.presentResult?.(args, denied)).toBeUndefined()
  })

  it('omits project and title labels after a post-execute policy redacts the script summary', async () => {
    const { session } = sessionOf(() => ({ script: SCRIPT }))
    const tool = libraryTool({ connect: async () => session, write: () => async () => undefined })
    const call = await bench(tool, (ctx) => {
      ctx.on('tools/post-execute', async () => ({ kind: 'accept', value: { action: 'link', id: 7, status: 'picked' } }))
    })
    const args = { action: 'link', id: 7, project_id: 'p-9', project_title: '乖乖女' }
    const redacted = await call(args)
    expect(redacted).toMatchObject({ isError: false, meta: { title: null, project: null } })
    expect(tool.presentResult?.(args, redacted)?.title).toBe('已登记投产 · ')
  })

  it('omits labels for older results missing usable presentation metadata', () => {
    const { session } = sessionOf(() => ({}))
    const tool = libraryTool({ connect: async () => session, write: () => async () => undefined })
    const args = { action: 'read', id: 7 }
    expect(tool.presentResult?.(args, { isError: false, content: [] })).toBeUndefined()
    expect(tool.presentResult?.(args, { isError: false, content: [], meta: null })).toBeUndefined()
    expect(tool.presentResult?.(args, { isError: false, content: [], meta: [] })).toBeUndefined()
    expect(tool.presentResult?.(args, { isError: false, content: [], meta: {} })?.title).toBe('已取出 ')
  })

  it('asks for the project when link names none', async () => {
    const { session, request } = sessionOf(() => ({}))
    const call = await bench(libraryTool({ connect: async () => session, write: () => async () => undefined }))
    const result = await call({ action: 'link', id: 7 })
    expect(result.isError).toBe(true)
    const overlong = await call({ action: 'link', id: 7, project_id: 'x'.repeat(81), project_title: 'x'.repeat(201) })
    expect(overlong.error?.message).toContain('project_id')
    expect(overlong.error?.message).toContain('project_title')
    expect(request).not.toHaveBeenCalled()
  })
})
