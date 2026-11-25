import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JingliuSession } from '@deepseek-ai/dsh-jingliu-connection'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { type Dependencies, workflowTools } from '../src/workflow-tools.ts'

const project = { id: 'film-1', title: '雨夜' }
const sid = 'session-1'
const account = 'alice'
const callId = 'call-1'
const projectRead = {
  name: 'project_info', description: '读取明细', role: 'viewer', risk: 'read', account_scoped: false,
  costs: false, long_running: false, needs_confirm: false, parameters: { type: 'object', properties: { project_id: { type: 'string' } } },
}
const draftWorkflow = { ...projectRead, name: 'export_jianying', parameters: { type: 'object', properties: {
  ...projectRead.parameters.properties, single_file: { type: 'boolean' },
} } }
const listing = (...tools: object[]) => ({ count: tools.length, tools })

function fixture({ cwd, hasSession = true, draftRoot, transport = {} }: {
  cwd?: string
  hasSession?: boolean
  draftRoot?: Dependencies['draftRoot']
  transport?: Pick<JingliuSession, 'media' | 'download' | 'place'>
} = {}) {
  const request = vi.fn<JingliuSession['request']>()
  const connect = vi.fn(async () => ({ identity: account, request, ...transport }))
  const approve = vi.fn<Dependencies['approve']>(async () => true)
  const selected = vi.fn<NonNullable<Dependencies['selected']>>(async () => project)
  const tools = workflowTools({ connect, approve, selected, ...(draftRoot === undefined ? {} : { draftRoot }) })
  const controller = new AbortController()
  const signal = controller.signal
  const definition = (name: string) => {
    const tool = tools.find(entry => entry.name === name)
    if (!tool) throw new Error(`Missing tool ${name}`)
    return tool
  }
  const call = (name: string, args: Record<string, unknown>) => {
    const agent = { session: { id: sid, header: { cwd } } } as NonNullable<ToolRunContext['agent']>
    const toolId = ToolCallId(callId)
    return definition(name).execute(args, { arguments: args, name, callId: toolId, rootCallId: toolId,
      token: Symbol() as ToolExecutionToken, ...(hasSession ? { agent } : {}), signal, deferContext() {}, concludeTurn() {},
    })
  }
  return { request, connect, approve, selected, signal, controller, definition,
    discovery: (args: Record<string, unknown>) => call('jingliu_workflows', args),
    run: (args: Record<string, unknown>) => call('jingliu_run', args),
    narration: (args: Record<string, unknown>) => call('jingliu_narration', { project_id: project.id, ...args }),
  }
}

async function temporary(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}

const archiveUrl = '/fw/media/exports/draft.zip'
const materialPath = '/fw/media/generated/clip.mp4'
const archiveSummary = { url: archiveUrl, shots: 1, materials: 1, materials_bytes: 4 }

async function draftFixture() {
  const workspace = await temporary('jingliu-tool-draft-')
  const root = join(workspace, 'drafts')
  await mkdir(root)
  const original = join(workspace, 'clip.mp4')
  await writeFile(original, 'clip')
  const name = '第1集'
  const bytes = zipSync({
    'pack/manifest.json': strToU8(JSON.stringify({
      drafts: [{ name }], materials: [{ name: 'clip.mp4', url: materialPath, size: 4 }],
      mat_token: '__SFMAT__', draft_token: '__SFDRAFT__', root_token: '__SFROOT__',
    })),
    [`pack/drafts/${name}/draft_content.json`]: strToU8(JSON.stringify({ tracks: [{ type: 'video', segments: [{ id: 'clip-1' }] }] })),
    [`pack/drafts/${name}/draft_meta_info.json`]: strToU8('{}'),
  })
  const media = vi.fn<NonNullable<JingliuSession['media']>>(async (path, _signal, consume) => {
    expect([archiveUrl, materialPath]).toContain(path)
    await consume(new Response(path === archiveUrl ? new Uint8Array(bytes) : 'clip'))
  })
  const download = vi.fn<NonNullable<JingliuSession['download']>>(async () => new Map([[materialPath,
    { path: materialPath, file: original, size: 4, contentType: 'video/mp4' }]]))
  const place = vi.fn<NonNullable<JingliuSession['place']>>(async (file, path) => { await copyFile(file.file, path) })
  return { root, workspace, media, download, transport: { media, download, place } }
}

