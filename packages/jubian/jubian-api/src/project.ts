/** Manual project creation and project identity metadata used by the official workbench. */
import { JubianError, type JubianRequest } from '@deepseek-ai/dsh-jubian'
import { readScript } from './catalog.ts'
import { readPayload } from './reading.ts'
import { invalid, wireObject, wirePositiveId } from './wire.ts'

/** Fields selected in the workbench's project-creation dialog. */
interface ProjectCreateFields {
  scriptName: string
  /** Manual creation does not start AI parsing. */
  createType: 1
  /** 0 selects the storyboard workspace; 1 selects the canvas workspace. */
  productionType: 0 | 1
  scriptStyle?: number
  episodeCount?: number
  storyboardCountPerEpisode?: number
  /** Current catalogue-selected settings; serialized once as the provider requires. */
  globalConfig?: Record<string, unknown>
}

/** Content projects bind a manuscript; pre-roll material projects are selected explicitly. */
export type ProjectCreateInput = ProjectCreateFields & (
  | { produceType: 1; manuscriptId: number }
  | { produceType: 2; manuscriptId?: null }
)

/** Parse phases distinguished by the current workbench; unrecognized numeric states remain unknown. */
export type ProjectParsingPhase = 'pending' | 'failed' | 'ready' | 'unknown'

/** One project detail with source metadata retained for manuscript binding checks. */
export interface ProjectDetail {
  script_id: number
  name: string | null
  production_type: number | null
  project_settings: Record<string, unknown>
  create_type: number | null
  produce_type: number | null
  manuscript_id: number | null
  parsing_status: number | null
  parsing_phase: ProjectParsingPhase
  parsing_message: string | null
  /** Uninterpreted fields do not imply that the full parsing result has been read. */
  snapshot: Record<string, unknown>
}

function argument(field: string): never { throw new JubianError('INVALID_ARGUMENT', field) }

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) argument(field)
  return value
}

function nonnegative(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) argument(field)
  return value
}

function name(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) argument(field)
  return value
}

function mode(value: unknown, choices: readonly number[], field: string): number {
  if (typeof value !== 'number' || !choices.includes(value)) argument(field)
  return value
}

function optionalNumber(value: unknown): number | null {
  const number = typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : null
}

function optionalText(value: unknown): string | null { return typeof value === 'string' ? value : null }

function parsingPhase(status: number | null): ProjectParsingPhase {
  switch (status) {
    case 0: case 1: case 2: return 'pending'
    case 3: case 4: case 7: case 8: return 'failed'
    case 5: case 6: return 'ready'
    default: return 'unknown'
  }
}

function encodeConfig(config: unknown): string {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) argument('globalConfig')
  try { return JSON.stringify(config) }
  catch (_error) { return argument('globalConfig must be JSON serializable') }
}

/**
 * Check for projects already bound to this manuscript and workspace mode.
 * @param manuscriptId - Manuscript selected for the project.
 * @param productionType - Storyboard or canvas workspace mode.
 * @returns The workbench's duplicate-check request.
 */
export function buildManuscriptProjectCheckRequest(manuscriptId: number, productionType: 0 | 1): JubianRequest {
  const id = positive(manuscriptId, 'manuscriptId')
  const selected = mode(productionType, [0, 1], 'productionType')
  return { method: 'GET', path: `/aigc/script/checkManuscriptProject?manuscriptId=${id}&productionType=${selected}` }
}

/**
 * Read the duplicate-check count without inferring a result from missing data.
 * @param data - Envelope data from the manuscript project check.
 * @returns The nonnegative count returned by the provider.
 */
export function readManuscriptProjectCheck(data: unknown): number {
  return readPayload('readManuscriptProjectCheck', data, () => {
    const count = optionalNumber(data)
    if (count === null) invalid()
    return count
  })
}

/**
 * Build the body for POST /aigc/script without choosing a project type or model.
 * @param input - Explicit creation mode, workspace mode and production-content type.
 * @returns A fresh body with globalConfig encoded as a JSON string when supplied.
 */
export function buildProjectCreateRequest(input: ProjectCreateInput): Record<string, unknown> {
  name(input.scriptName, 'scriptName')
  const createType = mode(input.createType, [1], 'createType')
  const productionType = mode(input.productionType, [0, 1], 'productionType')
  const produceType = mode(input.produceType, [1, 2], 'produceType')
  if (produceType === 1) {
    if (input.manuscriptId == null) argument('manuscriptId')
    positive(input.manuscriptId, 'manuscriptId')
  } else if (input.manuscriptId !== undefined && input.manuscriptId !== null) argument('manuscriptId')
  const body: Record<string, unknown> = {
    scriptName: input.scriptName, createType, productionType,
    produceType, manuscriptId: produceType === 1 ? input.manuscriptId : null,
  }
  if (input.scriptStyle !== undefined) body.scriptStyle = nonnegative(input.scriptStyle, 'scriptStyle')
  if (input.episodeCount !== undefined) body.episodeCount = nonnegative(input.episodeCount, 'episodeCount')
  if (input.storyboardCountPerEpisode !== undefined) {
    body.storyboardCountPerEpisode = nonnegative(input.storyboardCountPerEpisode, 'storyboardCountPerEpisode')
  }
  if (input.globalConfig !== undefined) body.globalConfig = encodeConfig(input.globalConfig)
  return body
}

/**
 * Read the scalar new-project identity consumed by the official creation callback.
 * @param data - Envelope data from POST /aigc/script.
 * @returns The positive project ID; an object is not assumed to carry the result.
 */
export function readCreatedProjectId(data: unknown): number {
  return readPayload('readCreatedProjectId', data, () => wirePositiveId(data))
}

/**
 * Read project identity and the exact parsing state without asserting parsed-content coverage.
 * @param data - Envelope data from GET /aigc/script/{id}.
 * @returns Known fields and a detached provider snapshot; unknown states stay visible.
 */
export function readProjectDetail(data: unknown): ProjectDetail {
  return readPayload('readProjectDetail', data, () => {
    const row = wireObject(data)
    const status = optionalNumber(row.parsingStatus)
    return { ...readScript(data), create_type: optionalNumber(row.createType),
      produce_type: optionalNumber(row.produceType), manuscript_id: row.manuscriptId == null ? null : wirePositiveId(row.manuscriptId),
      parsing_status: status, parsing_phase: parsingPhase(status), parsing_message: optionalText(row.parsingMsg),
      snapshot: structuredClone(row) }
  })
}
