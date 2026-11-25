import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JingliuSession } from '@deepseek-ai/dsh-jingliu-connection'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { imageTool, projectsTool } from '../src/production.ts'
import { studioTool } from '../src/studio.ts'
import type { Dependencies } from '../src/workflow-tools.ts'

const sid = 'session-1'
const account = 'user-1'
const project = { id: 'film-1', title: '雨夜' }
const models = { models: [{ id: 'gpt-image-2' }, { id: 'single', fixed_n: 1, supports_refs: false }] }

function fixture(hasSession = true) {
  const request = vi.fn<JingliuSession['request']>()
  const connect = vi.fn(async () => ({ identity: account, request }))
  const approve = vi.fn<Dependencies['approve']>(async () => true)
  const selected = vi.fn<NonNullable<Dependencies['selected']>>(async () => project)
  const select = vi.fn<NonNullable<Dependencies['select']>>(async () => project)
  const deps = { connect, approve, selected, select }
  const tools = { studio: studioTool(deps), projects: projectsTool(deps), image: imageTool(deps) }
  const signal = new AbortController().signal
  const id = ToolCallId('call-1')
  const agent = { session: { id: sid } } as NonNullable<ToolRunContext['agent']>
  const call = (tool: keyof typeof tools, args: Record<string, unknown>) => tools[tool].execute(args, {
    callId: id, rootCallId: id, token: Symbol() as ToolExecutionToken, arguments: args, name: tools[tool].name,
    ...(hasSession ? { agent } : {}), signal, deferContext() {}, concludeTurn() {},
  })
  return { request, connect, approve, selected, select, tools, signal, call }
}

async function useReceiptHome() {
  const home = await mkdtemp(join(tmpdir(), 'jingliu-production-'))
  vi.stubEnv('DSH_HOME', home)
  onTestFinished(async () => {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })
}

it.each(['studio', 'projects', 'image'] as const)('requires a Muse session before connecting the %s tool', async (tool) => {
  const f = fixture(false)
  await expect(f.call(tool, { action: tool === 'studio' ? 'library' : tool === 'projects' ? 'search' : 'models' }))
    .rejects.toMatchObject({ code: 'JINGLIU_SESSION_REQUIRED' })
  expect(f.connect).not.toHaveBeenCalled()
})

