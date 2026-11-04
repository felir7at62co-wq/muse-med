/** Explicit project episode plans used by approved-video delivery. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { ApprovedEpisodeDelivery, ApprovedEpisodeDeliverySummary, ApprovedEpisodeInputHashes, VideoRecoveryReview } from './types.ts'

const shotSchema = z.object({
  shot: z.number().int().positive(),
  idempotency_key: z.string().min(1),
  review_digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
const planSchema = z.object({
  schema_version: z.literal(1),
  episode: z.number().int().positive().max(99),
  total_shots: z.number().int().positive().max(500),
  shots: z.array(shotSchema).min(1).max(500),
  timeline: z.string().min(1),
  subtitle_srt: z.string().min(1),
  mix_profile: z.string().min(1),
  bgm: z.string().min(1).optional(),
}).strict()
const mixProfileSchema = z.object({ schema_version: z.literal(1), mode: z.enum(['legacy', 'no_bgm', 'ducking']) }).loose()
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)

/** SHA-256 hashes of the project configuration and the files used to render the episode. */
export const episodeInputHashesSchema = z.object({
  projectConfig: sha256Schema,
  timeline: sha256Schema,
  subtitle: sha256Schema,
  mixProfile: sha256Schema,
  bgm: sha256Schema.optional(),
}).strict().transform(({ bgm, ...required }): ApprovedEpisodeInputHashes => ({ ...required, ...(bgm === undefined ? {} : { bgm }) }))
const timelineSchema = z.object({
  clips: z.array(z.object({
    shot: z.number().int().positive(),
    start_us: z.number().int().nonnegative(),
    duration_us: z.number().int().positive(),
  })),
  body_end: z.number().positive(),
}).loose()

/** Parsed version-one project episode delivery plan. */
export type ApprovedEpisodePlan = z.infer<typeof planSchema>

function inside(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith('..' + sep))
}

async function projectFile(projectDir: string, value: string): Promise<string> {
  if (isAbsolute(value)) throw new Error('Episode delivery inputs must use project-relative paths')
  const path = resolve(projectDir, value)
  const root = await realpath(projectDir)
  if (!inside(root, path)) throw new Error('Episode delivery input escapes the selected project')
  const actual = await realpath(path)
  if (!inside(root, actual)) throw new Error('Episode delivery input escapes the selected project')
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Episode delivery input must be a regular project file')
  return actual
}

/**
 * Read and validate an episode plan and every authored editing input it names.
 * @param projectDir - The selected local Jubian project.
 * @param episode - One-based episode number.
 * @returns The plan, absolute input paths, per-file hashes and existing delivery digest.
 */
export async function readApprovedEpisodePlan(projectDir: string, episode: number): Promise<{
  readonly plan: ApprovedEpisodePlan
  readonly planPath: string
  readonly timelinePath: string
  readonly subtitlePath: string
  readonly mixProfilePath: string
  readonly bgmPath?: string
  readonly digest: string
  readonly inputHashes: ApprovedEpisodeInputHashes
}> {
  const name = String(episode).padStart(2, '0') + '-episode-delivery.json'
  const planPath = await projectFile(projectDir, join('editing', name))
  const source = await readFile(planPath, 'utf8')
  const plan = planSchema.parse(JSON.parse(source.replace(/^\uFEFF/u, '')))
  if (plan.episode !== episode || plan.total_shots !== plan.shots.length
    || plan.shots.some((shot, index) => shot.shot !== index + 1)
    || new Set(plan.shots.map(shot => shot.idempotency_key)).size !== plan.shots.length) {
    throw new Error('Episode plan must list each unique approved shot once, in contiguous shot order')
  }
  const timelinePath = await projectFile(projectDir, plan.timeline)
  const subtitlePath = await projectFile(projectDir, plan.subtitle_srt)
  const mixProfilePath = await projectFile(projectDir, plan.mix_profile)
  const bgmPath = plan.bgm === undefined ? undefined : await projectFile(projectDir, plan.bgm)
  const timelineBytes = await readFile(timelinePath)
  const timeline = timelineSchema.parse(JSON.parse(timelineBytes.toString('utf8')))
  let timelineEnd = 0
  if (timeline.clips.length !== plan.total_shots || timeline.clips.some((clip, index) => {
    const valid = clip.shot === index + 1 && clip.start_us === timelineEnd
    timelineEnd = clip.start_us + clip.duration_us
    return !valid
  }) || Math.abs(timeline.body_end - timelineEnd / 1_000_000) > 0.000001) {
    throw new Error('Episode timeline must place the listed shots once, in order, with matching body_end')
  }
  const mixProfileBytes = await readFile(mixProfilePath)
  const mixProfile = mixProfileSchema.parse(JSON.parse(mixProfileBytes.toString('utf8')))
  if ((mixProfile.mode === 'no_bgm') !== (bgmPath === undefined)) {
    throw new Error('A no_bgm profile omits bgm; other mix profiles require a project BGM file')
  }
  const subtitleBytes = await readFile(subtitlePath)
  const subtitle = subtitleBytes.toString('utf8')
  if (!/^\s*\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,.]\d{3}\s*\r?\n\S/mu.test(subtitle)) {
    throw new Error('Episode SRT must contain at least one timed, nonempty subtitle cue')
  }
  const projectConfigBytes = await readFile(await projectFile(projectDir, 'project_config.json'))
  // The project configuration hash is separate from the digest used by existing receipts and output names.
  const hash = createHash('sha256').update(JSON.stringify(plan)).update(timelineBytes).update(subtitleBytes).update(mixProfileBytes)
  let bgm: string | undefined
  if (bgmPath !== undefined) {
    const bgmHash = createHash('sha256')
    for await (const chunk of createReadStream(bgmPath)) {
      if (!(chunk instanceof Uint8Array)) throw new Error('Episode BGM stream returned non-binary data')
      hash.update(chunk)
      bgmHash.update(chunk)
    }
    bgm = bgmHash.digest('hex')
  }
  const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  return {
    plan, planPath, timelinePath, subtitlePath, mixProfilePath, ...(bgmPath === undefined ? {} : { bgmPath }),
    digest: hash.digest('hex'),
    inputHashes: {
      projectConfig: sha256(projectConfigBytes), timeline: sha256(timelineBytes),
      subtitle: sha256(subtitleBytes), mixProfile: sha256(mixProfileBytes), ...(bgm === undefined ? {} : { bgm }),
    },
  }
}

