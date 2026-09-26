/** Read-only product adapters for the native coding compositions the roster exposes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import Include, { type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { SHIPPED_PRESET_ROOT } from '@deepseek-ai/dsh-agent-presets'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Native compositions this product exposes as presets of its own roster. */
const ADAPTED_PRESETS = ['standard', 'ptc', 'minimal', 'cordis'] as const

/** One adapted composition's id. */
type AdaptedPreset = typeof ADAPTED_PRESETS[number]

/** Selection supplied by a product-owned composition row. */
interface NativePresetConfig {
  preset: string
}

/** Whether a roster row names a composition this adapter exposes. */
function isAdaptedPreset(value: string): value is AdaptedPreset {
  return (ADAPTED_PRESETS as readonly string[]).includes(value)
}

/**
 * Adapt one native composition's filesystem skill provider to the product.
 *
 * The Host owns the only provider that selects default roots
 * (`config/desktop.cordis.patch.yml`), so no adapted composition may leave its
 * own provider selecting them. `standard` and `ptc` publish no skill of their
 * own and give that row up entirely. `cordis` carries the composition-authoring
 * skills its own persona tells the agent to load, so its row survives serving
 * exactly that directory with default discovery off. `minimal` composes no
 * skill provider and needs no patch.
 * @param preset - the adapted composition's id.
 * @param directory - that composition's directory under the shipped preset root.
 * @returns the patches applied to the composition as this adapter includes it.
 */
function nativePatches(preset: AdaptedPreset, directory: string): PatchOptions[] {
  switch (preset) {
    case 'minimal':
      return []
    case 'cordis':
      return [{
        id: 'skill-filesystem',
        config: { includeDefaultRoots: false, customSkillDirs: [join(directory, 'skills')] },
      }]
    case 'standard':
    case 'ptc':
      return [{ id: 'skill-filesystem', disabled: true }]
  }
}

/**
 * Include one native coding composition unchanged, as a read-only product
 * preset that inherits the product's Host skill provider and skill tool.
 */
export default class NativePreset extends Include {
  static override inject = ['loader', 'tools']

  constructor(ctx: Context, config: NativePresetConfig) {
    if (!isAdaptedPreset(config.preset)) throw new Error('desktop: unsupported native product preset')
    const directory = join(SHIPPED_PRESET_ROOT, config.preset)
    super(ctx, {
      path: pathToFileURL(join(directory, 'agent.cordis.yml')).href,
      patches: nativePatches(config.preset, directory),
    })
  }

  /**
   * Resolve rows through the tree that composed this row.
   *
   * The nested composition holds upstream rows, whose bare package names must
   * resolve from the harness the owning tree already resolves against: a preset
   * package installed under `node_modules` cannot reach the deployment's tool
   * packages through Node's own upward walk, while the roster's tree carries the
   * base those specifiers were written against. Relative rows keep resolving
   * against the native composition directory through the inherited behavior.
   */
  override import(name: string, getOuterStack?: () => string[]): unknown {
    const owner = this.ctx.fiber.entry?.parent?.tree
    if (owner === undefined || owner === this) return super.import(name, getOuterStack)
    return owner.import(name, getOuterStack)
  }

  /** Native presets are immutable inputs, including during subtree disposal. */
  override write(): void {}
}
