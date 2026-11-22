/**
 * Batch Jianying drafts from Jingliu's draft plans: the studio lays out each episode's draft documents and material
 * list, and this computer downloads every material once into the production's media folder, links it into each
 * draft, cuts the cover and installs the draft. The studio writes no file for a plan.
 *
 * A draft's fingerprint is the account, project, episode and the plan's `draft_sha256`, so the same plan returns the
 * installed draft as existing after any number of calls, and a changed plan installs a new draft beside it.
 * @module
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { JingliuHttpError, mediaPath, type JingliuSession, type LocalMedia } from '@deepseek-ai/dsh-jingliu-connection'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { isFields } from './catalog.ts'
import { commitDraft, fill, installedDraft, invalid, leaf, placeholderPaths, trackCounts } from './delivery.ts'

type Fields = Record<string, JsonValue>

/** Episodes the plan route accepts in one request. */
export const PLAN_EPISODES = 10

/** Draft switches, named as the plan route and `jianying_draft` name them; omitted values keep the project's setting. */
export interface PlanSwitches {
  readonly subtitles?: boolean | undefined
  readonly music?: boolean | undefined
  readonly ending?: boolean | undefined
  readonly watermark?: boolean | undefined
  readonly watermark_text?: string | undefined
}

/** One batch of planned drafts. */
export interface PlannedDraftBatch {
  readonly project: string
  readonly episodes: readonly number[]
  readonly switches: PlanSwitches
  /** Draft name prefix; the studio names a draft `<prefix>-第N集` and uses the project title when this is omitted. */
  readonly namePrefix?: string | undefined
  /** User's Jianying draft root. */
  readonly root: string
  /**
   * Accept an episode whose only subtitle problem is `unverified`: legacy or older-path rows the user chose to keep.
   * Only the user's answer to the legacy-subtitle choice sets it.
   */
  readonly keepLegacy?: boolean | undefined
  /** The production's local media folder, `<workspace>/jingliu/<project>`. */
  readonly mediaFolder: string
  /**
   * Cut one JPEG frame from a local video.
   * @param video - Downloaded video.
   * @param seconds - Source time of the frame.
   * @param target - JPEG to write.
   * @param signal - Cancellation.
   * @returns Whether the frame was written.
   */
  readonly cover: (video: string, seconds: number, target: string, signal: AbortSignal) => Promise<boolean>
}

/** Why an episode got no draft. */
export type PlannedDraftRefusal = 'subtitles_missing' | 'subtitles_stale' | 'subtitles_unverified' | 'not_selected'
  | 'jingliu_outdated' | 'draft_failed'

/** Outcome of one batch, grouped by episode result. */
export interface PlannedDraftOutcome {
  created: Fields[]
  existing: Fields[]
  refused: Fields[]
  music_missing: number[]
  unsupported: string[]
}

/**
 * Whether a Jingliu failure means the server predates a route.
 * @param error - Failure of one request.
 * @returns True for 405 and for a 404 that is not a JSON detail of a known route, such as an unknown project.
 */
export function missingRoute(error: unknown): boolean {
  return error instanceof JingliuHttpError && (error.status === 405
    || error.status === 404 && (error.message === 'Not Found' || error.code === 'JINGLIU_INVALID_RESPONSE'))
}

interface Material { readonly path: string; readonly name: string; readonly size: number | null }
interface Cover { readonly path: string; readonly sourceInUs: number }
interface StatusLists { readonly status: string; readonly stale: number[]; readonly missing: number[]; readonly unverified: number[] }
interface PlannedEpisode {
  readonly episode: number
  readonly name: string
  readonly content: Fields
  readonly meta: Fields
  readonly materials: readonly Material[]
  readonly sha256: string
  readonly shots: number
  readonly subtitles: StatusLists
  readonly musicClips: number
  readonly cover: Cover | null
  readonly warnings: readonly string[]
}

const orders = (value: JsonValue | undefined): number[] =>
  Array.isArray(value) ? value.filter((order): order is number => typeof order === 'number' && Number.isSafeInteger(order)) : []

