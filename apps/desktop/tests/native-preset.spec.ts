import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import Include from '@deepseek-ai/cordis-plugin-include'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader, { EntryTree, Group } from '@deepseek-ai/cordis-plugin-loader'
import { SHIPPED_PRESET_ROOT } from '@deepseek-ai/dsh-agent-presets'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import NativePreset from '../../desktop-host/src/native-preset.ts'

/** What one adapted composition must contribute through the adapter. */
interface Adaptation {
  /** Whether the composition's own filesystem skill provider must mount. */
  readonly keepsSkillProvider: boolean
  /** Whether the composition mounts the skill tool. */
  readonly mountsSkillTool: boolean
}

const ADAPTATIONS: Readonly<Record<string, Adaptation>> = {
  // standard and ptc publish no skill of their own: the Host provider replaces theirs.
  standard: { keepsSkillProvider: false, mountsSkillTool: true },
  ptc: { keepsSkillProvider: false, mountsSkillTool: true },
  // minimal composes neither a skill provider nor the skill tool.
  minimal: { keepsSkillProvider: false, mountsSkillTool: false },
  // cordis keeps its own provider, rooted at the directory its persona tells
  // the agent to load from, with default roots off.
  cordis: { keepsSkillProvider: true, mountsSkillTool: true },
}

it.each(Object.keys(ADAPTATIONS))('includes native %s without changing its source', async (preset) => {
  const adaptation = ADAPTATIONS[preset]!
  const path = join(SHIPPED_PRESET_ROOT, preset, 'agent.cordis.yml')
  const before = await readFile(path, 'utf8')
  const ctx = new Context()
  const imported: string[] = []
  const fromNativeTree: boolean[] = []
  const root = await mkdtemp(join(tmpdir(), 'desktop-native-preset-'))
  const wrapper = join(root, 'agent.cordis.yml')
  await writeFile(wrapper, JSON.stringify([{ name: 'test:native', config: { preset } }]))
  // Bound to the receiving tree: a `cordis:` builtin resolves through
  // `this.ctx.loader`, so a prototype-bound copy would fail every group row and
  // report a composition that never mounted.
  const originalImport = EntryTree.prototype.import
  const nativeImport = vi.spyOn(EntryTree.prototype, 'import').mockImplementation(function (this: EntryTree, name, stack) {
    if (name.startsWith('cordis:')) return originalImport.call(this, name, stack)
    if (name === 'test:native') return NativePreset
    fromNativeTree.push(this instanceof NativePreset)
    imported.push(name)
    return { apply() {} }
  })
  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
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
    expect(imported.includes('@deepseek-ai/dsh-skill-filesystem')).toBe(adaptation.keepsSkillProvider)
    expect(imported.includes('@deepseek-ai/dsh-tool-skill')).toBe(adaptation.mountsSkillTool)
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

it('refuses a shipped preset this product does not adapt, before opening its composition', async () => {
  const ctx = new Context()
  try {
    expect(() => new NativePreset(ctx, { preset: 'short-drama' })).toThrow('unsupported native product preset')
  } finally {
    await ctx.fiber.dispose()
  }
})
