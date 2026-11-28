/**
 * Image generation payloads, ported from the product's pure builders.
 *
 * The catalogue selectors are resolved from the live account catalogue rather
 * than accepted from a caller: `standardId`, `platformId` and `videoStandardId`
 * are account state, and a stale pair would produce a request the provider
 * rejects after the caller already believes it was accepted.
 *
 * One model id can however be listed several times, once per platform and price.
 * Which of those rows to buy from is the deployment's decision, so it arrives as
 * an {@link ImageModelSelection} and an ambiguous catalogue fails instead of
 * picking one.
 */
import { JubianError } from '@deepseek-ai/dsh-jubian'
import { readPayload } from './reading.ts'

function invalid(detail?: string): never { throw new JubianError('CONTRACT_CHANGED', detail) }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) invalid()
  return value.map(object)
}

function positive(value: unknown): number {
  const candidate = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) invalid()
  return candidate
}

function text(value: unknown, multiline = false): string {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed()
    || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) invalid()
  return value
}

/** Selectors for one image-generation request. */
export interface ImageModelSelectors {
  standardId: number
  modelId: string
  platformId: string
  modelGenerationTypeId: number | null
  genType: 3
  videoStandardId: number
  resolution: string
  /** Provider quality copied from the selected specification when it declares one. */
  quality?: string
}

/**
 * The catalogue row a deployment pinned for image generation.
 *
 * One model id may be listed once per platform, and the platforms are not
 * interchangeable: a measured account lists `gpt-image-2` on `KU_AI` at 0.12 CNY
 * per image and on `DUO_YUAN_TAN_SUO` at 1.05 CNY per item. An empty selection
 * therefore works only while the catalogue carries exactly one such row; with
 * several rows the call fails and names every candidate instead of choosing.
 */
export interface ImageModelSelection {
  /** Explicit live model ID. With no model or row pin, the tool defaults to GPT Image 2. */
  modelId?: string
  /** Exact videoStandards row id when otherwise equivalent specifications repeat. */
  videoStandardId?: number
  /** Explicit live resolution; omitted calls choose the lowest supported resolution. */
  resolution?: string
  /** The row's `platformId`, such as `KU_AI`. */
  platformId?: string
  /** Exact live price row ID, which supplies its own model when no model is specified. */
  standardId?: number
}

/** Supported aspect ratios for one generated asset image. */
export type ImageAspectRatio = '16:9' | '9:16'

function imageAspectRatio(value: unknown): ImageAspectRatio {
  if (value !== '16:9' && value !== '9:16') {
    throw new JubianError('INVALID_ARGUMENT', 'image_aspect_ratio must be 16:9 or 9:16')
  }
  return value
}

const IMAGE_STYLES = ['live_action', 'anime', 'realistic_3d'] as const

/** Provider image style choices. Anime includes 2D and 3D animation. */
export type ImageStyle = typeof IMAGE_STYLES[number]

const IMAGE_STYLE_CODES: Record<ImageStyle, number> = { live_action: 0, anime: 1, realistic_3d: 3 }

/**
 * Read the caller's image style without rewriting the prompt.
 * @param prompt - Complete prompt whose leading positive style declaration supplies an omitted choice.
 *   The declaration may follow the exact `项目风格:` or `项目风格：` prefix on the same first line.
 * @param requested - Explicit image style, which must agree with a leading declaration.
 * @returns The explicit or declared style, or undefined when the caller provided neither.
 * @throws {JubianError} INVALID_ARGUMENT for an unsupported choice or contradictory declarations.
 */
export function requestedImageStyle(prompt: string, requested?: unknown): ImageStyle | undefined {
  const explicit = IMAGE_STYLES.find(style => style === requested)
  if (requested !== undefined && explicit === undefined) {
    throw new JubianError('INVALID_ARGUMENT', 'image_style must be live_action, anime, or realistic_3d')
  }
  const firstLine = prompt.trimStart().replace(/[\r\n][\s\S]*$/u, '')
  const declaration = firstLine.replace(/^项目风格[:：]\s*/u, '')
  const anime = new RegExp([
    String.raw`^(?:【(?:动漫|动画|3D动漫|3D动画)】|(?:3d|三维|风格化三维)\s*(?:动漫|动画|国漫)|`,
    String.raw`(?:stylized\s+)?3d\s+(?:anime|animation)\b|`,
    String.raw`(?:3danime|stylized\s*animation)(?:[／/，,:：。.!?！？\s]|$)|`,
    String.raw`(?:动漫|动画)(?:[／/，,:：\s]|$)|风格化动画(?:[／/，,:：。.!?！？\s]|$))`,
  ].join(''), 'iu').test(declaration)
  const liveAction = new RegExp([
    String.raw`^(?:【(?:真人|真人写实|写实真人)】|真人(?:写实)?(?:摄影|实拍)?(?:[／/，,:：\s]|$)|`,
    String.raw`(?:photorealistic\s+(?:portrait\s+)?photography|live[- ]action)\b)`,
  ].join(''), 'iu').test(declaration)
  const realistic3d = /^(?:【(?:3d|三维)\s*写实】|(?:3d|三维)\s*写实(?:[／/，,:：。.!?！？\s]|$))/iu.test(declaration)
  let declared: ImageStyle | undefined
  if (anime) declared = 'anime'
  else if (liveAction) declared = 'live_action'
  else if (realistic3d) declared = 'realistic_3d'
  if (explicit !== undefined && declared !== undefined && explicit !== declared) {
    throw new JubianError('INVALID_ARGUMENT', 'image_style conflicts with the leading prompt medium; align both before generation')
  }
  return explicit ?? declared
}