function plannedEpisode(value: Fields): PlannedEpisode | { episode: number; error: string } {
  const episode = value.episode
  if (typeof episode !== 'number' || !Number.isSafeInteger(episode)) throw invalid()
  if (typeof value.error === 'string') return { episode, error: value.error }
  const { draft_content: content, draft_meta_info: meta, subtitles, music, cover } = value
  if (typeof value.name !== 'string' || !value.name.trim() || !isFields(content) || !isFields(meta) || !Array.isArray(value.materials)
    || typeof value.draft_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.draft_sha256) || !isFields(subtitles)
    || typeof subtitles.status !== 'string' || !isFields(music) || !(cover === null || isFields(cover))) throw invalid()
  const names = new Set<string>()
  const materials = value.materials.map((row): Material => {
    if (!isFields(row) || typeof row.path !== 'string' || !leaf(row.name) || names.has(row.name.toLowerCase())
      || !(row.size === null || typeof row.size === 'number' && Number.isSafeInteger(row.size) && row.size > 0)) throw invalid()
    names.add(row.name.toLowerCase())
    return { path: mediaPath(row.path).path, name: row.name, size: row.size ?? null }
  })
  let planned: Cover | null = null
  if (cover !== null) {
    if (typeof cover.path !== 'string' || typeof cover.source_in_us !== 'number' || !Number.isFinite(cover.source_in_us)) throw invalid()
    planned = { path: mediaPath(cover.path).path, sourceInUs: Math.max(0, cover.source_in_us) }
  }
  return { episode, name: value.name, content, meta, materials, sha256: value.draft_sha256,
    shots: typeof value.shots === 'number' ? value.shots : 0,
    subtitles: { status: subtitles.status, stale: orders(subtitles.stale), missing: orders(subtitles.missing),
      unverified: orders(subtitles.unverified) },
    musicClips: typeof music.clips === 'number' ? music.clips : 0, cover: planned,
    warnings: Array.isArray(value.warnings) ? value.warnings.filter((row): row is string => typeof row === 'string') : [] }
}

