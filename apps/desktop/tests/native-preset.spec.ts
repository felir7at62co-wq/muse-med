import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import Include from '@deepseek-ai/cordis-plugin-include'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader, { EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import { SHIPPED_PRESET_ROOT } from '@deepseek-ai/dsh-agent-presets'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import NativePreset from '../../desktop-host/src/native-preset.ts'

it.each(['standard', 'ptc', 'minimal'])('includes native %s without changing its source or registering another skill provider', async (preset) => {
  const path = join(SHIPPED_PRESET_ROOT, preset, 'agent.cordis.yml')
  const before = await readFile(path, 'utf8')
  const ctx = new Context()
  const imported: string[] = []
  const fromNativeTree: boolean[] = []
  const root = await mkdtemp(join(tmpdir(), 'desktop-native-preset-'))
  const wrapper = join(root, 'agent.cordis.yml')
  await writeFile(wrapper, JSON.stringify([{ name: 'test:native', config: { preset } }]))
  const originalImport = EntryTree.prototype.import.bind(EntryTree.prototype) as (name: string, stack?: () => string[]) => unknown
  const nativeImport = vi.spyOn(EntryTree.prototype, 'import').mockImplementation(function (this: EntryTree, name, stack) {
    if (name.startsWith('cordis:')) return originalImport(name, stack)
    if (name === 'test:native') return NativePreset
    fromNativeTree.push(this instanceof NativePreset)
    imported.push(name)
    return { apply() {} }
  })
  try {
    await ctx.plugin(Loader)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(Tools)
    ctx.get('tools')!.register(defineContentToolFixture({ name: 'global-paid-tool', description: 'fixture', parameters: {}, execute: async () => [] }))
    const key = {}
    const scope = createScope(ctx, key)
    const owner: { tree?: Include } = {}
    class Owner extends Include {
      constructor(context: Context, config: Include.Config) {
        super(context, config)
        owner.tree = this
      }
    }
    const handle = await scope.ctx.plugin(Owner, { path: pathToFileURL(wrapper).href })
    await owner.tree!.await()
    expect(imported).toContain('@deepseek-ai/dsh-persona')
    expect(fromNativeTree.some(Boolean)).toBe(false)
    expect(imported).not.toContain('@deepseek-ai/dsh-skill-filesystem')
    if (preset !== 'minimal') expect(imported).toContain('@deepseek-ai/dsh-tool-skill')
    else expect(imported).not.toContain('@deepseek-ai/dsh-tool-skill')
    const scopedNames = ctx.get('tools')!.schemas(key).map(tool => tool.name)
    expect(scopedNames.includes('global-paid-tool')).toBe(preset !== 'minimal')
    expect(ctx.get('tools')!.schemas({}).map(tool => tool.name)).toContain('global-paid-tool')
    await handle.dispose()
    expect(ctx.get('tools')!.schemas(key).map(tool => tool.name)).toContain('global-paid-tool')
  } finally {
    await ctx.fiber.dispose()
    nativeImport.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
  expect(await readFile(path, 'utf8')).toBe(before)
})

it('refuses unselected shipped presets before opening their composition', async () => {
  const ctx = new Context()
  try {
    expect(() => new NativePreset(ctx, { preset: 'cordis' })).toThrow('unsupported native product preset')
  } finally {
    await ctx.fiber.dispose()
  }
})
