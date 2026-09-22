import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, name, workspacePipelineToken } from '../src/index.ts'
import { JubianImageRoutes } from '../src/image.ts'
import { JubianToken } from '../src/token.ts'

interface Registered {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** Mount the plugin against a stub `tools` registry and a stub credential store. */
async function mount(): Promise<{ registered: Registered[]; mounted: unknown[] }> {
  const registered: Registered[] = []
  const mounted: unknown[] = []
  const ctx = {
    plugin: (plugin: unknown) => { mounted.push(plugin) },
    get: () => undefined,
    tools: {
      register: (definition: Registered) => {
        registered.push(definition)
        return () => {}
      },
    },
    credentials: { resolve: async () => ({ value: 'eyJhbGci.payload.sig', source: 'file' }) },
  } as unknown as Context
  apply(ctx, { ledgerRoot: await mkdtemp(join(tmpdir(), 'jubian-tools-')) })
  return { registered, mounted }
}

describe('tool-jubian registration', () => {
  it('declares its identity and the services it needs', () => {
    expect(name).toBe('tool-jubian')
    expect(inject).toEqual(['tools', 'credentials'])
  })

  it('mounts both Remote namespaces beside the tools', async () => {
    const { mounted } = await mount()
    expect(mounted).toEqual([JubianToken, JubianImageRoutes])
  })

  it('registers the domain tools and background watcher', async () => {
    const tools = (await mount()).registered
    expect(tools.map(tool => tool.name).sort()).toEqual(
      ['jubian_asset', 'jubian_catalog', 'jubian_media', 'jubian_model', 'jubian_organize', 'jubian_storyboard', 'jubian_video', 'jubian_watch'])
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
      .toEqual(['task', 'tasks', 'subtasks', 'image_generate', 'upscale', 'retry'])

    const asset = byName.get('jubian_asset')!
    expect((asset.properties as Record<string, { enum?: string[] }>).method!.enum)
      .toEqual(['get', 'list', 'materials', 'generated_image', 'confirm_casting', 'remove', 'upload_reference',
        'create_folder', 'move', 'rename'])
    const assetKeys = Object.keys(asset.properties as Record<string, unknown>).sort()
    expect(assetKeys).toContain('image_path')
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
      .toEqual(['get', 'create', 'save', 'generate', 'select_assets', 'prepare_video', 'submit_video',
        'erase_subtitle'])
    expect((storyboard.properties as Record<string, Record<string, unknown>>).selections!).toMatchObject(
      { type: 'array',
        items: { type: 'object', additionalProperties: false, required: ['material_key', 'asset_id'] } })
    const storyboardKeys = Object.keys(storyboard.properties as Record<string, unknown>).sort()
    expect(storyboardKeys).toContain('project_dir')
    expect(storyboardKeys).toContain('preview_path')
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
    const ctx = {
      plugin: () => {},
      tools: { register: (definition: Registered) => { registered.push(definition); return () => {} } },
      credentials: { resolve: async () => undefined },
    } as unknown as Context
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