/**
 * Resolve a project setting to its supported image style.
 * @param projectStyle - The project's `scriptStyle` value.
 * @returns The corresponding image style, or live action for an absent value.
 * @throws {JubianError} INVALID_ARGUMENT when the project uses a style outside the supported choices.
 */
export function resolveProjectImageStyle(projectStyle: unknown): ImageStyle {
  const value = typeof projectStyle === 'string' ? projectStyle.trim() : projectStyle
  if (value === undefined || value === null || value === '') return 'live_action'
  const style = IMAGE_STYLES.find(style => value === IMAGE_STYLE_CODES[style] || value === String(IMAGE_STYLE_CODES[style]))
  if (style === undefined) {
    throw new JubianError('INVALID_ARGUMENT', 'The project style is unsupported for image generation. Set a supported image_style explicitly before submitting.')
  }
  return style
}

/**
 * Resolve the image style while preserving the caller's prompt.
 * @param prompt - Complete prompt whose leading positive style declaration may supply the image style.
 * @param requested - Explicit image style, which must agree with a leading declaration.
 * @param projectStyle - Optional project `scriptStyle` used when the caller provides neither.
 * @returns The caller's style, supported project style, or the legacy live-action default.
 * @throws {JubianError} INVALID_ARGUMENT for an unsupported style or conflicting caller choices.
 */
export function resolveImageStyle(prompt: string, requested?: unknown, projectStyle?: unknown): ImageStyle {
  return requestedImageStyle(prompt, requested) ?? resolveProjectImageStyle(projectStyle)
}

/** The default model when a caller omits an explicit model selection. */
const IMAGE_MODEL_ID = 'gpt-image-2'

/** The row field that becomes the request's `standardId`. */
function standardIdOf(row: Record<string, unknown>): unknown { return row.id ?? row.standardId }

/** One catalogue display unit, or null for a value no surface can show. */
function displayUnit(value: unknown): string | null {
  return typeof value === 'string' && value.trim() && value.length <= 128 && value.isWellFormed()
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : null
}

/** One `gpt-image-2` catalogue row, as a surface that pins a row offers it. */
export interface ImageModelCandidate {
  /** The row's own `id`, which the request carries as `standardId`. */
  standardId: number
  /** The platform the row buys from, such as `KU_AI`. */
  platformId: string
  /** The row's unit price, or null while the catalogue states none. */
  unitPrice: number | null
  /** The unit that price is quoted in, or null while the catalogue states none. */
  unit: string | null
}

/**
 * The `gpt-image-2` rows a deployment may pin, in catalogue order.
 *
 * A surface that lets a person choose lists these, so the choice does not have to
 * be read out of a failure message; the `standardId` it returns is what
 * {@link resolveImageModel} accepts as a selection.
 * @param catalogue - Envelope `data` from `/model/charge/getSelectList?taskType=2`.
 * @returns One entry per `gpt-image-2` row, empty when the catalogue carries none.
 * @throws {JubianError} `CONTRACT_CHANGED` when a matching row lacks a usable id or platform.
 */
export function imageCandidates(catalogue: unknown): ImageModelCandidate[] {
  return readPayload('imageCandidates', catalogue, () => rows(catalogue)
    .filter(row => row.modelId === IMAGE_MODEL_ID).map(row => ({
      standardId: positive(standardIdOf(row)),
      platformId: text(row.platformId),
      unitPrice: typeof row.unitPrice === 'number' && Number.isFinite(row.unitPrice) ? row.unitPrice : null,
      unit: displayUnit(row.unit),
    })))
}

