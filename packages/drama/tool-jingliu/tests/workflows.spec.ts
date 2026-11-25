import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { JingliuHttpError, type JingliuSession } from '@deepseek-ai/dsh-jingliu-connection'
import type { ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { workflowArgs } from '../src/catalog.ts'
import { workflowTools } from '../src/workflow-tools.ts'
import { submitOnce } from '../src/submit-once.ts'

const accountRead = { name: 'list_projects', description: '列项目', role: 'viewer', risk: 'read',
  account_scoped: true, costs: false, long_running: false, needs_confirm: false,
  parameters: { type: 'object', properties: {} } }
const produce = { ...accountRead, name: 'run_asset_generate', description: '生成镜头视频', account_scoped: false,
  risk: 'generate', costs: true, long_running: true,
  parameters: { type: 'object', required: ['project_id'], properties: {
    project_id: { type: 'string' }, shot_ids: { type: 'array', items: { type: 'string' } },
  } } }

const definitions = { count: 2, tools: [accountRead, produce] }
const quote = { tool: produce.name, estimate_fen: 248, note: '1 镜' }
function fixture() {
  const request = vi.fn<JingliuSession['request']>()
  const approve = vi.fn(async (_exec: ToolRunContext, _message: string) => true)
  const tools = workflowTools({ connect: async () => ({ identity: 'user-project', request }), approve })
  const call = (name: string, args: Record<string, unknown>) => {
    const tool = tools.find(entry => entry.name === name)!
    const id = ToolCallId('call-1')
    const ctx: ToolRunContext = {
      callId: id, rootCallId: id, token: Symbol() as ToolExecutionToken, arguments: args, name,
      agent: { session: { id: 'session-9' } } as ToolRunContext['agent'] & object,
      signal: new AbortController().signal, deferContext() {}, concludeTurn() {},
    }
    return tool.execute(args, ctx)
  }
  return { request, approve, call }
}

describe('Jingliu workflow gateway', () => {
  it('searches without changing the conversation and requests confirmation before selecting a project', async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce({ projects: [{ id: 'film', title: '雨夜', my_role: 'manager' }] })
    await expect(f.call('jingliu_projects', { action: 'search', query: '雨' })).resolves.toMatchObject({ projects: [{ id: 'film', title: '雨夜' }] })
    expect(f.approve).not.toHaveBeenCalled()
    f.request.mockResolvedValueOnce({ id: 'film', title: '雨夜' })
    await expect(f.call('jingliu_projects', { action: 'select', project_id: 'film' })).rejects.toMatchObject({ code: 'JINGLIU_APPROVAL_REQUIRED' })
  })
  it('quotes the default image model and reuses the original job on retry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jingliu-images-'))
    vi.stubEnv('DSH_HOME', dir)
    onTestFinished(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }) })
    const f = fixture()
    const models = { models: [{ id: 'gpt-image-2' }] }
    f.request.mockResolvedValueOnce(models).mockResolvedValueOnce({ ok: true, kind: 'image', estimate_fen: 25 }).mockResolvedValueOnce({ id: 'job-image' })
    const args = { action: 'generate', project_id: 'film', prompt: '暮色中的小站', count: 2 }
    await expect(f.call('jingliu_image', args)).resolves.toMatchObject({ job_id: 'job-image' })
    expect(f.approve.mock.calls[0]?.[1]).toContain('预计 ¥0.50')
    expect(f.request.mock.calls.at(-1)).toMatchObject(['/jobs', { method: 'POST', body: { kind: 'image', payload: { model_id: 'gpt-image-2', project_id: 'film', n: 2 } } }])
    f.request.mockResolvedValueOnce(models)
    await expect(f.call('jingliu_image', args)).resolves.toMatchObject({ job_id: 'job-image' })
    expect(f.approve).toHaveBeenCalledTimes(1)
  })
  it('requires a locked prompt and checks it again after the quote', async () => {
    const f = fixture()
    const video = { ...produce, name: 'run_shot_videos' }
    const catalog = { tools: [video], count: 1 }
    const shot = { ok: true, id: 's', override: { prompt: '原稿' }, gen_prompt: '原稿', prompt_state: 'manual', stale: false }
    const args = { workflow: video.name, project_id: 'film', args: { shot_ids: ['s'] } }
    f.request.mockResolvedValueOnce(catalog).mockResolvedValueOnce({ ...shot, prompt_state: 'auto' })
    await expect(f.call('jingliu_run', args)).rejects.toMatchObject({ code: 'JINGLIU_SHOT_REVIEW_REQUIRED' })
    f.request.mockResolvedValueOnce(catalog).mockResolvedValueOnce(shot).mockResolvedValueOnce({ ...quote, tool: video.name })
      .mockResolvedValueOnce({ ...shot, override: { prompt: '改稿' }, gen_prompt: '改稿' })
    await expect(f.call('jingliu_run', args)).rejects.toMatchObject({ code: 'JINGLIU_SHOT_CHANGED' })
    expect(f.request.mock.calls.filter(([path, options]) => path === '/desktop-agent/tool' && JSON.stringify(options?.body).includes('run_shot_videos'))).toHaveLength(0)
  })
  it('only modifies a subtitle returned in this project and checks the native response', async () => {
    const f = fixture()
    const args = { action: 'edit_subtitle', project_id: 'film', clip_id: 'a', text: ' 小舟 ' }
    f.request.mockResolvedValueOnce({ clips: [{ id: 'b' }] })
    await expect(f.call('jingliu_studio', args)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_ARGUMENTS' })
    f.request.mockResolvedValueOnce({ clips: [{ id: 'a' }] }).mockResolvedValueOnce({ id: 'a', text: '小舟' })
    await expect(f.call('jingliu_studio', args)).resolves.toMatchObject({ id: 'a', text: '小舟' })
    expect(f.request.mock.calls.at(-1)?.[1]?.body).toEqual({ text: '小舟' })
  })
  it('edits only the text of a subtitle; times belong to episode_subtitles', async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce({ clips: [{ id: 'a' }] })
    await expect(f.call('jingliu_studio', { action: 'edit_subtitle', project_id: 'film', clip_id: 'a', text: '  ' }))
      .rejects.toMatchObject({ code: 'JINGLIU_INVALID_ARGUMENTS' })
    expect(f.request).toHaveBeenCalledTimes(1)
  })
  it('discovers a workflow added by the server and returns its exact nested schema', async () => {
    const f = fixture()
    f.request.mockResolvedValue(definitions)
    await expect(f.call('jingliu_workflows', { query: '生成' })).resolves.toMatchObject({ total: 1, workflows: [{ name: 'run_asset_generate' }] })
    await expect(f.call('jingliu_workflows', { name: 'run_asset_generate' })).resolves.toEqual(produce)
    expect(f.approve).not.toHaveBeenCalled()
  })
  it.each([
    { name: 'an incomplete page', response: { count: 3, tools: definitions.tools } },
    { name: 'a duplicate operation', response: { count: 2, tools: [accountRead, accountRead] } },
    { name: 'a malformed operation', response: { count: 1, tools: [{ ...produce, needs_confirm: 'yes' }] } },
    { name: 'an invalid argument schema', response: { count: 1, tools: [{ ...produce, parameters: { ...produce.parameters, required: [1] } }] } },
  ])('rejects $name before quoting or dispatching a workflow', async ({ response }) => {
    const f = fixture()
    f.request.mockResolvedValueOnce(response)
    await expect(f.call('jingliu_run', { workflow: produce.name, project_id: 'film' }))
      .rejects.toMatchObject({ code: 'JINGLIU_INVALID_CATALOG' })
    expect(f.request.mock.calls.map(([route]) => route)).toEqual(['/desktop-agent/tools'])
    expect(f.approve).not.toHaveBeenCalled()
  })
  it('rejects malformed property definitions before validating a workflow call', () => {
    expect(() => workflowArgs({ ...produce, risk: 'generate', parameters: { type: 'object', properties: [] } }, 'film', {}))
      .toThrow(expect.objectContaining({ code: 'JINGLIU_INVALID_CATALOG' }))
  })
  it('invokes a read with the active account and original call identity', async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce(definitions).mockResolvedValueOnce({ rows: [] })
    await expect(f.call('jingliu_run', { workflow: 'list_projects' })).resolves.toMatchObject({ result: { rows: [] } })
    expect(f.request.mock.calls[1]?.[1]?.body).toEqual({ name: 'list_projects', args: {}, project_id: '', confirmed: false, call_id: 'session-9:call-1' })
    expect(f.approve).not.toHaveBeenCalled()
  })
  it('reports an explicitly rejected workflow returned in a successful HTTP response', async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce(definitions).mockResolvedValueOnce({ ok: false, error: '找不到该任务' })
    await expect(f.call('jingliu_run', { workflow: 'list_projects' })).rejects.toMatchObject({
      code: 'JINGLIU_WORKFLOW_REJECTED', message: '找不到该任务',
    })
  })
  it.each([
    { workflow: 'run_asset_generate' },
    { workflow: 'list_projects', project_id: 'one' },
    { workflow: 'run_asset_generate', project_id: 'one', args: { project_id: 'other' } },
    { workflow: 'run_asset_generate', project_id: 'one', args: { confirmed: true } },
    { workflow: 'run_asset_generate', project_id: 'one', args: { shot_ids: [7] } },
    { workflow: 'not_registered', project_id: 'one' },
  ])('does not quote or submit an unknown, mistyped or cross-project call', async (args) => {
    const f = fixture()
    f.request.mockResolvedValue(definitions)
    await expect(f.call('jingliu_run', args)).rejects.toThrow()
    expect(f.request).toHaveBeenCalledTimes(1)
    expect(f.approve).not.toHaveBeenCalled()
  })
  it('does not submit a cost when the user declines', async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce(definitions).mockResolvedValueOnce(quote)
    f.approve.mockResolvedValue(false)
    await expect(f.call('jingliu_run', { workflow: produce.name, project_id: 'p' })).rejects.toMatchObject({ code: 'JINGLIU_APPROVAL_REQUIRED' })
    expect(f.approve.mock.calls[0]?.[1]).toContain('2.48')
    expect(f.request.mock.calls.map(call => call[0])).toEqual(['/desktop-agent/tools', '/desktop-agent/quote'])
  })
  it('confirms the actual replacement warning and preserves the call ID across both requests', async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce(definitions).mockResolvedValueOnce(quote)
      .mockRejectedValueOnce(new JingliuHttpError(409, 'needs_confirm', '将替换第1集的分镜')).mockResolvedValueOnce({ job_id: 'job-x' })
    await expect(f.call('jingliu_run', { workflow: produce.name, project_id: 'p', args: { shot_ids: ['one'] } })).resolves.toMatchObject({ result: { job_id: 'job-x' } })
    expect(f.approve.mock.calls[1]?.[1]).toContain('将替换第1集的分镜')
    expect(f.request.mock.calls[2]?.[1]?.body).toMatchObject({ project_id: 'p', confirmed: false, call_id: 'session-9:call-1' })
    expect(f.request.mock.calls[3]?.[1]?.body).toMatchObject({ project_id: 'p', confirmed: true, call_id: 'session-9:call-1' })
  })
})

