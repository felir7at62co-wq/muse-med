import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, inject, name, workspacePipelineToken } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { JubianImageRoutes } from '../src/image.ts'
import { JubianToken } from '../src/token.ts'
import { JubianBudgets } from '../src/budget.ts'

interface Registered {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** Mount the plugin against a stub `tools` registry and a stub credential store. */
async function mount(options: { config?: Partial<Config>; jobs?: { start: (spec: unknown) => string }; defaultLedger?: boolean } = {})
  : Promise<{ registered: Registered[]; mounted: unknown[]; root: string }> {
  const registered: Registered[] = []
  const mounted: unknown[] = []
  const ctx = Object.assign(new Context(), {
    plugin: (plugin: unknown) => { mounted.push(plugin) },
    effect: (callback: () => unknown) => callback(),
    on: () => () => {},
    get: (service: string) => service === 'jobs' ? options.jobs : undefined,
    tools: {
      register: (definition: Registered) => {
        registered.push(definition)
        return () => {}
      },
    },
    credentials: { resolve: async () => ({ value: 'eyJhbGci.payload.sig', source: 'file' }) },
  })
  const root = await mkdtemp(join(tmpdir(), 'jubian-tools-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  if (options.defaultLedger) {
    vi.stubEnv('DSH_HOME', root)
    onTestFinished(() => { vi.unstubAllEnvs() })
  }
  apply(ctx, { ...(options.defaultLedger ? {} : { ledgerRoot: root }), workspaceSecrets: false, ...options.config })
  return { registered, mounted, root }
}

describe('tool-jubian registration', () => {
  it('uses the deployment home for an omitted ledger directory and renders the registered budget output', async () => {
    const { registered, root } = await mount({ defaultLedger: true })
    const budget = registered.find(tool => tool.name === 'jubian_budget')!
    expect(await budget.execute({ action: 'read', script_id: 2708 }, {})).toMatchObject({
      authorization_path: join(root, 'jubian', 'ledger', 'authorization.json'), source: 'unconfigured',
    })
  })
  it.each(['yes', 1, null])('rejects a nonboolean generated-media approval %j at the registered tool schema', async (approval) => {
    const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected transport'))
    onTestFinished(() => { transport.mockRestore() })
    const { registered, root } = await mount(), storyboard = registered.find(tool => tool.name === 'jubian_storyboard')!
    await expect(storyboard.execute({ method: 'delete_preview', script_id: 2708, project_dir: root,
      storyboard_ids: [1], delete_reason: 'User approved card cleanup', authorization_basis: 'Delete card 1',
      include_generated_media: approval }, {})).rejects.toThrow('invalid arguments')
    expect(transport).not.toHaveBeenCalled()
  })

  it.each([{}, { project_dir: '/project' }, { project_dir: '/project', limit_cny: '20' }])
  ('refuses an incomplete registered budget update %j before reading the project', async (fields) => {
    const budget = (await mount()).registered.find(tool => tool.name === 'jubian_budget')!
    await expect(budget.execute({ action: 'update', script_id: 2708, ...fields },
      { agent: {}, signal: new AbortController().signal }))
      .rejects.toThrow('live agent')
  })

  it('starts an owned snatch job, exposes its window and cancels the job hook without leaving a timer', async () => {
    const jobs: { kind: string; owner: string; run: () => { cancel: () => void; done: Promise<{ status: string }> } }[] = []
    const { registered } = await mount({ config: { timeoutMs: 1000, imageActiveTimeoutMs: 1000, imageActivePollMs: 100,
      baseUrl: 'https://workbench.example/', nameSeparator: '｜', seriesLabel: '全剧', assetIndexPath: 'assets/index.json' },
    jobs: { start: (spec) => {
      jobs.push(spec as (typeof jobs)[number])
      return 'owned-snatch-job'
    } } })
    const tool = registered.find(tool => tool.name === 'jubian_snatch')!
    const start_at = new Date(Date.now() + 60000).toISOString(), end_at = new Date(Date.now() + 120000).toISOString()
    const args = { scope: 'ids', script_ids: [11], start_at, end_at,
      idempotency_prefix: 'approved-window', authorization_basis: 'User approved ID 11 within this window' }
    await expect(tool.execute(args, {})).rejects.toThrow('owning Agent')
    expect(jobs).toEqual([])
    expect(await tool.execute(args, { agent: { id: 'mock-owner' } })).toMatchObject({ job_id: 'owned-snatch-job', start_at, end_at })
    expect(jobs[0]).toMatchObject({ kind: 'jubianClaim', owner: 'mock-owner' })
    const hook = jobs[0]!.run()
    try { hook.cancel(); expect((await hook.done).status).toBe('killed') }
    finally { hook.cancel(); await hook.done }
  })

  it('refuses snatch without a jobs provider and protects registered read calls with credential resolution', async () => {
    const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      JSON.stringify({ code: 200, data: { rows: [], total: 0 } })))
    onTestFinished(() => { transport.mockRestore() })
    const { registered } = await mount()
    const start_at = new Date(Date.now() + 60000).toISOString(), end_at = new Date(Date.now() + 120000).toISOString()
    await expect(registered.find(tool => tool.name === 'jubian_snatch')!.execute({ scope: 'ids', script_ids: [11],
      start_at, end_at, idempotency_prefix: 'window', authorization_basis: 'User approved ID 11' }, {})).rejects.toThrow('jobs provider')
    expect(await registered.find(tool => tool.name === 'jubian_find')!.execute({ scope: 'mine', name: 'empty' }, {}))
      .toMatchObject({ matches: [] })
    await expect(registered.find(tool => tool.name === 'jubian_claim')!.execute({ method: 'inspect', script_id: 11 }, {}))
      .rejects.toThrow()
    await expect(registered.find(tool => tool.name === 'jubian_media')!.execute({ method: 'download',
      media_url: 'https://untrusted.example/image.png', media_kind: 'image', output_path: '/unused.png' }, {})).rejects.toThrow()
  })
  it('applies configured readback bounds and index paths before refusing incomplete work', async () => {
    const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected transport'))
    onTestFinished(() => { transport.mockRestore() })
    const { registered, root } = await mount({ config: {
      imageActiveTimeoutMs: 1000, imageActivePollMs: 100, assetIndexPath: 'assets/index.json',
    } })
    await expect(registered.find(tool => tool.name === 'jubian_video')!.execute({ method: 'image_generate',
      script_id: 2708, asset_name: 'lead', asset_type: 1, prompt: 'Portrait' }, {})).rejects.toThrow('idempotency_key')
    await expect(registered.find(tool => tool.name === 'jubian_organize')!.execute({ method: 'index',
      script_id: 2708, project_dir: root }, {})).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })
  it('declares its identity and the services it needs', () => {
    expect(name).toBe('tool-jubian')
    expect(inject).toEqual(['tools', 'credentials'])
  })

  it('mounts both Remote namespaces beside the tools', async () => {
    const { mounted } = await mount()
    expect(mounted).toEqual([JubianToken, JubianBudgets, JubianImageRoutes])
  })

  it('registers the domain tools and background watcher', async () => {
    const tools = (await mount()).registered
    expect(tools.map(tool => tool.name).sort()).toEqual(
      ['jubian_asset', 'jubian_budget', 'jubian_catalog', 'jubian_claim', 'jubian_find', 'jubian_media', 'jubian_model', 'jubian_organize', 'jubian_snatch', 'jubian_storyboard', 'jubian_video', 'jubian_watch'])
  })

  it('states the paid and side-effecting nature in the description itself', async () => {
    const tools = (await mount()).registered
    const byName = new Map(tools.map(tool => [tool.name, tool.description]))
    expect(byName.get('jubian_storyboard')).toContain('计费')
    expect(byName.get('jubian_video')).toContain('计费')
    expect(byName.get('jubian_asset')).toContain('副作用')
    expect(byName.get('jubian_media')).toContain('不产生费用')
    // A model reads the description, not the source: the retry rule must be there.
    for (const tool of ['jubian_asset', 'jubian_storyboard', 'jubian_video']) {
      expect(byName.get(tool)).toContain('idempotency_key')
    }
    // The organization view is the one tool a model must never read as a writer.
    expect(byName.get('jubian_organize')).toContain('只读')
    expect(byName.get('jubian_organize')).toContain('不重命名、不移动')
    // Reorganizing is the user's decision, so the rule travels with the schema.
    expect(byName.get('jubian_asset')).toContain('批量改名或搬家前必须先取得用户明确同意')
    expect(byName.get('jubian_claim')).toContain('canClaim=1')
    expect(byName.get('jubian_claim')).toContain('明确授权')
    expect(byName.get('jubian_snatch')).toContain('明确授权')
    expect(byName.get('jubian_snatch')).toContain('重启不恢复')
  })

  it('describes resolution hints without authorizing paid upscale', async () => {
    const video = (await mount()).registered.find(tool => tool.name === 'jubian_video')!
    const properties = video.parameters.properties as Record<string, { description: string }>
    expect(properties.delivery_resolution!.description).toContain('仅提示实际分辨率低于交付尺寸')
    expect(properties.delivery_resolution!.description).toContain('不是内容不可用判定，也不构成付费义务')
    expect(properties.delivery_resolution!.description).not.toContain('必须先转高清才能使用')
    expect(video.description).toContain('SD2.5 默认使用原片，不自动提交或等待高清')
    expect(video.description).toContain('任何模型都不能仅因 needs_upscale=true 自动付费')
    expect(video.description).toContain('仅在用户明确要求或授权具体高清处理时调用 upscale（包括 SD2.5）')
    expect(video.description).toContain('普通导出尺寸与真实源分辨率须分别如实报告')
  })

  it('gives every tool a method enum and the fields that method needs', async () => {
    const tools = (await mount()).registered
    const byName = new Map(tools.map(tool => [tool.name, tool.parameters]))
    // `defineTool` compiles the authored parameter spec into raw JSON Schema, so
    // the assertions read the compiled shape rather than the authoring shorthand.
    const catalog = byName.get('jubian_catalog')!
    expect(Object.keys(catalog).sort()).toEqual(['properties', 'required', 'type'])
    expect(Object.keys(catalog.properties as Record<string, unknown>).sort()).toEqual(
      ['method', 'page_num', 'page_size', 'script_id', 'standard_id', 'task_type'])
    expect(catalog.required).toEqual(['method'])
    expect((catalog.properties as Record<string, { enum?: string[] }>).method!.enum)
      .toEqual(['models', 'rate', 'script', 'episodes'])

    const video = byName.get('jubian_video')!
    expect((video.properties as Record<string, { enum?: string[] }>).method!.enum)
      .toEqual(['task', 'tasks', 'subtasks', 'unresolved', 'image_generate', 'image_generate_batch', 'upscale', 'retry'])
    expect((video.properties as Record<string, Record<string, unknown>>).items).toMatchObject({
      type: 'array', items: { type: 'object', additionalProperties: false,
        required: ['idempotency_key', 'asset_name', 'prompt'] },
    })

    const asset = byName.get('jubian_asset')!
    expect((asset.properties as Record<string, { enum?: string[] }>).method!.enum)
      .toEqual(['get', 'list', 'materials', 'generated_image', 'confirm_casting', 'register', 'remove', 'upload_reference', 'upload_audio',
        'create_folder', 'move', 'rename', 'audio_list', 'audio_get', 'audio_delete_preview', 'audio_delete_apply'])
    const assetKeys = Object.keys(asset.properties as Record<string, unknown>).sort()
    expect(assetKeys).toContain('image_path')
    expect(assetKeys).toContain('audio_path')
    // The three organization writes need their own arguments in the same schema.
    for (const key of ['folder_name', 'parent_id', 'asset_scope_type', 'root_category_type', 'material_ids',
      'target_folder_id']) {
      expect(assetKeys).toContain(key)
    }

    const organize = byName.get('jubian_organize')!
    expect((organize.properties as Record<string, { enum?: string[] }>).method!.enum).toEqual(['index'])
    expect([...(organize.required as string[])].sort()).toEqual(['method', 'project_dir', 'script_id'])
    expect(Object.keys(organize.properties as Record<string, unknown>).sort())
      .toEqual(['method', 'project_dir', 'script_id'])

    const media = byName.get('jubian_media')!
    expect((media.properties as Record<string, { enum?: string[] }>).media_kind!.enum).toEqual(['image', 'video'])
    expect([...(media.required as string[])].sort()).toEqual(['media_kind', 'media_url', 'method', 'output_path'])

    const storyboard = byName.get('jubian_storyboard')!
    const subtitleBox = (storyboard.properties as Record<string, Record<string, unknown>>).subtitle_box!
    expect(subtitleBox).toMatchObject({ type: 'object', additionalProperties: true })
    // The storyboard-native channel is the only normal subject-video path, so its
    // three methods and their arguments must be visible in the schema.
    expect((storyboard.properties as Record<string, { enum?: string[] }>).method!.enum)
      .toEqual(['list', 'get', 'create', 'create_batch', 'save', 'edit_preview', 'edit_batch_preview', 'edit_apply',
        'generate', 'select_assets', 'prepare_video', 'submit_video', 'submit_video_batch', 'erase_subtitle',
        'delete_preview', 'delete_apply', 'audio_preview', 'audio_apply'])
    expect((storyboard.properties as Record<string, Record<string, unknown>>).selections!).toMatchObject(
      { type: 'array',
        items: { type: 'object', additionalProperties: false, required: ['material_key', 'asset_id'] } })
    const storyboardKeys = Object.keys(storyboard.properties as Record<string, unknown>).sort()
    expect(storyboardKeys).toContain('project_dir')
    expect(storyboardKeys).toContain('preview_path')
    expect(storyboardKeys).toContain('video_previews')
    expect(storyboardKeys).toContain('package_number')
    expect(storyboardKeys).toContain('episode')
    // The category decides the name segment and the asset library, so the schema
    // offers it wherever a name is composed.
    const videoParameters = byName.get('jubian_video')!.properties as Record<string, Record<string, unknown>>
    expect((videoParameters.asset_category as { enum?: string[] }).enum).toEqual(['角色', '场景', '道具'])
    expect(videoParameters.episode).toMatchObject({ type: 'string' })
  })

  it('routes the three organization writes and the index view without touching the network', async () => {
    const tools = (await mount()).registered
    const asset = tools.find(tool => tool.name === 'jubian_asset')!
    // Each call satisfies `requireArguments` and then fails on the missing key,
    // which is what proves the method reached its own writer.
    await expect(asset.execute({ method: 'create_folder', folder_name: 'EP05', asset_scope_type: 2,
      root_category_type: 1 }, {})).rejects.toThrow(/idempotency_key/)
    await expect(asset.execute({ method: 'move', material_ids: [900], target_folder_id: 11,
      asset_scope_type: 2, root_category_type: 1 }, {})).rejects.toThrow(/idempotency_key/)
    await expect(asset.execute({ method: 'rename', material_id: 900, asset_name: 'x' }, {}))
      .rejects.toThrow(/idempotency_key/)
    // The registry validates the method against the schema's enum, so an
    // unknown method never reaches the dispatcher's own default arm.
    await expect(asset.execute({ method: 'nope' }, {})).rejects.toThrow(/invalid arguments/)

    const organize = tools.find(tool => tool.name === 'jubian_organize')!
    await expect(organize.execute({ method: 'index', script_id: 1,
      project_dir: join(tmpdir(), 'jubian-absent-project') }, {})).rejects.toThrow(/assets_manifest\.json/)

    const storyboard = tools.find(tool => tool.name === 'jubian_storyboard')!
    await expect(storyboard.execute({ method: 'select_assets', storyboard_id: 1, selections: [] }, {}))
      .rejects.toThrow(/idempotency_key/)
  })

  it('refuses a paid method with no idempotency key before it touches the network', async () => {
    const tools = (await mount()).registered
    const video = tools.find(tool => tool.name === 'jubian_video')!
    await expect(video.execute({ method: 'image_generate', script_id: 1, asset_name: 'x', asset_type: 1,
      prompt: 'p' }, {})).rejects.toThrow()
  })

  it('reports a missing credential as an authentication failure rather than a crash', async () => {
    const registered: Registered[] = []
    const ctx = Object.assign(new Context(), {
      plugin: () => {},
      effect: (callback: () => unknown) => callback(),
      on: () => () => {},
      tools: { register: (definition: Registered) => { registered.push(definition); return () => {} } },
      credentials: { resolve: async () => undefined },
    })
    apply(ctx, { ledgerRoot: await mkdtemp(join(tmpdir(), 'jubian-tools-')) })
    const catalog = registered.find(tool => tool.name === 'jubian_catalog')!
    await expect(catalog.execute({ method: 'models', task_type: 2 }, {})).rejects.toMatchObject(
      { code: 'AUTHENTICATION_REQUIRED' })
  })

  it('falls back to the workspace pipeline secret file, preferring the admin token', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'jubian-workspace-'))
    const nested = join(workspace, 'projects', 'demo')
    await mkdir(join(workspace, '.agents', 'secrets'), { recursive: true })
    await mkdir(nested, { recursive: true })
    await writeFile(join(workspace, '.agents', 'secrets', 'pipeline.env'),
      '# comment\nJUBIANAI_TOKEN=legacy-value\nJUBIANAI_ADMIN_TOKEN="preferred-value"\n', 'utf8')
    try {
      expect(await workspacePipelineToken(nested)).toBe('preferred-value')
      await writeFile(join(workspace, '.agents', 'secrets', 'pipeline.env'),
        'JUBIANAI_TOKEN=legacy-only\n', 'utf8')
      expect(await workspacePipelineToken(nested)).toBe('legacy-only')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
