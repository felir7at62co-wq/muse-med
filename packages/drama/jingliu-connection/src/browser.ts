/** Translate native Jingliu project, budget and library responses for Muse. */
import { HarnessError } from '@deepseek-ai/dsh-error'
import { isRecord } from './http.ts'
import type { StudioAsset, StudioBalance, StudioCatalog, StudioConfig, StudioEpisode, StudioLibrary, StudioOptions, StudioPreferences, StudioProject, StudioProjectAssets, StudioShot, StudioShotMedia } from './types.ts'

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
      completed: count(row.shots_done), role: field(row.my_role), thumbnail: typeof row.thumb_url === 'string' ? row.thumb_url : '',
      mode: text(row.production_mode), aspect: text(row.base_aspect), createdAt: text(row.created_at),
      profile: profileOf(row.default_profile) }
  })
}

// The technical defaults a production was created with, stored by the studio as a JSON string.
function profileOf(value: unknown): StudioProject['profile'] {
  let parsed: unknown = null
  if (typeof value === 'string' && value !== '') {
    try { parsed = JSON.parse(value) } catch { parsed = null /* An unreadable profile shows no defaults. */ }
  }
  const row = isRecord(parsed) ? parsed : {}
  return { videoModel: text(row.video_model), generationMode: text(row.generation_mode), resolution: text(row.resolution) }
}

/**
 * Read the choices offered for a new production.
 * @param modes - `/production-modes`: modes with their art styles, aspects and resolutions.
 * @param image - `/providers/image`: image models.
 * @param video - `/providers/video`: video models and generation modes.
 * @returns The catalog the new-production form offers.
 */