/** One candidate row as a failure names it, so a caller can pin one explicitly. */
function candidateSummary(row: Record<string, unknown>): string {
  const standardId = standardIdOf(row)
  const unitPrice = typeof row.unitPrice === 'number' || typeof row.unitPrice === 'string'
    ? String(row.unitPrice) : '?'
  return `standardId=${typeof standardId === 'number' || typeof standardId === 'string' ? String(standardId) : '?'}`
    + ` platformId=${typeof row.platformId === 'string' ? row.platformId : '?'}`
    + ` unitPrice=${unitPrice} unit=${typeof row.unit === 'string' && row.unit.trim() ? row.unit : '?'}`
}

/** Pick the selected model and platform row, or fail naming every candidate. */
function imageModelRow(catalogue: unknown, selection: ImageModelSelection): Record<string, unknown> {
  const { standardId } = selection
  const modelId = selection.modelId ?? (standardId === undefined ? IMAGE_MODEL_ID : undefined)
  const matches = rows(catalogue).filter(row => modelId === undefined || row.modelId === modelId)
  if (matches.length === 0) invalid(`the account catalogue carries no ${modelId ?? 'image model'} row`)
  const selected = matches.filter(row => (selection.platformId === undefined || row.platformId === selection.platformId)
    && (standardId === undefined || Number(standardIdOf(row)) === standardId))
  if (selected.length === 1) return selected[0] as Record<string, unknown>
  const candidates = matches.map(candidateSummary).join(' | ')
  const target = modelId ?? `standardId=${standardId}`
  invalid(`the configured selection for ${target} selected ${selected.length} of ${matches.length} catalogue rows;`
    + ' pin exactly one row with image_model_id/image_platform_id, on the 短剧 settings page (资产图生成通道),'
    + ` or with the tool config fields imagePlatformId/imageStandardId. Candidates: ${candidates}`)
}

/**
 * Resolve the supported image selectors from a live `taskType=2` catalogue.
 * @param catalogue - Envelope `data` already read from `/model/charge/getSelectList?taskType=2`.
 * @param selection - The row this deployment pinned; required as soon as the catalogue lists several.
 * @param aspectRatio - Requested image ratio; existing callers default to 16:9.
 * @returns The selected standard or lowest supported resolution; GPT Image 2 also requires exact dimensions divisible by 16.
 * @throws {JubianError} `INVALID_ARGUMENT` for an unsupported ratio, or `CONTRACT_CHANGED` when the
 *   selected model row or requested image specification cannot be identified in the catalogue.
 */
export function resolveImageModel(catalogue: unknown, selection: ImageModelSelection = {},
  aspectRatio: ImageAspectRatio = '16:9'): ImageModelSelectors {
  const ratio = imageAspectRatio(aspectRatio)
  return readPayload('resolveImageModel', catalogue, () => {
    const model = imageModelRow(catalogue, selection)
    const strictDimensions = model.modelId === IMAGE_MODEL_ID
    const resolutions = model.modelId === 'seedream-5-5' && model.platformId === 'FANG_ZHOU'
      ? ['1K', '1.5K', '2K', '4K'] : ['1K', '2K', '4K']
    const standards = rows(model.videoStandards).filter(row => row.ratio === ratio
      && (selection.videoStandardId === undefined || Number(row.id) === selection.videoStandardId)
      && typeof row.resolution === 'string' && resolutions.includes(row.resolution.toUpperCase())
      && (!strictDimensions || (typeof row.width === 'number' && Number.isSafeInteger(row.width)
        && row.width > 0 && row.width <= 8192 && row.width % 16 === 0
        && typeof row.height === 'number' && Number.isSafeInteger(row.height)
        && row.height > 0 && row.height <= 8192 && row.height % 16 === 0
        && (ratio === '16:9' ? row.width * 9 === row.height * 16 : row.width * 16 === row.height * 9))))
    const resolution = selection.resolution === undefined
      ? resolutions.find(value => standards.some(row => (row.resolution as string).toUpperCase() === value))
      : selection.resolution.toUpperCase()
    const atResolution = standards.filter(row => (row.resolution as string).toUpperCase() === resolution)
    const generationRows = model.genTypes === undefined || model.genTypes === null ? [] : rows(model.genTypes)
    for (const row of generationRows) positive(row.type)
    const generations = generationRows.filter(row => row.type === 3)
    if (generations.length > 1) invalid()
    const generation = generations.length === 1 ? generations[0] : undefined
    const standard = atResolution[0]
    if (standard === undefined) invalid(`selected image catalogue row has no valid ${ratio} image specification`)
    if (atResolution.length > 1) invalid(`selected image catalogue row has multiple ${ratio} image specifications at ${resolution}`)
    const quality = standard.quality === undefined || standard.quality === null || standard.quality === ''
      ? undefined : text(standard.quality)
    return { standardId: positive(model.id ?? model.standardId), modelId: text(model.modelId),
      platformId: text(model.platformId), genType: 3,
      modelGenerationTypeId: generation === undefined || generation.id === undefined || generation.id === null
        ? null : positive(generation.id),
      videoStandardId: positive(standard.id), resolution: (standard.resolution as string).toUpperCase(),
      ...(quality === undefined ? {} : { quality }) }
  })
}