describe('Jingliu workflow catalog and dispatch', () => {
  it('lists account and project entries one page at a time without confirmation', async () => {
    const f = fixture()
    const accountRead = { ...projectRead, name: 'account_info', account_scoped: true }
    const entries = [accountRead, ...Array.from({ length: 24 }, (_, index) => ({ ...projectRead, name: `project_${index}` }))]
    f.request.mockResolvedValue(listing(...entries))
    await expect(f.discovery({ offset: -1 })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_ARGUMENTS' })
    expect(f.request).not.toHaveBeenCalled()
    await expect(f.discovery({})).resolves.toMatchObject({ total: 25, next_offset: 24,
      workflows: [{ name: accountRead.name, scope: 'account' }, ...entries.slice(1, 24).map(({ name }) => ({ name, scope: 'project' }))],
    })
    const next = { total: 25, workflows: [{ name: 'project_23', description: '读取明细', risk: 'read', costs: false, scope: 'project' }] }
    await expect(f.discovery({ offset: 24 })).resolves.toEqual(next)
    const tool = f.definition('jingliu_workflows')
    expect(tool.isConcurrencySafe?.({})).toBe(true)
    expect(tool.output.render({}, next)).toEqual([{ type: 'text', text: JSON.stringify(next) }])
    expect(f.approve).not.toHaveBeenCalled()
  })

  it('uses the selected project and refuses a different project or missing Muse session before dispatch', async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce(listing(projectRead)).mockResolvedValueOnce(listing(projectRead)).mockResolvedValueOnce({ rows: [] })
    const args = { workflow: projectRead.name }
    await expect(f.run({ ...args, project_id: 'different' })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_PROJECT' })
    await expect(f.run(args)).resolves.toEqual({ workflow: projectRead.name, project_id: project.id, result: { rows: [] } })
    expect(f.selected.mock.calls).toEqual([[sid, account], [sid, account]])
    expect(f.request.mock.calls.at(-1)).toEqual(['/desktop-agent/tool', { method: 'POST', signal: f.signal, body: {
      name: projectRead.name, project_id: project.id, args: { project_id: project.id }, call_id: `${sid}:${callId}`, confirmed: false,
    } }])
    expect(f.definition('jingliu_run').presentCall?.(args)).toMatchObject({ title: `镜流 · ${projectRead.name}`, rawInput: args })
    const outside = fixture({ hasSession: false })
    await expect(outside.run(args)).rejects.toMatchObject({ code: 'JINGLIU_SESSION_REQUIRED' })
    expect(outside.connect).not.toHaveBeenCalled()
  })

  it('stops on a bad quote or when the write approval ends after the call was cancelled', async () => {
    const f = fixture()
    const generate = { ...projectRead, name: 'render_image', risk: 'generate' }
    const write = { ...projectRead, name: 'save_project', risk: 'write' }
    f.request.mockResolvedValueOnce(listing(generate)).mockResolvedValueOnce({ tool: 'other', estimate_fen: 200, note: '' })
    await expect(f.run({ workflow: generate.name })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_QUOTE' })
    expect(f.approve).not.toHaveBeenCalled()
    const cancelled = new Error('Workflow cancelled during confirmation')
    f.request.mockResolvedValueOnce(listing(write))
    f.approve.mockImplementationOnce(async () => { f.controller.abort(cancelled); return true })
    await expect(f.run({ workflow: write.name })).rejects.toBe(cancelled)
    expect(f.request.mock.calls.map(([route]) => route)).toEqual(['/desktop-agent/tools', '/desktop-agent/quote', '/desktop-agent/tools'])
  })

  it('quotes the exact locked shots, rechecks the approval text and dispatches only the confirmed scope', async () => {
    const f = fixture()
    const video = { ...projectRead, name: 'run_shot_videos', risk: 'generate', parameters: {
      type: 'object', properties: {
        ...projectRead.parameters.properties, episode: { type: 'integer' }, shot_ids: { type: 'array', items: { type: 'string' } },
      },
    } }
    const prompt = '车灯照亮湿漉漉的路面。'
    const shot = { ok: true, id: 'shot-1', override: { prompt }, gen_prompt: prompt, prompt_state: 'manual' }
    f.request.mockResolvedValueOnce(listing(video))
      .mockResolvedValueOnce({ ok: true, truncated: false, total: 1, shots: [{ id: shot.id }] })
      .mockResolvedValueOnce(shot).mockResolvedValueOnce({ tool: video.name, estimate_fen: 0, note: '' })
      .mockResolvedValueOnce(shot).mockResolvedValueOnce({ job_id: 'job-1' })
    await expect(f.run({ workflow: video.name, args: { episode: 7 } })).resolves.toMatchObject({ result: { job_id: 'job-1' } })
    const operation = { name: video.name, project_id: project.id, args: { project_id: project.id, shot_ids: [shot.id] } }
    expect(f.approve.mock.calls[0]?.[1]).toContain(`费用以实际结算为准\n${shot.id}\n${prompt}`)
    expect(f.request.mock.calls[3]).toEqual(['/desktop-agent/quote', { method: 'POST', signal: f.signal, body: operation }])
    expect(f.request.mock.calls[4]?.[1]?.body).toEqual({ name: 'get_shot', project_id: project.id, args: { shot_id: shot.id } })
    expect(f.request.mock.calls[5]?.[1]?.body).toEqual({ ...operation, call_id: `${sid}:${callId}`, confirmed: false })
  })

  it.each([
    { result: false, code: 'JINGLIU_INVALID_RESULT', message: '镜流返回了无法识别的执行结果。请核对原任务。' },
    { result: { ok: false, message: '无法读取镜头' }, code: 'JINGLIU_WORKFLOW_REJECTED', message: '无法读取镜头' },
    { result: { ok: false, error: null }, code: 'JINGLIU_WORKFLOW_REJECTED', message: '镜流未完成本次工作流。' },
  ])('reports $code without retrying a rejected result', async ({ result, code, message }) => {
    const f = fixture()
    f.request.mockResolvedValueOnce(listing(projectRead)).mockResolvedValueOnce(result)
    await expect(f.run({ workflow: projectRead.name })).rejects.toMatchObject({ code, message })
    expect(f.request).toHaveBeenCalledTimes(2)
  })

  it('requires configured draft settings when the studio workflow can install local media', async () => {
    const download = vi.fn<NonNullable<JingliuSession['download']>>()
    const f = fixture({ draftRoot: async () => '', transport: { download } })
    f.request.mockResolvedValueOnce(listing(draftWorkflow))
    await expect(f.run({ workflow: draftWorkflow.name })).rejects.toMatchObject({ code: 'JINGLIU_DRAFT_ROOT_REQUIRED' })
    expect(f.request).toHaveBeenCalledTimes(1)
    expect(f.approve).not.toHaveBeenCalled()
  })

  it.each([true, false])('installs the confirmed studio export with workspace available = %s', async (hasWorkspace) => {
    const draft = await draftFixture()
    const f = fixture({
      ...(hasWorkspace ? { cwd: draft.workspace } : {}), draftRoot: async () => draft.root, transport: draft.transport,
    })
    f.request.mockResolvedValueOnce(listing(draftWorkflow)).mockResolvedValueOnce(archiveSummary)
    const outcome = await f.run({ workflow: draftWorkflow.name })
    expect(outcome).toMatchObject({ workflow: draftWorkflow.name, project_id: project.id, draft: { materials: 1, bytes: 4 } })
    expect(f.approve.mock.calls[0]?.[1]).toContain(draft.root)
    expect(f.request.mock.calls[1]?.[1]?.body).toMatchObject({ args: { project_id: project.id, single_file: false } })
    if (hasWorkspace) {
      expect(draft.download).toHaveBeenCalledExactlyOnceWith([materialPath], join(draft.workspace, 'jingliu', project.id), f.signal)
    } else {
      expect(draft.download).not.toHaveBeenCalled()
      expect(draft.media.mock.calls.map(([path]) => path)).toEqual([archiveUrl, materialPath])
    }
  })
})

const narrationRoot = `/projects/${project.id}/nd`
const narrationState = { episodes: [{ episode: 1, shots: [{ id: 'shot-1', status: 'aligned' }] }], models: ['voice-1'], has_script: true }

async function useReceiptHome() {
  vi.stubEnv('DSH_HOME', await temporary('jingliu-narration-'))
  onTestFinished(() => { vi.unstubAllEnvs() })
}

describe('Jingliu narration production', () => {
  it.each([
    { action: 'state', shot_id: 'shot-1' },
    { action: 'produce', shot_id: 'shot-1', episode: 1 },
    { action: 'breakdown', model: 'voice-1' },
    { action: 'produce', force: true },
    { action: 'export', beat: 1 },
    { action: 'breakdown', episode: 0 },
  ])('rejects a mismatched $action scope before contacting the studio', async (args) => {
    const f = fixture()
    await expect(f.narration(args)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_ARGUMENTS' })
    expect(f.connect).not.toHaveBeenCalled()
  })

  it('rejects a draft from a different selected production', async () => {
    const f = fixture()
    await expect(f.narration({ action: 'export', project_id: 'other-project' }))
      .rejects.toMatchObject({ code: 'JINGLIU_INVALID_PROJECT' })
    expect(f.selected).toHaveBeenCalledExactlyOnceWith(sid, account)
    expect(f.request).not.toHaveBeenCalled()
  })

  it('reads the current narration state but requires a Muse session to change it', async () => {
    const f = fixture({ hasSession: false })
    f.request.mockResolvedValue(narrationState)
    await expect(f.narration({ action: 'state' })).resolves.toEqual(narrationState)
    await expect(f.narration({ action: 'model', model: 'voice-1' })).rejects.toMatchObject({ code: 'JINGLIU_SESSION_REQUIRED' })
    const stateRequest = [`${narrationRoot}/state`, { signal: f.signal }]
    expect(f.request.mock.calls).toEqual([stateRequest, stateRequest])
    expect(f.approve).not.toHaveBeenCalled()
  })

  it.each([null, { episodes: [], models: false }])('rejects an unusable narration state', async (state) => {
    const f = fixture()
    f.request.mockResolvedValueOnce(state)
    await expect(f.narration({ action: 'state' })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_RESULT' })
  })

  it('accepts the named report beat only after the user confirms it', async () => {
    const f = fixture()
    const response = { accepted: true }
    f.request.mockResolvedValueOnce(narrationState).mockResolvedValueOnce(narrationState).mockResolvedValueOnce(response)
    const args = { action: 'accept', shot_id: 'shot-1' }
    await expect(f.narration(args)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_ARGUMENTS' })
    expect(f.approve).not.toHaveBeenCalled()
    await expect(f.narration({ ...args, beat: 0 })).resolves.toEqual(response)
    expect(f.approve.mock.calls[0]?.[1]).toContain('接受镜头 shot-1 的差异 0')
    expect(f.request.mock.calls.at(-1)).toEqual([`${narrationRoot}/shots/shot-1/accept`, {
      method: 'POST', signal: f.signal, body: { beat: 0 },
    }])
    expect(f.definition('jingliu_narration').output.render(args, response)).toEqual([{ type: 'text', text: JSON.stringify(response) }])
  })

  it('returns a remote full-drama export or refuses to install locally without a configured root', async () => {
    const remote = fixture()
    remote.request.mockResolvedValueOnce(narrationState).mockResolvedValueOnce(archiveSummary)
    await expect(remote.narration({ action: 'export' })).resolves.toEqual(archiveSummary)
    expect(remote.request.mock.calls.at(-1)).toEqual([`${narrationRoot}/export`, {
      method: 'POST', signal: remote.signal, body: { episode: null, single_file: true },
    }])
    expect(remote.approve.mock.calls[0]?.[1]).toContain('导出全剧剪映草稿')
    const local = fixture({ draftRoot: async () => '', transport: { download: vi.fn() } })
    local.request.mockResolvedValueOnce(narrationState)
    await expect(local.narration({ action: 'export' })).rejects.toMatchObject({ code: 'JINGLIU_DRAFT_ROOT_REQUIRED' })
    expect(local.request).toHaveBeenCalledTimes(1)
    expect(local.approve).not.toHaveBeenCalled()
  })

  it('installs a confirmed episode export and uses the selected project media folder', async () => {
    const draft = await draftFixture()
    const f = fixture({ cwd: draft.workspace, draftRoot: async () => draft.root, transport: draft.transport })
    f.request.mockResolvedValueOnce(narrationState).mockResolvedValueOnce(archiveSummary)
    await expect(f.narration({ action: 'export', episode: 1 })).resolves.toMatchObject({ draft: { materials: 1, bytes: 4 } })
    expect(f.approve.mock.calls[0]?.[1]).toContain(`导出第 1 集剪映草稿到 ${draft.root}`)
    expect(f.request.mock.calls.at(-1)).toEqual([`${narrationRoot}/export`, {
      method: 'POST', signal: f.signal, body: { episode: 1, single_file: false },
    }])
    expect(draft.download).toHaveBeenCalledExactlyOnceWith([materialPath], join(draft.workspace, 'jingliu', project.id), f.signal)
    const [folder] = await readdir(draft.root)
    if (folder === undefined) throw new Error('Draft directory missing')
    expect(await readFile(join(draft.root, folder, 'media', 'clip.mp4'), 'utf8')).toBe('clip')
  })

  it.each([
    { name: 'new episodes', args: {}, estimate: { project_id: project.id }, effect: '全剧 · 为尚未拆解的集拆台词' },
    { name: 'the whole drama by request', args: { force: true }, estimate: { project_id: project.id, force: true },
      effect: '全剧 · 重拆台词并替换已有分镜' },
    { name: 'the specified episode', args: { episode: 1 }, estimate: { project_id: project.id, episodes: [1] },
      effect: '第 1 集 · 重拆台词并替换已有分镜' },
  ])('quotes and submits dialogue breakdown for $name', async ({ args, estimate, effect }) => {
    await useReceiptHome()
    const f = fixture()
    f.request.mockResolvedValueOnce(narrationState).mockResolvedValueOnce({ ok: true, kind: 'nd_breakdown', estimate_fen: 100 })
      .mockResolvedValueOnce({ id: 'job-1' })
    await expect(f.narration({ action: 'breakdown', ...args })).resolves.toMatchObject({ job_id: 'job-1' })
    expect(f.approve.mock.calls[0]?.[1]).toContain(`${effect}\n预计 ¥1.00`)
    expect(f.request.mock.calls[1]?.[1]?.body).toEqual({ name: 'cost_estimate', project_id: project.id,
      args: { kind: 'nd_breakdown', project_id: project.id }, call_id: `${sid}:${callId}:quote`,
    })
    expect(f.request.mock.calls.at(-1)).toEqual(['/jobs', { method: 'POST', signal: f.signal,
      body: { kind: 'nd_breakdown', payload: estimate },
    }])
  })

  it('quotes and redoes just the named shot even when its previous result was aligned', async () => {
    await useReceiptHome()
    const f = fixture()
    const state = { ...narrationState, episodes: [null, { episode: 1, shots: false }, { episode: 2,
      shots: [null, { id: 0 }, { id: 'shot-1', status: 'aligned' }, { id: 'shot-2', status: 'aligned' }],
    }] }
    f.request.mockResolvedValueOnce(state).mockResolvedValueOnce({ ok: true, kind: 'nd_produce', estimate_fen: 75 })
      .mockResolvedValueOnce({ id: 'job-shot' })
    await expect(f.narration({ action: 'produce', shot_id: 'shot-2' })).resolves.toMatchObject({ job_id: 'job-shot' })
    expect(f.approve.mock.calls[0]?.[1]).toContain('镜头 shot-2 · 出片和核对')
    expect(f.request.mock.calls[1]?.[1]?.body).toMatchObject({ args: { shot_ids: ['shot-2'] } })
    expect(f.request.mock.calls[2]?.[1]?.body).toEqual({
      kind: 'nd_produce', payload: { project_id: project.id, shot_ids: ['shot-2'], redo: true },
    })
  })

  it('does not approve or submit when the script is missing or the quotation is invalid', async () => {
    await useReceiptHome()
    const f = fixture()
    const args = { action: 'breakdown' }
    f.request.mockResolvedValueOnce({ ...narrationState, has_script: false }).mockResolvedValueOnce(narrationState)
      .mockResolvedValueOnce({ ok: true, kind: 'nd_breakdown', estimate_fen: -1 })
    await expect(f.narration(args)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_PROJECT' })
    await expect(f.narration(args)).rejects.toMatchObject({ code: 'JINGLIU_INVALID_QUOTE' })
    expect(f.approve).not.toHaveBeenCalled()
    expect(f.request.mock.calls.map(([route]) => route)).toEqual([
      `${narrationRoot}/state`, `${narrationRoot}/state`, '/desktop-agent/tool',
    ])
  })
})