export function catalog(modes: unknown, image: unknown, video: unknown): StudioCatalog {
  if (!isRecord(modes) || !isRecord(modes.modes) || !isRecord(image) || !Array.isArray(image.models)) return invalid()
  if (!isRecord(video) || !Array.isArray(video.providers)) return invalid()
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  return {
    modes: Object.entries(modes.modes).flatMap(([key, mode]) => isRecord(mode) ? [{
      key, label: text(mode.label).replace(/^\P{L}+/u, '').trim() || key,
      styles: (Array.isArray(mode.styles) ? mode.styles : []).flatMap(style => isRecord(style) && typeof style.key === 'string'
        ? [{ key: style.key, label: text(style.label) || style.key, enabled: style.enabled !== false }] : []),
    }] : []),
    aspects: strings(modes.aspects),
    resolutions: strings(modes.resolutions),
    imageModels: image.models.flatMap(model => isRecord(model) && typeof model.id === 'string' ? [{ id: model.id, name: text(model.label) || model.id }] : []),
    videoModels: video.providers.flatMap(provider => isRecord(provider) && typeof provider.model_id === 'string' ? [{ id: provider.model_id, name: provider.model_id }] : []),
    generationModes: isRecord(video.generation_modes)
      ? Object.entries(video.generation_modes).map(([id, name]) => ({ id, name: text(name).split(/[（(]/u)[0]?.trim() || id })) : [],
  }
}

/**
 * Read the production the studio created.
 * @param value - `POST /projects` response.
 * @returns Its id and title.
 */
export function createdProject(value: unknown): { id: string; title: string } {
  if (!isRecord(value)) return invalid()
  return { id: field(value.id), title: field(value.title) }
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
    return { id: field(row.asset_id), kind: field(row.kind), name: field(row.name), thumbnail: typeof row.image_url === 'string' ? row.image_url : '',
      description: typeof row.prompt === 'string' ? row.prompt : '', referenceOnly: row.reference_only === true, uses: count(row.uses) }
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

const text = (value: unknown): string => typeof value === 'string' ? value : ''
const seconds = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const names = (value: unknown): string[] => Array.isArray(value)
  ? value.map(item => typeof item === 'string' ? item : isRecord(item) && typeof item.name === 'string' ? item.name : '').filter(Boolean)
  : []
const media = (value: unknown): string => typeof value === 'string' && /^\/fwp?\/media\//u.test(value) ? value : ''

/**
 * Read a workflow result: the studio answers `{ ok: true, ... }` or `{ ok: false, error }`.
 * @param value - Response of one desktop workflow.
 * @returns The fields of a successful result.
 */
export function workflowResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return invalid()
  if (value.ok !== true) throw new HarnessError(typeof value.error === 'string' && value.error ? value.error : '镜流没有完成这次读取。', 'JINGLIU_WORKFLOW_FAILED')
  return value
}

/**
 * Read a project's configuration.
 * @param value - Successful `get_project` result.
 * @returns The production settings shown in the workbench.
 */
export function projectConfig(value: Record<string, unknown>): StudioConfig {
  return { projectId: field(value.project_id), title: field(value.title), aspect: text(value.aspect), artStyle: text(value.art_style),
    mode: text(value.production_mode), resolution: text(value.resolution),
    imageModel: text(value.image_model), videoModel: text(value.video_model) }
}

/**
 * Read a production's episodes.
 * @param value - Successful `list_episodes` result.
 * @returns Episodes in their studio order.
 */
export function episodeList(value: Record<string, unknown>): StudioEpisode[] {
  if (!Array.isArray(value.episodes)) return invalid()
  return value.episodes.flatMap((row, position): StudioEpisode[] => {
    if (!isRecord(row)) return []
    const number = typeof row.order === 'number' ? row.order : typeof row.index === 'number' ? row.index : position + 1
    return [{ number, title: text(row.title), hasShots: row.has_shots === true }]
  })
}

/**
 * Join an episode's shot list with the full rows of its shots.
 * @param list - Successful `list_shots` result for the episode.
 * @param rows - `read_shots` rows of the same episode, in any number of pages.
 * @returns The episode's shots in order, numbered within the episode.
 */
export function episodeShots(list: Record<string, unknown>, rows: unknown[]): StudioShot[] {
  if (!Array.isArray(list.shots)) return invalid()
  const full = new Map(rows.filter(isRecord).map(row => [text(row.id), row]))
  return list.shots.filter(isRecord).filter(row => row.special !== true).map((row, position): StudioShot => {
    const id = field(row.id)
    const detail = full.get(id) ?? {}
    return { id, order: count(row.order), episode: count(row.episode), index: position + 1, prompt: text(detail.prompt),
      characters: names(detail.characters), location: text(detail.location), props: names(detail.props),
      durationSec: seconds(row.duration_sec), hasVideo: row.has_video === true,
      failReason: text(row.fail_reason), stale: row.stale === true }
  })
}

/**
 * Read one shot's media.
 * @param shot - Successful `get_shot` result.
 * @param versions - Successful `list_versions` result for the same shot.
 * @returns The video in use, its first frame and the version chain.
 */
export function shotMedia(shot: Record<string, unknown>, versions: Record<string, unknown>): StudioShotMedia {
  const chain = Array.isArray(versions.versions) ? versions.versions.filter(isRecord) : []
  return { shotId: field(shot.id), videoPath: media(shot.video_url), firstFramePath: media(shot.first_frame_url),
    adoptedVersion: typeof shot.adopted_version === 'number' ? shot.adopted_version : null,
    versions: chain.map(row => ({
      number: count(row.version_no), model: text(row.model_id), videoPath: media(row.video_url), createdAt: text(row.created_at),
    })) }
}

/**
 * Read a production's assets and audio clips.
 * @param assets - Successful `list_assets` result.
 * @param audio - Successful `list_audio_clips` result.
 * @returns The asset page's data.
 */
export function projectAssets(assets: Record<string, unknown>, audio: Record<string, unknown>): StudioProjectAssets {
  if (!Array.isArray(assets.assets)) return invalid()
  return {
    assets: assets.assets.filter(isRecord).map(row => ({
      id: field(row.id), kind: text(row.kind), name: text(row.name), imagePath: media(row.image_url), prompt: text(row.prompt),
    })),
    audio: (Array.isArray(audio.clips) ? audio.clips : []).filter(isRecord).map(row => ({
      id: field(row.id), kind: text(row.kind), text: text(row.text), path: media(row.url), durationSec: seconds(row.duration),
    })),
  }
}
