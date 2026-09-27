/**
 * The product's preset adapter over the upstream registry.
 *
 * The product owns its compositions as data under `apps/desktop-host/presets/`,
 * and `native-preset.ts` is the row that reads one of them into the registry. What
 * this file asserts is that reading one registers a preset whose rows import
 * through the composition's own tree — no private module tree, no second skill
 * provider — and that the composition file itself is never rewritten.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader, { EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import NativePreset from '../../desktop-host/src/native-preset.ts'

/** The product-owned compositions the Desktop Host assembles its roster from. */
const productPresets = fileURLToPath(new URL('../../desktop-host/presets', import.meta.url))

it('includes the product composition without changing its source or registering another skill provider', async () => {
  const preset = 'short-drama-local'
  const path = join(productPresets, preset, 'agent.cordis.yml')
  const before = await readFile(path, 'utf8')
  const ctx = new Context()
  const imported: string[] = []
  const fromNativeTree: boolean[] = []
  const root = await mkdtemp(join(tmpdir(), 'desktop-native-preset-'))
  const wrapper = join(root, 'agent.cordis.yml')
  await writeFile(wrapper, JSON.stringify([{ name: 'test:native', config: { id: preset, directory: join(productPresets, preset) } }]))
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
    // The registry records projections it never reads here; the preset tree under
    // test does not depend on them.
    ctx.provide('sessionProjections', { register: () => () => {} })
    await ctx.plugin(AgentPresetRegistry, { default: preset })
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
    expect(imported).toContain('@deepseek-ai/dsh-tool-skill')
    const scopedNames = ctx.get('tools')!.schemas(key).map(tool => tool.name)
    expect(scopedNames).toContain('global-paid-tool')
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

it('registers no preset for a directory that holds no composition', async () => {
  // The adapter's selected id IS a product directory; an id whose directory owns
  // no composition must register nothing rather than substitute another preset.
  const ctx = new Context()
  const register = vi.fn(async () => async () => {})
  const root = await mkdtemp(join(tmpdir(), 'desktop-native-preset-empty-'))
  try {
    ctx.provide('agentPresets', { register })
    await expect(ctx.plugin(NativePreset, { id: 'cordis', directory: root }).await())
      .rejects.toThrow(/agent\.cordis\.yml/u)
    expect(register).not.toHaveBeenCalled()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
