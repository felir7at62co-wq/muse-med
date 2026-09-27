/**
 * Register product-owned agent presets with the upstream preset registry.
 *
 * The product's presets are ordinary Cordis composition files under
 * `apps/desktop-host/presets/<id>/` — `agent.cordis.yml` plus the display metadata in `preset.yml`.
 * Upstream replaced its shipped-preset directory and `SHIPPED_PRESET_ROOT` constant with a registry
 * (`@deepseek-ai/dsh-agent-preset-registry`) whose `register()` accepts a `PresetDefinition`
 * (`{ id, name?, description?, order?, plugins }`). This plugin is the adapter: it reads the
 * product's composition and registers it, so the compositions stay product-owned data and no
 * upstream package has to keep existing for them to load.
 *
 * Registration is an effect of the owning fiber: the disposer `register()` returns is yielded from
 * the initializer, so stopping the row retires the preset with it.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { parse as parseYaml } from 'yaml'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

/** One product preset row: the id it is exposed under and its product-owned directory. */
export interface Config {
  /** Preset id the roster exposes and `mount()` selects. */
  id: string
  /** Absolute or repository-relative directory holding `agent.cordis.yml` and `preset.yml`. */
  directory: string
}

interface PresetMetadata {
  readonly name?: string
  readonly description?: string
  readonly order?: number
}

/**
 * The composition dialect's `!!js` scalar, which the Loader evaluates at entry
 * activation (`isJsExpr` reads `__jsExpr`, and a config value or a `disabled`
 * field carrying it is evaluated rather than taken literally).
 *
 * Parsing without this tag resolves every expression to its own source text:
 * `fontsDir: !!js process.env.MUSE_FONTS_DIR || 'C:/Windows/Fonts'` would mount
 * as that literal string, and `disabled: !!js process.platform !== 'win32'`
 * would disable its row on every platform, because the Loader reads any
 * non-expression `disabled` value with `Boolean()`.
 */
const JS_EXPRESSION_TAG = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value: string) => ({ __jsExpr: value }),
}

/**
 * Read the display metadata beside a product composition, tolerating its absence.
 * @param path - Absolute `preset.yml` path.
 * @returns The declared display fields, or an empty object when the file is absent.
 */
function readMetadata(path: string): PresetMetadata {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  return (parseYaml(text) as PresetMetadata | null) ?? {}
}

/** Registers one product-owned preset definition from its composition directory. */
export default class NativePreset {
  static inject = ['agentPresets']

  /**
   * @param ctx - Owning context providing the preset registry.
   * @param config - Product preset id and composition directory.
   */
  constructor(private readonly ctx: Context, private readonly config: Config) {}

  async* [Service.init](): AsyncGenerator<() => Promise<void>> {
    const directory = resolve(this.config.directory)
    const plugins = parseYaml(readFileSync(join(directory, 'agent.cordis.yml'), 'utf8'), {
      customTags: [JS_EXPRESSION_TAG],
    }) as readonly unknown[]
    const definition: PresetDefinition = {
      id: this.config.id,
      ...readMetadata(join(directory, 'preset.yml')),
      plugins: plugins as PresetDefinition['plugins'],
    }
    yield await this.ctx.agentPresets.register(definition)
  }
}
