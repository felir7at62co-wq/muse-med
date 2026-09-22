/**
 * The episode-and-category naming convention, and the audit that reports names
 * which predate it.
 *
 * A creation request's name is what a reader of the console's asset library sees
 * first, so it is where a caller can make a project's assets line up by episode
 * and category. This module composes those names. It never rewrites a name the
 * provider already holds: the one rename the console offers is not a capability
 * this package publishes, so the audit below only reports.
 */
import { JubianError } from '@deepseek-ai/dsh-jubian'

/** The three asset categories the console's own libraries page on. */
export const ASSET_CATEGORIES = ['角色', '场景', '道具'] as const

/** One asset category, as {@link ASSET_CATEGORIES} spells it. */
export type AssetCategory = (typeof ASSET_CATEGORIES)[number]

/** Default separator between the segments of a composed name. */
export const DEFAULT_NAME_SEPARATOR = '｜'

/** Default label of an asset that serves the whole series rather than one episode. */
export const DEFAULT_SERIES_LABEL = '全剧'

/**
 * The provider's own category numbering, which is the same number for an asset's
 * `assetType` and for the library a folder is created in.
 *
 * It is an external contract, not a deployment choice: the console pages on
 * exactly these three libraries, so the numbers stay fixed here.
 */
export const ASSET_CATEGORY_TYPES: Record<AssetCategory, number> = { 角色: 1, 场景: 2, 道具: 3 }

/**
 * Name the category one provider category number denotes.
 * @param value - An `assetType` or `rootCategoryType` value.
 * @returns The category, or null when the number is not one the console pages on.
 */
export function categoryOfType(value: number | null): AssetCategory | null {
  return ASSET_CATEGORIES.find(category => ASSET_CATEGORY_TYPES[category] === value) ?? null
}

/** Prefixes that name a category in a legacy asset name. */
const CATEGORY_PREFIXES: readonly (readonly [RegExp, AssetCategory])[] = [
  [/^(scene|场景)[_-]/i, '场景'],
  [/^(prop|道具)[_-]/i, '道具'],
  [/^(character|角色)[_-]/i, '角色'],
]

/** Slugs a scene name carries between its own segments. */
const SCENE_SLUGS = ['日', '夜'] as const

/**
 * Read the category a name declares about itself.
 *
 * Used by the audit to name assets whose `assetType` disagrees with what their
 * name says: a name that reads as a scene while the asset sits in the character
 * library is the shape of a creation request that sent the wrong type.
 * @param name - One asset name, as the provider or a manifest spells it.
 * @param naming - Resolved naming choices.
 * @returns The declared category, or null when the name declares none.
 */
export function declaredCategory(name: string, naming: Naming): AssetCategory | null {
  const parts = name.split(naming.separator)
  const fromConvention = segment(parts, 1).trim()
  if ((ASSET_CATEGORIES as readonly string[]).includes(fromConvention)) {
    return fromConvention as AssetCategory
  }
  for (const [pattern, category] of CATEGORY_PREFIXES) {
    if (pattern.test(name.trim())) return category
  }
  // `EP03｜天台｜日｜内` is a scene slug the pipeline writes between the
  // conventional segments; its second segment is a location, not a category.
  if (SCENE_SLUGS.some(slug => parts.includes(slug))) return '场景'
  return null
}

/** The naming choices a deployment can vary. */
export interface NamingOptions {
  /** Separator between the segments of a composed name; defaults to `｜`. */
  separator?: string
  /** Episode token of a series-wide asset; defaults to `全剧`. */
  seriesLabel?: string
}

/** The naming choices with every default applied. */
export interface Naming {
  /** Separator between the segments of a composed name. */
  separator: string
  /** Episode token of a series-wide asset. */
  seriesLabel: string
}

/**
 * Resolve the naming choices one deployment configured.
 *
 * Called once while the row mounts, so a blank separator or series label fails
 * the mount instead of composing a name no reader can split.
 * @param options - Configured overrides; omitted fields keep their defaults.
 * @returns The separator and series label every composed name uses.
 * @throws {Error} When either configured value is blank.
 */
export function resolveNaming(options: NamingOptions = {}): Naming {
  const separator = options.separator ?? DEFAULT_NAME_SEPARATOR
  const seriesLabel = options.seriesLabel ?? DEFAULT_SERIES_LABEL
  if (!separator.trim() || !seriesLabel.trim()) {
    throw new Error('tool-jubian: naming separator and series label must each be a non-blank string')
  }
  return { separator, seriesLabel }
}

/**
 * Normalize one episode number to its two-digit spelling.
 * @param value - An episode number as a manifest or a caller spells it, such as `2` or `02`.
 * @returns The two-digit form, or null when the value is not a number.
 */
export function normalizedEpisode(value: string | number): string | null {
  const text = String(value).trim()
  return /^[0-9]{1,3}$/.test(text) ? text.padStart(2, '0') : null
}

