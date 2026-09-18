import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, name } from '../src/index.ts'

interface Registered {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** Mount the plugin against a stub `tools` registry and a stub credential store. */
async function mount(): Promise<Registered[]> {
  const registered: Registered[] = []
  const ctx = {
    tools: {
      register: (definition: Registered) => {
        registered.push(definition)
        return () => {}
      },
    },
    credentials: { resolve: async () => ({ value: 'eyJhbGci.payload.sig', source: 'file' }) },
  } as unknown as Context
  apply(ctx, { ledgerRoot: await mkdtemp(join(tmpdir(), 'jubian-tools-')) })
  return registered
}

describe('tool-jubian registration', () => {
  it('declares its identity and the services it needs', () => {
    expect(name).toBe('tool-jubian')
    expect(inject).toEqual(['tools', 'credentials'])
  })

  it('registers exactly the five domain tools', async () => {
    const tools = await mount()
    expect(tools.map(tool => tool.name).sort()).toEqual(
      ['jubian_asset', 'jubian_catalog', 'jubian_media', 'jubian_storyboard', 'jubian_video'])
  })

  it('states the paid and side-effecting nature in the description itself', async () => {
    const tools = await mount()
    const byName = new Map(tools.map(tool => [tool.name, tool.description]))
    expect(byName.get('jubian_storyboard')).toContain('计费')
    expect(byName.get('jubian_video')).toContain('计费')
    expect(byName.get('jubian_asset')).toContain('副作用')
    expect(byName.get('jubian_media')).toContain('不产生费用')
    // A model reads the description, not the source: the retry rule must be there.
    for (const tool of ['jubian_asset', 'jubian_storyboard', 'jubian_video']) {
      expect(byName.get(tool)).toContain('idempotency_key')
    }
  })

  it('gives every tool a method enum and the fields that method needs', async () => {
    const tools = await mount()
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
      .toEqual(['task', 'tasks', 'subtasks', 'image_generate', 'upscale'])

    const media = byName.get('jubian_media')!
    expect((media.properties as Record<string, { enum?: string[] }>).media_kind!.enum).toEqual(['image', 'video'])
    expect([...(media.required as string[])].sort()).toEqual(['media_kind', 'media_url', 'method', 'output_path'])

    const storyboard = byName.get('jubian_storyboard')!
    const subtitleBox = (storyboard.properties as Record<string, Record<string, unknown>>).subtitle_box!
    expect(subtitleBox).toMatchObject({ type: 'object', additionalProperties: true })
  })

  it('refuses a paid method with no idempotency key before it touches the network', async () => {
    const tools = await mount()
    const video = tools.find(tool => tool.name === 'jubian_video')!
    await expect(video.execute({ method: 'image_generate', script_id: 1, asset_name: 'x', asset_type: 1,
      prompt: 'p' }, {})).rejects.toThrow()
  })

  it('reports a missing credential as an authentication failure rather than a crash', async () => {
    const registered: Registered[] = []
    const ctx = {
      tools: { register: (definition: Registered) => { registered.push(definition); return () => {} } },
      credentials: { resolve: async () => undefined },
    } as unknown as Context
    apply(ctx, { ledgerRoot: await mkdtemp(join(tmpdir(), 'jubian-tools-')) })
    const catalog = registered.find(tool => tool.name === 'jubian_catalog')!
    await expect(catalog.execute({ method: 'models', task_type: 2 }, {})).rejects.toMatchObject(
      { code: 'AUTHENTICATION_REQUIRED' })
  })
})