function folderName(name: string): string {
  const safe = Array.from(name.replace(/[\\/:*?"<>|\x00-\x1f]/gu, '_')).slice(0, 90).join('').replace(/[. ]+$/u, '')
  return safe || 'Jingliu'
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function install(session: JingliuSession, batch: PlannedDraftBatch, plan: PlannedEpisode, signal: AbortSignal):
Promise<{ readonly path: string; readonly existing: boolean }> {
  const fingerprint = createHash('sha256').update(JSON.stringify([session.identity, batch.project, plan.episode, plan.sha256])).digest('hex')
  const directory = join(resolve(batch.root), folderName(plan.name) + ' - Muse ' + fingerprint.slice(0, 10))
  if (await installedDraft(directory, fingerprint) !== undefined) return { path: directory, existing: true }
  if (await exists(directory)) throw invalid()
  const { download, place } = session
  if (!download || !place) throw new HarnessError('只有桌面版 Muse 能把镜流素材下载到本机。', 'JINGLIU_MEDIA_LOCAL_DISABLED')
  const wanted = [...new Set([...plan.materials.map(material => material.path), ...plan.cover === null ? [] : [plan.cover.path]])]
  const local = wanted.length === 0 ? new Map<string, LocalMedia>() : await download(wanted, batch.mediaFolder, signal)
  await commitDraft(batch.root, directory, async (stage) => {
    await mkdir(join(stage, 'media'))
    let bytes = 0
    for (const material of plan.materials) {
      const file = local.get(material.path)
      if (file === undefined || material.size !== null && file.size !== material.size) throw invalid()
      await place(file, join(stage, 'media', material.name))
      bytes += file.size
    }
    const paths = placeholderPaths(batch.root, directory)
    const content: Fields = { ...plan.content, name: basename(directory) }
    const meta: Fields = { ...plan.meta, draft_name: basename(directory), draft_id: randomUUID().toUpperCase() }
    const video = plan.cover === null ? undefined : local.get(plan.cover.path)
    const target = join(stage, 'draft_cover.jpg')
    const start = (plan.cover?.sourceInUs ?? 0) / 1_000_000
    const covered = video !== undefined
      && (await batch.cover(video.file, start + 1, target, signal) || await batch.cover(video.file, start, target, signal))
    if (!covered) delete meta.draft_cover
    const serialized = JSON.stringify(fill(content, paths))
    for (const file of ['draft_content.json', 'draft_info.json']) await writeFile(join(stage, file), serialized)
    await writeFile(join(stage, 'draft_meta_info.json'), JSON.stringify(fill(meta, paths)))
    return { fingerprint, path: directory, name: basename(directory), episode: plan.episode, draft_sha256: plan.sha256,
      shots: plan.shots, materials: plan.materials.length, bytes, cover: covered, tracks: trackCounts(content) }
  }, signal)
  return { path: directory, existing: false }
}

/**
 * Plan and install drafts for the given episodes, at most {@link PLAN_EPISODES} per plan request.
 * @param session - Signed-in Jingliu session; installing needs local media.
 * @param batch - Project, episodes, switches, draft root, media folder and cover cutter.
 * @param signal - Cancellation; a stage directory never survives it.
 * @returns Episodes grouped by result. Every episode is `jingliu_outdated` when the studio has no plan route.
 */
export async function plannedDrafts(session: JingliuSession, batch: PlannedDraftBatch, signal: AbortSignal): Promise<PlannedDraftOutcome> {
  const outcome: PlannedDraftOutcome = { created: [], existing: [], refused: [], music_missing: [], unsupported: [] }
  const unsupported = new Set<string>()
  for (let index = 0; index < batch.episodes.length; index += PLAN_EPISODES) {
    const episodes = batch.episodes.slice(index, index + PLAN_EPISODES)
    let response: unknown
    try {
      response = await session.request(`/projects/${encodeURIComponent(batch.project)}/jianying/plan`, { method: 'POST', signal,
        body: { episodes, switches: batch.switches, ...batch.namePrefix === undefined ? {} : { name_prefix: batch.namePrefix } } })
    } catch (error) {
      if (!missingRoute(error)) throw error
      for (const episode of batch.episodes.slice(index)) outcome.refused.push({ episode, reason: 'jingliu_outdated' })
      break
    }
    if (!isFields(response) || !Array.isArray(response.episodes)) throw invalid()
    if (Array.isArray(response.unsupported)) for (const name of response.unsupported) if (typeof name === 'string') unsupported.add(name)
    const plans = new Map(response.episodes.map((row) => {
      if (!isFields(row)) throw invalid()
      const plan = plannedEpisode(row)
      return [plan.episode, plan] as const
    }))
    for (const episode of episodes) {
      signal.throwIfAborted()
      const plan = plans.get(episode)
      const refuse = (reason: PlannedDraftRefusal, extra: Fields = {}) => { outcome.refused.push({ episode, reason, ...extra }) }
      if (plan === undefined) throw invalid()
      if ('error' in plan) { refuse('not_selected', { detail: plan.error }); continue }
      const lists = plan.subtitles
      if (batch.switches.subtitles !== false && lists.status !== 'fresh' && !(lists.status === 'unverified' && batch.keepLegacy === true)) {
        if (lists.status === 'stale') refuse('subtitles_stale', { changed_shots: lists.stale })
        else if (lists.status === 'unverified') refuse('subtitles_unverified', { shots: lists.unverified })
        else refuse('subtitles_missing', { shots: lists.missing })
        continue
      }
      try {
        const installed = await install(session, batch, plan, signal)
        if (installed.existing) { outcome.existing.push({ episode, path: installed.path }); continue }
        outcome.created.push({ episode, path: installed.path, ...plan.warnings.length === 0 ? {} : { warnings: [...plan.warnings] } })
        if (batch.switches.music !== false && plan.musicClips === 0) outcome.music_missing.push(episode)
      } catch (error) {
        signal.throwIfAborted()
        refuse('draft_failed', { error: (error instanceof Error ? error.message : String(error)).slice(0, 300) })
      }
    }
  }
  outcome.unsupported.push(...unsupported)
  return outcome
}