describe('Jingliu studio assets, episodes and subtitles', () => {
  it('lists shared assets without a selected project and preserves the query, kind and offset', async () => {
    const f = fixture()
    const response = { items: [{ id: 'asset-1', title: '油纸伞' }] }
    const args = { action: 'library', query: '油纸伞', kind: 'prop', offset: 24 }
    f.selected.mockResolvedValue(null)
    f.request.mockResolvedValue(response)
    await expect(f.call('studio', args)).resolves.toEqual(response)
    await expect(f.call('studio', { action: 'library' })).resolves.toEqual(response)
    expect(f.request.mock.calls).toEqual([
      [`/library?limit=24&offset=24&q=${encodeURIComponent('油纸伞')}&kind=prop`, { signal: f.signal }],
      ['/library?limit=24&offset=0&q=', { signal: f.signal }],
    ])
    expect(f.tools.studio.output.render(args, response)).toEqual([{ type: 'text', text: JSON.stringify(response) }])
    expect(f.approve).not.toHaveBeenCalled()
  })

  it('rejects a negative page or an unrecognized shared library response', async () => {
    const f = fixture()
    await expect(f.call('studio', { action: 'library', offset: -1 })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_ARGUMENTS' })
    expect(f.request).not.toHaveBeenCalled()
    f.request.mockResolvedValueOnce([])
    await expect(f.call('studio', { action: 'library' })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_RESULT' })
  })

  it.each([
    { action: 'episodes', route: '/episodes/content', response: { episodes: [{ episode: 1, content: '雨夜' }] } },
    { action: 'hd_history', route: '/video-upscale-jobs?limit=30', response: { jobs: [] } },
    { action: 'subtitles', route: '/subtitle-clips', response: { clips: [{ id: 'clip-1', text: '小舟' }] } },
  ])('reads $action through the confirmed project without approval', async ({ action, route, response }) => {
    const f = fixture()
    f.request.mockResolvedValueOnce(response)
    await expect(f.call('studio', { action })).resolves.toEqual(response)
    expect(f.selected).toHaveBeenCalledExactlyOnceWith(sid, account)
    expect(f.request).toHaveBeenCalledExactlyOnceWith(`/projects/${project.id}${route}`, { signal: f.signal })
    expect(f.approve).not.toHaveBeenCalled()
  })

  it('refuses missing, unsafe and different studio projects before reading their contents', async () => {
    const f = fixture()
    f.selected.mockResolvedValueOnce(null)
    await expect(f.call('studio', { action: 'episodes' })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_PROJECT' })
    for (const projectId of ['../other', 'other']) {
      await expect(f.call('studio', { action: 'episodes', project_id: projectId })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_PROJECT' })
    }
    expect(f.request).not.toHaveBeenCalled()
  })

  it('imports only explicit shared asset IDs after confirmation for the selected project', async () => {
    const f = fixture()
    const args = { action: 'import_assets', asset_ids: ['asset-1', 'asset-2'] }
    for (const ids of [[], ['unsafe/asset']]) {
      await expect(f.call('studio', { ...args, asset_ids: ids })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_ARGUMENTS' })
    }
    expect(f.approve).not.toHaveBeenCalled()
    f.approve.mockResolvedValueOnce(false)
    await expect(f.call('studio', args)).rejects.toMatchObject({ code: 'JINGLIU_APPROVAL_REQUIRED' })
    expect(f.request).not.toHaveBeenCalled()
    f.request.mockResolvedValueOnce({ imported: 2 })
    await expect(f.call('studio', args)).resolves.toEqual({ imported: 2 })
    expect(f.approve.mock.calls.at(-1)?.[1]).toContain(project.id)
    expect(f.request).toHaveBeenCalledExactlyOnceWith('/library/import', {
      method: 'POST', body: { project_id: project.id, asset_ids: args.asset_ids }, signal: f.signal,
    })
  })

  it('stops on a malformed subtitle list or a declined edit', async () => {
    const f = fixture()
    const args = { action: 'edit_subtitle', clip_id: 'clip-1', text: '小舟' }
    f.request.mockResolvedValueOnce({ clips: null })
    await expect(f.call('studio', args)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_RESULT' })
    expect(f.approve).not.toHaveBeenCalled()
    f.request.mockResolvedValueOnce({ clips: [null, { id: 'clip-1' }] })
    f.approve.mockResolvedValueOnce(false)
    await expect(f.call('studio', args)).rejects.toMatchObject({ code: 'JINGLIU_APPROVAL_REQUIRED' })
    expect(f.request.mock.calls.map(([route]) => route)).toEqual([
      `/projects/${project.id}/subtitle-clips`, `/projects/${project.id}/subtitle-clips`,
    ])
  })

  it.each([
    { name: 'a missing acknowledgement', response: null },
    { name: 'a different subtitle', response: { id: 'clip-2', text: '小舟' } },
    { name: 'the previous text', response: { id: 'clip-1', text: '旧稿' } },
  ])('does not report a successful subtitle edit after the studio returns $name', async ({ response }) => {
    const f = fixture()
    f.request.mockResolvedValueOnce({ clips: [{ id: 'clip-1' }] }).mockResolvedValueOnce(response)
    await expect(f.call('studio', { action: 'edit_subtitle', clip_id: 'clip-1', text: ' 小舟 ' }))
      .rejects.toMatchObject({ code: 'JINGLIU_INVALID_RESULT' })
    expect(f.request.mock.calls.at(-1)).toEqual(['/subtitle-clips/clip-1', {
      method: 'PATCH', body: { text: '小舟' }, signal: f.signal,
    }])
  })
})

describe('Jingliu project selection', () => {
  it('reports the current selection for the connected user and session', async () => {
    const f = fixture()
    f.selected.mockResolvedValueOnce(null)
    await expect(f.call('projects', { action: 'current' })).resolves.toEqual({ project: null })
    await expect(f.call('projects', { action: 'current' })).resolves.toEqual({ project })
    expect(f.selected.mock.calls).toEqual([[sid, account], [sid, account]])
    expect(f.request).not.toHaveBeenCalled()
  })

  it('trims search text, paginates and preserves absent project metadata as null', async () => {
    const f = fixture()
    const remaining = Array.from({ length: 24 }, (_, index) => ({ id: `film-page-${index}`, title: `第${index}部` }))
    const projects = [{ ...project, episodes_count: 8, shots_total: 10, shots_done: 5, my_role: 'editor', detail: 'internal' },
      ...remaining, { episodes_count: 0 }]
    f.request.mockResolvedValue({ projects })
    const args = { action: 'search', query: ' 雨夜 ' }
    const projection = { id: project.id, title: project.title, episodes: 8, shots: 10, ready: 5, role: 'editor' }
    await expect(f.call('projects', args)).resolves.toMatchObject({
      total: 26, next_offset: 24,
      projects: [projection, ...remaining.slice(0, 23)],
    })
    const page = { total: 26, projects: [
      { id: 'film-page-23', title: '第23部', episodes: null, shots: null, ready: null, role: null },
      { id: null, title: null, episodes: 0, shots: null, ready: null, role: null },
    ] }
    await expect(f.call('projects', { action: 'search', offset: 24 })).resolves.toEqual(page)
    const content = f.tools.projects.output.render(args, projection)
    expect(content).toEqual([{ type: 'text', text: JSON.stringify(projection) }])
    expect(f.request.mock.calls[0]).toEqual([`/projects?q=${encodeURIComponent('雨夜')}`, { signal: f.signal }])
    expect(f.request.mock.calls[1]).toEqual(['/projects?q=', { signal: f.signal }])
    expect(f.select).not.toHaveBeenCalled()
  })

  it('rejects invalid search requests and refuses to inspect a mismatched project response', async () => {
    const f = fixture()
    await expect(f.call('projects', { action: 'search', offset: -1 })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_ARGUMENTS' })
    await expect(f.call('projects', { action: 'inspect', project_id: '../other' })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_PROJECT' })
    expect(f.request).not.toHaveBeenCalled()
    f.request.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ ...project, id: 'other' })
    await expect(f.call('projects', { action: 'search' })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_RESULT' })
    await expect(f.call('projects', { action: 'inspect', project_id: project.id })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_RESULT' })
    expect(f.select).not.toHaveBeenCalled()
  })

  it('inspects without rebinding and only selects after the user approves the exact project', async () => {
    const f = fixture()
    f.request.mockResolvedValue(project)
    await expect(f.call('projects', { action: 'inspect', project_id: project.id })).resolves.toEqual({ project })
    expect(f.approve).not.toHaveBeenCalled()
    const args = { action: 'select', project_id: project.id }
    f.approve.mockResolvedValueOnce(false)
    await expect(f.call('projects', args)).rejects.toMatchObject({ code: 'JINGLIU_APPROVAL_REQUIRED' })
    expect(f.select).not.toHaveBeenCalled()
    await expect(f.call('projects', args)).resolves.toEqual({ project })
    expect(f.select).toHaveBeenCalledExactlyOnceWith(sid, project.id, f.signal)
    expect(f.approve.mock.calls.at(-1)?.[1]).toContain(`${project.title}」 (${project.id})`)
  })
})

describe('Jingliu image generation', () => {
  it('lists image models independently of project selection and rejects a malformed catalog', async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce(models).mockResolvedValueOnce({ models: null })
    await expect(f.call('image', { action: 'models' })).resolves.toEqual(models)
    await expect(f.call('image', { action: 'models' })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_RESULT' })
    expect(f.selected).not.toHaveBeenCalled()
  })

  it('keeps image history on the selected project and refuses malformed history', async () => {
    const f = fixture()
    const history = { jobs: [{ id: 'job-1' }] }
    f.request.mockResolvedValueOnce(models).mockResolvedValueOnce(history)
      .mockResolvedValueOnce(models).mockResolvedValueOnce(null).mockResolvedValueOnce(models)
    await expect(f.call('image', { action: 'history' })).resolves.toEqual(history)
    await expect(f.call('image', { action: 'history' })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_RESULT' })
    await expect(f.call('image', { action: 'history', project_id: 'other' })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_PROJECT' })
    expect(f.request.mock.calls.map(([route]) => route)).toEqual([
      '/providers/image', `/projects/${project.id}/image-jobs?limit=60`,
      '/providers/image', `/projects/${project.id}/image-jobs?limit=60`, '/providers/image',
    ])
  })

  it.each([
    { name: 'an unknown model', overrides: { model: 'missing' } },
    { name: 'a blank prompt', overrides: { prompt: ' ' } },
    { name: 'zero outputs', overrides: { count: 0 } },
    { name: 'more than four outputs', overrides: { count: 5 } },
    { name: 'an invalid size', overrides: { size: 'auto' } },
    { name: 'a fixed model with a different count', overrides: { model: 'single', count: 2 } },
    { name: 'a model without reference support', overrides: { model: 'single', reference_paths: ['/fw/media/ref.png'] } },
    { name: 'an external reference', overrides: { reference_paths: ['https://example.org/ref.png'] } },
    { name: 'a reference with query parameters', overrides: { reference_paths: ['/fw/media/ref.png?other=1'] } },
    { name: 'a reference with encoded traversal', overrides: { reference_paths: ['/fw/media/%252e%252e/ref.png'] } },
    { name: 'a reference with a parent segment', overrides: { reference_paths: ['/fw/media/../ref.png'] } },
  ])('does not quote or dispatch image generation for $name', async ({ overrides }) => {
    const f = fixture()
    f.request.mockResolvedValueOnce(models)
    await expect(f.call('image', { action: 'generate', prompt: '夜景', ...overrides }))
      .rejects.toMatchObject({ code: 'JINGLIU_INVALID_ARGUMENTS' })
    expect(f.request).toHaveBeenCalledExactlyOnceWith('/providers/image', { signal: f.signal })
    expect(f.approve).not.toHaveBeenCalled()
  })

  it('rejects an image quote issued for another operation or with invalid cents', async () => {
    await useReceiptHome()
    for (const quote of [{ ok: true, kind: 'narration', estimate_fen: 25 }, { ok: true, kind: 'image', estimate_fen: -1 },
      { ok: true, kind: 'image', estimate_fen: 0.25 }, { ok: true, kind: 'image', estimate_fen: '25' }]) {
      const f = fixture()
      f.request.mockResolvedValueOnce(models).mockResolvedValueOnce(quote)
      await expect(f.call('image', { action: 'generate', prompt: '夜景' })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_QUOTE' })
      expect(f.request.mock.calls.map(([route]) => route)).toEqual(['/providers/image', '/desktop-agent/tool'])
      expect(f.approve).not.toHaveBeenCalled()
    }
  })

  it('does not present a zero quote as free or dispatch when the user declines', async () => {
    await useReceiptHome()
    const f = fixture()
    f.approve.mockResolvedValueOnce(false)
    f.request.mockResolvedValueOnce(models).mockResolvedValueOnce({ ok: true, kind: 'image', estimate_fen: 0 })
    await expect(f.call('image', { action: 'generate', prompt: ' 夜景 ', reference_paths: ['/fwp/media/ref.png'] }))
      .rejects.toMatchObject({ code: 'JINGLIU_APPROVAL_REQUIRED' })
    expect(f.approve.mock.calls[0]?.[1]).toBe('镜流生图 · gpt-image-2 · 1 张 · 1024x1024\n镜流未给出金额，费用以实际结算为准\n夜景')
    expect(f.request.mock.calls.map(([route]) => route)).toEqual(['/providers/image', '/desktop-agent/tool'])
  })
})