/** One image generation request as a caller states it. */
export interface ImageRequestInput {
  scriptId: number
  assetName: string
  assetType: number
  prompt: string
  references: string[]
  /** Explicit image medium; omitted calls use a leading declaration or the legacy live-action default. */
  imageStyle?: ImageStyle
  /** Defaults to 16:9 when omitted. */
  aspectRatio?: ImageAspectRatio
  /** Present only for the update route; the provider then takes PUT instead of POST. */
  parentAssetId?: number
}

/**
 * Validate the local fields of a paid image request without reading the account catalogue.
 * @param input - Caller-supplied image identity, prompt, aspect ratio and reference URLs.
 * @throws {JubianError} `INVALID_ARGUMENT` when the requested aspect ratio is unsupported.
 */
export function validateImageRequestInput(input: ImageRequestInput): void {
  positive(input.scriptId)
  text(input.assetName)
  positive(input.assetType)
  text(input.prompt, true)
  resolveImageStyle(input.prompt, input.imageStyle)
  imageAspectRatio(input.aspectRatio ?? '16:9')
  if (input.parentAssetId !== undefined) positive(input.parentAssetId)
  if (!Array.isArray(input.references)) invalid()
  for (const materialUrl of input.references) {
    if (typeof materialUrl !== 'string') invalid()
    let url: URL
    try { url = new URL(materialUrl) } catch { return invalid() }
    if (!materialUrl.startsWith('https://') || /[\s\\]/.test(materialUrl) || materialUrl.includes('#')
      || url.username || url.password) invalid()
  }
}

/**
 * Build the exact `/aigc/asset` body.
 * @param input - Caller-supplied identity, prompt, optional aspect ratio and ordered reference URLs.
 * @param catalogue - Live `taskType=2` catalogue.
 * @param selection - The catalogue row this deployment pinned.
 * @returns The wire body requesting the caller's composition instead of the provider's asset reference template,
 *   with `id` present only on the update route.
 */
export function buildImageRequest(input: ImageRequestInput, catalogue: unknown,
  selection: ImageModelSelection = {}): Record<string, unknown> {
  validateImageRequestInput(input)
  const aspectRatio = input.aspectRatio ?? '16:9'
  const { resolution, quality, ...selectors } = resolveImageModel(catalogue, selection, aspectRatio)
  if (selectors.platformId === 'KU_AI' && input.references.length > 5) {
    throw new JubianError('INVALID_ARGUMENT', 'KU_AI image generation accepts at most 5 reference images; reduce references before submission')
  }
  const references = input.references.map((materialUrl, index) =>
    ({ materialUrl, materialType: 'image', sortOrder: index + 1 }))
  const config = { ...selectors, duration: 1, resolution, ratio: aspectRatio, genNum: 1, backupModelList: [],
    prompt: input.prompt, style: IMAGE_STYLE_CODES[resolveImageStyle(input.prompt, input.imageStyle)],
    materialList: references, quality: quality ?? '', skipAssetReferenceTemplate: true }
  return { scriptId: input.scriptId, assetName: input.assetName, assetType: input.assetType,
    modelConfig: JSON.stringify(config), isLocal: 0, isGenerate: 1,
    ...(input.parentAssetId === undefined ? {} : { id: input.parentAssetId }) }
}

/**
 * Read the catalogue's display price for the image route.
 * @param catalogue - Live `taskType=2` catalogue.
 * @param selection - The catalogue row this deployment pinned; the quote is that row's own price.
 * @returns Display fields only; never a verified quote or spending authorization.
 */
export function readImageDisplayPrice(catalogue: unknown,
  selection: ImageModelSelection = {}): Record<string, unknown> {
  return readPayload('readImageDisplayPrice', catalogue, () => {
    const model = imageModelRow(catalogue, selection)
    const { unitPrice } = model
    const unit = displayUnit(model.unit)
    if (typeof unitPrice !== 'number' || !Number.isFinite(unitPrice) || unitPrice < 0 || unit === null) {
      return { status: 'unavailable', quote_verified: false }
    }
    return { status: 'available', unit_price: unitPrice, unit, quote_verified: false }
  })
}