describe('narration jobs', () => {
  it('binds model selection and discrepancy acceptance to the named project', async () => {
    const f = fixture()
    const state = { models: ['h3'], episodes: [], has_script: true }
    f.request.mockResolvedValueOnce(state).mockResolvedValueOnce({ ok: true })
    await f.call('jingliu_narration', { action: 'model', project_id: 'p', model: 'h3' })
    expect(f.request.mock.calls[1]).toMatchObject(['/projects/p/nd/model', { method: 'PUT', body: { model: 'h3' } }])
    f.request.mockResolvedValueOnce(state)
    await expect(f.call('jingliu_narration', { action: 'model', project_id: 'p', model: 'x' })).rejects.toThrow()
    await expect(f.call('jingliu_narration', { action: 'accept', project_id: '../other', shot_id: 's', beat: 1 })).rejects.toThrow()
    expect(f.request).toHaveBeenCalledTimes(3)
  })
  it('does not submit an empty requested episode or a declined quote', async () => {
    const f = fixture()
    const state = { episodes: [{ episode: 1, shots: [{ id: 's', status: 'planned' }] }], models: [], has_script: true }
    f.request.mockResolvedValueOnce(state)
    await expect(f.call('jingliu_narration', { action: 'produce', project_id: 'p', episode: 2 })).rejects.toMatchObject({ code: 'JINGLIU_EMPTY_SCOPE' })
    f.request.mockResolvedValueOnce(state).mockResolvedValueOnce({ ok: true, kind: 'nd_produce', estimate_fen: 1234 })
    f.approve.mockResolvedValue(false)
    await expect(f.call('jingliu_narration', { action: 'produce', project_id: 'p', episode: 1 })).rejects.toThrow()
    expect(f.request.mock.calls[2]?.[1]?.body).toMatchObject({ name: 'cost_estimate', args: { project_id: 'p', kind: 'nd_produce', shot_ids: ['s'] } })
    expect(f.request).toHaveBeenCalledTimes(3)
  })
  it('replays the same receipt and refuses redispatch after transport loss or changed scope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jingliu-receipt-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const submit = vi.fn(async () => ({ id: 'job-a' }))
    await submitOnce(dir, ['s1', 'c1'], ['user1', 'p'], submit)
    await expect(submitOnce(dir, ['s1', 'c1'], ['user1', 'p'], submit)).resolves.toMatchObject({ job_id: 'job-a' })
    await expect(submitOnce(dir, ['s1', 'c1'], ['user2', 'p'], submit)).rejects.toMatchObject({ code: 'JINGLIU_JOB_CONFLICT' })
    submit.mockRejectedValueOnce(new Error('response lost'))
    await expect(submitOnce(dir, ['s1', 'c2'], ['user1', 'p'], submit)).rejects.toMatchObject({ code: 'JINGLIU_JOB_OUTCOME_UNKNOWN' })
    await expect(submitOnce(dir, ['s1', 'c2'], ['user1', 'p'], submit)).rejects.toMatchObject({ code: 'JINGLIU_JOB_OUTCOME_UNKNOWN' })
    expect(submit).toHaveBeenCalledTimes(2)
  })
  it('returns a submitted episode job before processing its now-complete shots or quoting it again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jingliu-episode-'))
    vi.stubEnv('DSH_HOME', dir)
    onTestFinished(async () => {
      vi.unstubAllEnvs()
      await rm(dir, { recursive: true, force: true })
    })
    const f = fixture()
    const args = { action: 'produce', episode: 1, project_id: 'p' }
    f.request.mockResolvedValueOnce({ episodes: [{ episode: 1, shots: [{ id: 's', status: 'planned' }] }], models: [], has_script: true })
      .mockResolvedValueOnce({ ok: true, kind: 'nd_produce', estimate_fen: 990 })
      .mockResolvedValueOnce({ id: 'job' })
    const original = await f.call('jingliu_narration', args)
    expect(original).toMatchObject({ job_id: 'job' })
    expect(f.request.mock.calls[2]?.[1]?.body).toEqual({ kind: 'nd_produce', payload: { project_id: 'p', shot_ids: ['s'] } })
    f.request.mockResolvedValue({ episodes: [{ episode: 1, shots: [{ id: 's', status: 'aligned' }] }], models: [], has_script: true })
    await expect(f.call('jingliu_narration', args)).resolves.toEqual(original)
    expect(f.approve).toHaveBeenCalledTimes(1)
    expect(f.request).toHaveBeenCalledTimes(3)
  })
})
