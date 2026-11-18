/** Translate native Jingliu project, budget and library responses for Muse. */
import { HarnessError } from '@deepseek-ai/dsh-error'
import { isRecord } from './http.ts'
import type { StudioAsset, StudioBalance, StudioLibrary, StudioOptions, StudioPreferences, StudioProject } from './types.ts'

function invalid(): never {
  throw new HarnessError('镜流返回的数据格式已变更，请刷新后重试。', 'JINGLIU_INVALID_RESULT')
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid()
}

function field(value: unknown): string {
  return typeof value === 'string' ? value : invalid()
}

/**
 * Read the studio catalog for the signed-in account.
 * @param value - Project list returned by the signed-in studio.
 * @returns Available cloud projects.
 */
export function projects(value: unknown): StudioProject[] {
  if (!isRecord(value) || !Array.isArray(value.projects)) return invalid()
  return value.projects.map((row) => {
    if (!isRecord(row)) return invalid()
    return { id: field(row.id), title: field(row.title), episodes: count(row.episodes_count), shots: count(row.shots_total),
      completed: count(row.shots_done), role: field(row.my_role), thumbnail: typeof row.thumb_url === 'string' ? row.thumb_url : '' }
  })
}

/**
 * Read a page of shared production assets.
 * @param value - Backend-filtered shared catalog page.
 * @returns Library entries for the signed-in user.
 */
export function library(value: unknown): StudioLibrary {
  if (!isRecord(value) || !Array.isArray(value.items)) return invalid()
  const items = value.items.map((row): StudioAsset => {
    if (!isRecord(row)) return invalid()
    return { id: field(row.asset_id), kind: field(row.kind), name: field(row.name), thumbnail: typeof row.image_url === 'string' ? row.image_url : '' }
  })
  return { total: count(value.total), items }
}

/**
 * Read the current account allowance and usage.
 * @param value - Native balance response.
 * @returns Currency and allowance exactly as reported by Jingliu.
 */
export function balance(value: unknown): StudioBalance {
  if (!isRecord(value) || typeof value.unlimited !== 'boolean') return invalid()
  return { unlimited: value.unlimited, available: field(value.available_yuan),
    usedFen: count(value.used_fen), heldFen: count(value.held_fen) }
}

/**
 * Read the native settings of one production.
 * @param value - Project preference response.
 * @param projectId - Selected project.
 * @returns Stored project settings.
 */
export function preferences(value: unknown, projectId: string): StudioPreferences {
  if (!isRecord(value) || value.project_id !== projectId || !isRecord(value.prefs) || typeof value.prefs.prompt_chips_hidden !== 'boolean') return invalid()
  return { projectId, hidePromptChips: value.prefs.prompt_chips_hidden }
}

/**
 * Read per-category image models and supported video resolutions.
 * @param projectId - Native project ID.
 * @param image - Asset model overrides.
 * @param video - Resolution settings.
 * @returns Project options offered by this studio.
 */
export function options(projectId: string, image: unknown, video: unknown): StudioOptions {
  if (!isRecord(image) || !Array.isArray(image.models) || !isRecord(image.by_kind) ||
      !isRecord(video) || !Array.isArray(video.tiers)) return invalid()
  const current = (v: unknown): string => v == null ? '' : field(v)
  const supported = Array.isArray(video.supported) ? video.supported.map(field) : null
  const resolutions = video.tiers.map(field).filter(tier => !supported || supported.includes(tier) || tier === video.resolution)
  return { projectId, resolution: current(video.resolution), resolutions,
    models: image.models.map(m => isRecord(m) ? { id: field(m.id), name: field(m.label ?? m.name ?? m.id) } : invalid()),
    projectModel: current(image.project_model), character: current(image.by_kind.character),
    location: current(image.by_kind.location), prop: current(image.by_kind.prop) }
}

/**
 * Validate a studio project ID for use in a request path.
 * @param id - Selected project.
 * @returns Encoded native project path.
 */
export function projectPath(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) throw new HarnessError('镜流项目编号无效。', 'JINGLIU_INVALID_PROJECT')
  return '/projects/' + id
}
