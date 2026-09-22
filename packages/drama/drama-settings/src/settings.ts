/**
 * The short-drama settings section: the durable fields the Web Settings page
 * edits and the drama pipeline reads.
 *
 * Both compiler faces share this module. The Host half registers
 * {@link DramaSettingsSchema} with the settings service; the browser half reads
 * the resolved section over the settings transport and compiles its edits back
 * into path operations, so the defaults declared here are also what the page
 * shows as a field's reset value.
 *
 * When and whether to ask before a paid or state-changing step is deliberately
 * NOT a setting: the pipeline's agent judges that per call, and a stored tier
 * would be a second, staler answer to the same question. Which catalogue row the
 * paid image route buys from is a different question — the account lists
 * `gpt-image-2` once per platform at its own price, and nothing here may pick one
 * of them on the deployment's behalf, so {@link DramaSettings.imageStandardId}
 * carries that choice and the paid call reads it.
 *
 * The defaults are machine paths and a delivery spec a deployment is expected to
 * change in the settings document. They are the schema's own defaults rather
 * than composition config: one home per fact, reachable from the page.
 *
 * @module @deepseek-ai/dsh-drama-settings/src/settings
 */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by this plugin. */
export const DRAMA_SETTINGS_NAMESPACE = 'drama'

/** The one field carrying the delivery spec. */
export const DELIVERY_SPEC_FIELD = 'deliverySpec'

/** Every field of the section, in the order a reader meets them. */
export const DRAMA_SETTINGS_FIELDS = [
  'deliveryDir', 'jianyingDraftDir', DELIVERY_SPEC_FIELD, 'bgmDir', 'imageStandardId',
] as const satisfies readonly (keyof DramaSettings)[]

/** One durable field of the section. */
export type DramaSettingsField = typeof DRAMA_SETTINGS_FIELDS[number]

/**
 * The delivery target one finished episode is rendered to.
 *
 * A type alias rather than an interface: its values ride a settings path
 * operation as JSON, and only an alias carries the implicit index signature
 * that the wire's `JsonValue` admits.
 */
export type DramaDeliverySpec = {
  /** Frame width in pixels. */
  width: number
  /** Frame height in pixels. */
  height: number
  /** Frames per second. */
  fps: number
  /** Bitrate floor the delivered file must hold, in megabits per second. */
  minBitrateMbps: number
}

/** The durable short-drama section. */
export interface DramaSettings {
  /** Absolute directory finished episodes are delivered to; empty means `<project>/delivery`. */
  deliveryDir: string
  /** Absolute JianyingPro draft root; empty means this machine's default root. */
  jianyingDraftDir: string
  /** Resolution, frame rate and bitrate floor of a delivered episode. */
  deliverySpec: DramaDeliverySpec
  /** Absolute local BGM library the mood matcher searches. */
  bgmDir: string
  /**
   * The `gpt-image-2` catalogue row the paid asset-image route buys from, as
   * that row's own `standardId` (`id`). Absent means the route decides for
   * itself, which only works while the account catalogue lists exactly one
   * `gpt-image-2` row: with several, the paid call fails and names every
   * candidate rather than buying from a platform nobody chose.
   */
  imageStandardId?: number
}

/** JianyingPro draft root this deployment renders to when the section declares none. */
export const DEFAULT_JIANYING_DRAFT_DIR
  = 'C:\\Users\\EDY\\AppData\\Local\\JianyingPro\\User Data\\Projects\\com.lveditor.draft'

/**
 * Where a downloaded BGM track lands when the section declares no directory.
 *
 * Empty means no local library: `bgm_match` searches the published catalogue and
 * downloads the one chosen track into its own cache, so nothing here points at a
 * folder that has to be kept in sync.
 */
export const DEFAULT_BGM_DIR = ''

/** Delivery target of a finished episode when the section declares none. */
export const DEFAULT_DELIVERY_SPEC: DramaDeliverySpec = {
  width: 1440,
  height: 2560,
  fps: 60,
  minBitrateMbps: 4.6,
}

/** Every field's value while the settings document holds no override for it. */
export const DRAMA_SETTINGS_DEFAULTS: DramaSettings = {
  deliveryDir: '',
  jianyingDraftDir: DEFAULT_JIANYING_DRAFT_DIR,
  deliverySpec: DEFAULT_DELIVERY_SPEC,
  bgmDir: DEFAULT_BGM_DIR,
}

/**
 * Durable short-drama schema, and the wire envelope the browser scope validates
 * its section against. A section absent from a layer resolves to
 * {@link DRAMA_SETTINGS_DEFAULTS}; the paths are plain strings because a blank
 * one means "use the default", which is what the page's reset leaves behind.
 */
export const DramaSettingsSchema: z<DramaSettings> = z.object({
  deliveryDir: z.string().default(DRAMA_SETTINGS_DEFAULTS.deliveryDir),
  jianyingDraftDir: z.string().default(DEFAULT_JIANYING_DRAFT_DIR),
  [DELIVERY_SPEC_FIELD]: z.object({
    width: z.number().step(1).min(1).default(DEFAULT_DELIVERY_SPEC.width),
    height: z.number().step(1).min(1).default(DEFAULT_DELIVERY_SPEC.height),
    fps: z.number().step(1).min(1).max(240).default(DEFAULT_DELIVERY_SPEC.fps),
    minBitrateMbps: z.number().min(0.1).default(DEFAULT_DELIVERY_SPEC.minBitrateMbps),
  }),
  bgmDir: z.string().default(DEFAULT_BGM_DIR),
  imageStandardId: z.number().step(1).min(1),
})
