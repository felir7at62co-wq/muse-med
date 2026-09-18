/**
 * Image generation payloads, ported from the product's pure builders.
 *
 * The catalogue selectors are resolved from the live account catalogue rather
 * than accepted from a caller: `standardId`, `platformId` and `videoStandardId`
 * are account state, and a stale pair would produce a request the provider
 * rejects after the caller already believes it was accepted.
 */
import { JubianError } from '@deepseek-ai/dsh-jubian'

function invalid(): never { throw new JubianError('CONTRACT_CHANGED') }

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

/** The selectors one GPT Image 2 request needs. */
export interface ImageModelSelectors {
  standardId: number
  modelId: string
  platformId: string
  modelGenerationTypeId: number | null
  genType: 3
  videoStandardId: number
  resolution: string
}

function imageModelRow(catalogue: unknown): Record<string, unknown> {
  const matches = rows(catalogue).filter(row => row.modelId === 'gpt-image-2')
  const first = matches.length === 1 ? matches[0] : undefined
  if (first === undefined) invalid()
  return first
}

/**
 * Resolve the supported image selectors from a live `taskType=2` catalogue.
 * @param catalogue - Envelope `data` already read from `/model/charge/getSelectList?taskType=2`.
 * @returns The lowest supported resolution whose standard has exact 16:9 dimensions divisible by 16.
 */
export function resolveImageModel(catalogue: unknown): ImageModelSelectors {
  const model = imageModelRow(catalogue)
  const standards = rows(model.videoStandards).filter(row => row.ratio === '16:9'
    && typeof row.resolution === 'string' && ['1K', '2K', '4K'].includes(row.resolution.toUpperCase())
    && typeof row.width === 'number' && Number.isSafeInteger(row.width) && row.width > 0 && row.width <= 8192
    && row.width % 16 === 0
    && typeof row.height === 'number' && Number.isSafeInteger(row.height) && row.height > 0 && row.height <= 8192
    && row.height % 16 === 0 && row.width * 9 === row.height * 16)
  const resolution = ['1K', '2K', '4K'].find(value => standards.some(row => (row.resolution as string).toUpperCase() === value))
  const atResolution = standards.filter(row => (row.resolution as string).toUpperCase() === resolution)
  const generationRows = model.genTypes === undefined || model.genTypes === null ? [] : rows(model.genTypes)
  for (const row of generationRows) positive(row.type)
  const generations = generationRows.filter(row => row.type === 3)
  if (generations.length > 1) invalid()
  const generation = generations.length === 1 ? generations[0] : undefined
  const standard = atResolution.length === 1 ? atResolution[0] : undefined
  if (standard === undefined) invalid()
  return { standardId: positive(model.id ?? model.standardId), modelId: 'gpt-image-2',
    platformId: text(model.platformId), genType: 3,
    modelGenerationTypeId: generation === undefined || generation.id === undefined || generation.id === null
      ? null : positive(generation.id),
    videoStandardId: positive(standard.id), resolution: (standard.resolution as string).toUpperCase() }
}

/** One image generation request as a caller states it. */
export interface ImageRequestInput {
  scriptId: number
  assetName: string
  assetType: number
  prompt: string
  references: string[]
  /** Present only for the update route; the provider then takes PUT instead of POST. */
  parentAssetId?: number
}

/**
 * Build the exact `/aigc/asset` body.
 * @param input - Caller-supplied identity, prompt and ordered reference URLs.
 * @param catalogue - Live `taskType=2` catalogue.
 * @returns The wire body, with `id` present only on the update route.
 */
export function buildImageRequest(input: ImageRequestInput, catalogue: unknown): Record<string, unknown> {
  const { resolution, ...selectors } = resolveImageModel(catalogue)
  const references = input.references.map((materialUrl, index) => {
    let url: URL
    try { url = new URL(materialUrl) } catch { return invalid() }
    if (!materialUrl.startsWith('https://') || /[\s\\]/.test(materialUrl) || materialUrl.includes('#')
      || url.protocol !== 'https:' || !url.hostname || url.username || url.password) invalid()
    return { materialUrl, materialType: 'image', sortOrder: index + 1 }
  })
  const config = { ...selectors, duration: 1, resolution, ratio: '16:9', genNum: 1, backupModelList: [],
    prompt: text(input.prompt, true), style: 0, materialList: references, quality: '' }
  return { scriptId: positive(input.scriptId), assetName: text(input.assetName), assetType: positive(input.assetType),
    modelConfig: JSON.stringify(config), isLocal: 0, isGenerate: 1,
    ...(input.parentAssetId === undefined ? {} : { id: positive(input.parentAssetId) }) }
}

/**
 * Read the catalogue's display price for the image route.
 * @param catalogue - Live `taskType=2` catalogue.
 * @returns Display fields only; never a verified quote or spending authorization.
 */
export function readImageDisplayPrice(catalogue: unknown): Record<string, unknown> {
  const model = imageModelRow(catalogue)
  const { unitPrice, unit } = model
  if (typeof unitPrice !== 'number' || !Number.isFinite(unitPrice) || unitPrice < 0
    || typeof unit !== 'string' || !unit.trim() || unit.length > 128 || !unit.isWellFormed()
    || /[\u0000-\u001f\u007f]/.test(unit)) return { status: 'unavailable', quote_verified: false }
  return { status: 'available', unit_price: unitPrice, unit, quote_verified: false }
}
