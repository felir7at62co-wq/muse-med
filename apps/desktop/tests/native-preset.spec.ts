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
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader, { EntryTree, Group } from '@deepseek-ai/cordis-plugin-loader'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import NativePreset from '../../desktop-host/src/native-preset.ts'

/** The Loader's `!!js` scalar, which the adapter preserves as an unevaluated expression. */
const JS_EXPRESSION_TAG = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (value: string) => ({ __jsExpr: value }),
})
const JS_SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_EXPRESSION_TAG])

/** The product-owned compositions the Desktop Host assembles its roster from. */
const productPresets = fileURLToPath(new URL('../../desktop-host/presets', import.meta.url))

/**
 * The filesystem skill provider each packaged composition declares.
 *
 * The Host owns the only provider that selects default roots, so `standard` and
 * `ptc` and `editing` declare their own row disabled, `cordis` keeps a row serving
 * exactly its own authoring skills with default discovery off, and `minimal` declares none.
 */
const DECLARED_SKILL_PROVIDER: Readonly<Record<string, 'disabled' | 'own-skills' | 'none'>> = {
  'short-drama': 'none',
  standard: 'disabled',
  ptc: 'disabled',
  minimal: 'none',
  editing: 'disabled',
  cordis: 'own-skills',
}

it.each(Object.keys(DECLARED_SKILL_PROVIDER))('declares the adapted skill provider for %s', async (preset) => {
  const rows = await readFile(join(productPresets, preset, 'agent.cordis.yml'), 'utf8')
    .then(text => yaml.load(text, { schema: JS_SCHEMA }) as { id?: string; disabled?: unknown; config?: Record<string, unknown> }[])
  const provider = rows.find(row => row.id === 'skill-filesystem')
  const declared = DECLARED_SKILL_PROVIDER[preset]
  if (declared === 'none') expect(provider).toBeUndefined()
  else expect(provider).toBeDefined()
  if (declared === 'disabled') expect(provider?.disabled).toBe(true)
  if (declared === 'own-skills') {
    expect(provider?.config?.includeDefaultRoots).toBe(false)
    expect(provider?.config?.customSkillDirs).toHaveLength(1)
    // The entry stays an unevaluated !!js expression; it names the package directory to resolve.
    const skillRoot = String(((provider?.config?.customSkillDirs as { __jsExpr?: string }[])[0] ?? {}).__jsExpr)
    expect(skillRoot).toContain('\'presets\', \'cordis\', \'skills\'')
    expect(skillRoot).toContain('app.asar.unpacked')
  }
})

it.each(['short-drama', 'standard'])('includes the product composition %s without changing its source or registering another skill provider', async (preset) => {
  const path = join(productPresets, preset, 'agent.cordis.yml')
  const before = await readFile(path, 'utf8')
  const ctx = new Context()
  const imported: string[] = []
  const fromNativeTree: boolean[] = []
  const root = await mkdtemp(join(tmpdir(), 'desktop-native-preset-'))
  const wrapper = join(root, 'agent.cordis.yml')
  await writeFile(wrapper, JSON.stringify([{ name: 'test:native', config: { id: preset, directory: join(productPresets, preset) } }]))
  // Bound to the receiving tree: a `cordis:` builtin resolves through
  // `this.ctx.loader`, so a prototype-bound copy would fail every group row.
  const originalImport: unknown = Reflect.get(EntryTree.prototype, 'import')
  if (typeof originalImport !== 'function') throw new Error('EntryTree.import must be callable')
  const nativeImport = vi.spyOn(EntryTree.prototype, 'import').mockImplementation(function (this: EntryTree, name, stack) {
    if (name.startsWith('cordis:')) {
      const loaded: unknown = Reflect.apply(originalImport, this, [name, stack])
      return loaded
    }
    if (name === 'test:native') return NativePreset
    fromNativeTree.push(this instanceof NativePreset)
    imported.push(name)
    return { apply() {} }
  })
  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
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