/**
 * Resolve the episode token that opens a composed name.
 * @param value - An episode number (`5` or `05`) or the configured series label.
 * @param naming - Resolved naming choices.
 * @returns `EP05` for an episode, or the series label for a series-wide asset.
 * @throws {JubianError} `INVALID_ARGUMENT` when the value is neither, so a caller learns which
 *   argument to correct without a request leaving.
 */
export function episodePrefix(value: string | number, naming: Naming): string {
  const text = String(value).trim()
  if (text === naming.seriesLabel) return text
  const normalized = normalizedEpisode(text)
  if (normalized !== null) return `EP${normalized}`
  throw new JubianError('INVALID_ARGUMENT', `episode=${text} 既不是集号也不是 ${naming.seriesLabel}`)
}

/**
 * Compose the name a creation request carries.
 * @param episode - The `episode` argument: an episode number or the series label.
 * @param category - One of {@link ASSET_CATEGORIES}.
 * @param name - The asset's own name, such as `红包`.
 * @param naming - Resolved naming choices.
 * @returns `EP05｜道具｜红包`, or `全剧｜角色｜陆沉舟` for a series-wide master.
 * @throws {JubianError} `INVALID_ARGUMENT` when the episode or the name is unusable.
 */
export function composedAssetName(episode: string | number, category: AssetCategory, name: string,
  naming: Naming): string {
  const trimmed = name.trim()
  if (!trimmed) throw new JubianError('INVALID_ARGUMENT', 'asset_name')
  return [episodePrefix(episode, naming), category, trimmed].join(naming.separator)
}

/**
 * Compose the sortable prefix of a processing task's name.
 * @param episode - The `episode` argument: an episode number or the series label.
 * @param packageNumber - Package number within the episode, or undefined for the whole episode.
 * @param naming - Resolved naming choices.
 * @returns `EP05`, `EP05-P3`, or the series label when no package number was given.
 * @throws {JubianError} `INVALID_ARGUMENT` when the episode or the package number is unusable.
 */
export function taskPrefix(episode: string | number, packageNumber: string | number | undefined,
  naming: Naming): string {
  const prefix = episodePrefix(episode, naming)
  if (packageNumber === undefined) return prefix
  const text = String(packageNumber).trim()
  if (!/^[0-9]{1,3}$/.test(text)) throw new JubianError('INVALID_ARGUMENT', `package_number=${text}`)
  return `${prefix}-P${text}`
}

/**
 * What auditing one name found.
 *
 * The two states are distinct types so a caller that reports a violation reads
 * the reason as a string rather than as something it has to guard.
 */
export type NameAudit =
  | { conforming: true; reason: null }
  | { conforming: false; reason: string }

/** Read one segment of a split name, or an empty string when it has fewer. */
function segment(parts: readonly string[], index: number): string {
  return parts[index] ?? ''
}

/**
 * Audit one name against the convention.
 * @param name - A name as the provider or a manifest spells it.
 * @param naming - Resolved naming choices.
 * @returns Whether it reads as `EP{nn}｜{类别}｜{名称}` or `{全剧}｜{类别}｜{名称}`.
 */
export function auditAssetName(name: string, naming: Naming): NameAudit {
  const parts = name.split(naming.separator)
  const head = segment(parts, 0)
  const category = segment(parts, 1)
  const leaf = segment(parts, 2)
  if (head !== naming.seriesLabel && !/^EP[0-9]{2,3}$/.test(head)) {
    return { conforming: false, reason: `缺少集号前缀（应为 EP{两位集数} 或 ${naming.seriesLabel}）` }
  }
  if (parts.length < 3) {
    return { conforming: false, reason: `缺少类别与名称段（应为 {集号}${naming.separator}{类别}${naming.separator}{名称}）` }
  }
  if (!(ASSET_CATEGORIES as readonly string[]).includes(category)) {
    return { conforming: false, reason: `类别段 ${category} 不是 ${ASSET_CATEGORIES.join('、')}` }
  }
  if (!leaf.trim()) return { conforming: false, reason: '名称段为空' }
  return { conforming: true, reason: null }
}

/**
 * Read the episode token a name already carries.
 *
 * A task name is the provider's own field, so a caller cannot assume one was
 * composed here; this reads a token a name carries whatever wrote it.
 * @param name - One provider name, such as `EP05-P3-sb12-去字幕`.
 * @param naming - Resolved naming choices.
 * @returns `EP05`, the series label, or null when the name carries neither.
 */
export function carriedEpisode(name: string, naming: Naming): string | null {
  for (const segment of name.split(naming.separator)) {
    for (const token of segment.split('-')) {
      if (token === naming.seriesLabel) return token
      if (/^EP[0-9]{2,3}$/.test(token)) return token
    }
  }
  return null
}