/**
 * Summarize exact approval coverage for an episode plan.
 * @param projectDir - The selected local Jubian project.
 * @param episode - One-based episode number.
 * @param reports - Reports that belong to this project.
 * @param delivery - Previously recorded delivery for the same digest.
 * @returns Readiness, missing approvals and any saved output.
 */
export async function summarizeApprovedEpisode(projectDir: string, episode: number,
  reports: readonly VideoRecoveryReview[], delivery?: ApprovedEpisodeDelivery): Promise<ApprovedEpisodeDeliverySummary> {
  try {
    const { plan, digest } = await readApprovedEpisodePlan(projectDir, episode)
    const byKey = new Map(reports.map(report => [report.idempotencyKey, report]))
    const missing: string[] = []
    let approvedShots = 0
    for (const shot of plan.shots) {
      const report = byKey.get(shot.idempotency_key)
      if (report === undefined || report.digest !== shot.review_digest
        || report.decision !== 'approve' || report.status !== 'awaiting_review') {
        missing.push(String(shot.shot))
      } else if (report.mediaChecks.length !== 1 || report.mediaChecks[0] === undefined
        || !report.mediaChecks[0].video || !report.mediaChecks[0].audio) {
        missing.push(String(shot.shot))
      } else {
        approvedShots += 1
      }
    }
    return {
      episode, approvedShots, totalShots: plan.total_shots,
      readiness: missing.length === 0 ? 'ready' : 'incomplete', digest, missing,
      ...(delivery === undefined ? {} : { delivery }),
    }
  } catch (error) {
    return { episode, approvedShots: 0, totalShots: 0, readiness: 'invalid',
      missing: [error instanceof Error ? error.message : 'Episode plan could not be read'] }
  }
}

/**
 * Find plan numbers declared in a selected project's editing folder.
 * @param projectDir - The selected local Jubian project.
 * @returns Sorted one-based episode numbers with plan files.
 */
export async function listApprovedEpisodeNumbers(projectDir: string): Promise<number[]> {
  const directory = join(projectDir, 'editing')
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  return entries.flatMap((entry) => {
    const match = /^(\d{2})-episode-delivery\.json$/u.exec(entry.name)
    return entry.isFile() && !entry.isSymbolicLink() && match?.[1] ? [Number(match[1])] : []
  }).sort((a, b) => a - b)
}

/**
 * Validate a durable receipt before showing it in the project UI.
 * @param value - Parsed receipt JSON from the project.
 * @returns A receipt with validated path, digest, duration and checks.
 */
export function parseEpisodeDelivery(value: unknown): ApprovedEpisodeDelivery {
  const { inputHashes, ...receipt } = z.object({
    path: z.string().regex(/^exports\/Supermuse-episode-\d{2}-[a-f0-9]{64}\.mp4$/u),
    sha256: sha256Schema,
    durationSeconds: z.number().positive(),
    checks: z.array(z.object({ id: z.string(), ok: z.boolean(), detail: z.string() })),
    inputHashes: episodeInputHashesSchema.optional(),
  }).parse(value)
  return { ...receipt, ...(inputHashes === undefined ? {} : { inputHashes }) }
}

/**
 * Return the deterministic receipt location for a plan version.
 * @param projectDir - The selected local Jubian project.
 * @param episode - One-based episode number.
 * @param digest - Current plan and editing-input digest.
 * @returns The project-local receipt path.
 */
export function episodeDeliveryReceiptPath(projectDir: string, episode: number, digest: string): string {
  return join(projectDir, 'video_tasks', 'review', `episode-${String(episode).padStart(2, '0')}-${digest}.delivery.json`)
}

/**
 * Read and validate a delivery receipt for its exact plan digest.
 * @param projectDir - The selected local Jubian project.
 * @param episode - One-based episode number.
 * @param digest - Current plan and editing-input digest.
 * @returns The matching saved receipt, when present.
 */
export async function readEpisodeDelivery(
  projectDir: string,
  episode: number,
  digest: string,
): Promise<ApprovedEpisodeDelivery | undefined> {
  const path = episodeDeliveryReceiptPath(projectDir, episode, digest)
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Episode delivery receipt must be a regular file')
    const receipt = parseEpisodeDelivery(JSON.parse(await readFile(path, 'utf8')))
    if (receipt.path !== `exports/Supermuse-episode-${String(episode).padStart(2, '0')}-${digest}.mp4`) {
      throw new Error('Episode delivery receipt does not match its episode plan')
    }
    return receipt
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}
