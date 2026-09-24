/** Read-only product adapters for the selected upstream coding presets. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import Include from '@deepseek-ai/cordis-plugin-include'
import { SHIPPED_PRESET_ROOT } from '@deepseek-ai/dsh-agent-presets'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Selection supplied by a product-owned composition row. */
interface NativePresetConfig {
  preset: string
}

/** Include the native composition while inheriting the product's Host skill provider. */
export default class NativePreset extends Include {
  static override inject = ['loader', 'tools']

  constructor(ctx: Context, config: NativePresetConfig) {
    if (!['standard', 'ptc', 'minimal'].includes(config.preset)) throw new Error('desktop: unsupported native product preset')
    super(ctx, {
      path: pathToFileURL(join(SHIPPED_PRESET_ROOT, config.preset, 'agent.cordis.yml')).href,
      patches: config.preset === 'minimal' ? [] : [{ id: 'skill-filesystem', disabled: true }],
    })
    if (config.preset === 'minimal') ctx.tools.restrict({ allow: [] })
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
